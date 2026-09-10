/**
 * ตัวรันในเครื่อง — ใช้ทดสอบก่อน deploy เท่านั้น
 *
 * ⚠️ บน Vercel ไฟล์นี้ไม่ถูกใช้เลย Vercel เรียก api/*.js โดยตรง
 *    (ของเดิมที่เปิดพอร์ตค้างด้วย listen() คือสาเหตุที่ deploy แล้วขึ้น
 *     FUNCTION_INVOCATION_FAILED -- serverless ไม่ให้เปิดพอร์ตค้าง)
 *
 * ใช้:  node --env-file=env server.js      แล้วเปิด http://127.0.0.1:3000/api/health
 */

import http from "node:http";
import webhook from "./api/webhook.js";
import health from "./api/health.js";
import exportH from "./api/export.js";
import prune from "./api/prune.js";

const routes = { "/api/webhook": webhook, "/api/health": health,
                 "/api/export": exportH, "/api/prune": prune };
const PORT = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const h = routes[p];
  if (!h) { res.statusCode = 404; return res.end("not found"); }
  try { await h(req, res); }
  catch (e) { console.error(e); res.statusCode = 500; res.end("error"); }
}).listen(PORT, () => console.log(`ทดสอบในเครื่องที่ http://127.0.0.1:${PORT}/api/health`));
