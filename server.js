/**
 * osuka-chatlog — ตัวดักแชทเพจ Facebook แยก AI ออกจากคน
 *
 * ทำ 4 อย่าง:
 *   GET  /webhook   ตอบ verify ตอน Meta มาเช็ก URL
 *   POST /webhook   รับ event -> ตรวจลายเซ็น -> เก็บลง SQLite
 *   GET  /health    ดูว่ายังมีชีวิตและเก็บได้กี่แถวแล้ว
 *   GET  /export    ให้ mixhub ดึงข้อมูลเข้าไปวิเคราะห์ (ต้องมีโทเคน)
 *
 * ⚠️ ไม่มี dependency เลยสักตัว -- ใช้ของที่ Node มีให้ (node:sqlite ตั้งแต่ v22)
 *    ต่างจากคู่มือ 23ADS ที่ใช้ express + better-sqlite3
 *    เหตุผล: better-sqlite3 ต้อง build native ซึ่งพังบ่อยบน Windows และบน VPS
 *    ที่ไม่มี build tools -- ตัวนี้ก๊อปไฟล์ไปวางแล้ว `node server.js` ได้เลย
 *
 * ⚠️ การแยก AI ออกจากคน อยู่ที่ ai_generated ไม่ใช่ app_id
 *    Business Agent กับแอดมินที่พิมพ์ใน Page Inbox ใช้ app_id เดียวกัน (263902037430900)
 *    ถ้าแยกด้วย "มี app_id ไหม" จะนับคนเป็น AI ทุกข้อความโดยไม่มีอะไรฟ้อง
 */

import http from "node:http";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const APP_SECRET   = process.env.APP_SECRET || "";
const EXPORT_TOKEN = process.env.EXPORT_TOKEN || "";
const PORT         = Number(process.env.PORT || 3000);
const DB_PATH      = process.env.DB_PATH || "chatlog.db";

for (const [k, v] of Object.entries({ VERIFY_TOKEN, APP_SECRET, EXPORT_TOKEN })) {
  if (!v) {
    console.error(`ขาดค่า ${k} -- ดู .env.example`);
    process.exit(1);
  }
}

/* app_id ที่รู้จัก -- ที่มา: คู่มือ 23ADS ไฟล์ 01 (ได้จากการแกะ payload จริง ไม่ใช่ docs) */
const APP_PAGE_INBOX = "263902037430900";  // Business Suite / Pages app (ทั้งคนและ Business Agent)
const APP_CRMIXER    = "225915530485492";  // CRMIXER สรุปออเดอร์ -- ไม่ใช่ผู้ตอบ

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  mid          TEXT PRIMARY KEY,          -- กัน Meta ส่งซ้ำ
  page_id      TEXT NOT NULL,
  psid         TEXT NOT NULL,             -- ลูกค้าเสมอ (echo ก็เป็นลูกค้า)
  direction    TEXT NOT NULL,             -- in = ลูกค้าพิมพ์ | out = เพจตอบ
  actor        TEXT NOT NULL,             -- customer|ai|human|system|bot|unknown
  app_id       TEXT,
  ai_generated INTEGER DEFAULT 0,
  metadata     TEXT,
  text_masked  TEXT,                      -- กลบ PII แล้ว -- ห้ามเก็บข้อความดิบ
  has_close    INTEGER DEFAULT 0,
  close_amount REAL,
  ts           INTEGER NOT NULL,          -- ms epoch จาก Meta
  raw          TEXT NOT NULL              -- payload ดิบ (กลบ PII แล้วเช่นกัน)
);
CREATE INDEX IF NOT EXISTS idx_msg_page_ts ON messages(page_id, ts);

CREATE TABLE IF NOT EXISTS referrals (
  page_id  TEXT NOT NULL,
  psid     TEXT NOT NULL,
  mid      TEXT DEFAULT '',
  ad_id    TEXT,
  ad_title TEXT,
  post_id  TEXT,
  source   TEXT,
  ref      TEXT,
  ts       INTEGER NOT NULL,
  raw      TEXT NOT NULL,
  PRIMARY KEY (page_id, psid, mid, ad_id)
);

CREATE TABLE IF NOT EXISTS handovers (
  page_id  TEXT NOT NULL,
  psid     TEXT NOT NULL,
  event    TEXT NOT NULL,
  app_id   TEXT,
  metadata TEXT,
  ts       INTEGER NOT NULL,
  raw      TEXT NOT NULL,
  PRIMARY KEY (page_id, psid, event, ts)
);
`);

const insMsg = db.prepare(`INSERT OR IGNORE INTO messages
  (mid,page_id,psid,direction,actor,app_id,ai_generated,metadata,text_masked,has_close,close_amount,ts,raw)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insRef = db.prepare(`INSERT OR IGNORE INTO referrals
  (page_id,psid,mid,ad_id,ad_title,post_id,source,ref,ts,raw) VALUES (?,?,?,?,?,?,?,?,?,?)`);
const insHand = db.prepare(`INSERT OR IGNORE INTO handovers
  (page_id,psid,event,app_id,metadata,ts,raw) VALUES (?,?,?,?,?,?,?)`);

/**
 * กลบข้อมูลส่วนบุคคลก่อนเก็บ
 *
 * ⚠️ ทำตามที่ระบบเดิมของทีมทำอยู่ (legacy/tools/chat-analysis/chat_pull.php)
 *    "กลบข้อมูลส่วนบุคคลตั้งแต่ก่อนลงฐาน -- เบอร์โทร ที่อยู่ เลขบัญชี อีเมล"
 *    คู่มือ 23ADS เก็บข้อความดิบ แต่เราไม่ทำตามตรงนี้
 * ⚠️ รายงานทั้ง 4 ข้อไม่ต้องใช้เนื้อความแชทเลย ใช้แค่ ใครตอบ/เมื่อไหร่/ยอด/มาจากแอดไหน
 *    เก็บดิบไว้จึงมีแต่ความเสี่ยง PDPA โดยไม่ได้ประโยชน์เพิ่ม
 * ⚠️ ที่อยู่กลบด้วย regex ไม่ได้จริง -- ตัดความยาวช่วยลดความเสี่ยงได้บ้างเท่านั้น
 */
function maskPII(s) {
  if (!s) return s;
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[อีเมล]")
    .replace(/(?:\+66|0)\s?\d[\d\s-]{7,12}\d/g, "[เบอร์]")
    .replace(/\d[\d-]{8,}\d/g, "[เลขยาว]");   // เลขบัญชี/พัสดุ/บัตรประชาชน
}

/**
 * ก้อน raw ที่จะเก็บ -- กลบเฉพาะ "ข้อความที่คนพิมพ์" ไม่ใช่ทั้งก้อน
 *
 * ⚠️ ห้ามเอา maskPII ไปครอบ JSON.stringify ทั้งก้อนเด็ดขาด (เจอจริง 10 ก.ย. 69)
 *    timestamp เป็นเลข 13 หลัก จะโดนกลบเป็น [เลขยาว] แล้ว JSON พังทั้งแถว
 *    อ่านกลับไม่ได้ = เสียเหตุผลทั้งหมดของการเก็บ raw
 *    และ psid ของลูกค้าจริงก็เป็นเลขยาว โดนกลบเมื่อไหร่เธรดพังทั้งระบบ
 *    -- ต้องแตะเฉพาะ message.text ที่เดียว โครงสร้างกับ id ต้องอยู่ครบ
 */
function rawForStorage(ev) {
  const c = structuredClone(ev);
  if (c?.message?.text) c.message.text = maskPII(c.message.text);
  return JSON.stringify(c);
}

/** /close 1290 หรือ /close 1,290.50 -- แอดมินพิมพ์ในแชทเพื่อบอกว่าปิดการขายได้ */
const CLOSE_RE = /^\s*\/close\b\s*([\d][\d,]*(?:\.\d{1,2})?)?/i;

/**
 * ใครเป็นคนตอบ -- ล้อตารางในคู่มือ 23ADS เป๊ะ
 * เช็ก Crmixer ก่อนทุกอย่าง เพราะเป็นข้อความระบบ ไม่ใช่ผู้ตอบ ต้องไม่ปนเข้าสถิติ
 */
function classify(isEcho, appId, aiGenerated) {
  if (!isEcho) return "customer";
  if (appId === APP_CRMIXER) return "system";
  if (aiGenerated) return "ai";
  if (appId === APP_PAGE_INBOX) return "human";
  return appId ? "bot" : "unknown";
}

function handleEvent(pageId, ev) {
  const m = ev.message;
  const isEcho = m?.is_echo === true;

  /* ⚠️ ฝั่งไหนเป็นลูกค้าสลับไปมาตามชนิด event -- กฎที่ใช้ได้ทุกกรณีคือ
     "ฝั่งที่ไม่ใช่เพจ คือลูกค้า" อย่าผูกกับ is_echo ไม่งั้น event ส่งต่อหลุดหมด */
  const sender = ev.sender?.id ?? "";
  const psid = sender && sender !== pageId ? sender : (ev.recipient?.id ?? "");
  if (!psid || psid === pageId) return;

  const ts = Number(ev.timestamp) || Date.now();
  const rawMasked = rawForStorage(ev);

  // ลูกค้าคลิกแอดเข้ามา -- มาได้ 3 ทาง
  const ref = ev.referral ?? ev.postback?.referral ?? ev.message?.referral;
  if (ref) {
    insRef.run(pageId, psid, m?.mid ?? "", ref.ad_id ?? null,
      ref.ads_context_data?.ad_title ?? null, ref.ads_context_data?.post_id ?? null,
      ref.source ?? null, ref.ref ?? null, ts, rawMasked);
  }

  // ส่งต่อระหว่าง AI กับคน (ถ้าเพจเปิด Handover Protocol)
  for (const k of ["pass_thread_control", "take_thread_control", "request_thread_control"]) {
    if (ev[k]) {
      insHand.run(pageId, psid, k,
        String(ev[k].new_owner_app_id ?? ev[k].previous_owner_app_id ?? ev[k].requested_owner_app_id ?? ""),
        String(ev[k].metadata ?? ""), ts, rawMasked);
    }
  }

  if (!m?.mid) return;   // delivery / read / postback ล้วน -- ไม่ใช่ข้อความ

  const appId = isEcho ? String(m.app_id ?? "") : "";
  const aiGen = m.ai_generated === true;
  const actor = classify(isEcho, appId, aiGen);
  const text = String(m.text ?? "");

  /* อ่าน /close ก่อนกลบ PII -- ยอดเงินเป็นตัวเลขยาวอาจโดนกลบไปด้วย */
  let hasClose = 0, amount = null;
  const cm = isEcho && actor !== "system" ? text.match(CLOSE_RE) : null;
  if (cm) {
    hasClose = 1;
    amount = cm[1] ? Number(cm[1].replace(/,/g, "")) : null;
  }

  insMsg.run(m.mid, pageId, psid, isEcho ? "out" : "in", actor,
    appId || null, aiGen ? 1 : 0,
    m.metadata ? JSON.stringify(m.metadata) : null,
    maskPII(text).slice(0, 300), hasClose, amount, ts, rawMasked);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  // --- Meta มายืนยัน URL ตอนกด Verify ใน App Dashboard ---
  if (req.method === "GET" && url.pathname === "/webhook") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
               url.searchParams.get("hub.verify_token") === VERIFY_TOKEN;
    res.writeHead(ok ? 200 : 403, { "content-type": "text/plain" });
    return res.end(ok ? url.searchParams.get("hub.challenge") : "forbidden");
  }

  // --- ดูว่ายังมีชีวิตและเก็บได้เท่าไหร่แล้ว ---
  if (req.method === "GET" && url.pathname === "/health") {
    const row = db.prepare(`SELECT count(*) n, max(ts) last FROM messages`).get();
    const by = db.prepare(`SELECT actor, count(*) n FROM messages GROUP BY actor`).all();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true, messages: row.n,
      last_message_at: row.last ? new Date(row.last).toISOString() : null,
      by_actor: Object.fromEntries(by.map((r) => [r.actor, r.n])),
    }, null, 2));
  }

  // --- ให้ mixhub ดึงเข้าไปวิเคราะห์ ---
  if (req.method === "GET" && url.pathname === "/export") {
    if (url.searchParams.get("token") !== EXPORT_TOKEN) {
      res.writeHead(401); return res.end("unauthorized");
    }
    const since = Number(url.searchParams.get("since") || 0);
    const limit = Math.min(Number(url.searchParams.get("limit") || 1000), 5000);
    const out = {
      messages:  db.prepare(`SELECT rowid AS cursor, * FROM messages  WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(since, limit),
      referrals: db.prepare(`SELECT rowid AS cursor, * FROM referrals WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(since, limit),
      handovers: db.prepare(`SELECT rowid AS cursor, * FROM handovers WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(since, limit),
    };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(out));
  }

  // --- รับ event จาก Meta ---
  if (req.method === "POST" && url.pathname === "/webhook") {
    const body = await readBody(req);

    /* ตรวจลายเซ็น -- URL นี้เปิดสาธารณะ ใครก็ยิงข้อมูลปลอมเข้ามาได้ถ้าไม่ตรวจ */
    const sig = req.headers["x-hub-signature-256"] || "";
    const expect = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
    if (sig.length !== expect.length ||
        !crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(expect))) {
      res.writeHead(401); return res.end("bad signature");
    }

    /* ⚠️ ตอบ 200 ก่อนแล้วค่อยเก็บ -- Meta ให้เวลาไม่กี่วินาที ตอบช้าจะยิงซ้ำ
       และถ้าล้มนานมาก Meta ยกเลิก subscription ของเพจนั้นทิ้ง */
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("OK");

    let payload;
    try { payload = JSON.parse(body.toString("utf8")); } catch { return; }
    if (payload.object !== "page") return;

    for (const entry of payload.entry ?? []) {
      /* standby = event ที่มาถึงตอนแอปเราไม่ได้ถือสิทธิ์คุย (หลังส่งต่อให้คนแล้ว)
         ไม่อ่านตรงนี้จะขาดช่วง "หลังส่งคืนคน" ซึ่งเป็นช่วงที่รายงานต้องการที่สุด */
      for (const ev of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
        try { handleEvent(entry.id, ev); }
        catch (e) { console.error("[event ล้มเหลว]", e.message); }
      }
    }
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => {
  console.log(`osuka-chatlog ฟังที่พอร์ต ${PORT} · ฐาน ${path.resolve(DB_PATH)}`);
});
