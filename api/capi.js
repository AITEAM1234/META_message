/**
 * /api/capi -- ตัวส่ง order_summary เข้า Meta Conversions API
 *
 * ⚠️ ห้ามเอาไปเรียกในตัว webhook
 *    Vercel หยุดฟังก์ชันทันทีที่ response จบ (คอมเมนต์ใน api/webhook.js เขียนไว้แล้ว)
 *    และ Meta ให้เวลา webhook ราว 20 วินาที ถ้าใส่ HTTP call ไป Meta ในนั้น
 *    = ทุกข้อความที่เข้ามาช้าลง และเสี่ยง timeout ทั้งก้อน
 *    ตัวนี้ต้องเป็น route แยก เรียกด้วย cron หรือจากข้างนอก
 *
 * ⚠️ ต้องลงทะเบียนใน routes ของ server.js ด้วย
 *    Vercel ใช้ server.js เป็น entrypoint -- วางไฟล์ใน api/ อย่างเดียวได้ 404
 *    (เคยพลาดมาแล้วตอนเพิ่ม api/backfill.js)
 *
 * ⚠️ URL นี้เปิดสาธารณะ ต้องมี CRON_SECRET ไม่งั้นใครก็สั่งยิง event ปลอมได้
 *
 * ปลายทาง: dataset "OSUKA Chat Orders" = 1227750919543299
 *   บัญชีโฆษณา OSUKA Sale Ads Project 01 (1787571085289147)
 *   ธุรกิจ Imax power tools (331188017355695)
 *   เดิมชื่อ "CRMixer - OSUKA" -- เปลี่ยนชื่อแล้ว ID ไม่เปลี่ยน
 *
 * ⚠️ ห้ามยิงเข้า Pixel Osukapowertool.com (3634784846565263)
 *    ตัวนั้นรับจากเว็บอยู่แล้ว 4.3 แสน event/28 วัน (ซื้อ 183)
 *    ปนเข้าไป = แยกไม่ออกว่ายอดไหนมาจากเว็บ ยอดไหนมาจากแชท และเทียบ drift ไม่ได้
 *
 * ENV ที่ต้องมี
 *   CAPI_DATASET_ID     ไม่ใส่ = ใช้ 1227750919543299 (OSUKA Chat Orders)
 *   CAPI_TOKEN          system user token ที่มีสิทธิ์ page_events
 *   CRON_SECRET         กันคนนอก (cron ของ Vercel แนบเป็น Bearer ให้เอง)
 *   EXPORT_TOKEN        กุญแจสำรองไว้ยิงมือ `?token=` -- CRON_SECRET อ่านกลับไม่ได้ยิง
 *   GRAPH_VERSION       เช่น v21.0 -- ตรวจเวอร์ชันล่าสุดก่อนตั้ง
 *   CAPI_TEST_CODE      (ไม่บังคับ) ใส่ตอนทดสอบ จะเข้าแท็บ Test Events ไม่กระทบยอดจริง
 *   HOLD_DAYS           (ไม่บังคับ) หน่วงกี่วันก่อนยิง ค่าตั้งต้น 0 = ยิงทันที
 *
 * ⚠️ ปลุกจากเครื่องเรา ไม่ใช่ cron ของ Vercel (เจ้าของเคาะ 28 ต.ค. 69)
 *    Hobby ให้ cron วันละครั้งเท่านั้น -- หน่วง 0 วันแต่รอ cron อีก 24 ชม. ก็ไม่ได้ทันทีจริง
 *    Task MixhubAdsPull บนเครื่อง server รันทุก 30 นาทีอยู่แล้ว ให้มันยิง
 *      curl -s "https://<host>/api/capi?token=$EXPORT_TOKEN"
 */

import { db, ensureSchema } from "../lib/store.js";

const SCHEMA_NAME = (process.env.DB_SCHEMA || "chatlog").trim();
const T = (n) => `${SCHEMA_NAME}.${n}`;

/* ⚠️ OSUKA Chat Orders (1227750919543299) ใช้เป็นปลายทางไม่ได้ -- ไม่มีเพจผูก Meta ตีกลับทุกใบ
      เก็บเลขไว้เป็นประวัติเท่านั้น ปลายทางจริงดูที่ datasetOf() */
const DATASET_WEB_PIXEL   = "3634784846565263";   // Pixel Osukapowertool.com -- ห้ามแตะ

const DAY = 86400000;
const HOLD_DAYS = Math.max(0, Number(process.env.HOLD_DAYS ?? 0) || 0);

/* ⚠️ Meta ไม่รับ event_time เก่ากว่า 7 วัน และถ้ามีอันเดียวเกิน
      "reject ทั้ง request และไม่ประมวลผล event ใดเลย"
      เลยตัดที่ 6 วัน เหลือกันชน 1 วัน แถวที่เกินตีเป็น expired ห้ามส่ง */
const MAX_AGE_DAYS = 6;

function buildEvent(row) {
  const ud = {
    page_id: row.page_id,                 // ⚠️ ห้าม hash
    page_scoped_user_id: row.psid,        // ⚠️ ห้าม hash
  };
  if (row.phone_sha256)     ud.ph = [row.phone_sha256];
  if (row.cust_name_sha256) ud.fn = [row.cust_name_sha256];
  if (row.zipcode_sha256)   ud.zp = [row.zipcode_sha256];

  const items = Array.isArray(row.items) ? row.items : [];
  const ev = {
    event_name: "Purchase",
    event_time: Math.floor(Number(row.ts) / 1000),   // วินาที ไม่ใช่มิลลิวินาที
    event_id: `sum-${row.mid}-${row.ordinal}`,       // กันยิงซ้ำ
    action_source: "business_messaging",
    messaging_channel: "messenger",
    user_data: ud,
    custom_data: {
      currency: "THB",
      value: Number(row.total),
      contents: items
        .filter((i) => i.sku)
        .map((i) => ({ id: i.sku, quantity: Number(i.qty) || 1 })),
    },
  };
  return ev;
}

export default async function handler(req, res) {
  const u = new URL(req.url, "http://x");
  const json = (code, body) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body, null, 1));
  };

  /* กันคนนอก -- รับ 2 ทางเหมือน /api/backfill
       cron  : Authorization: Bearer $CRON_SECRET (Vercel แนบให้เอง)
       คนยิง : ?token=$EXPORT_TOKEN
     ⚠️ ต้องมีทางที่สอง -- CRON_SECRET บน Vercel ตั้งเป็นชนิด sensitive = เขียนอย่างเดียว
        อ่านกลับไม่ได้แม้แต่เจ้าของ ค่าที่สุ่มไว้ 22 ก.ย. 69 หายไปแล้ว (ยืนยัน 29 ต.ค. 69)
        ไม่ได้ลดชั้นความปลอดภัย -- EXPORT_TOKEN เปิด /api/export (แชททั้งหมด) + /api/backfill อยู่แล้ว */
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const cronOk = process.env.CRON_SECRET
              && (bearer === process.env.CRON_SECRET || u.searchParams.get("key") === process.env.CRON_SECRET);
  const manOk  = process.env.EXPORT_TOKEN && u.searchParams.get("token") === process.env.EXPORT_TOKEN;
  if (!cronOk && !manOk) return json(401, { ok: false, error: "unauthorized" });

  const dry = u.searchParams.get("dry") === "1";
  const now = Date.now();

  try {
    await ensureSchema();
    const c = db();

    /* 1) เลยกำหนด 7 วันแล้ว -> expired ห้ามส่ง ไม่งั้น Meta reject ทั้ง batch */
    const exp = await c.query(
      `UPDATE ${T("order_summary")} SET state='expired'
        WHERE state='held' AND ts < $1 RETURNING seq`,
      [now - MAX_AGE_DAYS * DAY]);

    /* 2) ถึงคิวยิง */
    const { rows } = await c.query(
      `SELECT * FROM ${T("order_summary")}
        WHERE state='held' AND status='ok'
          AND ts <= $1 AND ts >= $2
        ORDER BY ts LIMIT 500`,
      [now - HOLD_DAYS * DAY, now - MAX_AGE_DAYS * DAY]);

    if (!rows.length)
      return json(200, { ok: true, expired: exp.rowCount, due: 0, sent: 0, dry });

    const token = process.env.CAPI_TOKEN;
    const ver   = process.env.GRAPH_VERSION || "v21.0";

    /* ⚠️ ปลายทางเป็น dataset "ของเพจนั้น" ไม่ใช่ dataset รวมตัวเดียว (ตรวจจริง 29 ต.ค. 69)
       Meta ตีกลับ "Messaging event no Page associated to dataset" ถ้ายิงเข้า dataset ที่ไม่มีเพจผูก
       และหน้าตั้งค่า dataset ไม่มีช่องให้ผูกเพจ -- Meta สร้าง dataset ให้เพจเองตอนเพจเริ่มมี CTM
       จึงต้องถาม Meta ตอนรันว่าเพจนี้ใช้ dataset ไหน ไม่ฮาร์ดโค้ด เพจใหม่จะได้ทำงานเอง */
    const dsCache = new Map();
    const datasetOf = async (pageId) => {
      if (process.env.CAPI_DATASET_ID) return process.env.CAPI_DATASET_ID;   // บังคับทับได้
      if (dsCache.has(pageId)) return dsCache.get(pageId);
      let id = null;
      try {
        const u = `https://graph.facebook.com/${ver}/${pageId}/dataset?access_token=${encodeURIComponent(token)}`;
        const j = await fetch(u).then((x) => x.json()).catch(() => ({}));
        id = j?.data?.[0]?.id ?? null;
      } catch { id = null; }
      dsCache.set(pageId, id);
      return id;
    };

    /* จัดกลุ่ม event ตาม dataset ปลายทาง */
    const byDs = new Map();      // dataset -> {events, seqs}
    const skipped = [];
    for (const row of rows) {
      const ds = await datasetOf(row.page_id);
      if (!ds)                      { skipped.push({ seq: row.seq, page_id: row.page_id, why: "เพจนี้ยังไม่มี dataset" }); continue; }
      /* กันพลาดชนิดที่แก้คืนไม่ได้ -- ยิงเข้า Pixel เว็บแล้วลบ event ออกไม่ได้ */
      if (ds === DATASET_WEB_PIXEL) { skipped.push({ seq: row.seq, page_id: row.page_id, why: "เพจนี้ชี้ไป Pixel ของเว็บ -- ไม่ยิง" }); continue; }
      if (!byDs.has(ds)) byDs.set(ds, { events: [], seqs: [] });
      const g = byDs.get(ds);
      g.events.push(buildEvent(row));
      g.seqs.push(row.seq);
    }

    if (dry) {
      return json(200, { ok: true, expired: exp.rowCount, due: rows.length, dry: true, skipped,
        plan: [...byDs].map(([ds, g]) => ({ dataset: ds, n: g.events.length, events: g.events })) });
    }
    if (!token) return json(500, { ok: false, error: "ไม่มี CAPI_TOKEN" });
    if (!byDs.size) return json(200, { ok: true, expired: exp.rowCount, due: rows.length, sent: 0, skipped });

    /* ⚠️ Meta reject ทั้ง batch ถ้ามี event เดียวผิด -- ยิงแยก dataset และ mark sent เฉพาะกลุ่มที่ผ่าน */
    const sentSeqs = [], results = [];
    for (const [ds, g] of byDs) {
      const payload = { data: g.events, access_token: token };
      if (process.env.CAPI_TEST_CODE) payload.test_event_code = process.env.CAPI_TEST_CODE;
      const r = await fetch(`https://graph.facebook.com/${ver}/${ds}/events`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      results.push({ dataset: ds, n: g.events.length, ok: r.ok, meta: body });
      if (r.ok) sentSeqs.push(...g.seqs);
    }
    if (!sentSeqs.length)
      return json(502, { ok: false, expired: exp.rowCount, due: rows.length, skipped, results });

    const ids = sentSeqs;
    await c.query(
      `UPDATE ${T("order_summary")}
          SET state='sent', sent_at=$2, meta_event_id='sum-'||mid||'-'||ordinal
        WHERE seq = ANY($1::bigint[])`,
      [ids, now]);

    return json(200, {
      ok: true, expired: exp.rowCount, due: rows.length, sent: sentSeqs.length,
      skipped, results, test_mode: !!process.env.CAPI_TEST_CODE,
    });
  } catch (e) {
    console.error("[capi ล้มเหลว]", e);
    return json(500, { ok: false, error: e.message });
  }
}
