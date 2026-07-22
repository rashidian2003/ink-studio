# گزارش مرحلهٔ اول: سامانهٔ طراحی و نوار ابزار

## نام مرحله

مرحلهٔ اول بازطراحی رابط، بدون تغییر موتور قلم، مدل داده یا قالب ذخیره‌سازی.

## هدف

یکپارچه‌کردن اندازه‌ها و فاصله‌ها، گروه‌بندی واضح toolbar، نمایش واضح ابزار جاری، حفظ حالت فشرده و بهبود رفتار موبایل/تبلت و تم روشن/تاریک.

## فایل‌های بررسی‌شده

`src/view/InkView.ts`، `src/view/floatingToolbar.ts`، `src/view/penPanel.ts`، `src/view/colorPopover.ts`، `src/view/thumbnailStrip.ts`، `styles.css`، `src/canvas/CanvasEngine.ts`، `src/canvas/inputMath.ts`، `src/types.ts`، `src/settings.ts`، `src/main.ts` و تست‌ها.

## فایل‌های تغییرکرده

- `src/view/InkView.ts`: summary ابزار جاری، گروه‌بندی toolbar، stateهای ARIA، disabled واقعی و sync پنل.
- `src/view/penPanel.ts`: قرارگیری امن پنل داخل viewport و اعلام open/close به toolbar.
- `src/view/thumbnailStrip.ts`: همگام‌سازی state باز/بستهٔ drawer با دکمهٔ صفحات.
- `styles.css`: design tokens، touch target، active/pressed/disabled state، responsive rules و light/dark surfaces.
- `docs/ARCHITECTURE-AUDIT.md`: ممیزی و خط مبنای قبل از تغییر.
- `docs/PHASE-1-REPORT.md`: گزارش این مرحله.

## مشکلات کشف‌شده

- اندازهٔ کنترل‌ها در چند بخش ۳۴، ۳۵، ۳۶ و ۴۰px بود و target لمسی ۴۴px به‌طور ثابت رعایت نمی‌شد.
- toolbar ابزار جاری را فقط با highlight دکمه نشان می‌داد و رنگ/ضخامت جاری دیده نمی‌شد.
- undo/redo در حالت unavailable فقط با class و opacity کنترل می‌شدند و semantic disabled نداشتند.
- پنل قلم با عرض ثابت ۳۴۰px مکان‌دهی می‌شد و نزدیک لبهٔ پایین یا در split باریک می‌توانست خارج از view قرار گیرد.
- CSS چند نسل از toolbar را در یک فایل نگه می‌دارد؛ cascade فعلی کار می‌کند اما بدهی نگه‌داری باقی است.

## تغییرات انجام‌شده

- tokenهای فاصله ۴/۸/۱۲/۱۶px، کنترل ۴۰px، touch target ۴۴px، icon ۲۰px، radius، border، motion، surface و status تعریف شد.
- summary ابزار جاری شامل icon، نام، ضخامت و swatch رنگ اضافه شد؛ برای ابزارهای stroke همان کنترل پنل سریع را باز می‌کند.
- ابزارها به current، drawing، selection، history، content/more، preset و pages گروه‌بندی شدند.
- pen و eraser و lasso و select و undo و more و page indicator در compact باقی می‌مانند؛ ابزارهای ثانویه در عرض کوچک پنهان می‌شوند.
- active state با رنگ، border داخلی و indicator نمایش داده می‌شود؛ panel-open و pressed state مستقل دارند.
- undo/redo و previous/next علاوه بر ظاهر، `disabled` و `aria-disabled` واقعی دارند.
- صفحه در عرض کوچک فقط با indicator واحد جمع می‌شود و جزئیات page navigation پنهان می‌شوند.
- کنترل‌های coarse pointer از token حداقل ۴۴px استفاده می‌کنند.
- پنل قلم اندازهٔ واقعی خود را اندازه می‌گیرد و بر اساس فضای بالا/پایین داخل viewport clamp می‌شود.
- blur و shadow سطح شناور سبک‌تر شد و `prefers-reduced-motion` حفظ شد.

## دلیل انتخاب راه‌حل

تغییر فقط در presentation و orchestration رابط انجام شد تا رفتار input، history و فایل `.ink` ثابت بماند. summary ابزار جاری اطلاعات ضروری را بدون بازکردن پنل نشان می‌دهد و compact mode تراکم را با حذف ابزارهای ثانویه کاهش می‌دهد.

## راه‌حل‌های ردشده

- افزودن ابزار Hand رد شد، چون به تغییر state و input engine نیاز دارد و خارج از مرحلهٔ اول است.
- جابه‌جایی همهٔ فایل‌ها به معماری پوشه‌ای جدید رد شد، چون ریسک regression بدون سود مرحلهٔ رابط زیاد بود.
- تغییر preset model، pressure curve و storage رد شد، چون قالب داده و موتور قلم را وارد این مرحله می‌کرد.
- پاک‌کردن کامل CSS قدیمی در همین مرحله رد شد، چون نیازمند visual regression کامل در چند نسخهٔ Obsidian است؛ tokenها اکنون منبع نهایی cascade هستند و پاک‌سازی می‌تواند جدا انجام شود.

## خطرات باقی‌مانده

- visual QA واقعی در Android tablet، iPad و split pane هنوز لازم است.
- toolbar کامل روی view بسیار باریک ممکن است scroll افقی داشته باشد؛ compact/hidden مسیر امن هستند.
- منوهای Obsidian state باز/بسته را به toolbar برنمی‌گردانند؛ panel قلم sync می‌شود ولی Insert/More فقط هنگام کلیک state داخلی ندارند.
- بدهی CSS قدیمی هنوز باید در یک مرحلهٔ کم‌ریسک با screenshot regression حذف شود.

## اثر بر عملکرد و ذخیره‌سازی

هیچ کد مسیر pointer، redraw، history، autosave، parse یا serialize تغییر نکرده است. هزینهٔ رابط به چند element کوچک و به‌روزرسانی متن هنگام تغییر ابزار محدود است. قالب ذخیره‌سازی و سازگاری فایل‌های قبلی بدون تغییر است.

## حالت قبل و بعد

قبل: ابزار فعال فقط در میان تعداد زیادی icon با رنگ مشخص بود؛ اندازه‌های دکمه متغیر، اطلاعات رنگ/ضخامت مخفی و page controls در toolbar کامل پراکنده بودند.

بعد: ابتدای toolbar یک summary ثابت دارد؛ گروه‌ها ترتیب current → quick tools → history → content → pages دارند؛ compact/mobile فقط عملیات اصلی را نگه می‌دارد؛ stateهای active، pressed، unavailable و panel-open از هم قابل‌تشخیص‌اند.

## آزمایش دستی لازم

1. تم روشن و تاریک Obsidian، paper auto/light/dark.
2. toolbar در top/bottom/left/right/floating و drag/snap.
3. full/compact/hidden در عرض‌های ۳۶۰، ۷۰۰، ۱۰۲۴ و desktop split pane.
4. Android stylus: اندازهٔ ۴۴px، بازشدن پنل با tap دوم و عدم بسته‌شدن هنگام slider.
5. pen/pencil/highlighter/eraser: summary icon، رنگ، ضخامت و panel-open state.
6. undo/redo و previous/next: تغییر زندهٔ disabled و کارکرد keyboard.
7. focus mode، safe-area و خروج با Escape/دکمه.
8. drawer صفحات روی desktop و bottom drawer روی mobile.

## برنامهٔ دقیق مرحلهٔ دوم

1. instrumentation بدون تغییر رفتار برای latency، event time، frame time، redraw و point count.
2. تست‌های pointercancel، lost capture، visibility change، قلم+لمس و rotation.
3. safety rail ذخیره/recovery و revision guard پیش از migration مدل نقطه.
4. استخراج `PointerController` و `ViewportTransform` با snapshot tests رفتار فعلی.
5. جداسازی pressure processor، path smoothing و stabilizer با presetهای قابل‌آزمایش.
6. افزودن DPR cap اختیاری و مقایسهٔ حافظه/کیفیت.
7. لایهٔ static/active/overlay و culling؛ سپس spatial index و پاک‌کن جزئی.

هر زیربخش با benchmark قبل/بعد، تست فایل قدیمی و build مستقل پایان می‌یابد.
