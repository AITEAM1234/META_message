# -*- coding: utf-8 -*-
"""เปิด field ที่ฝั่งเพจ ให้ตรงกับที่ตั้งไว้ระดับ app

ทำไมต้องมี:
    webhook มี 2 ชั้นที่ต้องเปิดตรงกัน
      ชั้น app  = "ฉันอยากได้ event อะไร"        (ตั้งใน App Dashboard)
      ชั้นเพจ   = "เพจนี้จะส่ง event อะไรให้ app"  (ตัวนี้แหละ)
    ขาดชั้นใดชั้นหนึ่ง = ไม่มีข้อมูลไหล และไม่มีอะไรฟ้อง

⚠️ ค่าเริ่มต้นเป็นโหมดดูอย่างเดียว -- ต้องใส่ --apply เองถึงจะเขียนจริง
⚠️ เขียนทับรายการ field เดิมทั้งชุด (Meta ไม่มี "เพิ่มทีละตัว")
   สคริปต์จึงรวมของเดิมเข้ากับของใหม่ให้ ไม่ตัดของเดิมทิ้ง

ใช้:
    python subscribe_pages.py                    ดูว่าจะเปลี่ยนอะไรบ้าง (ไม่เขียน)
    python subscribe_pages.py --apply            เขียนจริง ทุกเพจ
    python subscribe_pages.py --apply --only 106369459054082,106769424226678
"""
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

API = "https://graph.facebook.com/v21.0"

# ต้องตรงกับที่ติ๊กไว้ใน App Dashboard -> Webhooks -> object Page
WANT = [
    "messages",              # ลูกค้าพิมพ์เข้า
    "message_echoes",        # เพจตอบออก -- ตัวที่ใช้แยก AI ออกจากคน
    "messaging_referrals",   # ลูกค้าคลิกแอดไหนเข้ามา
    "messaging_postbacks",   # ลูกค้ากดปุ่ม
    "messaging_handovers",   # AI ส่งต่อให้คน
]

ENV_FILES = [
    r"C:\Users\Tada.p\Projects\Dail_Report_OSUKA\.env",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "env"),
]


def load_env():
    out = {}
    for p in ENV_FILES:
        if not os.path.exists(p):
            continue
        for line in io.open(p, encoding="utf-8-sig"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return out


def call(path, params, post=False):
    q = urllib.parse.urlencode(params)
    try:
        if post:
            req = urllib.request.Request(f"{API}/{path}", data=q.encode(), method="POST")
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        with urllib.request.urlopen(f"{API}/{path}?{q}", timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode("utf-8", "replace"))


def main():
    apply = "--apply" in sys.argv
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))

    env = load_env()
    tok = env.get("META_ACCESS_TOKEN")
    if not tok:
        raise SystemExit("ไม่พบ META_ACCESS_TOKEN")

    r = call("me/accounts", {"access_token": tok, "fields": "id,name", "limit": 100})
    if "error" in r:
        raise SystemExit("อ่านรายชื่อเพจไม่ได้: %s" % r["error"].get("message"))
    pages = [p for p in (r.get("data") or []) if not only or p["id"] in only]

    print("โหมด: %s · %d เพจ\n" % ("เขียนจริง" if apply else "ดูอย่างเดียว (ใส่ --apply ถึงจะเขียน)",
                                    len(pages)))
    changed = same = failed = 0

    for p in pages:
        pid, name = p["id"], p["name"][:38]

        info = call(pid, {"access_token": tok, "fields": "access_token"})
        ptok = info.get("access_token")
        if not ptok:
            print("  [ข้าม]   %-38s ขอ page token ไม่ได้: %s"
                  % (name, (info.get("error") or {}).get("message", "")[:50]))
            failed += 1
            continue

        cur = call("%s/subscribed_apps" % pid, {"access_token": ptok})
        if "error" in cur:
            print("  [ข้าม]   %-38s %s" % (name, cur["error"].get("message", "")[:50]))
            failed += 1
            continue

        have = []
        for a in (cur.get("data") or []):
            have += a.get("subscribed_fields") or []
        missing = [w for w in WANT if w not in have]

        if not missing:
            print("  [ครบแล้ว] %-38s" % name)
            same += 1
            continue

        # รวมของเดิม + ของใหม่ -- Meta เขียนทับทั้งชุด ถ้าส่งแค่ของใหม่ ของเดิมหาย
        merged = sorted(set(have) | set(WANT))
        print("  [ต้องเพิ่ม] %-38s + %s" % (name, ", ".join(missing)))

        if not apply:
            continue

        res = call("%s/subscribed_apps" % pid,
                   {"access_token": ptok, "subscribed_fields": ",".join(merged)},
                   post=True)
        if res.get("success"):
            print("             -> สำเร็จ (ตอนนี้มี %d field)" % len(merged))
            changed += 1
        else:
            print("             -> ล้มเหลว: %s" % (res.get("error") or {}).get("message", "")[:70])
            failed += 1

    print("\nสรุป: ครบอยู่แล้ว %d · แก้ไป %d · มีปัญหา %d" % (same, changed, failed))
    if not apply:
        print("ยังไม่ได้เขียนอะไร -- ใส่ --apply เมื่อพร้อม")
    return 0


if __name__ == "__main__":
    sys.exit(main())
