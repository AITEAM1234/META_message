/**
 * ทดสอบตัวลบของเก่า — ต้องต่อ Postgres จริง
 *
 * ใช้:  set DATABASE_URL=postgresql://...
 *       set DB_SCHEMA=chatlog_test          <- อย่าชี้ schema จริง เดี๋ยวลบของจริง
 *       node test_prune.mjs
 *
 * ⚠️ สคริปต์นี้ลบ schema ทิ้งตอนจบ จึงต้องยืนยันว่าไม่ใช่ schema จริงก่อนเริ่ม
 */
const SCHEMA = (process.env.DB_SCHEMA || "").trim();
if (!SCHEMA.endsWith("_test")) {
  console.error("ปฏิเสธ: DB_SCHEMA ต้องลงท้ายด้วย _test (กันเผลอลบ schema จริง)");
  process.exit(1);
}

const { db, ensureSchema, pruneRows } = await import("./lib/store.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ผ่าน  " : "  ตก    ") + name + (extra ? "   " + extra : ""));
  if (!cond) fail++;
};

const DAY = 86400000;
const now = Date.now();

async function reset() {
  await db().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  // ensureSchema จำไว้ว่าสร้างแล้ว ต้องสร้างใหม่ตรง ๆ
  const { SCHEMA: DDL } = await import("./lib/store.js");
  await db().query(DDL);
}

/** ใส่ข้อความ 1 แถว คืน seq */
async function addMsg(mid, ageDays) {
  const r = await db().query(
    `INSERT INTO ${SCHEMA}.messages (mid,page_id,psid,direction,actor,ts,raw)
     VALUES ($1,'P','U','in','customer',$2,'{}') RETURNING seq`,
    [mid, now - ageDays * DAY]
  );
  return Number(r.rows[0].seq);
}

const count = async (t) =>
  Number((await db().query(`SELECT count(*)::int n FROM ${SCHEMA}.${t}`)).rows[0].n);

await ensureSchema();
await reset();

console.log("\n-- เตรียมข้อมูล: 4 แถว อายุ 30/20/3/0 วัน --");
const s30 = await addMsg("m30", 30);
const s20 = await addMsg("m20", 20);
const s3 = await addMsg("m3", 3);
const s0 = await addMsg("m0", 0);
check("ใส่ครบ 4 แถว", (await count("messages")) === 4);

console.log("\n-- cursor = 0 ต้องไม่ลบอะไรเลย (จุดที่พลาดแล้วเกลี้ยงทั้งตาราง) --");
let r = await pruneRows({ messages: 0 }, 7);
check("ไม่ลบอะไร", r.deleted.messages === 0 && (await count("messages")) === 4);

console.log("\n-- ไม่ส่ง cursors มาเลย ต้องไม่ลบ --");
r = await pruneRows({}, 7);
check("ไม่ลบอะไร", r.deleted.messages === 0 && (await count("messages")) === 4);

console.log("\n-- cursor ครอบทุกแถว keep 7 วัน: ต้องลบเฉพาะที่เก่ากว่า 7 วัน --");
r = await pruneRows({ messages: s0 }, 7);
check("ลบ 2 แถว (30 กับ 20 วัน)", r.deleted.messages === 2, `ได้ ${r.deleted.messages}`);
check("เหลือ 2 แถว (3 กับ 0 วัน)", (await count("messages")) === 2);

console.log("\n-- แถวเก่าแต่ mixhub ยังไม่ยืนยัน: ต้องไม่โดนลบ --");
await reset();
const a30 = await addMsg("a30", 30);
await addMsg("b30", 30);
r = await pruneRows({ messages: a30 }, 7);
check("ลบแค่แถวที่ยืนยันแล้ว 1 แถว", r.deleted.messages === 1, `ได้ ${r.deleted.messages}`);
check("แถวที่ยังไม่ยืนยันยังอยู่", (await count("messages")) === 1);

console.log("\n-- keepDays = 0 ต้องถอยไปใช้ค่าตั้งต้น 7 ไม่ใช่ลบให้หมด --");
await reset();
await addMsg("today", 0);
const sYest = await addMsg("yest", 2);
r = await pruneRows({ messages: sYest }, 0);
check("kept_days = 7 (ค่าตั้งต้น)", r.kept_days === 7, `ได้ ${r.kept_days}`);
check("ไม่ลบอะไรเลย ทั้งของวันนี้และเมื่อวาน", (await count("messages")) === 2);

console.log("\n-- keepDays = 1 (ตั้งมาจริง) ต้องเคารพค่านั้น --");
r = await pruneRows({ messages: sYest }, 1);
check("kept_days = 1", r.kept_days === 1, `ได้ ${r.kept_days}`);
check("ลบแถวอายุ 2 วัน เหลือของวันนี้", (await count("messages")) === 1);

console.log("\n-- cursor เป็นสตริง (JSON ส่งมาแบบนั้นได้) ต้องยังทำงานถูก --");
await reset();
const sx = await addMsg("x", 30);
r = await pruneRows({ messages: String(sx) }, 7);
check("ลบได้ 1 แถว", r.deleted.messages === 1, `ได้ ${r.deleted.messages}`);

console.log("\n-- cursor เป็นค่าขยะ ต้องไม่ลบ --");
await reset();
await addMsg("y", 30);
for (const bad of ["abc", -5, 1.5, null, NaN]) {
  r = await pruneRows({ messages: bad }, 7);
  if (r.deleted.messages !== 0) fail++;
}
check("ค่าขยะทุกแบบไม่ลบอะไร", (await count("messages")) === 1);

await db().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await db().end();

console.log(fail ? `\n❌ ตก ${fail} ข้อ\n` : "\n✅ ผ่านหมด\n");
process.exit(fail ? 1 : 0);
