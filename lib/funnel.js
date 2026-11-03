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
);
ALTER TABLE ${T("funnel_events")} ADD COLUMN IF NOT EXISTS ud jsonb;   -- ตัวตนที่ข้อความนี้ให้มา (hash) ใช้ต่อกับ event ถัดไปของห้อง
-- ชื่อ/หมวด/ราคาสินค้า -- ซิงก์จาก mixhub.price_channels + product_category ฝั่ง server (ยังไม่อัตโนมัติ)
CREATE TABLE IF NOT EXISTS ${T("products")} (
  code text PRIMARY KEY, name text, category text, sub text, rsp numeric, fb_own numeric, fb_third numeric, synced_at timestamptz DEFAULT now()
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
      `INSERT INTO ${T("funnel_events")} (page_id, psid, event, day, mid, skus, ts, ud) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (page_id, psid, event, day) DO NOTHING RETURNING seq`,
      [pageId, psid, f.event, day, mid, f.skus, ts, f.ud ? JSON.stringify(f.ud) : null]);
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

  const ctx = await roomContext(c, T, pageId, psid);
  for (const id of new Set([...ctx.skus, ...fresh.flatMap((f) => f.skus)])) ctx.prod[id] = await product(c, T, id);
  const data = fresh.map((f) => buildFunnelEvent(f, { pageId, psid, ts, day, ctx }));
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

/* ---------- ทำให้ event ละเอียดกว่า Pixel (3 พ.ย. 69 เจ้าของ "แท็กน้อยชิบหาย ควรแท็กให้ได้เยอะกว่านี้") ----------
   ทุก event ได้: สินค้าของห้อง (ข้อความนี้ไม่มีรหัส = ใช้รุ่นล่าสุดที่คุยกันในห้อง) + ชื่อ/หมวด/ราคา (chatlog.products)
   + ตัวตนลูกค้าที่ห้องนี้เคยให้ไว้ (เบอร์ · รหัสไปรษณีย์ · ชื่อ จาก Lead/ใบสรุปก่อนหน้า) + แอดที่ลูกค้ากดทักมา (referrals)
   ราคาเพจหลัก = fb_own · เพจอื่น = fb_third (เหมือน PriceCheck ฝั่ง server) */
const MAIN_PAGE = "106769424226678";
const prodCache = new Map();

async function product(c, T, code) {
  if (prodCache.has(code)) return prodCache.get(code);
  let row = null;
  try {
    const r = await c.query(`SELECT code, name, category, sub, rsp, fb_own, fb_third FROM ${T("products")}
                              WHERE code = $1 OR code LIKE $2 ORDER BY (code = $1) DESC, code LIMIT 1`, [code, code + "-%"]);
    row = r.rows[0] ?? null;
  } catch { row = null; }
  prodCache.set(code, row);
  return row;
}

/** ความจำของห้อง: รุ่นล่าสุดที่คุยกัน · ตัวตนที่ลูกค้าเคยให้ · แอดที่ทักมา */
export async function roomContext(c, T, pageId, psid) {
  const ctx = { skus: [], ud: {}, ad: null };
  const since = Date.now() - 7 * 86400000;
  try {
    const s = await c.query(`SELECT skus FROM ${T("funnel_events")} WHERE page_id=$1 AND psid=$2 AND ts > $3 AND cardinality(skus) > 0 ORDER BY ts DESC LIMIT 1`, [pageId, psid, since]);
    if (s.rows[0]) ctx.skus = s.rows[0].skus;
    const u = await c.query(`SELECT ud FROM ${T("funnel_events")} WHERE page_id=$1 AND psid=$2 AND ud IS NOT NULL ORDER BY ts DESC LIMIT 5`, [pageId, psid]);
    for (const r of u.rows.reverse()) Object.assign(ctx.ud, r.ud);
    const o = await c.query(`SELECT phone_sha256, zipcode_sha256, cust_name FROM ${T("order_summary")} WHERE page_id=$1 AND psid=$2 ORDER BY seq DESC LIMIT 1`, [pageId, psid]);
    if (o.rows[0]) {
      const r = o.rows[0];
      if (r.phone_sha256) { ctx.ud.ph = [r.phone_sha256]; }
      if (r.zipcode_sha256) ctx.ud.zp = [r.zipcode_sha256];
      const parts = String(r.cust_name ?? "").replace(/^(คุณ|นาย|นางสาว|นาง)\s*/, "").trim().split(/\s+/).filter(Boolean);
      if (parts[0]) ctx.ud.fn = [sha(parts[0])];
      if (parts.length > 1) ctx.ud.ln = [sha(parts.slice(1).join(" "))];
    }
    const a = await c.query(`SELECT ad_id, ad_title, source FROM ${T("referrals")} WHERE page_id=$1 AND psid=$2 ORDER BY ts DESC LIMIT 1`, [pageId, psid]);
    if (a.rows[0]) ctx.ad = a.rows[0];
  } catch (e) { console.error("[funnel context]", e.message); }
  /* ราคา/ชื่อของรุ่นที่จะใช้ */
  ctx.prod = {};
  return ctx;
}

const STEP = { ViewContent: 1, AddToCart: 2, InitiateCheckout: 3, LeadSubmitted: 4 };

export function buildFunnelEvent(f, { pageId, psid, ts, day, ctx }) {
  const skus = f.skus.length ? f.skus : ctx.skus;
  const ud = { page_id: pageId, page_scoped_user_id: psid, country: [sha("th")], ...ctx.ud, ...(f.ud ?? {}) };
  if (ud.ph && !ud.external_id) ud.external_id = ud.ph;
  const custom = { currency: "THB", funnel_step: STEP[f.event] ?? 0, channel: "messenger", sku_from: f.skus.length ? "message" : (skus.length ? "room" : "none") };
  if (skus.length) {
    const ps = skus.map((id) => ctx.prod[id] ?? null);
    const price = (p) => p ? Number((pageId === MAIN_PAGE ? p.fb_own : (p.fb_third ?? p.fb_own)) ?? p.rsp ?? 0) || null : null;
    custom.content_type = "product";
    custom.content_ids = skus;
    custom.contents = skus.map((id, i) => ({ id, quantity: 1, ...(price(ps[i]) ? { item_price: price(ps[i]) } : {}) }));
    custom.num_items = skus.length;
    const p0 = ps.find(Boolean);
    if (p0?.name) custom.content_name = p0.name;
    if (p0?.category) custom.content_category = p0.sub ? `${p0.category} > ${p0.sub}` : p0.category;
    const v = ps.reduce((a, p) => a + (price(p) || 0), 0);
    if (v > 0) custom.value = v;
  }
  if (ctx.ad?.ad_id) { custom.ad_id = ctx.ad.ad_id; if (ctx.ad.ad_title) custom.ad_title = String(ctx.ad.ad_title).slice(0, 100); }
  return {
    event_name: f.event,
    event_time: Math.floor(ts / 1000),
    event_id: `fn-${f.event}-${psid}-${day}`,
    action_source: "business_messaging",
    messaging_channel: "messenger",
    user_data: ud,
    custom_data: custom,
  };
}
