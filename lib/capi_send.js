/**
 * ส่งออเดอร์จากแชทเข้า Meta Conversions API -- ตัวส่งมีที่เดียว
 *
 * ใช้ร่วมสองทาง:
 *   1) ทันทีใน webhook (lib/store.js)  = ทางหลัก  -- แกะแพทเทินได้เมื่อไหร่ ส่งเลย
 *   2) /api/capi                        = ตาข่ายรับ -- เก็บใบที่ทางแรกพลาด
 *
 * ⚠️ ห้าม import จาก store.js  -- store.js import ไฟล์นี้ จะวนกันเอง
 *    ต้องรับ pg client เข้ามาเป็นพารามิเตอร์เสมอ
 *
 * ⚠️ ส่งต้องเสร็จ "ก่อน" res.end() ของ webhook
 *    Vercel หยุดฟังก์ชันทันทีที่ response จบ ยิงแบบไม่รอผลคืองานโดนตัดกลางคัน
 *    Meta ให้เวลา webhook ~20 วินาที -- ตัวส่งจึงมี timeout ของตัวเอง (SEND_TIMEOUT_MS)
 *    หมดเวลา/ล้ม = ไม่ throw ออกไป ปล่อยแถวค้าง state='held' ให้ /api/capi เก็บรอบหน้า
 *
 * ⚠️ เสียเวลาเฉพาะข้อความที่เข้าแพทเทินจริง (ไม่กี่ใบต่อวัน) ไม่ใช่ทุกข้อความ
 *    -- เหตุผลเดิมที่เขียนกันไว้ว่า "จะทำให้ทุกข้อความช้าลง" ไม่ตรงกับของจริง
 *
 * ⚠️ ปลายทางเป็น dataset "ของเพจนั้น" ไม่ใช่ก้อนเดียวรวม
 *    Meta ตีกลับ "Messaging event no Page associated to dataset" ถ้า dataset ไม่มีเพจผูก
 *    และหน้าตั้งค่า dataset ไม่มีช่องให้ผูกเพจ -- ต้องไปทำที่ เชื่อมต่อข้อมูล > การส่งข้อความ
 *    จึงถาม Graph ตอนรันว่าเพจนี้ใช้ dataset ไหน เพจใหม่จะได้ทำงานเองโดยไม่ต้องแก้โค้ด
 */

const SCHEMA_NAME = (process.env.DB_SCHEMA || "chatlog").trim();
const T = (n) => `${SCHEMA_NAME}.${n}`;

/* ⚠️ ห้ามยิงเข้า Pixel ของเว็บ -- ตัวนั้นรับจากเว็บอยู่แล้วแสนกว่า event
      ปนเข้าไปแล้วแยกไม่ออกว่ายอดไหนมาจากเว็บ ยอดไหนมาจากแชท และลบ event คืนไม่ได้ */
export const DATASET_WEB_PIXEL = "3634784846565263";

const DAY = 86400000;

/* ⚠️ Meta ไม่รับ event_time เก่ากว่า 7 วัน และถ้ามีใบเดียวเกิน
      "reject ทั้ง request ไม่ประมวลผล event ใดเลย"
      ตัดที่ 6 วัน เหลือกันชน 1 วัน แถวที่เกินตีเป็น expired ห้ามส่ง */
export const MAX_AGE_DAYS = 6;

/* webhook มีงบเวลาจำกัด -- ยาวกว่านี้เสี่ยง Meta ตัดแล้วยิง webhook ซ้ำ
   (ยิงซ้ำไม่ทำให้ยอดเบิ้ล เพราะ event_id เดิม Meta ตัดซ้ำให้ภายใน dataset เดียวกัน
    แต่เสียเวลาเปล่าและ log รก) */
export const SEND_TIMEOUT_MS = 6000;

const ver = () => process.env.GRAPH_VERSION || "v21.0";

/* แคชข้าม request ได้เท่าที่ lambda ยังอุ่น -- เพจเดิมจะได้ไม่ถาม Graph ซ้ำทุกใบ */
const dsCache = new Map();

async function fetchJson(url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, body };
  } finally { clearTimeout(t); }
}

/** เพจนี้ส่งเข้า dataset ไหน -- null = เพจยังไม่มี dataset ผูกไว้ */
export async function datasetOf(pageId, timeoutMs = SEND_TIMEOUT_MS) {
  if (process.env.CAPI_DATASET_ID) return process.env.CAPI_DATASET_ID;   // บังคับทับได้
  if (dsCache.has(pageId)) return dsCache.get(pageId);
  const token = process.env.CAPI_TOKEN;
  if (!token) return null;
  let id = null;
  try {
    const u = `https://graph.facebook.com/${ver()}/${pageId}/dataset?access_token=${encodeURIComponent(token)}`;
    const { body } = await fetchJson(u, {}, timeoutMs);
    id = body?.data?.[0]?.id ?? null;
  } catch { id = null; }
  if (id) dsCache.set(pageId, id);        // ล้มเหลวไม่แคช จะได้ลองใหม่รอบหน้า
  return id;
}

export function buildEvent(row) {
  const ud = {
    page_id: row.page_id,                 // ⚠️ ห้าม hash
    page_scoped_user_id: row.psid,        // ⚠️ ห้าม hash
  };
  if (row.phone_sha256)     ud.ph = [row.phone_sha256];
  if (row.cust_name_sha256) ud.fn = [row.cust_name_sha256];
  if (row.zipcode_sha256)   ud.zp = [row.zipcode_sha256];

  const items = Array.isArray(row.items) ? row.items : [];
  return {
    event_name: "Purchase",
    event_time: Math.floor(Number(row.ts) / 1000),   // วินาที ไม่ใช่มิลลิวินาที
    event_id: `sum-${row.mid}-${row.ordinal}`,       // กันยิงซ้ำ
    action_source: "business_messaging",
    messaging_channel: "messenger",
    user_data: ud,
    custom_data: {
      currency: "THB",
      value: Number(row.total),
      contents: items.filter((i) => i.sku)
                     .map((i) => ({ id: i.sku, quantity: Number(i.qty) || 1 })),
    },
  };
}

/**
 * ส่งแถวที่ให้มา แล้ว mark state='sent' เฉพาะกลุ่มที่ Meta รับ
 * @returns {{sent:number, skipped:Array, results:Array, dry:boolean}}
 */
export async function sendRows(c, rows, { dry = false, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  const out = { sent: 0, skipped: [], results: [], dry };
  if (!rows.length) return out;

  /* จัดกลุ่มตาม dataset ปลายทาง */
  const byDs = new Map();
  for (const row of rows) {
    const ds = await datasetOf(row.page_id, timeoutMs);
    if (!ds) { out.skipped.push({ seq: row.seq, page_id: row.page_id, why: "เพจนี้ยังไม่มี dataset" }); continue; }
    if (ds === DATASET_WEB_PIXEL) { out.skipped.push({ seq: row.seq, page_id: row.page_id, why: "เพจนี้ชี้ไป Pixel ของเว็บ -- ไม่ยิง" }); continue; }
    if (!byDs.has(ds)) byDs.set(ds, { events: [], seqs: [] });
    const g = byDs.get(ds);
    g.events.push(buildEvent(row));
    g.seqs.push(row.seq);
  }

  if (dry) {
    out.plan = [...byDs].map(([ds, g]) => ({ dataset: ds, n: g.events.length, events: g.events }));
    return out;
  }

  const token = process.env.CAPI_TOKEN;
  if (!token) { out.error = "ไม่มี CAPI_TOKEN"; return out; }

  /* ⚠️ Meta reject ทั้ง batch ถ้ามี event เดียวผิด -- ยิงแยก dataset แล้ว mark เฉพาะกลุ่มที่ผ่าน */
  const sentSeqs = [];
  for (const [ds, g] of byDs) {
    const payload = { data: g.events, access_token: token };
    if (process.env.CAPI_TEST_CODE) payload.test_event_code = process.env.CAPI_TEST_CODE;
    let ok = false, body = {};
    try {
      ({ ok, body } = await fetchJson(`https://graph.facebook.com/${ver()}/${ds}/events`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      }, timeoutMs));
    } catch (e) { body = { error: { message: String(e?.message || e) } }; }
    out.results.push({ dataset: ds, n: g.events.length, ok, meta: body });
    if (ok) sentSeqs.push(...g.seqs);
  }

  if (sentSeqs.length) {
    await c.query(
      `UPDATE ${T("order_summary")}
          SET state='sent', sent_at=$2, meta_event_id='sum-'||mid||'-'||ordinal
        WHERE seq = ANY($1::bigint[])`,
      [sentSeqs, Date.now()]);
    out.sent = sentSeqs.length;
  }
  return out;
}

/** ส่งเฉพาะ seq ที่ระบุ -- webhook ใช้ตัวนี้กับใบที่เพิ่งแกะได้ */
export async function sendSeqs(c, seqs, opts = {}) {
  if (!seqs?.length) return { sent: 0, skipped: [], results: [], dry: false };
  const now = Date.now();
  const { rows } = await c.query(
    `SELECT * FROM ${T("order_summary")}
      WHERE seq = ANY($1::bigint[]) AND state='held' AND status='ok' AND ts >= $2`,
    [seqs, now - MAX_AGE_DAYS * DAY]);
  return sendRows(c, rows, opts);
}

/** ตาข่ายรับ: ปิดใบหมดอายุ แล้วส่งใบที่ถึงคิวทั้งหมด -- /api/capi เรียกตัวนี้ */
export async function sendDue(c, { dry = false, timeoutMs = 20000 } = {}) {
  const now = Date.now();
  const holdMs = Math.max(0, Number(process.env.HOLD_DAYS ?? 0) || 0) * DAY;

  const exp = await c.query(
    `UPDATE ${T("order_summary")} SET state='expired'
      WHERE state='held' AND ts < $1 RETURNING seq`,
    [now - MAX_AGE_DAYS * DAY]);

  const { rows } = await c.query(
    `SELECT * FROM ${T("order_summary")}
      WHERE state='held' AND status='ok' AND ts <= $1 AND ts >= $2
      ORDER BY ts LIMIT 500`,
    [now - holdMs, now - MAX_AGE_DAYS * DAY]);

  const out = await sendRows(c, rows, { dry, timeoutMs });
  return { expired: exp.rowCount, due: rows.length, ...out };
}
