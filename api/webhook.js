import crypto from "node:crypto";
import { ingest, saveRaw } from "../lib/store.js";

/**
 * ⚠️ ต้องปิด body parser ของ Vercel
 *    ลายเซ็นของ Meta คำนวณจาก "ไบต์ดิบ" ของ body ถ้าปล่อยให้ Vercel แปลงเป็น object
 *    แล้วเรา JSON.stringify กลับ ไบต์จะไม่ตรงเป๊ะ (ลำดับคีย์/ช่องว่าง/ยูนิโค้ด)
 *    → ลายเซ็นไม่ผ่านทุกใบ ทั้งที่ของจริงถูกต้อง
 */
export const config = { api: { bodyParser: false } };

/** อ่านไบต์ดิบ — เผื่อบางรันไทม์แปลง body ให้แล้ว จะได้ไม่ค้างรออ่านสตรีมเปล่า */
async function rawBody(req) {
  if (req.readableEnded || req.bodyUsed) {
    if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
    if (Buffer.isBuffer(req.body)) return req.body;
    if (req.body) return Buffer.from(JSON.stringify(req.body), "utf8");
    return Buffer.alloc(0);
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  // --- Meta มายืนยัน URL ตอนกด Verify ใน App Dashboard ---
  if (req.method === "GET") {
    const u = new URL(req.url, "http://x");
    const ok = u.searchParams.get("hub.mode") === "subscribe" &&
               u.searchParams.get("hub.verify_token") === process.env.VERIFY_TOKEN;
    res.statusCode = ok ? 200 : 403;
    return res.end(ok ? u.searchParams.get("hub.challenge") : "forbidden");
  }

  if (req.method !== "POST") { res.statusCode = 405; return res.end("method not allowed"); }

  const body = await rawBody(req);

  /* ตรวจลายเซ็น — URL นี้เปิดสาธารณะ ใครก็ยิงข้อมูลปลอมเข้ามาได้ถ้าไม่ตรวจ */
  const secret = process.env.APP_SECRET || "";
  const got = String(req.headers["x-hub-signature-256"] || "");
  const want = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  if (got.length !== want.length ||
      !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    console.error("[ลายเซ็นไม่ผ่าน] ได้", got.slice(0, 20), "ควรเป็น", want.slice(0, 20));
    res.statusCode = 401;
    return res.end("bad signature");
  }

  let payload;
  try { payload = JSON.parse(body.toString("utf8")); }
  catch { res.statusCode = 400; return res.end("bad json"); }

  /* ⚠️ serverless ต่างจากเซิร์ฟเวอร์ปกติ — ตอบ 200 ก่อนแล้วค่อยทำงานต่อ "ไม่ได้"
     เพราะ Vercel หยุดฟังก์ชันทันทีที่ response จบ งานที่ค้างจะถูกตัดกลางคัน
     จึงต้องเขียนลงฐานให้เสร็จก่อนแล้วค่อยตอบ — Meta ให้เวลาราว 20 วินาที พอ */

  /* 1) เก็บดิบทั้งก้อนก่อนเสมอ -- ทุก object ทุก event ไม่คัดทิ้ง (17 ก.ย. 69)
        นี่คือที่เก็บตัวจริง ล้มเมื่อไหร่ต้องตอบ 500 ให้ Meta ยิงซ้ำ ไม่งั้นหายถาวร
        ยิงซ้ำก้อนเดิมไม่เก็บสองแถว เพราะกันซ้ำด้วย sha ของไบต์ดิบ */
  try {
    await saveRaw(body, payload);
  } catch (e) {
    console.error("[เก็บข้อมูลดิบไม่สำเร็จ]", e.message);
    res.statusCode = 500;
    return res.end("store failed");
  }

  if (payload.object !== "page") { res.statusCode = 200; return res.end("raw only"); }

  /* 2) แยกลงตารางสำเร็จรูป -- ไว้ให้ /api/health นับเร็ว ๆ เท่านั้น
        ⚠️ แยกพลาดตอบ 200 ได้ เพราะก้อนดิบลงฐานแล้ว Mixhub แยกเองจาก raw_events ได้
           ตอบ 500 ตรงนี้ Meta จะยิงก้อนเดิมซ้ำไม่จบ ทั้งที่ข้อมูลไม่ได้หาย */
  try {
    const n = await ingest(payload);
    res.statusCode = 200;
    return res.end(`OK ${n}`);
  } catch (e) {
    console.error("[แยกข้อมูลไม่สำเร็จ ก้อนดิบเก็บแล้ว]", e.message);
    res.statusCode = 200;
    return res.end("raw saved");
  }
}
