/**
 * ทดสอบตัวเติมย้อนหลังในเครื่องก่อนขึ้น Vercel (23 ก.ย. 69)
 *   node test_backfill.mjs --dry     ดูว่าจะเก็บห้องไหนบ้าง ไม่เขียนฐาน
 *   node test_backfill.mjs           เขียนจริง (ซ้ำกับของเดิมไม่ได้ เพราะกันด้วย mid)
 *
 * อ่าน env จากไฟล์ env ของโปรเจกต์นี้ + META_ACCESS_TOKEN จาก legacy/.env ของ Mixhub
 * (บน Vercel ต้องไปตั้ง META_ACCESS_TOKEN ใน Project Settings เอง)
 */
import fs from "node:fs";

function load(file, keys = null) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (keys && !keys.includes(k)) continue;
    if (!process.env[k]) process.env[k] = v;
  }
}

load("env");
load("C:/Users/Tada.p/server/www/app/legacy/.env", ["META_ACCESS_TOKEN"]);

const { backfill } = await import("./lib/backfill.js");
const out = await backfill({ dry: process.argv.includes("--dry"), lookbackH: 6, budgetMs: 25000 });
console.log(JSON.stringify(out, null, 2));
process.exit(0);
