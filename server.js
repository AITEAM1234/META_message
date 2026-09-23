/**
 * ตัวรันในเครื่อง — ใช้ทดสอบก่อน deploy เท่านั้น
 *
 * ⚠️ **แก้ความเข้าใจผิด 23 ก.ย. 69: บน Vercel ไฟล์นี้ถูกใช้จริง**
 *    Build log เขียนว่า "Build complete -- Using server.js as the root entrypoint"
 *    แปลว่า Vercel รันไฟล์นี้เป็นเซิร์ฟเวอร์ ไม่ได้เรียก api/*.js เป็นฟังก์ชันแยกตามชื่อไฟล์
 *    => **เพิ่มไฟล์ใน api/ อย่างเดียวไม่พอ ต้องลงทะเบียนในตาราง routes ข้างล่างด้วย**
 *    (ของจริง: เพิ่ม api/backfill.js แล้ว deploy ไป ยิงเข้าไปได้ 404 "not found" จากบรรทัดในไฟล์นี้เอง)
 *
 * ใช้:  node --env-file=env server.js      แล้วเปิด http://127.0.0.1:3000/api/health
 */

import http from "node:http";
import webhook from "./api/webhook.js";
import health from "./api/health.js";
import exportH from "./api/export.js";
import prune from "./api/prune.js";
import backfill from "./api/backfill.js";

const routes = { "/api/webhook": webhook, "/api/health": health,
                 "/api/export": exportH, "/api/prune": prune,
                 "/api/backfill": backfill };
const PORT = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const h = routes[p];
  if (!h) { res.statusCode = 404; return res.end("not found"); }
  try { await h(req, res); }
  catch (e) { console.error(e); res.statusCode = 500; res.end("error"); }
}).listen(PORT, () => console.log(`ทดสอบในเครื่องที่ http://127.0.0.1:${PORT}/api/health`));
