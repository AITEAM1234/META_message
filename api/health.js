import { stats } from "../lib/store.js";

/** ดูว่าต่อฐานได้ไหมและเก็บได้กี่แถวแล้ว — ใช้เช็กหลัง deploy ว่าติดจริง */
export default async function handler(req, res) {
  try {
    const s = await stats();
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(JSON.stringify(s, null, 2));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e.message }, null, 2));
  }
}
