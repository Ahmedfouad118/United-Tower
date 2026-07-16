# رفع United Tower على سيرفر (Deployment)

## ⚠️ مهم: ليه مينفعش Vercel زي برنامج الفواتير؟

برنامج الفواتير مبني على قاعدة بيانات **خارجية** (سحابية)، فـ Vercel بيشتغل معاه.
لكن United Tower بيستخدم **SQLite = ملف على القرص** (`data/app.db`).

Vercel (و Netlify) بيشتغلوا **Serverless**: القرص **مؤقّت وللقراءة فقط**، ويتمسح مع كل
نشر/إعادة تشغيل. يعني لو رفعناه على Vercel كده → **كل البيانات هتضيع** (عملاء، عقود، فواتير، قيود).

**الحل:** استضافة فيها **قرص دائم** (Persistent Disk / Volume). التطبيق جاهز ليها بدون أي تعديل كود.

---

## الخيار 1 (الأسهل والموصى به): Railway أو Render
قرص دائم + Node طويل المدى. صفر تعديلات على الكود.

1. ارفع الكود على GitHub (repo خاص).
2. من Railway/Render: **New Project → Deploy from GitHub**.
3. أضف **Volume** ووصّله على `/data`.
4. اضبط المتغيرات (Environment Variables):
   - `UT_DB=/data/app.db`
   - `UT_SECRET=<مفتاح طويل عشوائي>`   ← مهم جداً للأمان
   - `PORT` (بيتظبط تلقائي عادة)
5. Deploy. أول تشغيل هيعمل seed تلقائي.

## الخيار 2: cPanel بتاعك (عندك واحد بالفعل)
cPanel فيه **Setup Node.js App** — قرص دائم وبيشتغل تمام مع SQLite.

1. cPanel → **Setup Node.js App** → Create Application.
2. Node version: **22 أو أعلى** (لازم — `node:sqlite` مش موجود قبل كده).
3. Application root: مجلد المشروع، Startup file: `server.js`.
4. Environment variables: `UT_SECRET`, و(اختياري) `UT_DB`.
5. **Run NPM Install** ثم **Start**.

## الخيار 3: أي VPS / Docker
```bash
docker build -t united-tower .
docker run -d -p 4000:4000 -v ut_data:/data \
  -e UT_SECRET="<مفتاح طويل عشوائي>" \
  --name united-tower united-tower
```

## الخيار 4: Vercel فعلاً (يحتاج شغل إضافي)
لازم نهاجر قاعدة البيانات من SQLite المحلي إلى **Turso (libSQL)** أو **Postgres**.
ده تعديل حقيقي في طبقة الداتابيز (كل الاستعلامات دلوقتي متزامنة sync، هتبقى async).
ينفع يتعمل — بس هو شغل منفصل، مش مجرد رفع.

---

## قبل ما ترفع (Production checklist)
- [ ] **غيّر كلمة مرور admin** (الافتراضية `admin123`).
- [ ] اضبط `UT_SECRET` بمفتاح طويل عشوائي (مش الافتراضي).
- [ ] فعّل **HTTPS** (الاستضافة بتوفره عادة تلقائي).
- [ ] خد **نسخة احتياطية** دورية من `app.db` (نسخ الملف كفاية).

## نقل بياناتك الحالية للسيرفر
البيانات كلها في ملف واحد: `data/app.db`.
ارفعه على السيرفر في مسار `UT_DB` وهتلاقي كل حاجة زي ما هي.
