/**
 * ปลายทางให้ Vercel Cron เรียก -- เติมแชทที่ webhook ตกหล่นจาก Meta Graph (23 ก.ย. 69)
 *
 * เรียกยังไง
 *   Vercel Cron  ตั้งใน vercel.json แล้ว Vercel จะแนบ Authorization: Bearer $CRON_SECRET มาเอง
 *   มือ          GET /api/backfill?token=<EXPORT_TOKEN>[&hours=6][&dry=1]
 *
 * ⚠️ ต้องมี env: META_ACCESS_TOKEN (user token ที่เห็นเพจทั้งหมด) · DATABASE_URL · CRON_SECRET หรือ EXPORT_TOKEN
 * ⚠️ อ่าน Meta อย่างเดียว ไม่ส่งข้อความ ไม่แก้อะไรบนเพจ
 */

import { backfill } from "../lib/backfill.js";

export default async function handler(req, res) {
  const u = new URL(req.url, "http://x");

  /* ⚠️ ปลายทางนี้ยิงข้อมูลเข้าฐานได้ ต้องมีกุญแจเสมอ ไม่งั้นใครก็สั่งให้เราไปดูด Graph รัว ๆ ได้ */
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const qs = u.searchParams.get("token") || "";
  const cronOk = process.env.CRON_SECRET && bearer === process.env.CRON_SECRET;
  const manOk = process.env.EXPORT_TOKEN && qs === process.env.EXPORT_TOKEN;
  if (!cronOk && !manOk) {
    res.statusCode = 401;
    return res.end("unauthorized");
  }

  const out = await backfill({
    lookbackH: Math.min(24, Math.max(1, Number(u.searchParams.get("hours") || 6))),
    dry: u.searchParams.get("dry") === "1",
  });

  res.statusCode = out.ok ? 200 : 500;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(out, null, 2));
}
