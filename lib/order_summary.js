/**
 * แกะแพทเทิน "สรุปรายการ" ที่แอดมินพิมพ์ในแชท  →  ลงตาราง chatlog.order_summary
 *
 * ⚠️ ต้องเรียก "ก่อน" maskPII เสมอ
 *    maskPII กลบเบอร์เป็น [เบอร์] และกลบเลข 10 หลักขึ้นไปเป็น [เลขยาว]
 *    เรียกทีหลัง = เบอร์หาย ทำ user_data.ph ส่ง Meta ไม่ได้
 *    (เหตุผลเดียวกับที่โค้ดเดิมอ่าน /close ก่อนกลบ PII)
 *
 * ⚠️ เก็บเบอร์เป็น hash เท่านั้น ไม่เก็บเบอร์ดิบ
 *    นโยบายของ repo นี้คือกลบ PII ก่อนลงฐาน -- Meta ก็รับแต่ hash อยู่แล้ว
 *    ที่อยู่เก็บแค่รหัสไปรษณีย์ ไม่เก็บบรรทัดเต็ม
 *
 * ⚠️ หัวข้อต้องยืนเดี่ยวบรรทัดเดียว
 *    คำว่า "สรุปรายการ" แอดมินพิมพ์อยู่แล้ว 25 ครั้งแบบอินไลน์
 *    ("ได้รับข้อมูลแล้วค่ะ สรุปรายการ OCAG746-E1 จำนวน 1 ชุด ราคา 2,390 บาทค่ะ")
 *    จับแบบ "หาคำเจอ" = โดน 25 อันนี้ทั้งหมด
 */

import crypto from "node:crypto";

const HEADER = /^\s*(?:สรุปรายการ|สรุปออ?ร?์?เดอร?์|คีย์\s*ออ?ร?์?เดอร?์)\s*$/;
const FIELD  = /^\s*(ชื่อลูกค้า|ที่อยู่|เบอร์โทร|รายการ|จำนวน|รวมยอด|ชำระ)\s*[:：]\s*(.*)$/;
const SKU    = /\bO[A-Z]{1,4}-?\d{2,4}(?:-?[A-Z0-9]+)*\b/;
const MONEY  = /(\d[\d,\s]*(?:\.\d{1,2})?)/;
const ZIP    = /\b(\d{5})\b/;
const PHONE  = /\b(0\d{8,9})\b/;
const MASKED = /\[\s*(?:เบอร์|เลขยาว|อีเมล)\s*\]/;

/* เลขไทย -- แอดมินบางคนพิมพ์ ๒ แทน 2 */
const THAI_DIGITS = { "๐":"0","๑":"1","๒":"2","๓":"3","๔":"4","๕":"5","๖":"6","๗":"7","๘":"8","๙":"9" };
const deThai = (s) => String(s ?? "").replace(/[๐-๙]/g, (d) => THAI_DIGITS[d]);

const num = (s) => {
  const m = MONEY.exec(deThai(s));
  if (!m) return null;
  const v = Number(m[1].replace(/[,\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

/* Meta ต้องการ SHA-256 ของค่าที่ normalize แล้ว (trim + ตัวพิมพ์เล็ก) */
const sha = (s) => {
  const v = String(s ?? "").normalize("NFKC").trim().toLowerCase();
  return v ? crypto.createHash("sha256").update(v, "utf8").digest("hex") : null;
};

/**
 * @param {string} text ข้อความดิบ ยังไม่ผ่าน maskPII
 * @returns {Array} ออเดอร์ที่แกะได้ -- 1 ข้อความอาจมีหลายออเดอร์ (แยกที่ "ชื่อลูกค้า")
 */
export function parseOrderSummary(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  if (!lines.slice(0, 3).some((l) => HEADER.test(l))) return [];

  const blank = () => ({ cust_name: null, zipcode: null, address_seen: false,
                         phone_raw: null, items: [], total: null, pay_method: null,
                         orphan_qty: 0 });
  const orders = [];
  let cur = null;

  for (const line of lines) {
    const m = FIELD.exec(line);
    if (!m) continue;
    const key = m[1], val = m[2].trim();

    if (key === "ชื่อลูกค้า") {
      if (cur) orders.push(cur);
      cur = blank();
      cur.cust_name = val || null;
      continue;
    }
    if (!cur) cur = blank();

    switch (key) {
      case "ที่อยู่": {
        cur.address_seen = !!val;
        const z = ZIP.exec(deThai(val));
        cur.zipcode = z ? z[1] : null;
        break;
      }
      case "เบอร์โทร": cur.phone_raw  = val || null; break;
      case "ชำระ":     cur.pay_method = val || null; break;
      case "รวมยอด":   cur.total      = num(val);    break;
      case "รายการ":   cur.items.push({ name: val || null, sku: null, qty: null }); break;
      case "จำนวน": {
        const q = num(val);
        /* ผูกกับ "รายการ" ล่าสุดที่ยังไม่มีจำนวน -- รองรับกรณีพิมพ์สลับลำดับ */
        const tgt = [...cur.items].reverse().find((it) => it.qty === null);
        if (tgt) tgt.qty = q; else cur.orphan_qty++;
        break;
      }
    }
  }
  if (cur) orders.push(cur);

  return orders.map((o) => {
    const flags = [];

    for (const it of o.items) {
      if (!it.name) continue;
      const s = SKU.exec(it.name.toUpperCase());
      if (s) it.sku = s[0];
      if (it.qty === null) { it.qty = 1; flags.push("qty_assumed"); }
    }
    const items = o.items.filter((it) => it.name);
    if (o.orphan_qty) flags.push("qty_orphan");

    const phoneMasked = !!(o.phone_raw && MASKED.test(o.phone_raw));
    const ph = PHONE.exec(deThai(o.phone_raw || ""));
    if (phoneMasked) flags.push("phone_masked");
    else if (o.phone_raw && !ph) flags.push("phone_invalid");

    if (o.address_seen && !o.zipcode) flags.push("no_zip");

    /* ไม่มีช่อง "ชำระ" ในแพทเทิน -> เดาจากคำว่าปลายทาง/โอน ในข้อความ
       ⚠️ เดาได้แต่ไม่ควรพึ่ง -- มันตัดสินว่าจะยิง Purchase เมื่อไหร่ ควรขอให้เพิ่มช่องนี้ */
    let pay = o.pay_method;
    if (!pay) {
      if (/ปลายทาง/.test(text)) pay = "cod";
      else if (/โอน/.test(text)) pay = "transfer";
      else flags.push("pay_method_unknown");
    } else {
      pay = /ปลายทาง/.test(pay) ? "cod" : /โอน/.test(pay) ? "transfer" : pay;
    }

    let status;
    const anything = o.cust_name || o.address_seen || o.total !== null || items.length;
    if (!anything)               status = "blank_template";   // ก๊อปเทมเพลตมาไม่กรอก -> ทิ้งเงียบ
    else if (o.total === null) { status = "incomplete"; flags.push("no_total"); }
    else if (!items.length)    { status = "incomplete"; flags.push("no_items"); }
    else if (!o.cust_name)     { status = "incomplete"; flags.push("no_name"); }
    else if (o.total <= 0)     { status = "incomplete"; flags.push("bad_total"); }
    else                         status = "ok";

    return {
      /* mode/confidence เป็น NOT NULL ในตารางจริง -- ต้องมีเสมอ */
      mode: "template",
      confidence: status === "ok" ? "auto" : "review",
      line_prices: null, line_sum: null, sum_checks: null,
      cust_name: o.cust_name,
      cust_name_sha256: sha(o.cust_name),
      zipcode: o.zipcode,
      zipcode_sha256: sha(o.zipcode),
      phone_sha256: ph ? sha(ph[1]) : null,
      phone_masked: phoneMasked,
      items, total: o.total, pay_method: pay,
      status, flags: [...new Set(flags)].sort(),
    };
  });
}

/* ---------- DDL -- เอาไปต่อท้าย const SCHEMA ใน lib/store.js ---------- */
export const ORDER_SCHEMA = (T) => `
CREATE TABLE IF NOT EXISTS ${T("order_summary")} (
  seq              bigserial PRIMARY KEY,
  mid              text NOT NULL,
  ordinal          int  NOT NULL DEFAULT 1,     -- 1 ข้อความมีได้หลายออเดอร์
  page_id          text NOT NULL,
  psid             text NOT NULL,
  ts               bigint NOT NULL,             -- ใช้เป็น event_time ตอนยิง Meta

  -- ⚠️ ตารางจริงบน Supabase (สร้างโดย create_and_backfill.py ไปแล้ว) ตั้ง mode/confidence
  --    เป็น NOT NULL ไม่มีค่าตั้งต้น -- DDL นี้ต้องตรงกัน ไม่งั้น INSERT พังเงียบใน try/catch
  mode             text NOT NULL,               -- template | bot_template | freeform
  confidence       text NOT NULL,               -- auto = ยิงได้ · review = ต้องให้คนตรวจ
  line_prices      jsonb,                       -- ราคารายบรรทัดที่อ่านได้ (freeform)
  line_sum         numeric(12,2),               -- ผลบวกรายบรรทัด
  sum_checks       boolean,                     -- บวกแล้วตรงยอดรวมไหม

  cust_name        text,
  cust_name_sha256 text,
  zipcode          text,
  zipcode_sha256   text,
  phone_sha256     text,                        -- hash เท่านั้น ไม่เก็บเบอร์ดิบ
  phone_masked     boolean NOT NULL DEFAULT false,
  total            numeric(12,2),
  pay_method       text,                        -- cod | transfer | null
  items            jsonb NOT NULL DEFAULT '[]', -- [{name,sku,qty}]

  status           text NOT NULL,               -- ok | incomplete | blank_template
  flags            text[] NOT NULL DEFAULT '{}',

  -- คิวส่ง Meta
  state            text NOT NULL DEFAULT 'held',-- held|sent|dropped|cancel_sent|ambiguous|expired
  release_at       bigint,                      -- ts + หน้าต่างหน่วง
  meta_event_id    text,
  sent_at          bigint,
  cancelled_at     bigint,
  cancel_mid       text,

  UNIQUE (mid, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_os_release ON ${T("order_summary")}(state, release_at);
CREATE INDEX IF NOT EXISTS idx_os_thread  ON ${T("order_summary")}(page_id, psid, state);`;

/* ---------- ยกเลิก ---------- */
export const CANCEL_RE = /^\s*ยกเลิกออ?ร?์?เดอร?์\s*(?:[:：]\s*([\d,๐-๙]+(?:\.\d{1,2})?))?\s*$/;

/** แอดมินรับเรื่องยกเลิกด้วยภาษาคน -- ของจริงในฐาน เช่น
 *  "รับทราบค่ะ แอดมินจะยกเลิกข้อมูลออเดอร์นี้ให้นะคะ"
 *  ⚠️ เป็นการเดาจากภาษาคน ต้อง mark cancel_source='admin_ack' ไว้ แยกจากคำสั่งตรง */
export const isCancelAck = (t) =>
  /ยกเลิก/.test(t ?? "") && /(รับทราบ|รับเรื่อง|แจ้งยกเลิก|จะยกเลิก)/.test(t ?? "");

export { num as parseMoney, sha as hashForMeta };
