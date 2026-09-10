import { pruneRows } from "../lib/store.js";

/**
 * ลบของเก่าที่ mixhub ยืนยันแล้วว่าเก็บเรียบร้อย
 *
 * ใครเรียก: sync_to_mixhub.py บนเครื่อง mixhub เรียกให้เอง หลัง commit สำเร็จ
 *           (ฝั่งนี้ไม่รู้ว่าอะไรเข้า mixhub แล้วบ้าง จึงต้องให้ฝั่งโน้นเป็นคนบอก)
 *
 * ⚠️ เป็น POST ไม่ใช่ GET -- GET ต้องไม่ทำให้ข้อมูลหาย
 *    ตัวไล่เก็บลิงก์/ตัว preview ยิง GET เองได้ ถ้าทำเป็น GET แล้วโดนยิงมั่ว = ข้อมูลหาย
 *
 * ⚠️ ใช้โทเคนตัวเดียวกับ /export -- URL เปิดสาธารณะ ใครก็ยิงได้ถ้าไม่กั้น
 */
export const config = { api: { bodyParser: false } };

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const json = (code, body) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };

  const u = new URL(req.url, "http://x");
  if (u.searchParams.get("token") !== process.env.EXPORT_TOKEN) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "ต้องเป็น POST เท่านั้น" });
  }

  const body = await readJson(req);
  if (body === null) return json(400, { ok: false, error: "bad json" });

  try {
    const out = await pruneRows(body.cursors || {}, body.keep_days);
    return json(200, { ok: true, ...out });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
}
