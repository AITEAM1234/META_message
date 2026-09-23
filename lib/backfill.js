/**
 * เติมแชทที่ webhook ตกหล่น ด้วย Meta Graph API -- ฝั่ง Vercel (23 ก.ย. 69)
 *
 * ทำไมต้องมีทั้งที่ในเครื่องมี chat_gapfill.py อยู่แล้ว:
 *   ตัวในเครื่องรันด้วย Task Scheduler ของพีซีเครื่องเดียว ปิดเครื่อง/ย้ายเครื่องเมื่อไหร่ข้อมูลหยุดเติมทันที
 *   ส่วนตัวนี้อยู่ที่เดียวกับ webhook เลย -- Meta หยุดส่งเมื่อไหร่ ตัวนี้ตามเก็บให้เองบนคลาวด์
 *   (ของจริง 22-23 ก.ย. 69: เพจ OSUKA powertool ได้ webhook แค่ 53 จาก 437 ห้องใน 24 ชม.)
 *
 * ⚠️ อ่านอย่างเดียว (GET) ไม่ส่งข้อความหาใครทั้งสิ้น
 * ⚠️ เก็บลงตาราง api_fill แยกจาก raw_events -- raw_events คือ "ก้อนตามที่ Meta ส่งมาเป๊ะ"
 *    ของที่เราประกอบเองจาก API ห้ามปนเข้าไป (sync_to_mixhub ใช้ seq เป็น cursor)
 * ⚠️ ตารางเดียวกับที่ chat_gapfill.py ใช้ -- คีย์เป็น mid ทั้งคู่ เขียนซ้ำกันได้ ไม่เกิดแถวซ้ำ
 * ⚠️ กลบข้อมูลส่วนบุคคลด้วย maskPII ก่อนลงฐานเสมอ เหมือนทาง webhook
 */

import { db, maskPII } from "./store.js";

const GRAPH = "https://graph.facebook.com/v21.0/";
const SCHEMA = (process.env.DB_SCHEMA || "chatlog").trim();
const T = (n) => `${SCHEMA}.${n}`;

/* ป้ายที่ Meta ใส่มาเอง -- ใช้แยกว่าใครพูด เพราะ Graph ไม่ให้ app_id / ai_generated เหมือน webhook
   (กติกาเดียวกับ chat_gapfill.py ห้ามแก้ให้ต่างกัน ไม่งั้นข้อมูลสองทางตีกัน) */
const HANDOVER_RE = /(โอนแชทนี้ให้|transferred this chat)/i;
const AI_ON_RE = /(AI agent will respond|เอเจนต์ AI ของคุณจะตอบกลับ)/i;
const SYSTEM_RE = /^(.{0,40}(replied to (an ad|a post|your)|ได้ตอบกลับโพสต์|ทำเครื่องหมายคำสั่งซื้อ|สร้างคำสั่งซื้อ|marked the order as paid|created an order))/i;

async function graph(path, params) {
  const url = GRAPH + path + "?" + new URLSearchParams(params).toString();
  const r = await fetch(url, { method: "GET" });
  const j = await r.json().catch(() => ({}));
  if (j?.error) return { __error: j.error.message || "graph error" };
  return j;
}

/* ⚠️ ต้องเป็นโครงเดียวกับที่ chat_gapfill.py สร้างไว้เป๊ะ (filled_at เป็น timestamptz ไม่ใช่ bigint)
   สองตัวเขียนตารางเดียวกัน โครงต่างกันเมื่อไหร่ ตัวที่สร้างทีหลังจะพังหรือได้คอลัมน์ผิดชนิด */
export async function ensureFillTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${T("api_fill")} (
      mid         text PRIMARY KEY,
      page_id     text NOT NULL,
      psid        text NOT NULL,
      conv_id     text NOT NULL,
      ts          bigint NOT NULL,           -- มิลลิวินาที แบบเดียวกับ raw_events
      kind        text NOT NULL,             -- customer | ai | human | handoff | system
      text_masked text,
      filled_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS api_fill_page_ts ON ${T("api_fill")}(page_id, psid, ts);`);
}

/** เวลาล่าสุดที่เรามีของแต่ละห้อง (ดูทั้ง webhook และที่เคยเติมไว้) */
async function latestPerRoom(client, sinceMs) {
  const out = new Map();
  const a = await client.query(
    `SELECT page_id, psid, max(ts) AS ts FROM ${T("api_fill")} WHERE ts > $1 GROUP BY 1,2`, [sinceMs]);
  for (const r of a.rows) out.set(`${r.page_id}:${r.psid}`, Number(r.ts));

  /* ฝั่ง webhook ต้องแกะจาก jsonb -- ห้องเดียวกันเอาค่าที่ใหม่กว่า */
  const b = await client.query(
    `SELECT e->>'id' AS page,
            coalesce(x->'sender'->>'id', '') AS s,
            coalesce(x->'recipient'->>'id', '') AS rcp,
            max((x->>'timestamp')::bigint) AS ts
       FROM ${T("raw_events")} r,
            jsonb_array_elements(r.raw->'entry') e,
            jsonb_array_elements(coalesce(e->'messaging','[]'::jsonb) || coalesce(e->'standby','[]'::jsonb)) x
      WHERE r.received_at > $1
      GROUP BY 1,2,3`, [sinceMs]);
  for (const r of b.rows) {
    const page = String(r.page || "");
    const psid = r.s && r.s !== page ? r.s : r.rcp;
    if (!page || !psid) continue;
    const k = `${page}:${psid}`;
    out.set(k, Math.max(out.get(k) || 0, Number(r.ts)));
  }
  return out;
}

/**
 * ดึงห้องที่ขยับหลังจากของที่เรามี แล้วเก็บข้อความที่ยังไม่มีลง api_fill
 * @param {{lookbackH?:number, convLimit?:number, budgetMs?:number, dry?:boolean}} opt
 */
export async function backfill(opt = {}) {
  const lookbackH = opt.lookbackH ?? 6;
  const convLimit = opt.convLimit ?? 25;
  const budgetMs = opt.budgetMs ?? 8000;      // Vercel ตัดฟังก์ชันที่รันนาน -- เก็บเท่าที่ทันแล้วค่อยต่อรอบหน้า
  const started = Date.now();
  const token = process.env.META_ACCESS_TOKEN || "";
  if (!token) return { ok: false, error: "ไม่มี META_ACCESS_TOKEN" };

  const sinceMs = Date.now() - lookbackH * 3600 * 1000;
  const client = await db().connect();
  const report = { ok: true, pages: 0, rooms: 0, saved: 0, skipped: 0, ranOutOfTime: false, errors: [] };
  try {
    await ensureFillTable(client);
    const latest = await latestPerRoom(client, sinceMs);

    const acc = await graph("me/accounts", { access_token: token, fields: "id,name,access_token", limit: "50" });
    if (acc.__error) return { ok: false, error: acc.__error };

    /* ⚠️ ต้องยิงขนาน -- ไล่ทีละเพจใช้เวลา ~20 วินาที ซึ่งเกินเวลาที่ Vercel ให้ฟังก์ชันรัน
       15 เพจยิงพร้อมกันจบใน ~2 วินาที (วัดจริง 23 ก.ย. 69) */
    const pages = (acc.data || []).filter((p) => p.access_token);
    const convs = await Promise.all(pages.map(async (page) => {
      const r = await graph(`${page.id}/conversations`, {
        access_token: page.access_token, fields: "id,updated_time,participants", limit: String(convLimit),
      });
      return { page, r };
    }));

    /* คัดเฉพาะห้องที่ Graph บอกว่าขยับหลังของที่เรามี = webhook ตกหล่นจริง */
    const todo = [];
    for (const { page, r } of convs) {
      report.pages++;
      if (r.__error) { report.errors.push(`${page.name}: ${r.__error}`); continue; }
      for (const c of r.data || []) {
        const upd = Date.parse(c.updated_time || "") || 0;
        if (upd < sinceMs) continue;
        const other = (c.participants?.data || []).find((x) => String(x.id) !== String(page.id));
        const psid = String(other?.id || "");
        if (!psid) continue;
        const ours = latest.get(`${page.id}:${psid}`) || 0;
        if (ours && upd <= ours + 60_000) continue;
        todo.push({ page, conv: c, psid });
      }
    }

    /* ดึงข้อความของห้องที่ขาด ทีละชุด -- ไม่ยิงทีเดียวหมดเพราะ Graph จำกัดอัตราเรียก */
    const CHUNK = 6;
    for (let i = 0; i < todo.length; i += CHUNK) {
      if (Date.now() - started > budgetMs) { report.ranOutOfTime = true; break; }
      const part = todo.slice(i, i + CHUNK);
      const got = await Promise.all(part.map(async (t) => ({
        t,
        m: await graph(`${t.conv.id}/messages`, {
          access_token: t.page.access_token, fields: "id,message,from,created_time", limit: "25",
        }),
      })));

      for (const { t, m } of got) {
        if (m.__error) { report.errors.push(`ห้อง …${t.psid.slice(-6)}: ${m.__error}`); continue; }
        report.rooms++;
        const pid = String(t.page.id);
        /* ไล่จากเก่าไปใหม่ -- ป้าย "AI จะตอบ" กับ "โอนแชทให้คน" เป็นตัวบอกว่าหลังจากนั้นใครพูด */
        const list = (m.data || []).slice().sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
        let aiOn = false, handed = false;
        const rows = [];
        for (const msg of list) {
          const text = String(msg.message || "").trim();
          const ts = Date.parse(msg.created_time || "") || 0;
          const fromPage = String(msg.from?.id || "") === pid;
          let kind;
          if (!fromPage) kind = "customer";
          else if (HANDOVER_RE.test(text)) { kind = "handoff"; handed = true; }
          else if (AI_ON_RE.test(text)) { kind = "system"; aiOn = true; }
          else if (SYSTEM_RE.test(text)) kind = "system";
          else kind = aiOn && !handed ? "ai" : "human";
          rows.push([String(msg.id), pid, t.psid, String(t.conv.id), ts, kind, maskPII(text).slice(0, 300)]);
        }
        if (opt.dry) { report.skipped += rows.length; continue; }
        if (!rows.length) continue;

        /* ⚠️ แทรกทีละแถวไม่ไหว -- ฐานอยู่ไกล (Supabase pooler) แถวละ ~0.4 วิ
           50 แถวก็ 20 วินาทีแล้ว เกินเวลาที่ Vercel ให้ -- ยัดเป็นคำสั่งเดียวต่อห้อง */
        const vals = rows.map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`).join(",");
        const w = await client.query(
          `INSERT INTO ${T("api_fill")} (mid, page_id, psid, conv_id, ts, kind, text_masked)
                VALUES ${vals} ON CONFLICT (mid) DO NOTHING`, rows.flat());
        report.saved += w.rowCount;
        report.skipped += rows.length - w.rowCount;
      }
    }
  } catch (e) {
    report.ok = false;
    report.errors.push(String(e?.message || e));
  } finally {
    client.release();
  }
  report.tookMs = Date.now() - started;
  return report;
}
