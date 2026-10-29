/**
 * /api/capi -- ตาข่ายรับของตัวส่ง Meta CAPI
 *
 * ⚠️ นี่ไม่ใช่ทางหลักแล้ว (29 ต.ค. 69 เจ้าของ "มันควรเข้าแบบทางเดียว
 *    เพราะเรามี webhook แล้ว ได้จาก keyword ก็ส่งมาเลยทันที")
 *    ทางหลัก = webhook ส่งเองทันทีที่แกะแพทเทินได้ (lib/store.js -> sendSeqs)
 *    ตัวนี้เหลือไว้เก็บใบที่ทางแรกพลาด: Meta ล่ม · timeout · เพจยังไม่ได้ผูก dataset
 *    ตรรกะ/พรอมป์การส่งอยู่ `lib/capi_send.js` ที่เดียว -- ห้ามเขียนตัวส่งซ้ำที่นี่
 *
 * ⚠️ ต้องลงทะเบียนใน routes ของ server.js ด้วย
 *    Vercel ใช้ server.js เป็น entrypoint -- วางไฟล์ใน api/ อย่างเดียวได้ 404
 *
 * ⚠️ URL นี้เปิดสาธารณะ ต้องมีกุญแจ ไม่งั้นใครก็สั่งยิง event ปลอมได้
 *
 * ENV ที่ต้องมี
 *   CAPI_TOKEN          system user token ที่มีสิทธิ์ page_events
 *   CRON_SECRET         กันคนนอก (cron ของ Vercel แนบเป็น Bearer ให้เอง)
 *   EXPORT_TOKEN        กุญแจสำรองไว้ยิงมือ `?token=` -- CRON_SECRET อ่านกลับไม่ได้
 *   GRAPH_VERSION       เช่น v21.0 -- ตรวจเวอร์ชันล่าสุดก่อนตั้ง
 *   CAPI_TEST_CODE      (ไม่บังคับ) ใส่ตอนทดสอบ จะเข้าแท็บ Test Events ไม่กระทบยอดจริง
 *   HOLD_DAYS           (ไม่บังคับ) หน่วงกี่วันก่อนยิง ค่าตั้งต้น 0 = ยิงทันที
 *
 * ⚠️ ปลุกจากเครื่องเรา ไม่ใช่ cron ของ Vercel (เจ้าของเคาะ 28 ต.ค. 69)
 *    Hobby ให้ cron วันละครั้งเท่านั้น ไม่ทันเพดาน 7 วันของ Meta ถ้าคิวยาว
 *    ต่อท้าย Task MixhubAdsPull (ทุก 30 นาที) ไว้แล้วที่
 *      legacy/tools/ads-dash/run_pull.cmd ในโปรเจกต์ mixhub-laravel
 *      curl -s "https://<host>/api/capi?token=$EXPORT_TOKEN"
 */

import { db, ensureSchema } from "../lib/store.js";
import { sendDue } from "../lib/capi_send.js";

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

  try {
    await ensureSchema();
    const out = await sendDue(db(), { dry });
    if (!dry && out.due > 0 && out.sent === 0 && out.results?.length)
      return json(502, { ok: false, ...out });
    return json(200, { ok: true, ...out, test_mode: !!process.env.CAPI_TEST_CODE });
  } catch (e) {
    console.error("[capi ล้มเหลว]", e);
    return json(500, { ok: false, error: e.message });
  }
}
