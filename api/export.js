import { exportRows } from "../lib/store.js";

/** ให้ mixhub ดึงข้อมูลไปวิเคราะห์ — ต้องมีโทเคน เพราะ URL เปิดสาธารณะ */
export default async function handler(req, res) {
  const u = new URL(req.url, "http://x");
  if (u.searchParams.get("token") !== process.env.EXPORT_TOKEN) {
    res.statusCode = 401; return res.end("unauthorized");
  }
  try {
    const since = Number(u.searchParams.get("since") || 0);
    const limit = Math.min(Number(u.searchParams.get("limit") || 1000), 5000);
    const out = await exportRows(since, limit);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
}
