# osuka-chatlog

ตัวดักแชทเพจ Facebook เพื่อ **แยกว่าข้อความไหน Meta Business Agent ตอบ ข้อความไหนแอดมินตอบ**
และรู้ว่าลูกค้าคลิกแอดตัวไหนเข้ามา

ทำตามคู่มือ 23ADS ไฟล์ 01 · ต่อเข้ากับ `mixhub.fbchat_*` ที่มีอยู่แล้ว

---

## ทำไมต้องมีตัวนี้

Meta ส่งฟิลด์ 2 ตัวนี้มา **ทาง webhook ทางเดียว** ไม่มีใน API ที่ดึงย้อนหลังได้:

| ฟิลด์ | บอกอะไร |
|---|---|
| `message.ai_generated` | Business Agent เป็นคนตอบ |
| `referral.ad_id` + `ad_title` | ลูกค้าคลิกแอดตัวไหนเข้ามา |

**ข้อมูลเริ่มนับตั้งแต่วันที่ตัวนี้เริ่มทำงาน** ย้อนหลังเก็บไม่ได้เลย

---

## ไฟล์ในโปรเจกต์

| ไฟล์ | รันที่ไหน | ทำอะไร |
|---|---|---|
| `server.js` | เครื่องที่มี HTTPS สาธารณะ | รับ webhook จาก Meta เก็บลง SQLite |
| `sync_to_mixhub.py` | **เครื่อง mixhub (AI-000-D)** | ดึงจาก `/export` เข้า `mixhub.fbchat_*` |

**ไม่มี dependency เลยสักตัว** — ใช้ `node:sqlite` ที่มีใน Node 22+ ก๊อปไปวางแล้วรันได้เลย
(คู่มือใช้ `express` + `better-sqlite3` ซึ่งตัวหลังต้อง build native พังบ่อยบน Windows/VPS เปล่า)

---

## รันยังไง

```bash
node -v          # ต้อง >= 22
cp .env.example .env    # แล้วเติมค่า
node server.js
```

Windows PowerShell:
```powershell
$env:VERIFY_TOKEN="osuka-2026"; $env:APP_SECRET="..."; $env:EXPORT_TOKEN="..."; node server.js
```

บน VPS ให้รันค้างด้วย pm2:
```bash
pm2 start server.js --name chatlog && pm2 save
```

### ค่าที่ต้องตั้ง

| | เอามาจากไหน |
|---|---|
| `VERIFY_TOKEN` | ตั้งเอง ต้องใส่ค่าเดียวกันตอนผูก webhook ใน App Dashboard |
| `APP_SECRET` | Meta App → App settings → Basic → App Secret |
| `EXPORT_TOKEN` | ตั้งเอง สุ่มยาว ๆ — โทเคนให้ mixhub ดึงข้อมูล |

---

## ปลายทางที่เปิดไว้

| | ใครเรียก | ทำอะไร |
|---|---|---|
| `GET /webhook` | Meta | ตอบ verify challenge ตอนกด Verify ใน Dashboard |
| `POST /webhook` | Meta | รับ event (ตรวจลายเซ็นก่อนเสมอ) |
| `GET /health` | คน | ดูว่ายังมีชีวิต เก็บได้กี่แถว แยกตาม actor |
| `GET /export?token=…&since=…` | mixhub | ดึงข้อมูลไปวิเคราะห์ |

---

## ตั้งค่าฝั่ง Meta (สรุปจากคู่มือ Step 1-4)

1. **สร้าง App** ที่ developers.facebook.com → type **Business** → Add Product → **Messenger**
   **App Roles → เพิ่มแอดมินเพจทุกคนเป็น Admin/Developer** ← ไม่ทำ = เพจนั้นไม่ส่ง event มา
2. **ผูก webhook** — Messenger → Settings → Webhooks → object `Page`
   Callback URL = `https://<โดเมน>/webhook` · Verify token = `VERIFY_TOKEN`
   ติ๊ก 4 field: `messages` · `message_echoes` · `messaging_referrals` · `messaging_postbacks`
3. **subscribe ทีละเพจ**
   ```bash
   curl -X POST "https://graph.facebook.com/v25.0/<PAGE_ID>/subscribed_apps" \
     -d "subscribed_fields=messages,message_echoes,messaging_referrals,messaging_postbacks" \
     -d "access_token=<PAGE_ACCESS_TOKEN>"
   ```
4. **เช็ก** — `curl "https://graph.facebook.com/v25.0/<PAGE_ID>/subscribed_apps?access_token=..."`

> **App อยู่ใน Development mode ใช้ได้ ไม่ต้องขอ App Review**
> **Page token หมดอายุไม่กระทบ** — subscribe ครั้งเดียวแล้วทำงานต่อเอง

---

## ดึงเข้า mixhub

รันบนเครื่อง AI-000-D:
```powershell
$env:CHATLOG_URL="https://<โดเมน>"; $env:CHATLOG_TOKEN="<EXPORT_TOKEN>"; py -3 sync_to_mixhub.py
```

ดึงซ้ำได้ไม่เสียหาย (`mid` เป็น primary key) · จำตำแหน่งไว้ใน `.sync_state.json`
ตั้งเป็น Task Scheduler รายวันได้ แล้ว routine `osuka-chat-daily` 09:00 จะมีข้อมูลอ่าน

---

## การแยก actor — จุดที่พลาดกันง่ายที่สุด

| actor | เงื่อนไข | นับเป็น |
|---|---|---|
| `customer` | ไม่มี `is_echo` | ลูกค้า |
| `ai` | echo + **`ai_generated = true`** | Business Agent |
| `human` | echo + `app_id = 263902037430900` | คนพิมพ์ใน Page Inbox |
| `system` | echo + `app_id = 225915530485492` | Crmixer — **ตัดออกจากทุกการวัด** |
| `bot` | echo + app_id อื่น | ผิดปกติ ต้องแจ้งคน |

> ⚠️ **Business Agent กับแอดมินใช้ `app_id` เดียวกัน** (`263902037430900`)
> ตัวชี้ขาดคือ `ai_generated` เท่านั้น — ถ้าแยกด้วย "มี app_id ไหม" จะนับคนเป็น AI ทุกข้อความ
> โดยไม่มีอะไรฟ้อง แล้วรายงานผิดทั้งฉบับ

---

## PDPA — ตัวนี้ทำเกินคู่มือ

คู่มือเก็บข้อความดิบ **ตัวนี้กลบก่อนเก็บ** ตามที่ระบบเดิมของทีมทำ
(`legacy/tools/chat-analysis/chat_pull.php`: *"กลบข้อมูลส่วนบุคคลตั้งแต่ก่อนลงฐาน"*)

กลบ: อีเมล · เบอร์โทร · เลขยาว (บัญชี/พัสดุ/บัตรประชาชน) · ตัดข้อความที่ 300 ตัว

> ⚠️ **ห้ามเอาตัวกลบไปครอบ JSON ทั้งก้อน** — `timestamp` เป็นเลข 13 หลัก และ `psid`
> ก็เป็นเลขยาว จะโดนกลบไปด้วยแล้ว JSON พัง/เธรดพัง (เจอจริงตอนทดสอบ 10 ก.ย. 69)
> ต้องแตะเฉพาะ `message.text`

**ที่อยู่กลบด้วย regex ไม่ได้จริง** — ตัดความยาวช่วยลดความเสี่ยงได้บ้างเท่านั้น

---

## ทดสอบแล้วว่าอะไรใช้ได้ (10 ก.ย. 69)

ยิง payload จำลอง 8 event ตามรูปแบบจริงในคู่มือ:

```
verify challenge        200 + คืน challenge
ลายเซ็นผิด               401
ยิง event ซ้ำ 2 รอบ      ยังมี 7 แถว (ไม่ซ้ำ)

by_actor: ai 1 · human 2 · customer 3 · system 1
  → AI กับคนใช้ app_id เดียวกัน แต่แยกออกได้
  → Crmixer "/close 99999" ไม่ถูกนับเป็นยอดขาย
  → "/close 1,290.50" ของจริงเข้า close_amount = 1290.5
  → "โทรกลับ 081-234-5678" → "โทรกลับ [เบอร์]"
  → ad_title "BOF-0001 | [VDO30] | ..." เก็บครบ
  → pass_thread_control เก็บได้

sync เข้า mixhub → daily.py รายงาน:
  mixed 1 · no_reply 1 · AI รับหน้า 1 ส่งต่อคน 1
  คนใช้เวลารับต่อ 10.0 นาที (ตรงกับที่จำลอง)
```

**ยังไม่ได้ทดสอบกับ Meta จริง** — ต้องมี HTTPS สาธารณะก่อน

---

## ที่ยังต้องทำ

1. หาที่รันที่มี HTTPS สาธารณะ (VPS เล็ก / Vercel+ฐานคลาวด์ / tunnel จากเครื่องตัวเอง)
2. สร้าง Meta App + ผูก webhook + subscribe เพจ
3. **ตกลงกติกา `/close <ยอด>` กับทีมแอดมินก่อนเริ่มเก็บ** ไม่งั้น conversion เป็น 0 ทุกเพจ
   ⚠️ ข้อความนี้ลูกค้าเห็นด้วย — ตัดสินใจก่อนประกาศใช้
4. กรอก `mixhub.fbchat_pages` ว่าเพจไหนเปิด Business Agent ตั้งแต่วันไหน (`chat_system`, `agent_on_since`)
