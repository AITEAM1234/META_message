# -*- coding: utf-8 -*-
"""ตรวจทุกชั้นของระบบเก็บแชท แล้วบอกว่าชั้นไหนขาด

ทำไมต้องมี:
    ระบบนี้มี 5 ชั้นที่ต้องถูกพร้อมกัน ขาดชั้นเดียวคือไม่มีข้อมูลไหล
    และ "ไม่มีข้อมูล" หน้าตาเหมือนกันหมดไม่ว่าจะพังชั้นไหน
    เคยพลาดมาแล้ว 2 รอบเพราะไล่ดูด้วยตา:
      - ตั้ง Callback URL ที่ object Catalog แทน Page
      - เปิด marketing_message_echoes แทน message_echoes (ชื่อคล้ายกันมาก)

อ่านอย่างเดียว ไม่แก้ไขอะไรทั้งสิ้น

ใช้:  python check_setup.py
"""
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APP_ID = "1609798180568059"
VERCEL = "https://meta-message-seven.vercel.app"
API = "https://graph.facebook.com/v21.0"

NEED_FIELDS = ["messages", "message_echoes", "messaging_referrals",
               "messaging_postbacks", "messaging_handovers"]
# เปิดไว้แล้วไม่พัง แต่ทำให้ตัวเลข "เพจตอบ" บวมเกินจริง
NOISY_FIELDS = ["marketing_message_echoes", "message_reads", "message_deliveries"]

ENV_FILES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "env"),
    r"C:\Users\Tada.p\Projects\Dail_Report_OSUKA\.env",
]

OK, BAD, WARN = "  [ผ่าน]  ", "  [ตก]   ", "  [เตือน]"
problems = []
warnings = []


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


def g(path, params):
    q = urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(f"{API}/{path}?{q}", timeout=45) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode("utf-8", "replace"))
    except Exception as e:
        return {"error": {"message": str(e)}}


def http(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def check(cond, name, detail="", fatal=True):
    if cond:
        print(OK + name + (("  " + detail) if detail else ""))
    else:
        print((BAD if fatal else WARN) + name + (("  " + detail) if detail else ""))
        (problems if fatal else warnings).append(name)
    return cond


env = load_env()

print("=" * 68)
print("ชั้นที่ 1 — ค่าตั้งในเครื่อง")
print("=" * 68)
for k in ("VERIFY_TOKEN", "APP_SECRET", "EXPORT_TOKEN", "DATABASE_URL"):
    check(bool(env.get(k)), "มีค่า %s" % k)
u = env.get("DATABASE_URL", "")
if u:
    check(":6543" in u and "pooler" in u, "DATABASE_URL ใช้ Transaction pooler (6543)",
          "ถ้าใช้ Direct 5432 จะต่อจาก Vercel ไม่ได้")
    check("[" not in u and "]" not in u, "DATABASE_URL ไม่มีวงเล็บ [ ] ค้าง")
check(bool(env.get("META_ACCESS_TOKEN")), "มี META_ACCESS_TOKEN (ไว้คุยกับ Graph)")

print()
print("=" * 68)
print("ชั้นที่ 2 — เว็บที่รับ webhook (Vercel)")
print("=" * 68)
code, body = http(VERCEL + "/api/health")
check(code == 200, "/api/health ตอบ 200", "ได้ %s" % code)
check("sso-api" not in body and code != 302,
      "ไม่มี Deployment Protection ขวาง", "ถ้าขวาง Meta จะ verify ไม่ผ่าน")
try:
    health = json.loads(body)
except Exception:
    health = {}
check(health.get("ok") is True, "ต่อฐาน Supabase ได้จาก Vercel")

vt = env.get("VERIFY_TOKEN", "")
q = urllib.parse.urlencode({"hub.mode": "subscribe", "hub.verify_token": vt,
                            "hub.challenge": "PROBE123"})
code, body = http(f"{VERCEL}/api/webhook?{q}")
check(code == 200 and body.strip() == "PROBE123",
      "ตอบ verify challenge ถูกต้อง (ท่าที่ Meta ใช้ตอนกด Verify)")
q = urllib.parse.urlencode({"hub.mode": "subscribe", "hub.verify_token": "wrong",
                            "hub.challenge": "PROBE123"})
code, _ = http(f"{VERCEL}/api/webhook?{q}")
check(code == 403, "โทเคนผิดถูกปฏิเสธ 403")

print()
print("=" * 68)
print("ชั้นที่ 3 — แอป Meta")
print("=" * 68)
apptok = "%s|%s" % (APP_ID, env.get("APP_SECRET", ""))
subs = g(f"{APP_ID}/subscriptions", {"access_token": apptok})
if not check("error" not in subs, "APP_SECRET ตรงกับแอป %s" % APP_ID,
             (subs.get("error") or {}).get("message", "")[:60]):
    print("\n>>> หยุดตรวจ: APP_SECRET ผิด ชั้นถัดไปเช็กไม่ได้")
    sys.exit(1)

rows = subs.get("data") or []
page = next((x for x in rows if x.get("object") == "page"), None)
check(page is not None, "มี webhook ที่ object 'page'",
      "ถ้าไปตั้งที่ Catalog/User จะไม่มีข้อความแชทเลย")
if page:
    check(page.get("active") is True, "subscription active")
    check(page.get("callback_url") == VERCEL + "/api/webhook",
          "Callback URL ถูกต้อง", page.get("callback_url", ""))
    got = [f.get("name") if isinstance(f, dict) else f for f in (page.get("fields") or [])]
    for f in NEED_FIELDS:
        check(f in got, "field %s" % f)
    for f in NOISY_FIELDS:
        if f in got:
            check(False, "field %s เปิดค้างอยู่" % f,
                  "ทำให้ตัวเลขเพจตอบบวมเกินจริง", fatal=False)
for x in rows:
    if x.get("object") != "page":
        check(False, "มี object '%s' ค้างอยู่" % x.get("object"),
              "ลบทิ้งได้ ไม่กวนแต่ทำให้สับสน", fatal=False)

roles = g(f"{APP_ID}/roles", {"access_token": apptok})
n_admin = len([r for r in (roles.get("data") or []) if r.get("role") == "administrators"])
check(n_admin > 0, "มีคนถือ role ใน app (%d คน)" % n_admin,
      "คู่มือ 23ADS: admin เพจต้องมี role ไม่งั้น webhook เพจนั้นไม่มา")

print()
print("=" * 68)
print("ชั้นที่ 4 — เพจ")
print("=" * 68)
tok = env.get("META_ACCESS_TOKEN", "")
acc = g("me/accounts", {"access_token": tok, "fields": "id,name", "limit": 100})
pages = acc.get("data") or []
check(bool(pages), "เข้าถึงเพจได้ (%d เพจ)" % len(pages))
bad_pages = []
for p in pages:
    ptok = g(p["id"], {"access_token": tok, "fields": "access_token"}).get("access_token")
    if not ptok:
        bad_pages.append((p["name"], "ขอ page token ไม่ได้")); continue
    sa = g("%s/subscribed_apps" % p["id"], {"access_token": ptok})
    have = []
    for a in (sa.get("data") or []):
        if str(a.get("id")) == APP_ID:
            have = a.get("subscribed_fields") or []
    if not have:
        bad_pages.append((p["name"], "ยังไม่ subscribe app นี้")); continue
    miss = [f for f in NEED_FIELDS if f not in have]
    if miss:
        bad_pages.append((p["name"], "ขาด " + ", ".join(miss)))
check(not bad_pages, "ทุกเพจ subscribe ครบทุก field",
      "" if not bad_pages else "%d เพจมีปัญหา" % len(bad_pages))
for name, why in bad_pages:
    print("           - %-40s %s" % (name[:40], why))

print()
print("=" * 68)
print("ชั้นที่ 5 — มีข้อมูลไหลเข้าจริงไหม")
print("=" * 68)
n = health.get("messages", 0)
if n:
    print(OK + "มีข้อความแล้ว %d ใบ" % n)
    print("           by_actor: %s" % json.dumps(health.get("by_actor") or {}, ensure_ascii=False))
else:
    print(WARN + "ยังไม่มีข้อความสักใบ")
    print("           ถ้าชั้น 1-4 ผ่านหมด แปลว่าตั้งค่าถูกแล้ว เหลือแค่ยังไม่มีใครทัก")
    print("           ทดสอบ: ให้คนที่มี role ใน app ทักเข้าเพจด้วย Facebook ส่วนตัว")
    print("           (dev mode ส่ง event เฉพาะคนที่มี role -- ลูกค้าทั่วไปต้องเผยแพร่แอปก่อน)")

print()
print("=" * 68)
if problems:
    print("ตก %d ข้อ:" % len(problems))
    for p in problems:
        print("   - " + p)
else:
    print("ชั้น 1-4 ผ่านหมด — ตั้งค่าครบถ้วน")
if warnings:
    print("\nเตือน %d ข้อ (ไม่ถึงกับพัง แต่ควรเก็บกวาด):" % len(warnings))
    for w in warnings:
        print("   - " + w)
print("=" * 68)
sys.exit(1 if problems else 0)
