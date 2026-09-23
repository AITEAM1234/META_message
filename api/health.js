import { stats } from "../lib/store.js";

/** ดูว่าต่อฐานได้ไหมและเก็บได้กี่แถวแล้ว — ใช้เช็กหลัง deploy ว่าติดจริง */
export default async function handler(req, res) {
  try {
    const s = await stats();
    /* ป้ายบอกว่าโค้ดชุดไหนกำลังรันอยู่ -- 23 ก.ย. 69 เคยงงว่า push แล้วแต่ของใหม่ไม่ขึ้น
       (deployment เก่ายังเสิร์ฟอยู่) มีเลข commit ให้เทียบจะรู้ทันที */
    s.commit = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7);
    s.endpoints = ["/api/webhook", "/api/export", "/api/prune", "/api/health", "/api/backfill"];
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(JSON.stringify(s, null, 2));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e.message }, null, 2));
  }
}
