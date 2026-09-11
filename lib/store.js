/**
 * ตรรกะกลาง — ใช้ร่วมกันทั้งบน Vercel และตอนรันในเครื่อง
 *
 * ⚠️ ใช้ Postgres ไม่ใช่ SQLite (ต่างจากคู่มือ 23ADS)
 *    เพราะ Vercel เป็น serverless: ดิสก์เป็นของชั่วคราว ลบทิ้งทุกครั้งที่ฟังก์ชันจบ
 *    เขียน SQLite ลงไฟล์ = ข้อมูลหายหมดแบบเงียบ ๆ (verify ผ่าน แต่ไม่มีข้อความเก็บเลย)
 *
 * ⚠️ การแยก AI ออกจากคน อยู่ที่ ai_generated ไม่ใช่ app_id
 *    Business Agent กับแอดมินที่พิมพ์ใน Page Inbox ใช้ app_id เดียวกัน (263902037430900)
 *    แยกด้วย "มี app_id ไหม" = นับคนเป็น AI ทุกข้อความโดยไม่มีอะไรฟ้อง
 */

import pg from "pg";

/* app_id ที่รู้จัก — จากคู่มือ 23ADS ไฟล์ 01 (ได้จากการแกะ payload จริง ไม่ใช่ docs) */
const APP_PAGE_INBOX = "263902037430900"; // Business Suite / Pages app (ทั้งคนและ Business Agent)
const APP_CRMIXER    = "225915530485492"; // CRMIXER สรุปออเดอร์ — ไม่ใช่ผู้ตอบ

/* ⚠️ pool ต้องอยู่นอกฟังก์ชัน — Vercel ใช้ container ซ้ำระหว่าง request ที่มาติด ๆ กัน
      ถ้าสร้าง pool ใหม่ทุกครั้ง จะเปิด connection ค้างจนฐานเต็ม
   ⚠️ ถ้าใช้ Supabase ต้องเอาสตริงของ "pooler" (พอร์ต 6543) ไม่ใช่ direct (5432)
      serverless เปิด connection ถี่มาก ต่อตรงจะเต็มโควตาเร็ว
      และ direct ของแพลนฟรีเป็น IPv6 อย่างเดียว ซึ่ง Vercel ต่อไม่ได้ */
/**
 * ⚠️ ห้ามสร้างตารางใน schema "public" ของ Supabase
 *    Supabase เปิด REST API สาธารณะให้ schema public โดยอัตโนมัติ (PostgREST)
 *    ตารางที่ไม่ได้ตั้ง RLS จะอ่านได้ด้วย anon key ซึ่งเป็นคีย์ที่ออกแบบมาให้เปิดเผย
 *    = ข้อความแชทลูกค้าหลุดได้โดยไม่ต้องเจาะอะไรเลย
 *    ใช้ schema ของตัวเองแทน -- PostgREST ไม่แตะ schema อื่นถ้าไม่ได้ตั้งค่าเพิ่ม
 * ⚠️ เขียนชื่อ schema นำหน้าทุกคำสั่ง ไม่พึ่ง search_path
 *    เพราะ pooler แบบ transaction mode ไม่รับประกันว่าจะได้ connection เดิม
 *    ที่ตั้ง search_path ไว้ (และ PgBouncer บางเวอร์ชันตัด startup option ทิ้ง)
 */
const SCHEMA_NAME = (process.env.DB_SCHEMA || "chatlog").trim();
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA_NAME)) {
  throw new Error(`DB_SCHEMA ไม่ถูกรูปแบบ: ${SCHEMA_NAME}`);
}
const T = (name) => `${SCHEMA_NAME}.${name}`;

let pool;
export function db() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("ไม่มี DATABASE_URL");
    pool = new pg.Pool({
      connectionString: url,
      max: 3,                                   // serverless ไม่ต้องการมาก
      ssl: url.includes("localhost") || url.includes("127.0.0.1")
        ? false
        : { rejectUnauthorized: false },        // Neon/Supabase บังคับ SSL
    });
  }
  return pool;
}

/* สร้างตารางครั้งเดียวต่อ container — ไม่ใช่ทุก request */
let schemaReady;
export function ensureSchema() {
  if (!schemaReady) schemaReady = db().query(SCHEMA).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

export const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME};

CREATE TABLE IF NOT EXISTS ${T("messages")} (
  seq          bigserial PRIMARY KEY,
  mid          text UNIQUE NOT NULL,
  page_id      text NOT NULL,
  psid         text NOT NULL,
  direction    text NOT NULL,
  actor        text NOT NULL,
  app_id       text,
  ai_generated boolean DEFAULT false,
  metadata     text,
  text_masked  text,
  has_close    boolean DEFAULT false,
  close_amount numeric(12,2),
  ts           bigint NOT NULL,
  raw          jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_page_ts ON ${T("messages")}(page_id, ts);

CREATE TABLE IF NOT EXISTS ${T("referrals")} (
  seq      bigserial PRIMARY KEY,
  page_id  text NOT NULL,
  psid     text NOT NULL,
  mid      text NOT NULL DEFAULT '',
  ad_id    text NOT NULL DEFAULT '',
  ad_title text,
  post_id  text,
  source   text,
  ref      text,
  ts       bigint NOT NULL,
  raw      jsonb NOT NULL,
  UNIQUE (page_id, psid, mid, ad_id)
);

CREATE TABLE IF NOT EXISTS ${T("handovers")} (
  seq      bigserial PRIMARY KEY,
  page_id  text NOT NULL,
  psid     text NOT NULL,
  event    text NOT NULL,
  app_id   text,
  metadata text,
  ts       bigint NOT NULL,
  raw      jsonb NOT NULL,
  UNIQUE (page_id, psid, event, ts)
);`;

/**
 * กลบข้อมูลส่วนบุคคลก่อนเก็บ
 *
 * ⚠️ ทำตามระบบเดิมของทีม (legacy/tools/chat-analysis/chat_pull.php)
 *    "กลบข้อมูลส่วนบุคคลตั้งแต่ก่อนลงฐาน — เบอร์โทร ที่อยู่ เลขบัญชี อีเมล"
 *    คู่มือ 23ADS เก็บดิบ แต่เราไม่ทำตาม เพราะรายงานไม่ต้องใช้เนื้อความแชทเลย
 * ⚠️ ที่อยู่กลบด้วย regex ไม่ได้จริง — ตัดความยาวช่วยลดความเสี่ยงได้บ้างเท่านั้น
 */
export function maskPII(s) {
  if (!s) return s;
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[อีเมล]")
    .replace(/(?:\+66|0)\s?\d[\d\s-]{7,12}\d/g, "[เบอร์]")
    .replace(/\d[\d-]{8,}\d/g, "[เลขยาว]");
}

/**
 * ⚠️ ห้ามเอา maskPII ไปครอบ JSON ทั้งก้อน (เจอจริง 10 ก.ย. 69)
 *    timestamp เป็นเลข 13 หลักจะโดนกลบเป็น [เลขยาว] แล้ว JSON พังทั้งแถว
 *    และ psid ของลูกค้าจริงก็เป็นเลขยาว โดนกลบเมื่อไหร่เธรดพังทั้งระบบ
 */
export function rawForStorage(ev) {
  const c = structuredClone(ev);
  if (c?.message?.text) c.message.text = maskPII(c.message.text);
  return c;
}

const CLOSE_RE = /^\s*\/close\b\s*([\d][\d,]*(?:\.\d{1,2})?)?/i;

/** เช็ก Crmixer ก่อนทุกอย่าง — เป็นข้อความระบบ ไม่ใช่ผู้ตอบ ต้องไม่ปนเข้าสถิติ */
export function classify(isEcho, appId, aiGenerated) {
  if (!isEcho) return "customer";
  if (appId === APP_CRMIXER) return "system";
  if (aiGenerated) return "ai";
  if (appId === APP_PAGE_INBOX) return "human";
  return appId ? "bot" : "unknown";
}

async function handleEvent(c, pageId, ev) {
  const m = ev.message;
  const isEcho = m?.is_echo === true;

  /* ⚠️ ฝั่งที่ไม่ใช่เพจคือลูกค้าเสมอ — อย่าผูกกับ is_echo
     ไม่งั้น event ส่งต่อ (sender = เพจ ไม่มี message) หลุดหายทั้งหมด */
  const sender = ev.sender?.id ?? "";
  const psid = sender && sender !== pageId ? sender : (ev.recipient?.id ?? "");
  if (!psid || psid === pageId) return;

  /* ⚠️ Meta ส่ง timestamp เป็นมิลลิวินาที -- แต่ payload ทดสอบจากแดชบอร์ดส่งเป็น "วินาที"
     (เจอจริง 11 ก.ย. 69: 1527459824 กลายเป็น ค.ศ. 1970 ในฐาน)
     ถ้าไม่กันไว้ แถวพวกนั้นจะหลุดออกจากรายงานทุกฉบับเงียบ ๆ เพราะตัวกรองวันที่ไม่ครอบ
     เลข 1e11 ms = ปี 1973 ส่วนวินาทีจริงจะไม่มีทางเกินค่านี้จนถึงปี 5138 */
  let ts = Number(ev.timestamp) || Date.now();
  if (ts > 0 && ts < 1e11) ts *= 1000;
  const raw = rawForStorage(ev);

  const ref = ev.referral ?? ev.postback?.referral ?? ev.message?.referral;
  if (ref) {
    await c.query(
      `INSERT INTO ${T("referrals")} (page_id,psid,mid,ad_id,ad_title,post_id,source,ref,ts,raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (page_id,psid,mid,ad_id) DO NOTHING`,
      [pageId, psid, m?.mid ?? "", ref.ad_id ?? "", ref.ads_context_data?.ad_title ?? null,
       ref.ads_context_data?.post_id ?? null, ref.source ?? null, ref.ref ?? null, ts, raw]);
  }

  for (const k of ["pass_thread_control", "take_thread_control", "request_thread_control"]) {
    if (ev[k]) {
      await c.query(
        `INSERT INTO ${T("handovers")} (page_id,psid,event,app_id,metadata,ts,raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (page_id,psid,event,ts) DO NOTHING`,
        [pageId, psid, k,
         String(ev[k].new_owner_app_id ?? ev[k].previous_owner_app_id ?? ev[k].requested_owner_app_id ?? ""),
         String(ev[k].metadata ?? ""), ts, raw]);
    }
  }

  if (!m?.mid) return;   // delivery / read — ไม่ใช่ข้อความ

  const appId = isEcho ? String(m.app_id ?? "") : "";
  const aiGen = m.ai_generated === true;
  const actor = classify(isEcho, appId, aiGen);
  const text = String(m.text ?? "");

  /* อ่าน /close ก่อนกลบ PII — ยอดเงินเป็นเลขยาวอาจโดนกลบไปด้วย */
  const cm = isEcho && actor !== "system" ? text.match(CLOSE_RE) : null;

  await c.query(
    `INSERT INTO ${T("messages")}
       (mid,page_id,psid,direction,actor,app_id,ai_generated,metadata,text_masked,has_close,close_amount,ts,raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (mid) DO NOTHING`,
    [m.mid, pageId, psid, isEcho ? "out" : "in", actor, appId || null, aiGen,
     m.metadata ? JSON.stringify(m.metadata) : null,
     maskPII(text).slice(0, 300), !!cm,
     cm?.[1] ? Number(cm[1].replace(/,/g, "")) : null, ts, raw]);
}

/**
 * เก็บทั้ง payload — คืนจำนวน event ที่ประมวลผล
 *
 * ⚠️ ใช้ pool.query ทีละคำสั่ง ไม่จอง client เดี่ยวค้างไว้
 *    เพราะ pooler แบบ transaction mode (Supabase Supavisor / PgBouncer) คืน connection
 *    เข้ากองทุกครั้งที่คำสั่งจบ การจอง client ไว้ยาว ๆ จึงไม่ได้ประโยชน์และเปลืองช่อง
 *    ทุก insert เป็นอิสระต่อกัน (ON CONFLICT DO NOTHING) ไม่ต้องอยู่ transaction เดียวกัน
 */
export async function ingest(payload) {
  await ensureSchema();
  const c = db();
  let n = 0;
  for (const entry of payload.entry ?? []) {
    /* standby = event ที่มาตอนแอปเราไม่ได้ถือสิทธิ์คุย (หลังส่งต่อให้คนแล้ว)
       ไม่อ่านจะขาดช่วง "หลังส่งคืนคน" ซึ่งเป็นช่วงที่รายงานต้องการที่สุด */
    for (const ev of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      try { await handleEvent(c, entry.id, ev); n++; }
      catch (e) { console.error("[event ล้มเหลว]", e.message); }
    }
  }
  return n;
}

export async function stats() {
  await ensureSchema();
  const a = await db().query(`SELECT count(*)::int n, max(ts) last FROM ${T("messages")}`);
  const b = await db().query(`SELECT actor, count(*)::int n FROM ${T("messages")} GROUP BY actor`);
  return {
    ok: true,
    messages: a.rows[0].n,
    last_message_at: a.rows[0].last ? new Date(Number(a.rows[0].last)).toISOString() : null,
    by_actor: Object.fromEntries(b.rows.map((r) => [r.actor, r.n])),
  };
}

export async function exportRows(since, limit) {
  await ensureSchema();
  const q = (t) => db().query(
    `SELECT seq AS cursor, * FROM ${T(t)} WHERE seq > $1 ORDER BY seq LIMIT $2`, [since, limit]);
  const [m, r, h] = await Promise.all([q("messages"), q("referrals"), q("handovers")]);
  return { messages: m.rows, referrals: r.rows, handovers: h.rows };
}

/**
 * ลบของเก่าในฐานพัก เฉพาะที่ยืนยันแล้วว่าเข้า mixhub เรียบร้อย
 *
 * ทำไมต้องมี: ฟรีเทียร์ของ Supabase ~500 MB ทุกแถวเก็บ raw payload ทั้งก้อน
 *             ไม่ลบของเก่าออกเลย เดี๋ยวก็เต็มแล้ว insert ใหม่ไม่ได้ = ข้อมูลหายจริง
 *
 * ⚠️ ฐานนี้เป็น "ที่พัก" ตัวจริงอยู่ที่ mixhub -- แต่ที่พักไม่ได้แปลว่าลบมั่วได้
 *    ต้องครบ 2 เงื่อนไขพร้อมกันเท่านั้น:
 *      1. seq <= ตำแหน่งที่ mixhub "ยืนยันว่าเก็บลงฐานแล้ว"
 *         (ไม่ใช่ตำแหน่งที่ /export ส่งออกไป -- ส่งไปแล้วฝั่งโน้นอาจ commit ไม่สำเร็จ)
 *      2. เก่ากว่า keepDays วัน -- กันเผื่อ mixhub ต้องดึงซ้ำ
 *    ขาดข้อใดข้อหนึ่ง = ข้อมูลหายถาวร เพราะ Meta ไม่ให้ดึงแชทย้อนหลัง
 *
 * ⚠️ cursor เป็น 0 หรือไม่ได้ส่งมา แปลว่า "ยังไม่ยืนยันอะไรเลย" ต้องไม่ลบอะไรทั้งนั้น
 *    ห้ามตีความว่าลบได้หมด -- พลาดตรงนี้ทีเดียวคือเกลี้ยงทั้งตาราง
 */
export async function pruneRows(cursors = {}, keepDays = 7) {
  await ensureSchema();
  // keepDays ที่ใช้ไม่ได้ (ไม่ส่งมา / 0 / ติดลบ / ไม่ใช่ตัวเลข) -> ถอยไปใช้ค่าตั้งต้น 7
  // ห้ามตีความ 0 ว่า "ไม่ต้องเก็บเลย" -- คนพิมพ์ 0 มักหมายถึง "ไม่ได้ตั้ง" ไม่ใช่ "ลบให้หมด"
  const n = Number(keepDays);
  const days = Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 7;
  const cutoff = Date.now() - days * 86400000;
  const out = { kept_days: days, cutoff_ts: cutoff, deleted: {} };
  for (const t of ["messages", "referrals", "handovers"]) {
    const c = Number(cursors[t] || 0);
    if (!Number.isSafeInteger(c) || c <= 0) { out.deleted[t] = 0; continue; }
    const r = await db().query(
      `DELETE FROM ${T(t)} WHERE seq <= $1 AND ts < $2`, [c, cutoff]);
    out.deleted[t] = r.rowCount;
  }
  return out;
}
