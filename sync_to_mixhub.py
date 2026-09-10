# -*- coding: utf-8 -*-
"""ดึงข้อมูลจาก osuka-chatlog เข้า mixhub.fbchat_*

⚠️ ตัวนี้รันบนเครื่อง mixhub (AI-000-D) ไม่ใช่บนเครื่องที่รัน server.js
   เพราะฐานของ mixhub อยู่ในวง LAN -- เซิร์ฟเวอร์ข้างนอกต่อเข้ามาตรง ๆ ไม่ได้
   จึงต้องให้ฝั่งในเป็นคนไปดึง ผ่าน /api/export ที่มีโทเคนกั้น

⚠️ ดึงซ้ำได้ไม่เสียหาย -- mid เป็น primary key และ referral/handover มี unique index
   ถ้าไฟล์จำตำแหน่ง (.sync_state.json) หาย ก็แค่ดึงใหม่ทั้งหมด ช้าแต่ไม่ผิด

ใช้:  set CHATLOG_URL=https://<โดเมน>   (หรือ http://127.0.0.1:3000 ตอนทดสอบ)
      set CHATLOG_TOKEN=<EXPORT_TOKEN>
      python sync_to_mixhub.py
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = (os.environ.get("CHATLOG_URL") or "").rstrip("/")
TOKEN = os.environ.get("CHATLOG_TOKEN") or ""
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".sync_state.json")


def load_env(path):
    env = {}
    if os.path.exists(path):
        for line in io.open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def db():
    import psycopg

    env = load_env(os.path.join(os.environ["LOCALAPPDATA"], "Mixhub", "database.env"))
    return psycopg.connect(
        host=env.get("DB_HOST", "127.0.0.1"),
        port=env.get("DB_PORT", "55433"),
        dbname=env.get("DB_NAME") or env.get("DB_DATABASE", "mixhub"),
        user=env.get("DB_USER") or env.get("DB_USERNAME"),
        password=env.get("DB_PASS") or env.get("DB_PASSWORD"),
    )


def state():
    try:
        return json.load(io.open(STATE, encoding="utf-8"))
    except Exception:
        return {"messages": 0, "referrals": 0, "handovers": 0}


def fetch(since):
    q = urllib.parse.urlencode({"token": TOKEN, "since": since, "limit": 1000})
    with urllib.request.urlopen(f"{BASE}/api/export?{q}", timeout=60) as r:
        return json.load(r)


def js(v):
    """raw ที่มาจาก /api/export เป็น jsonb -- ฝั่ง Postgres คืนมาเป็น dict ไม่ใช่สตริง
    ⚠️ ส่ง dict เข้า psycopg ตรง ๆ ไม่ได้ ("can't adapt type dict") ต้องแปลงเป็น JSON ก่อน"""
    if v is None:
        return "{}"
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def prune(cursors, keep_days):
    """สั่ง chatlog ลบของเก่าที่ลงฐาน mixhub เรียบร้อยแล้ว

    ⚠️ เรียกได้เฉพาะหลัง conn.commit() ผ่าน และเขียน .sync_state.json เสร็จแล้วเท่านั้น
       ตำแหน่งที่ส่งไปต้องเป็น "ที่ลงฐานแล้วจริง" ไม่ใช่ "ที่ดึงมาได้"
       ถ้า commit ล้มแล้วยังสั่งลบ = ข้อมูลหายถาวร Meta ไม่ให้ดึงแชทย้อนหลัง
    """
    body = json.dumps({"cursors": cursors, "keep_days": keep_days}).encode("utf-8")
    q = urllib.parse.urlencode({"token": TOKEN})
    req = urllib.request.Request(f"{BASE}/api/prune?{q}", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def ts(ms):
    """ms epoch -> ISO ให้ Postgres อ่านเป็น timestamptz"""
    from datetime import datetime, timezone
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()


def main():
    if not BASE or not TOKEN:
        raise SystemExit("ต้องตั้ง CHATLOG_URL และ CHATLOG_TOKEN ก่อน")

    st = state()
    # ใช้ cursor ต่ำสุดของสามชนิด -- ดึงเกินมาบ้างไม่เป็นไร เพราะ insert กันซ้ำอยู่แล้ว
    since = min(int(st.get("messages", 0)), int(st.get("referrals", 0)), int(st.get("handovers", 0)))
    data = fetch(since)
    msgs, refs, hands = data["messages"], data["referrals"], data["handovers"]
    print(f"ดึงมาได้ ข้อความ {len(msgs)} · referral {len(refs)} · ส่งต่อ {len(hands)}")

    if not (msgs or refs or hands):
        print("ไม่มีอะไรใหม่")
        return 0

    with db() as conn, conn.cursor() as cur:
        for m in msgs:
            tid = f"{m['page_id']}:{m['psid']}"
            cur.execute(
                """INSERT INTO mixhub.fbchat_pages (page_id, subscribed_at) VALUES (%s, now())
                   ON CONFLICT (page_id) DO NOTHING""", (m["page_id"],))
            cur.execute(
                """INSERT INTO mixhub.fbchat_threads (thread_id, page_id, psid, started_at, last_msg_at)
                   VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (thread_id) DO UPDATE
                   SET last_msg_at = GREATEST(mixhub.fbchat_threads.last_msg_at, EXCLUDED.last_msg_at)""",
                (tid, m["page_id"], m["psid"], ts(m["ts"]), ts(m["ts"])))
            cur.execute(
                """INSERT INTO mixhub.fbchat_messages
                       (mid, thread_id, page_id, direction, actor, app_id, ai_generated,
                        metadata, sent_at, text_content, raw_payload)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (mid) DO NOTHING""",
                (m["mid"], tid, m["page_id"], m["direction"], m["actor"],
                 m.get("app_id") or "", bool(m.get("ai_generated")),
                 (m.get("metadata") or "")[:500], ts(m["ts"]),
                 m.get("text_masked") or "", js(m.get("raw"))))

            # /close -- ฝั่ง chatlog แกะยอดให้แล้ว ไม่ต้องมาแกะข้อความซ้ำ
            if m.get("has_close"):
                cur.execute(
                    """INSERT INTO mixhub.fbchat_closes
                           (thread_id, page_id, mid, amount, raw_text, closed_at)
                       VALUES (%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (mid) WHERE mid <> '' DO NOTHING""",
                    (tid, m["page_id"], m["mid"], m.get("close_amount"),
                     (m.get("text_masked") or "")[:500], ts(m["ts"])))

        for r in refs:
            tid = f"{r['page_id']}:{r['psid']}"
            cur.execute(
                """INSERT INTO mixhub.fbchat_referrals
                       (thread_id, mid, ad_id, ad_title, ref, source, seen_at, raw)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (thread_id, mid, ad_id) DO NOTHING""",
                (tid, r.get("mid") or "", r.get("ad_id") or "", r.get("ad_title") or "",
                 r.get("ref") or "", r.get("source") or "", ts(r["ts"]), js(r.get("raw"))))
            if r.get("ad_id"):
                cur.execute(
                    """UPDATE mixhub.fbchat_threads SET first_ad_id = %s
                        WHERE thread_id = %s AND first_ad_id = ''""",
                    (r["ad_id"], tid))

        for h in hands:
            tid = f"{h['page_id']}:{h['psid']}"
            cur.execute(
                """INSERT INTO mixhub.fbchat_handovers
                       (thread_id, page_id, event, app_id, metadata, happened_at, raw)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (thread_id, event, happened_at) DO NOTHING""",
                (tid, h["page_id"], h["event"], h.get("app_id") or "",
                 (h.get("metadata") or "")[:500], ts(h["ts"]), js(h.get("raw"))))
        conn.commit()

    # ⚠️ cursor มาจาก bigserial ซึ่ง Postgres ส่งเป็นสตริงทาง JSON ("7" ไม่ใช่ 7)
    #    ถ้าเก็บเป็นสตริง พอถึงแถวที่ 10 การเทียบจะกลายเป็นแบบตัวอักษร ("10" < "7")
    #    แล้ว min() รอบหน้าจะได้ตำแหน่งผิด ดึงซ้ำทั้งกองโดยไม่มีอะไรฟ้อง -- บังคับเป็น int
    st = {
        "messages":  max([int(m["cursor"]) for m in msgs],  default=int(st.get("messages", 0))),
        "referrals": max([int(r["cursor"]) for r in refs],  default=int(st.get("referrals", 0))),
        "handovers": max([int(h["cursor"]) for h in hands], default=int(st.get("handovers", 0))),
    }
    io.open(STATE, "w", encoding="utf-8").write(json.dumps(st))
    print(f"ลงฐาน mixhub แล้ว · ตำแหน่งล่าสุด {st}")

    # ลบของเก่าในฐานพัก -- ต้องสั่งเอง ไม่ทำเงียบ ๆ เพราะเป็นการลบข้อมูล
    if "--prune" in sys.argv:
        keep = int(os.environ.get("CHATLOG_KEEP_DAYS") or 7)
        try:
            r = prune(st, keep)
            d = r.get("deleted") or {}
            print(f"ลบของเก่าเกิน {r.get('kept_days')} วันแล้ว · "
                  f"ข้อความ {d.get('messages', 0)} · referral {d.get('referrals', 0)} · "
                  f"ส่งต่อ {d.get('handovers', 0)}")
        except Exception as e:
            # ลบไม่สำเร็จไม่ใช่เรื่องคอขาดบาดตาย ข้อมูลลง mixhub ไปแล้ว
            print(f"[เตือน] สั่งลบของเก่าไม่สำเร็จ (ข้อมูลลง mixhub แล้ว ไม่กระทบ): {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
