/**
 * ส่วนขยาย -- รองรับ "แพทเทินที่แอดมินใช้จริง" ที่เจอในฐาน (ไม่ใช่เทมเพลตที่ออกแบบไว้)
 *
 * ของจริงมี 3 แบบ เรียงตามความน่าเชื่อถือ
 *   A. เทมเพลตมีหัวข้อ "สรุปรายการ" + ช่อง  -> เชื่อได้ ยิงอัตโนมัติ    (order_summary.js)
 *   B. บอทพิมพ์ "ได้รับข้อมูลแล้วค่ะ ... ยอดรวม N บาท" -> เชื่อได้ ยิงอัตโนมัติ
 *   C. แอดมินพิมพ์อิสระ แค่มีคำว่า "ยอดรวม"  -> ❌ ห้ามยิงอัตโนมัติ ต้องให้คนตรวจ
 *
 * ⚠️ ทำไมแบบ C ห้ามยิงอัตโนมัติ -- ของจริงในฐานพิสูจน์แล้ว
 *    "1 แบตเตอรี่ Ultracell+ 4.0Ah ราคา 1,060 บาท
 *     3 แท่นชาร์จแบตเตอรี่ 20V ราคา 650 บาท
 *     3สว่านโรตารี่ 852-k1 3590บาท
 *     ยอดรวม 6360 บาทค่ะ"
 *    1,060 + 650 + 3,590 = 5,300  แต่ยอดรวมเขียน 6,360 (ต่าง 1,060)
 *    เลข 1/3/3 ข้างหน้าเป็น "ลำดับข้อ" หรือ "จำนวนชิ้น" ก็ตีความได้ทั้งคู่
 *    เครื่องเดาไม่ได้ และเดาผิด = ยอดเข้า Meta ผิด
 */

const MONEY_G = /([\d][\d,]*(?:\.\d{1,2})?)/;
const SKU_G   = /\bO[A-Z]{1,4}-?\d{2,4}(?:-?[A-Z0-9]+)*\b/g;

/* ยอดรวม / รวมยอด / ยอดสุทธิ -- ของจริงใช้ "ยอดรวม" */
const TOTAL_RE = /(?:ยอดรวม|รวมยอด|ยอดสุทธิ|รวมทั้งสิ้น)\s*[:：]?\s*([\d][\d,]*(?:\.\d{1,2})?)/;

/* แบบ B -- บอทบนเพจ 370441686151976 (app_id 4724464494303704)
   "ได้รับข้อมูลแล้วค่ะ [รายการ] OSHT2001 จำนวน 1 ชุด ราคา 890 บาท ยอดรวม 890 บาทค่ะ"
   หน่วยที่เจอจริง: ชุด / ชิ้น / ตัว / ก้อน */
const BOT_RE = new RegExp(
  "ได้รับข้อมูลแล้ว\\S*\\s*(?:รายการ\\s*)?" +
  "([A-Z][A-Z0-9\\-]{3,})\\s*" +
  "จำนวน\\s*(\\d+)\\s*\\S+\\s*" +
  "ราคา\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s*บาท\\s*" +
  "ยอดรวม\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s*บาท"
);

const n = (s) => {
  if (s == null) return null;
  const v = Number(String(s).replace(/[,\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

/**
 * @returns {null | {mode, total, items, confidence, status, flags, note}}
 *   confidence: 'auto'   = ยิงได้เลย
 *               'review' = ต้องให้คนกดยืนยันก่อน
 */
export function parseRealWorld(text) {
  if (!text) return null;
  const t = String(text);

  /* ---------- B. บอท ---------- */
  const b = BOT_RE.exec(t);
  if (b) {
    const [, sku, qty, price, total] = b;
    const flags = [];
    const unit = n(price), tot = n(total), q = n(qty);
    /* ตรวจเลข -- ถ้า ราคา×จำนวน ไม่เท่ายอดรวม แปลว่าเทมเพลตเปลี่ยนไป ต้องรู้ตัว */
    if (unit != null && q != null && tot != null && Math.abs(unit * q - tot) > 0.01)
      flags.push("total_mismatch");
    return {
      mode: "bot_template",
      total: tot,
      items: [{ name: sku, sku, qty: q ?? 1, unit_price: unit }],
      confidence: flags.length ? "review" : "auto",
      status: flags.length ? "needs_review" : "ok",
      flags,
      note: "บอทพิมพ์ -- รูปแบบคงที่ เชื่อได้",
    };
  }

  /* ---------- C. แอดมินพิมพ์อิสระ ---------- */
  const m = TOTAL_RE.exec(t);
  if (!m) return null;

  const total = n(m[1]);
  const skus = [...new Set(t.toUpperCase().match(SKU_G) ?? [])];

  /* ราคารายบรรทัด -- ตัดท่อน "ยอดรวม N" ทิ้งก่อน ไม่งั้นนับยอดรวมเป็นราคาสินค้าด้วย
     ⚠️ ห้ามตัดทั้งบรรทัด -- ของจริงเขียน "9790+12590บาท ยอดรวม 22380 บาทค่ะ" บรรทัดเดียว
        ตัดทั้งบรรทัด = ราคาหายหมด เช็กยอดไม่ได้เลย */
  const body = t.replace(TOTAL_RE, " ");
  const prices = [];
  const seen = new Set();
  /* ⚠️ กันซ้ำที่ "ตำแหน่งของตัวเลข" ไม่ใช่ตำแหน่งที่ match เริ่ม
        "ราคาโปร 3610.- บาท" เข้าได้ทั้ง pattern ราคา และ pattern บาท
        ถ้ากันซ้ำด้วย g.index จะนับ 3610 สองรอบ ยอดเพี้ยนทันที */
  const push = (v, at) => {
    if (v == null || v < 50) return;          // ตัดเลขเล็ก อย่าง 2.0Ah / จำนวนก้อน
    if (seen.has(at)) return;
    seen.add(at); prices.push(v);
  };
  const posOf = (g, i) => g.index + g[0].indexOf(g[i]);
  /* เจอจริง 4 รูป: "ราคา 2590" (ไม่มีบาท) · "390บาท" · "3610.- บาท" · "9790+12590บาท" */
  for (const g of body.matchAll(/ราคา(?:โปร)?\s*([\d][\d,]*(?:\.\d{1,2})?)/g)) push(n(g[1]), posOf(g, 1));
  for (const g of body.matchAll(/([\d][\d,]*(?:\.\d{1,2})?)\s*(?:บาท|\.-)/g))    push(n(g[1]), posOf(g, 1));
  for (const g of body.matchAll(/([\d][\d,]*)\s*\+\s*([\d][\d,]*)/g)) {
    push(n(g[1]), posOf(g, 1));
    push(n(g[2]), g.index + g[0].lastIndexOf(g[2]));
  }
  const sum = prices.reduce((a, b2) => a + b2, 0);

  /* ⚠️ ตัวตัดสินว่าเชื่อได้ไหม = "ราคารายบรรทัดบวกแล้วเท่ายอดรวมหรือเปล่า"
     ตรง   = แอดมินคิดเลขมาครบ เชื่อยอดได้ -> ยิงได้
     ไม่ตรง = มีอะไรที่เครื่องอ่านไม่ครบ (ของแถม ส่วนลด จำนวนชิ้น) -> ให้คนตรวจ */
  const checked = prices.length >= 1 && total != null && Math.abs(sum - total) <= 0.01;

  const flags = ["freeform"];
  if (!skus.length) flags.push("no_sku");
  if (total == null) flags.push("no_total");
  if (!checked) flags.push("sum_unverified");

  /* ไม่มี SKU = ส่ง contents ให้ Meta ไม่ได้ แต่ value ยังส่งได้
     ยังให้ยิงได้ถ้ายอดตรวจผ่าน -- ยอดเงินคือสิ่งที่ Meta ต้องการที่สุด */
  return {
    mode: "freeform",
    total,
    items: skus.map((s) => ({ name: s, sku: s, qty: null, unit_price: null })),
    line_prices: prices,
    line_sum: sum,
    sum_checks: checked,
    confidence: checked ? "auto" : "review",
    status: checked ? "ok" : "needs_review",
    flags,
    note: checked
      ? "แอดมินพิมพ์อิสระ แต่ราคารายบรรทัดบวกแล้วเท่ายอดรวม -- เชื่อยอดได้"
      : "แอดมินพิมพ์อิสระ และบวกเลขแล้วไม่ตรงยอดรวม -- ต้องให้คนยืนยันก่อนยิง",
  };
}
