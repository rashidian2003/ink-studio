# ممیزی معماری Ink Studio

این گزارش وضعیت نسخهٔ `0.15.0` را پیش از تغییرات مرحلهٔ اول رابط ثبت می‌کند. هدف، تعیین خط مبنا و جلوگیری از تغییر هم‌زمان رابط، موتور قلم و قالب فایل است.

## ساختار پروژه

| حوزه | فایل‌های اصلی | مسئولیت فعلی |
|---|---|---|
| مدل سند | `src/types.ts` | تعریف صفحه، خط، تصویر و متن؛ parse/serialize قالب JSON |
| ورودی و بوم | `src/canvas/CanvasEngine.ts` | ورودی Pointer، لمس، pan/zoom، ابزارها، انتخاب، تاریخچه و رندر تعاملی |
| تبدیل مختصات | `src/canvas/inputMath.ts` | تبدیل screen/page، فشار، EMA و حذف نمونه‌های نزدیک |
| رندر خط | `src/canvas/strokeRender.ts` | تولید مسیر با `perfect-freehand` و cache کردن `Path2D` |
| رندر صفحه | `src/canvas/pageRender.ts`, `templates.ts` | کاغذ، متن، تصویر کوچک و الگوها |
| رابط نما | `src/view/InkView.ts` | چرخهٔ Obsidian، toolbar، منوها، import/export و autosave |
| رابط شناور | `src/view/floatingToolbar.ts` | جابه‌جایی، dock، حالت full/compact/hidden |
| تنظیم قلم | `src/view/penPanel.ts`, `colorPopover.ts` | تنظیم سریع قلم، رنگ و presetهای فعلی |
| صفحات | `src/view/thumbnailStrip.ts` | drawer، thumbnail، انتخاب، حذف، تکثیر، تغییر نام و ترتیب |
| تنظیمات | `src/settings.ts` | تنظیمات افزونه و صفحهٔ Settings |
| PDF و فایل | `src/pdf/*`, `src/importers.ts`, `src/assets.ts` | PDF، تصویر و cache دارایی‌ها |

دو فایل بزرگ، چند مسئولیت را هم‌زمان نگه می‌دارند: `CanvasEngine.ts` حدود ۲۳۲۰ خط و `InkView.ts` حدود ۱۵۰۰ خط است. این وضعیت هنوز قابل اجراست، اما تغییر موتور قلم، تاریخچه یا ذخیره‌سازی را پرخطر می‌کند.

## معماری بوم و رندر

- بوم از دو Canvas هم‌اندازهٔ viewport ساخته شده است؛ SVG استفاده نمی‌شود.
- `base` کاغذ، PDF، تصویر، متن و خطوط ثبت‌شده را نگه می‌دارد.
- `live` خط در حال رسم و chrome انتخاب/خط‌کش را نمایش می‌دهد و ورودی Pointer را دریافت می‌کند.
- هر خط یک شیء مستقل `Stroke` با شناسه و آرایهٔ نقاط برداری است؛ هر خط عنصر DOM مستقل نیست.
- هنگام نوشتن فقط `live` با `requestAnimationFrame` بازطراحی می‌شود. در پایان خط، همان خط به‌صورت افزایشی روی `base` رسم می‌شود.
- بازطراحی ساختاری، pan/zoom، پاک‌کن، undo و جابه‌جایی تصویر تمام محتوای ثابت صفحه را دوباره رسم می‌کند. مسیر خطوط ثابت با `WeakMap<Path2D>` cache می‌شود، ولی culling مکانی وجود ندارد.
- اندازهٔ فیزیکی هر Canvas برابر اندازهٔ CSS ضرب‌در `devicePixelRatio` است؛ بنابراین روی نمایشگر پرتراکم واضح است. DPR سقف ندارد و روی دستگاه ضعیف می‌تواند حافظه و هزینهٔ clear/redraw را زیاد کند.

## مختصات

- ورودی رویداد با `getBoundingClientRect()` به مختصات محلی viewport تبدیل می‌شود.
- `screenToPage()` در `src/canvas/inputMath.ts` با `offsetX`, `offsetY` و `viewScale` مختصات سند را می‌سازد.
- `applyTransform()` در موتور، page → backing-canvas را با `viewScale * dpr` اعمال می‌کند.
- `pageToScreen()` در ماژول قابل‌آزمایش موجود است، هرچند بیشتر رسم از transform مستقیم Canvas استفاده می‌کند.
- محاسبهٔ zoom/pan، clamp و fit هنوز داخل `CanvasEngine` است؛ تبدیل پایه متمرکز شده اما کل viewport transform هنوز یک ماژول مستقل نیست.

## جریان کامل یک خط قلم

1. `pointerdown` روی Canvas زنده به `handlePointerDown()` می‌رسد.
2. نوع ورودی و رد کف دست در `isDrawInput()` بررسی می‌شود؛ قلم همیشه پذیرفته، لمس بسته به تنظیمات و سابقهٔ قلم رد یا پذیرفته می‌شود.
3. `beginStroke()` مختصات را با `toPage()` و `screenToPage()` تبدیل می‌کند، pointer capture می‌گیرد و snapshot پیش از gesture را ثبت می‌کند.
4. فشار با `normalizedPressure()` اصلاح و اولین `StrokePoint` ساخته می‌شود.
5. هر `pointermove`، نمونه‌های `getCoalescedEvents()` را دریافت می‌کند.
6. `processPoint()` projection خط‌کش و EMA فعلی را اعمال می‌کند؛ `shouldKeepSample()` نقاط بسیار نزدیک را حذف می‌کند.
7. نقاط فوراً به `current.points` اضافه می‌شوند و `queueLiveRedraw()` حداکثر یک رسم در هر frame برنامه‌ریزی می‌کند.
8. `drawLive()` مسیر جاری را با `perfect-freehand` روی Canvas زنده رسم می‌کند.
9. در `pointerup` یا `pointercancel` آخرین نمونه افزوده و خط وارد `page.strokes` می‌شود.
10. خط نهایی بدون بازسازی کامل صفحه روی Canvas ثابت رسم می‌شود.
11. `finishGesture()` snapshot را به history همان صفحه اضافه و `host.onChange()` را فراخوانی می‌کند.
12. `InkView.onChange()` وضعیت را Saving می‌کند و پس از quiet period پیش‌فرض ۳۵۰ms، `TextFileView.requestSave()` را صدا می‌زند.
13. Obsidian هنگام ذخیره `getViewData()` را فراخوانی می‌کند و `serializeDocument()` کل سند را به JSON تبدیل می‌کند.

## مدل وضعیت

- ابزار و رنگ فعال در `InkView` نگه‌داری می‌شوند.
- اندازه‌ها، presetها و تنظیمات قلم در تنظیمات افزونه قرار دارند.
- zoom، pan، pointer فعال، انتخاب، ruler، صفحهٔ فعال و history داخل `CanvasEngine` هستند.
- سند مشترک بین View و Engine با reference نگه‌داری می‌شود.

مالکیت هر وضعیت عموماً مشخص است، ولی «منبع حقیقت واحد» یک store مستقل نیست. رابط برای خواندن وضعیت‌های موتور به callbackها وابسته است و `CanvasEngine` هم‌زمان input controller، renderer، tool controller، page manager و history manager است.

## ذخیره‌سازی و سازگاری

- هر فایل `.ink` یک JSON کامل با `app`, `version`, `pages` و عناصر برداری است.
- فشار هر نقطه در `p` ذخیره می‌شود؛ timestamp، tilt، twist و pointerType ذخیره نمی‌شوند.
- خط‌ها شناسهٔ یکتا دارند، اما حذف/ویرایش در حافظه انجام می‌شود و هنگام save کل JSON بازسازی می‌شود.
- autosave پس از پایان عملیات و با debounce انجام می‌شود، نه در هر pointermove.
- کد افزونه فایل موقت، checksum، backup یا recovery journal ندارد و جایگزینی اتمی را خودش تضمین نمی‌کند.
- اگر parse شکست بخورد، سند خالی سالم برگردانده می‌شود. این رفتار crash را جلوگیری می‌کند، اما بدون نگه‌داری نسخهٔ خراب و هشدار بازیابی، خطر بازنویسی ناخواسته دارد.
- نسخهٔ قالب خوانده می‌شود ولی migration/validation عمیق و تشخیص شناسهٔ تکراری وجود ندارد.
- تغییر هم‌زمان از نمای دوم یا تغییر خارجی با revision/hash کنترل نمی‌شود.

## خط مبنای قابل‌اندازه‌گیری

محیط: Node محلی، ۲۴ نقطه برای هر خط، میانگین ۲۰ اجرا. این benchmark فقط parse/serialize را اندازه می‌گیرد و جای تست WebView واقعی را نمی‌گیرد.

| تعداد خط | اندازهٔ JSON | serialize میانگین | parse میانگین | heap تقریبی سند parse‌شده |
|---:|---:|---:|---:|---:|
| ۱۰۰ | 80,465 B | 0.169 ms | 0.384 ms | 262,456 B |
| ۱۰۰۰ | 822,315 B | 1.737 ms | 3.736 ms | 2,685,696 B |
| ۵۰۰۰ | 4,166,334 B | 8.833 ms | 21.437 ms | 13,416,096 B |

تست موجود parse برای ۱۰هزار خط در این اجرا `11.88ms` ثبت کرد؛ دادهٔ آن تست نقاط کمتری از benchmark بالا دارد، بنابراین اعداد مستقیماً قابل مقایسه نیستند.

موارد زیر بدون اجرای Obsidian روی دستگاه واقعی قابل ثبت معتبر نیستند و باید در مرحلهٔ دوم instrument شوند: latency تماس تا اولین pixel، زمان هر pointer event، frame time، redraw count، سرعت eraser/undo و حافظهٔ GPU Canvas. برای آن‌ها سناریوی ثابت Android tablet، desktop و سند ۱۰۰/۱۰۰۰/۵۰۰۰ خط لازم است.

## قابلیت‌های موجود

- قلم، مداد، ماژیک، پاک‌کن کل‌خطی، فشار پایه و EMA فعلی
- coalesced pointer samples، حذف نقاط نزدیک و رندر live با rAF
- رد کف دست پایه، pinch zoom، pan، swipe صفحه و zoom lock
- انتخاب تصویر/متن و جابه‌جایی؛ کمند خطوط با move و resize
- اشکال، جدول، خط‌کش، تصویر، sticker، متن و پس‌زمینهٔ PDF
- صفحه‌های چندگانه با thumbnail، نام، افزودن، حذف، تکثیر و reorder
- undo/redo جدا برای هر صفحه، autosave debounced و وضعیت نمایشی save
- toolbar شناور قابل dock، حالت فشرده/مخفی، focus mode و تم روشن/تاریک
- خروجی PDF حاشیه‌نویسی‌شده و تست واحد مدل سند/مختصات

## قابلیت‌های ناقص

- تنظیمات قلم preset کامل نیست: نام، ترتیب، ویرایش، تکثیر، opacity، pressure curve، smoothing مستقل، taper و tip geometry وجود ندارد.
- smoothing و stabilization یک پارامتر EMA مشترک هستند.
- پاک‌کن جزئی، cursor پاک‌کن و barrel eraser وجود ندارد.
- کمند rotation، clipboard، layer order و scale-width policy ندارد.
- متن formatting، background، alignment و کنترل RTL/LTR ندارد.
- تصویر rotation، crop، lock، opacity، background mode و link/embed choice ندارد.
- thumbnailها برای همهٔ صفحات به‌صورت synchronous ساخته می‌شوند؛ virtualization و idle queue ندارند.
- صفحه search، bookmark، multi-select، batch template/export و jump-to-page وجود ندارد.
- shortcutهای View با keydown هستند و فقط ساخت note به Command system خود Obsidian ثبت شده است.
- focus mode دو سطح مستقل ندارد و class سراسری body در چند نمای هم‌زمان نیاز به هماهنگی دارد.
- ذخیرهٔ مقاوم، recovery، corruption report و conflict detection وجود ندارد.

## قابلیت‌های کاملاً جدید

- لایه‌های قابل‌نام‌گذاری/قفل/ترتیب
- spatial index و پاک‌کن جزئی واقعی
- predicted points موقت و pipeline ماژولار raw/final
- pressure curve سفارشی و stabilizer دنبال‌کننده
- PNG/SVG export مستقل از viewport و PDF export انتخابی پیشرفته
- diagnostic input page و performance monitor
- atomic/recovery storage، backup browser و multi-view revision control

## مشکلات و خطرهای اصلی

1. **از دست رفتن داده:** parse خراب به سند خالی تبدیل می‌شود و recovery مستقل وجود ندارد.
2. **هم‌زمانی:** چند View می‌توانند referenceهای جدا را بدون revision guard ذخیره کنند.
3. **لغو pointer:** `pointercancel` مثل پایان عادی commit می‌شود؛ برای بعضی edge caseها باید سیاست امن و قابل‌آزمایش تعریف شود.
4. **DPR نامحدود:** دو backing buffer بزرگ روی تبلت پرتراکم می‌توانند حافظهٔ زیادی مصرف کنند.
5. **موتور چندمسئولیتی:** تغییر یک ابزار می‌تواند input، history، rendering و page navigation را هم‌زمان تحت تأثیر قرار دهد.
6. **رندر اسناد بزرگ:** بازطراحی کامل صفحه همهٔ strokeها را پیمایش می‌کند و culling/spatial index ندارد.
7. **thumbnailها:** بازسازی هم‌زمان تمام صفحات می‌تواند drawer را در جزوهٔ بزرگ متوقف کند.
8. **save indicator:** عبارت Saved با timer نمایش داده می‌شود و acknowledgment واقعی نوشتن فایل نیست.
9. **مدل نقطهٔ حداقلی:** برای tilt، pressure diagnostics، predicted samples و مهاجرت‌های آینده فیلد/نسخه‌گذاری لازم است.

## نقشهٔ اجرای مرحله‌ای

| مرحله | خروجی | وابستگی | زمان نسبی |
|---|---|---|---:|
| ۱ | design system، toolbar گروه‌بندی‌شده، active state، compact و responsive | بدون تغییر مدل/موتور | 1× |
| ۲.۰ | benchmark داخل WebView، input diagnostics و تست edge case | مرحلهٔ ۱ | 1× |
| ۲.۱ | safety rail ذخیره: backup/recovery و revision guard پیش از refactor عمیق | ۲.۰ | 2× |
| ۲.۲ | استخراج pointer/viewport/stroke pipeline با رفتار معادل | ۲.۰ و تست‌ها | 2× |
| ۲.۳ | pressure curves، smoothing مستقل و stabilization با migration کنترل‌شده | ۲.۲ | 3× |
| ۲.۴ | static/active/overlay layers، culling و spatial index | ۲.۲ | 3× |
| ۲.۵ | cursor و پاک‌کن جزئی command-based | ۲.۴ | 3× |
| ۳ | preset manager کامل، کمند پیشرفته، متن/تصویر | مرحلهٔ ۲ | 4× |
| ۴ | pages virtualization، layers، export PNG/SVG/PDF پیشرفته | مرحلهٔ ۲ و ۳ | 4× |

اصل توقف: هر مرحله فقط در صورت بهبود قابل‌اندازه‌گیری و عبور از تست سازگاری فایل‌های قدیمی ادغام می‌شود.
