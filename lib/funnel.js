/**
 * event ขั้นต่าง ๆ จากแชท แบบ Pixel ของเว็บ -> Conversions API (3 พ.ย. 69 เจ้าของ
 * "อยากได้ View Content ฯลฯ แบบ Pixel ทุกเพจ ทำจาก keyword/coding ให้คล้ายพิกเซลมากที่สุด")
 *
 * เทียบ Pixel:  ViewContent · AddToCart · InitiateCheckout · (AddPaymentInfo -> LeadSubmitted) · Purchase (ตัวเดิม capi_send.js)
 * Meta รับจากแชทได้แค่ชนิดในรายการ business_messaging -- ไม่มี PageView/Search/AddPaymentInfo
 *
 * กติกา (ทดสอบกับแชทจริง 20 ต.ค.-2 พ.ย. 69 ก่อนเขียนไฟล์นี้):
 *   ViewContent      ลูกค้าพิมพ์รหัสรุ่น / ถามราคา · หรือเพจตอบข้อมูลสินค้าที่มีรหัสรุ่น
 *   AddToCart        ลูกค้าบอกจะเอา (เอาตัวนี้ · รับ 1 ชุด · สั่งเลย) หรือกดปุ่ม "สั่งซื้อรุ่นนี้" / "รับข้อเสนอ"
 *   InitiateCheckout ลูกค้าถามวิธีซื้อ/ส่ง/จ่าย (ปลายทาง · ค่าส่ง · โอน) หรือเพจขอ ชื่อ-ที่อยู่ (ข้อความสั้น ไม่ใช่แม่แบบสินค้า)
 *   LeadSubmitted    ลูกค้าส่งเบอร์มือถือ หรือที่อยู่ที่มี ต./อ./จ./หมู่ + รหัสไปรษณีย์
 * 1 ชนิดต่อห้องต่อวัน (ตาราง funnel_events กันซ้ำ) · ห้องลูกค้าเก่าตามเรื่องเคลม/พัสดุ ไม่นับเจตนาซื้อ
 * ⚠️ ต้องเรียก "ก่อน" maskPII -- เบอร์/รหัสไปรษณีย์ใช้ทำ user_data
 */
import crypto from "node:crypto";
import { datasetOf, DATASET_WEB_PIXEL } from "./capi_send.js";

const SKU      = /\b(O[A-Z]{1,5}-?\d{3,4}[A-Z]?)(?:-[A-Z0-9]{1,6})?\b/;
const PRICE_Q  = /(ราคา|เท่าไหร่|เท่าไร|กี่บาท|โปร)/;
const INTENT   = /(สั่งเลย|สั่งได้เลย|เอาเลย|เอา\s*\d+\s*(ตัว|ชิ้น|อัน|ชุด|ก้อน|เส้น)|รับ\s*\d+\s*(ตัว|ชิ้น|อัน|ชุด|ก้อน|เส้น)|(?<!ไม่น่า)(?<!ไม่)ซื้อเลย|ตกลงซื้อ|จะสั่ง|ขอสั่ง|อยากสั่ง|สั่งค่ะ|สั่งครับ|เอาตัวนี้|เอาอันนี้|สั่งซื้อรุ่นนี้|รับข้อเสนอ|ขอซื้อได้)/i;
const CHECKOUT = /(ปลายทาง|เก็บเงิน|\bcod\b|ค่าส่ง|ตัวเลือกการจัดส่ง|จัดส่ง.{0,12}กี่วัน|กี่วันถึง|ซื้อยังไง|สั่งยังไง|จ่ายยังไง|ชำระ|โอนได้|แบบโอน|เลขบัญชี|ผ่อน|บัตรเครดิต|สั่งได้ไหม)/i;
const PAGE_ASK = /(ขอที่อยู่|แจ้งที่อยู่|รบกวนแจ้ง ?ชื่อ|แจ้งชื่อ)/;
const FOLLOW   = /(ตั้งเบิก|คืนเงิน|โอนคืน|เงินคืน|เคลม|ส่งซ่อม|ของเสีย|ชำรุด|ใช้ไม่ได้|เปลี่ยนสินค้า|ยังไม่ได้รับ|ยังไม่ได้ของ|เลขพัสดุ|พัสดุ|tracking)/i;
const SYSTEM   = /(ทำเครื่องหมายคำสั่งซื้อ|marked the order|สร้างคำสั่งซื้อมูลค่า|created an order|เชื่อมต่อบัญชีธนาคาร)/i;
const PHONE    = /(?<!\d)0([689]\d{8})(?!\d)/;
const ADDR     = /(ต\.|อ\.|จ\.|ตำบล|อำเภอ|จังหวัด|แขวง|เขต|หมู่|ม\.\d|ซอย|ถนน)/;
const ZIP      = /(?<!\d)([1-9]\d{4})(?!\d)/;

const sha = (s) => {
  const v = String(s ?? "").normalize("NFKC").trim().toLowerCase();
  return v ? crypto.createHash("sha256").update(v, "utf8").digest("hex") : null;
};

export const FUNNEL_SCHEMA = (T) => `
CREATE TABLE IF NOT EXISTS ${T("funnel_events")} (
  seq       bigserial PRIMARY KEY,
  page_id   text NOT NULL,
  psid      text NOT NULL,
  event     text NOT NULL,
  day       text NOT NULL,
  mid       text NOT NULL,
  skus      text[] NOT NULL DEFAULT '{}',
  ts        bigint NOT NULL,
  state     text NOT NULL DEFAULT 'new',   -- new · sent · off (เพจยังไม่เปิด) · no_dataset · web_pixel · error
  detail    text,
  UNIQUE (page_id, psid, event, day)
);`;

/** event ที่ข้อความนี้ก่อ -- คืน [{event, skus, ud}] */
export function detect({ isEcho, actor, text }) {
  const t = String(text ?? "");
  if (!t.trim() || SYSTEM.test(t)) return [];
  const up = t.toUpperCase();
  const skus = [...new Set([...up.matchAll(new RegExp(SKU.source, "g"))].map((m) => m[0]))];   // รหัสเต็ม (OCPS427-D1) ให้ตรงกับ Purchase
  const out = [];
  if (!isEcho) {
    const follow = FOLLOW.test(t);
    if (skus.length || PRICE_Q.test(t)) out.push({ event: "ViewContent", skus });
    if (!follow && INTENT.test(t)) out.push({ event: "AddToCart", skus });
    if (!follow && CHECKOUT.test(t)) out.push({ event: "InitiateCheckout", skus });
    const digits = t.replace(/[\s\-.]/g, "");
    const ph = PHONE.exec(digits);
    const z = ZIP.exec(t);
    if (ph || (z && ADDR.test(t))) {
      const ud = {};
      if (ph) ud.ph = [sha("66" + ph[1])];
      if (z) ud.zp = [sha(z[1])];
      out.push({ event: "LeadSubmitted", skus, ud });
    }
  } else if (actor === "human" || actor === "bot") {
    if (skus.length) out.push({ event: "ViewContent", skus });
    if (PAGE_ASK.test(t) && !skus.length && t.length < 160) out.push({ event: "InitiateCheckout", skus });
  }
  return out;
}

const DAYFMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" });

/**
 * จดลงตาราง (กันซ้ำ 1 ชนิด/ห้อง/วัน) แล้วส่งเข้า dataset ของเพจทันที
 * ⚠️ ล้มเหลวไม่ throw -- แถวค้าง state=error ไว้ให้ดู · webhook ต้องตอบ 200 เสมอ
 */
export async function recordAndSend(c, T, { pageId, psid, mid, ts, found, timeoutMs = 6000 }) {
  if (!found.length) return [];
  const day = DAYFMT.format(new Date(ts));
  const fresh = [];
  for (const f of found) {
    const r = await c.query(
      `INSERT INTO ${T("funnel_events")} (page_id, psid, event, day, mid, skus, ts) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (page_id, psid, event, day) DO NOTHING RETURNING seq`,
      [pageId, psid, f.event, day, mid, f.skus, ts]);
    if (r.rows[0]) fresh.push({ ...f, seq: r.rows[0].seq });
  }
  if (!fresh.length) return [];

  /* เปิดส่งทีละเพจ -- ตอนนี้เฉพาะ Jobsite Tools (OSUKA Chat Orders) ตามที่เจ้าของสั่งลองก่อน 3 พ.ย. 69
     เพิ่มเพจ = ตั้ง env FUNNEL_PAGES (คั่นด้วย ,) · เพจอื่นยังจดลงตารางครบ แค่ไม่ส่ง (state off) */
  const allow = (process.env.FUNNEL_PAGES || "370441686151976").split(",").map((x) => x.trim());
  if (!allow.includes(pageId)) {
    await c.query(`UPDATE ${T("funnel_events")} SET state='off' WHERE seq = ANY($1::bigint[])`, [fresh.map((f) => f.seq)]);
    return fresh;
  }
  const ds = await datasetOf(pageId, timeoutMs);
  const mark = (state, detail) => c.query(
    `UPDATE ${T("funnel_events")} SET state=$2, detail=$3 WHERE seq = ANY($1::bigint[])`,
    [fresh.map((f) => f.seq), state, detail]);
  if (!ds) { await mark("no_dataset", null); return fresh; }
  if (ds === DATASET_WEB_PIXEL) { await mark("web_pixel", null); return fresh; }

  const data = fresh.map((f) => {
    const ud = { page_id: pageId, page_scoped_user_id: psid, country: [sha("th")], ...(f.ud ?? {}) };
    const custom = {};
    if (f.skus.length) { custom.content_type = "product"; custom.content_ids = f.skus; custom.contents = f.skus.map((id) => ({ id, quantity: 1 })); }
    return {
      event_name: f.event,
      event_time: Math.floor(ts / 1000),
      event_id: `fn-${f.event}-${psid}-${day}`,
      action_source: "business_messaging",
      messaging_channel: "messenger",
      user_data: ud,
      ...(Object.keys(custom).length ? { custom_data: custom } : {}),
    };
  });
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), timeoutMs);
    const body = { data, access_token: process.env.CAPI_TOKEN };
    if (process.env.CAPI_TEST_CODE) body.test_event_code = process.env.CAPI_TEST_CODE;
    const res = await fetch(`https://graph.facebook.com/${process.env.GRAPH_VERSION || "v21.0"}/${ds}/events`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ac.signal,
    }).finally(() => clearTimeout(tm));
    const j = await res.json().catch(() => ({}));
    /* เก็บคำตอบ Meta ไว้เป็นหลักฐาน: events_received = จำนวนที่ Meta รับจริง · fbtrace_id ใช้ถาม Meta ได้ */
    await mark(res.ok ? "sent" : "error", res.ok ? `ds ${ds} · received ${j.events_received ?? "?"} · trace ${j.fbtrace_id ?? ""}` : JSON.stringify(j.error ?? j).slice(0, 300));
  } catch (e) {
    await mark("error", String(e.message).slice(0, 300));
  }
  return fresh;
}
