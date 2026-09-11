# คู่มือติดตั้งระบบเก็บแชท — ฉบับทำใหม่ตั้งแต่ศูนย์

เขียนจากของที่ตั้งเสร็จแล้วจริง 11 ก.ย. 69 · ทุกขั้นมีคำสั่งตรวจกำกับ

---

## ทำไมต้องมีคู่มือนี้

ระบบนี้มี **5 ชั้นที่ต้องถูกพร้อมกัน** ขาดชั้นเดียวคือไม่มีข้อมูลไหล

**และนี่คือปัญหาที่แท้จริง: "ไม่มีข้อมูล" หน้าตาเหมือนกันหมดไม่ว่าจะพังชั้นไหน**
ไม่มี error ไม่มี log ไม่มีอะไรฟ้อง — `/api/health` ขึ้น `messages: 0` เหมือนเดิมทุกกรณี

```
ชั้น 1  ค่าตั้งในเครื่อง (env)
ชั้น 2  เว็บรับ webhook (Vercel + Supabase)
ชั้น 3  แอป Meta        (Callback URL + field)
ชั้น 4  เพจ             (subscribed_apps ทีละเพจ)
ชั้น 5  ข้อมูลจริงไหล
```

**ชั้น 3 กับ 4 ต้องเปิด field ตรงกัน** — แอปบอกว่า "อยากได้อะไร" เพจบอกว่า "จะส่งอะไรให้"
ขาดฝั่งใดฝั่งหนึ่งคือตกหล่นเงียบ ๆ

---

## ตรวจทุกชั้นด้วยคำสั่งเดียว

```bash
cd C:\Users\Tada.p\Desktop\osuka-chatlog && python check_setup.py
```

**ใช้อันนี้แทนการไล่ดูด้วยตา** — ที่พลาดมา 2 รอบเพราะไล่ดูเองในหน้าเว็บ

---

## 5 จุดที่พลาดมาแล้วจริง

### 1. ตั้ง Callback URL ผิด object

หน้า Webhooks ของ Meta มีแถบซ้ายเลือก object: `Catalog` `User` `Page` `Permissions` …
**ค่าเริ่มต้นไม่ใช่ Page** เผลอกรอก URL ลง `Catalog` แล้วกดบันทึกไปทั้งอย่างนั้น

**อาการ:** บันทึกผ่าน ขึ้นเขียว ดูเหมือนสำเร็จทุกอย่าง แต่ไม่มีข้อความแชทเลยสักใบ

**สังเกตยังไง:** ดูรายการ field ข้างล่าง ถ้าเห็น `items_batch` / `product_feed` = อยู่ผิด object
ของที่ถูกต้องจะเห็น `messages` / `message_echoes`

### 2. เปิด field ผิดตัว — `marketing_message_echoes`

รายการ field เรียงตามตัวอักษร และ `marketing_message_echoes` มาก่อน `message_echoes`

| ชื่อ | คืออะไร |
|---|---|
| `marketing_message_echoes` | ข้อความโปรโมทแบบ broadcast ที่ต้องจ่ายเงิน |
| **`message_echoes`** | **ข้อความที่เพจตอบลูกค้าในแชทปกติ ← ที่ต้องการ** |

**ทำไมร้ายแรง:** ไม่เปิด `message_echoes` = ไม่เห็นฝั่งเพจตอบเลย เหลือแต่ข้อความลูกค้าขาเข้า
ทั้งระบบนี้ทำมาเพื่อแยก AI กับคน ซึ่งอยู่ในฝั่งที่เพจตอบทั้งหมด

**ตำแหน่ง:** เลื่อนผ่าน `marketing_*` และ `merchant_*` ไปจนถึงกลุ่ม `message_*`
`message_echoes` อยู่ถัดจาก `message_deliveries` หนึ่งบรรทัด

### 3. ลืมว่าฝั่งเพจต้องเปิด field แยกอีกชั้น

ตั้งที่แอปเสร็จแล้วไม่พอ **เพจต้อง subscribe field ชุดเดียวกันด้วย**

เพจทั้ง 15 เดิมเปิดไว้แค่ `messages, messaging_postbacks, message_reads, feed`
ขาด 3 ตัวที่เพิ่งเปิดที่แอป

**ทำมือ 15 รอบเสี่ยงพลาดแบบข้อ 2** ใช้สคริปต์:

```bash
python subscribe_pages.py            # ดูก่อนว่าจะเปลี่ยนอะไร
python subscribe_pages.py --apply    # เขียนจริง
```

⚠️ **Meta ไม่มีคำสั่ง "เพิ่ม field ทีละตัว"** — มันเขียนทับทั้งชุด
ส่งแค่ field ใหม่ไป ของเดิม (`message_reads`, `feed`) จะหายเงียบ ๆ
สคริปต์รวม `set(ของเดิม) | set(ของใหม่)` ให้ก่อนส่งแล้ว

### 4. ใช้ DATABASE_URL ผิดแบบ

Supabase ให้สตริงมา 2 แบบ **ต้องใช้ Transaction pooler เท่านั้น**

```
❌ postgresql://postgres:PASS@db.xxx.supabase.co:5432/postgres
✅ postgresql://postgres.xxx:PASS@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres
              ^^^^^^^^^^^^^^ มี .รหัสโปรเจกต์   ^^^^^^ pooler       ^^^^ 6543
```

**ทำไม Direct ใช้ไม่ได้:** แพลนฟรีเปิด 5432 เฉพาะ IPv6 ซึ่ง Vercel ไม่มีให้ฟังก์ชันใช้
ต่อไม่ติดแล้วขึ้น timeout เฉย ๆ ไม่บอกสาเหตุ

**กับดักย่อย** ที่เจอบ่อย:
- ลืมลบวงเล็บ `[ ]` รอบรหัสผ่าน (Supabase ใส่มาเป็นตัวอย่าง)
- ใส่อัญประกาศครอบค่าใน Vercel — มันเก็บอัญประกาศไปด้วยจริง ๆ
- รหัสมี `@` — **อันนี้ผ่านได้** ตัวแกะ URL นับ `@` ตัวสุดท้ายเป็นตัวแบ่ง ทดสอบแล้ว

### 5. เข้าใจผิดเรื่อง "ต้องเผยแพร่แอปไหม"

**หน้าจอ Meta** ขึ้นกรอบแดง: *"จะไม่มีการส่งข้อมูลการผลิต เว้นแต่แอพจะได้รับการเผยแพร่"*
**คู่มือ 23ADS** เขียน: *"ไม่ต้องขอ App Review — Development mode ก็รับ webhook ได้ครบ"*

**สองอันนี้พูดคนละเรื่อง ไม่ได้ขัดกัน:**

| | ใช้กับใคร |
|---|---|
| คู่มือ | คนที่**มี role ใน app** — พอสำหรับทดสอบและพิสูจน์ว่าระบบทำงาน |
| กรอบแดง | **ลูกค้าจริงทั่วไป** ที่ไม่มี role ใน app |

⚠️ คู่มือมี**เงื่อนไขแนบมา**ที่อ่านข้ามง่ายมาก:
> *"เงื่อนไข: คนที่เป็น admin เพจต้องมี role Admin/Developer ใน app"*

ตรวจแล้วแอปนี้มี administrator 7 คน — เงื่อนไขผ่าน

**วิธีทดสอบให้จบ:** ให้คนใน 7 คนนั้นเอา Facebook ส่วนตัวทักเข้าเพจ
ถ้า `messages` ขยับ = ระบบใช้ได้ · เหลือแค่ตอบว่าลูกค้าทั่วไปต้องเผยแพร่ก่อนไหม

---

## ขั้นตอนติดตั้งตั้งแต่ศูนย์

### ชั้น 1 — ไฟล์ env

```
VERIFY_TOKEN=<ตั้งเอง สุ่มยาว ๆ>
APP_SECRET=<App settings -> Basic -> App Secret>
EXPORT_TOKEN=<ตั้งเอง สุ่มยาว ๆ>
DATABASE_URL=<Supabase -> Connect -> Transaction pooler>
```

ไม่มีอัญประกาศ · ไม่มีช่องว่างรอบ `=` · `.gitignore` กัน `env` ไว้แล้ว

### ชั้น 2 — Vercel

```
Repository       AITEAM1234/META_message
Root Directory   ./  (รากเลย)
Framework        Other
Build Command    เว้นว่าง
```

ใส่ env 4 ตัวเดียวกัน แล้ว **ปิด Deployment Protection**
(`Settings → Deployment Protection → Disabled` — ไม่ปิดแล้ว Meta จะ verify ไม่ผ่าน)

ตรวจ:
```bash
curl https://meta-message-seven.vercel.app/api/health
# ต้องได้ {"ok":true,"messages":0,...}
```

### ชั้น 3 — แอป Meta

`developers.facebook.com/apps/1609798180568059/webhooks/`

1. **เลือก object `Page` ในแถบซ้ายก่อน** ← จุดพลาดข้อ 1
2. `URL การเรียกกลับ` = `https://meta-message-seven.vercel.app/api/webhook`
3. `ตรวจสอบยืนยันโทเค็น` = ค่า `VERIFY_TOKEN`
4. กด **ตรวจสอบยืนยันและบันทึก**
5. **แล้วค่อย**เลื่อนลงเปิด field — ต้องบันทึก URL ก่อนถึงจะเปิด field ได้

เปิด 5 ตัวนี้:
```
messages              ลูกค้าพิมพ์เข้า
message_echoes        เพจตอบออก  ← ตัวสำคัญที่สุด ระวังสับสนกับ marketing_message_echoes
messaging_referrals   ลูกค้าคลิกแอดไหนเข้ามา
messaging_postbacks   ลูกค้ากดปุ่ม
messaging_handovers   AI ส่งต่อให้คน
```

ไม่ต้องเปิด `message_reads` / `message_deliveries` / `marketing_message_echoes`
เปิดแล้วได้ข้อมูลขยะเข้าฐาน และทำให้ตัวเลข "เพจตอบ" บวมเกินจริง

เวอร์ชันปล่อยเป็นค่าเดิมทุกตัว — Meta เตือนเองว่าต้องใช้เวอร์ชันเดียวกันทั้ง object

### ชั้น 4 — เพจ

```bash
python subscribe_pages.py            # ดูก่อน
python subscribe_pages.py --apply    # เขียนจริง
python subscribe_pages.py            # ยืนยัน ต้องขึ้น [ครบแล้ว] ทุกบรรทัด
```

### ชั้น 5 — ทดสอบ

ให้คนที่มี role ใน app ทักเข้าเพจ แล้ว:
```bash
curl https://meta-message-seven.vercel.app/api/health
```
`messages` ต้องขยับจาก 0

---

## สถานะ ณ 11 ก.ย. 69

```
ชั้น 1  ผ่าน   env ครบ · pooler ถูก · ไม่มีวงเล็บค้าง
ชั้น 2  ผ่าน   health 200 · ต่อ Supabase ได้ · verify challenge ถูก · โทเคนผิด 403
ชั้น 3  ผ่าน   object page · active · callback ถูก · field ครบ 5 · มี role 7 คน
ชั้น 4  ผ่าน   15 เพจ subscribe ครบทุก field
ชั้น 5  รอ     ยังไม่มีข้อความสักใบ

เตือน 1 ข้อ: marketing_message_echoes เปิดค้างอยู่ ควรปิด
```

---

## พิสูจน์แล้วว่าแยก AI ออกจากคนได้จริง

ยิง payload ที่เซ็นลายเซ็นถูกต้องเข้า endpoint จริงบน Vercel:

```
ลูกค้าพิมพ์เข้า                          → actor = customer   ✅
AI ตอบ   app_id=263902037430900 ai=true  → actor = ai         ✅
คนตอบ    app_id=263902037430900 ai=ไม่มี  → actor = human      ✅
ลายเซ็นมั่ว / ไม่ส่งลายเซ็น                → 401 ปฏิเสธ         ✅
```

⚠️ **AI กับคนใช้ `app_id` เดียวกันเป๊ะ** ตัวแยกคือ `ai_generated` เท่านั้น
ใครเขียน query ที่แยก AI ด้วย "มี app_id ไหม" คือผิดแบบเงียบ ๆ ทั้งชุด

---

## หลังมีข้อมูลแล้วต้องทำต่อ

1. **ตั้ง Task Scheduler** ให้ `sync_to_mixhub.py --prune` รันทุกวันก่อน 09:10
   (ไม่ตั้ง = ข้อมูลกองที่ Supabase ไม่เข้า mixhub แล้วรายงานจะว่างโดยไม่มีอะไรฟ้อง)
2. **เขียน view `mixhub.fbchat_conv_source`** — สเปกอยู่ใน `MATCHINGfbchat.md` แต่ไฟล์ migration ไม่เคยมีอยู่จริง
3. **กรอก `mixhub.fbchat_pages`** — `chat_system` ใช้คำว่า `business_agent` หรือ `human_only` เท่านั้น
   และ `agent_on_since` = วันเปิด AI (ไม่มีค่านี้ = เทียบก่อน/หลังไม่ได้)
4. **ตกลงกติกา `/close <ยอด>`** กับทีมแอดมิน — ลูกค้าเห็นข้อความนี้ด้วย ต้องตัดสินใจก่อนประกาศใช้
