# osuka-chatlog

ตัวดักแชทเพจ Facebook เพื่อ **แยกว่าข้อความไหน Meta Business Agent ตอบ ข้อความไหนแอดมินตอบ**
และรู้ว่าลูกค้าคลิกแอดตัวไหนเข้ามา

รันบน **Vercel** · เก็บลง **Postgres** · ต่อเข้า `mixhub.fbchat_*`

---

## ทำไมต้องมีตัวนี้

Meta ส่ง 2 ฟิลด์นี้มา **ทาง webhook ทางเดียว** ไม่มีใน Conversations API ที่ดึงย้อนหลังได้:

| ฟิลด์ | บอกอะไร |
|---|---|
| `message.ai_generated` | Business Agent เป็นคนตอบ |
| `referral.ad_id` + `ad_title` | ลูกค้าคลิกแอดตัวไหนเข้ามา |

**ข้อมูลเริ่มนับตั้งแต่วันที่ deploy** ย้อนหลังเก็บไม่ได้เลย — ยิ่งช้าวันไหน ข้อมูลวันนั้นหายถาวร

---

## โครงไฟล์

```
api/webhook.js      ← Meta ยิงเข้าตรงนี้
api/health.js       ← เช็กว่าต่อฐานได้และเก็บได้กี่แถว
api/export.js       ← ให้ mixhub ดึงข้อมูล (ต้องมีโทเคน)
lib/store.js        ← ตรรกะกลาง: แยก actor · กลบ PII · เขียนฐาน
server.js           ← ตัวรันในเครื่องไว้ทดสอบ (Vercel ไม่ใช้ไฟล์นี้)
sync_to_mixhub.py   ← รันบนเครื่อง mixhub ดึงเข้า fbchat_*
```

### ⚠️ ทำไมใช้ Postgres ไม่ใช่ SQLite อย่างในคู่มือ 23ADS

Vercel เป็น serverless — **ดิสก์เป็นของชั่วคราว ลบทิ้งทุกครั้งที่ฟังก์ชันจบ**
ถ้าใช้ SQLite เขียนไฟล์ จะเจออาการที่แย่ที่สุด: verify ผ่าน · Meta บอกว่าเชื่อมสำเร็จ ·
แต่ข้อความหายทุกข้อความแบบเงียบ ๆ ไปรู้ตัวอีกทีตอนเปิดรายงานแล้วว่างเปล่าอีกเดือนถัดมา

และ **ห้ามใช้ `http.createServer().listen()`** — เวอร์ชันแรกของไฟล์นี้ทำแบบนั้น
deploy แล้วขึ้น `FUNCTION_INVOCATION_FAILED` ทันที เพราะ serverless ไม่ให้เปิดพอร์ตค้าง

---

## Deploy ขึ้น Vercel

### 1. เตรียม Postgres

ใช้ **Neon** (ฟรี) หรือ Supabase / Vercel Postgres — แชทเป็นข้อความล้วน วันละไม่กี่พันแถว
ฟรีเทียร์เหลือเฟือ **ไม่ต้องกังวลเรื่องขนาดเหมือนไฟล์รูปในระบบหลัก**

ตารางสร้างเองอัตโนมัติตอนเรียกครั้งแรก ไม่ต้องรัน SQL มือ

### 2. ตั้ง Environment Variables ใน Vercel

Project → Settings → Environment Variables (ใส่ให้ครบทั้ง **Production** และ **Preview**)

| ตัวแปร | เอามาจากไหน |
|---|---|
| `VERIFY_TOKEN` | ตั้งเอง — ต้องใส่ค่าเดียวกันตอนผูก webhook |
| `APP_SECRET` | Meta App → App settings → Basic → App Secret |
| `EXPORT_TOKEN` | ตั้งเอง สุ่มยาว ๆ |
| `DATABASE_URL` | connection string จาก Neon (`?sslmode=require`) |

**ตั้ง env แล้วต้อง redeploy** ค่าใหม่ถึงจะมีผล

### 3. เช็กว่าติดจริง

```
https://<โปรเจกต์>.vercel.app/api/health
```
ต้องได้ `{"ok":true,"messages":0,...}` — ถ้าขึ้น error แปลว่า `DATABASE_URL` ผิด

---

## ตั้งค่าฝั่ง Meta

1. **สร้าง App** — developers.facebook.com → type **Business** → Add Product → **Messenger**
   **App Roles → เพิ่มแอดมินเพจทุกคนเป็น Admin/Developer** ← ไม่ทำ = เพจนั้นไม่ส่ง event มา
2. **ผูก webhook** — Messenger → Settings → Webhooks → object `Page`
   - Callback URL = `https://<โปรเจกต์>.vercel.app/api/webhook`
   - Verify token = ค่า `VERIFY_TOKEN`
   - ติ๊ก 4 field: `messages` · `message_echoes` · `messaging_referrals` · `messaging_postbacks`
3. **subscribe ทีละเพจ**
   ```bash
   curl -X POST "https://graph.facebook.com/v25.0/<PAGE_ID>/subscribed_apps" \
     -d "subscribed_fields=messages,message_echoes,messaging_referrals,messaging_postbacks" \
     -d "access_token=<PAGE_ACCESS_TOKEN>"
   ```

> **App อยู่ใน Development mode ใช้ได้ ไม่ต้องขอ App Review**
> **Page token หมดอายุไม่กระทบ** — subscribe ครั้งเดียวแล้วทำงานต่อเอง

---

## ดึงเข้า mixhub

รันบนเครื่อง AI-000-D (ฐาน mixhub อยู่ในวง LAN เซิร์ฟเวอร์ข้างนอกต่อเข้ามาไม่ได้ ต้องให้ฝั่งในไปดึง):

```powershell
$env:CHATLOG_URL="https://<โปรเจกต์>.vercel.app/api"
$env:CHATLOG_TOKEN="<EXPORT_TOKEN>"
py -3 sync_to_mixhub.py
```

ดึงซ้ำได้ไม่เสียหาย (`mid` เป็น unique) · จำตำแหน่งใน `.sync_state.json`
ตั้งเป็น Task Scheduler รายวัน แล้ว routine `osuka-chat-daily` 09:00 จะมีข้อมูลอ่าน

---

## รันในเครื่องเพื่อทดสอบ

```bash
npm install
node --env-file=env server.js       # ต้องมีไฟล์ env ที่มี DATABASE_URL
# แล้วเปิด http://127.0.0.1:3000/api/health
```

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
> ตัวชี้ขาดคือ `ai_generated` เท่านั้น — ถ้าแยกด้วย "มี app_id ไหม" จะนับคนเป็น AI
> ทุกข้อความโดยไม่มีอะไรฟ้อง แล้วรายงานผิดทั้งฉบับ

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

## ⚠️ ความลับ

`.gitignore` กัน `env` (ไม่มีจุด) · `.env` · `.env.*` ไว้แล้ว
**เคยเกือบหลุดมาแล้ว** เพราะเวอร์ชันแรกกันแค่ `.env` แต่มีเครื่องมือสร้างไฟล์ชื่อ `env`
ที่มี `APP_SECRET` ตัวจริงอยู่ — ถ้าเพิ่มไฟล์ตั้งค่าใหม่ ตรวจ `git status` ทุกครั้งก่อน commit

---

## ทดสอบแล้วว่าอะไรใช้ได้ (10 ก.ย. 69)

ยิง payload จำลอง 8 event ตามรูปแบบจริงในคู่มือ เข้า handler ชุดเดียวกับที่ deploy
โดยต่อ Postgres จริง:

```
verify challenge        200 + คืน challenge
ลายเซ็นผิด               401
ยิง event ซ้ำ 2 รอบ      ยังมี 7 แถว (ไม่ซ้ำ)

by_actor: ai 1 · human 2 · customer 3 · system 1
  → AI กับคนใช้ app_id เดียวกัน แต่แยกออกได้
  → Crmixer "/close 99999" ไม่ถูกนับเป็นยอดขาย
  → "/close 1,290.50" ของจริงเข้า close_amount = 1290.50
  → "โทรกลับ 081-234-5678" → "โทรกลับ [เบอร์]"
  → ad_title "BOF-0001 | [VDO30] | ..." เก็บครบ
  → pass_thread_control เก็บได้

sync เข้า mixhub → daily.py รายงาน:
  mixed 1 · no_reply 1 · AI รับหน้า 1 ส่งต่อคน 1
  คนใช้เวลารับต่อ 10.0 นาที (ตรงกับที่จำลอง)
```

**ยังไม่ได้ทดสอบกับ Meta จริง** — ต้อง deploy แล้วผูก webhook ก่อน
สิ่งที่ต้องดูรอบแรก: `/api/health` ต้องขึ้น `messages` เพิ่มขึ้นจริงหลังมีคนทักเพจ

---

## ที่ยังต้องทำ

1. เปิดบัญชี Neon → เอา `DATABASE_URL` ใส่ Vercel → redeploy → เช็ก `/api/health`
2. สร้าง Meta App + ผูก webhook + subscribe เพจ
3. **ตกลงกติกา `/close <ยอด>` กับทีมแอดมินก่อนเริ่มเก็บ** ไม่งั้น conversion เป็น 0 ทุกเพจ
   ⚠️ ข้อความนี้ลูกค้าเห็นด้วย — ตัดสินใจก่อนประกาศใช้
4. กรอก `mixhub.fbchat_pages` ว่าเพจไหนเปิด Business Agent ตั้งแต่วันไหน
