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
 *   CRON_SECRET         กันคนนอกยิง
 *   GRAPH_VERSION       เช่น v21.0 -- ตรวจเวอร์ชันล่าสุดก่อนตั้ง
 *   CAPI_TEST_CODE      (ไม่บังคับ) ใส่ตอนทดสอบ จะเข้าแท็บ Test Events ไม่กระทบยอดจริง
 *   HOLD_DAYS           (ไม่บังคับ) หน่วงกี่วันก่อนยิง ค่าตั้งต้น 0 = ยิงทันที
 *
 * ⚠️ ปลุกจากเครื่องเรา ไม่ใช่ cron ของ Vercel (เจ้าของเคาะ 28 ต.ค. 69)
 *    Hobby ให้ cron วันละครั้งเท่านั้น -- หน่วง 0 วันแต่รอ cron อีก 24 ชม. ก็ไม่ได้ทันทีจริง
 *    Task MixhubAdsPull บนเครื่อง server รันทุก 30 นาทีอยู่แล้ว ให้มันยิง
 *      curl -s "https://<host>/api/capi?key=$CRON_SECRET"
 */

import { db, ensureSchema } from "../lib/store.js";

const SCHEMA_NAME = (process.env.DB_SCHEMA || "chatlog").trim();
const T = (n) => `${SCHEMA_NAME}.${n}`;

const DATASET_CHAT_ORDERS = "1227750919543299";   // OSUKA Chat Orders -- ปลายทางของเรา
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

  /* กันคนนอก -- Vercel cron ส่ง Authorization: Bearer $CRON_SECRET มาให้ */
  const secret = process.env.CRON_SECRET || "";
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")
             || u.searchParams.get("key") || "";
  if (!secret || given !== secret) return json(401, { ok: false, error: "unauthorized" });

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

    const events = rows.map(buildEvent);

    if (dry)
      return json(200, { ok: true, expired: exp.rowCount, due: rows.length, dry: true, events });

    const dataset = process.env.CAPI_DATASET_ID || DATASET_CHAT_ORDERS;
    const token   = process.env.CAPI_TOKEN;
    const ver     = process.env.GRAPH_VERSION || "v21.0";
    if (!token) return json(500, { ok: false, error: "ไม่มี CAPI_TOKEN" });
    /* กันพลาดชนิดที่แก้คืนไม่ได้ -- ยิงเข้า Pixel เว็บแล้วลบ event ออกไม่ได้ */
    if (dataset === DATASET_WEB_PIXEL)
      return json(400, { ok: false, error: "ห้ามยิงเข้า Pixel ของเว็บ (3634784846565263)" });

    const payload = { data: events, access_token: token };
    if (process.env.CAPI_TEST_CODE) payload.test_event_code = process.env.CAPI_TEST_CODE;

    const r = await fetch(`https://graph.facebook.com/${ver}/${dataset}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));

    /* ⚠️ Meta reject ทั้ง batch ถ้ามี event เดียวผิด -- ไม่สำเร็จห้าม mark sent */
    if (!r.ok) return json(502, { ok: false, expired: exp.rowCount, due: rows.length, meta: body });

    const ids = rows.map((x) => x.seq);
    await c.query(
      `UPDATE ${T("order_summary")}
          SET state='sent', sent_at=$2, meta_event_id='sum-'||mid||'-'||ordinal
        WHERE seq = ANY($1::bigint[])`,
      [ids, now]);

    return json(200, {
      ok: true, expired: exp.rowCount, sent: rows.length,
      test_mode: !!process.env.CAPI_TEST_CODE, meta: body,
    });
  } catch (e) {
    console.error("[capi ล้มเหลว]", e);
    return json(500, { ok: false, error: e.message });
  }
}
