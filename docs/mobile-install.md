# Installer l'application téléphone / تثبيت تطبيق الهاتف

[Français](#français) · [العربية](#العربية)

---

## Français

L'application Android permet à un vendeur, un technicien ou un magasinier d'utiliser le magasin depuis son téléphone (vente, réparations, stock, recherche par scan). Elle fonctionne **sans internet** : le téléphone parle au PC du magasin par le Wi-Fi du magasin.

### Ce qu'il faut
- Le PC du magasin avec Phone Store Manager ouvert, et une licence qui contient l'option **mobile** (par exemple `lifetime+mobile3` pour 3 téléphones). Sans l'option, la carte « Téléphones sur ce réseau » explique comment l'obtenir.
- Un téléphone Android 8.0 ou plus récent, connecté au **même Wi-Fi** que le PC.

### Installer l'application (sans câble, sans internet)
1. Sur le PC : **Paramètres > Téléphones sur ce réseau**. Cochez **Autoriser les téléphones sur ce réseau**. Si Windows demande d'autoriser l'application sur les réseaux privés, cliquez sur **Autoriser**.
2. Cliquez sur **Obtenir l'application** : un code QR s'affiche.
3. Sur le téléphone, connectez-vous au Wi-Fi du magasin, ouvrez l'appareil photo et scannez le code QR. Le fichier `.apk` se télécharge.
4. Ouvrez le fichier téléchargé. Android demande d'**autoriser l'installation depuis cette source** (le navigateur ou l'application Fichiers que vous utilisez) : acceptez, revenez en arrière, puis appuyez sur **Installer**.
5. Ouvrez **Phone Store Manager**, choisissez la langue.

### Appairer le téléphone
1. Sur le PC : **Appairer un appareil**. Un grand code QR et un code à 6 chiffres s'affichent (valables 2 minutes).
2. Sur le téléphone : **Scanner le code** (ou saisissez l'adresse du PC et le code). Autorisez la caméra.
3. Sur le PC, un formulaire s'ouvre : donnez un nom au téléphone, choisissez son **rôle** (propriétaire, vendeur, technicien, magasinier) et l'employé. Enregistrez.
4. Le téléphone affiche alors les onglets de son rôle.

### Mises à jour
Quand le PC contient une application plus récente, le téléphone affiche **Mise à jour disponible** : appuyez, téléchargez et installez par-dessus l'ancienne version (le téléphone reste appairé).

### Si ça ne marche pas
- « Non connecté au PC du magasin » : même Wi-Fi ? Application ouverte sur le PC ? Option activée dans les paramètres ?
- Le QR de téléchargement ne s'ouvre pas : vérifiez que le téléphone n'utilise pas les données mobiles à la place du Wi-Fi, ou saisissez l'adresse affichée sous le QR dans le navigateur du téléphone.
- « Votre licence autorise N téléphones » : révoquez un téléphone dans la liste, ou demandez une licence avec plus de téléphones.

### Pour le revendeur : fabriquer l'application
Prérequis : JDK 21 et le SDK Android (plateforme 36).
1. Une seule fois : `cd mobile && npm install && npm run android:keystore`. Cela crée `mobile/android/release.keystore` et `mobile/android/keystore.properties` (ignorés par git).
2. **Sauvegardez ces deux fichiers hors ligne.** Une mise à jour ne s'installe par-dessus l'application existante que si elle est signée avec la **même clé, pour toujours**. Si la clé est perdue, chaque client devra désinstaller l'application et refaire l'appairage.
3. `npm run android:apk` (dans `mobile/`) fabrique l'APK signé. Il est copié dans `dist/phone-store-manager-mobile-<version>.apk` et dans `build/mobile/` (le PC le sert à l'adresse `/app.apk`). Le nom de version suit celle du PC ; le numéro de version Android augmente à chaque fabrication.
4. `npm run dist:win` (à la racine) met l'APK dans l'installateur Windows.
5. GitHub Actions : ajoutez les secrets `ANDROID_KEYSTORE_BASE64` (`base64 -i release.keystore`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`release`) et `ANDROID_KEY_PASSWORD`, puis lancez « Build signed Android APK ». Le workflow de l'installateur Windows le fait automatiquement.
6. Licence : dans l'outil de licences, mettez l'édition `lifetime+mobile3` pour 3 téléphones (`lifetime+mobile` : nombre illimité).

---

## العربية

يتيح تطبيق أندرويد للبائع أو التقني أو أمين المخزن استعمال المحل من هاتفه (البيع، التصليحات، المخزون، البحث بالمسح). يعمل **دون إنترنت**: يتصل الهاتف بحاسوب المحل عبر واي فاي المحل.

### المتطلبات
- حاسوب المحل وبرنامج Phone Store Manager مفتوح، ورخصة تتضمن خيار **mobile** (مثلا `lifetime+mobile3` لثلاثة هواتف). دون هذا الخيار تشرح بطاقة «الهواتف على هذه الشبكة» كيفية الحصول عليه.
- هاتف أندرويد 8.0 أو أحدث، متصل بـ**نفس الواي فاي** مع الحاسوب.

### تثبيت التطبيق (دون كابل ودون إنترنت)
1. على الحاسوب: **الإعدادات > الهواتف على هذه الشبكة**. فعّل **السماح للهواتف على هذه الشبكة**. إذا طلب ويندوز السماح للتطبيق على الشبكات الخاصة فاضغط **السماح**.
2. اضغط **الحصول على التطبيق** فيظهر رمز QR.
3. على الهاتف: اتصل بواي فاي المحل، افتح الكاميرا وامسح الرمز. يبدأ تنزيل ملف `.apk`.
4. افتح الملف المنزَّل. سيطلب أندرويد **السماح بالتثبيت من هذا المصدر** (المتصفح أو تطبيق الملفات الذي تستعمله): وافق، ارجع، ثم اضغط **تثبيت**.
5. افتح **Phone Store Manager** واختر اللغة.

### اقتران الهاتف
1. على الحاسوب: اضغط **اقتران جهاز**. يظهر رمز QR كبير ورمز من 6 أرقام (صالح دقيقتين).
2. على الهاتف: اضغط **مسح الرمز** (أو اكتب عنوان الحاسوب والرمز يدويا). اسمح بالكاميرا.
3. على الحاسوب يظهر نموذج: أعطِ الهاتف اسما، واختر **دوره** (مالك، بائع، تقني، أمين مخزن) والموظف، ثم احفظ.
4. يعرض الهاتف عندئذ تبويبات دوره.

### التحديثات
عندما يحتوي الحاسوب على تطبيق أحدث يعرض الهاتف **تحديث متوفر**: اضغط ونزّل وثبّت فوق النسخة القديمة (يبقى الهاتف مقترنا).

### إذا لم يعمل
- «غير متصل بحاسوب المحل»: هل هما على نفس الواي فاي؟ هل البرنامج مفتوح على الحاسوب؟ هل الخيار مفعّل في الإعدادات؟
- لا يفتح رمز التنزيل: تأكد أن الهاتف لا يستعمل بيانات الهاتف بدل الواي فاي، أو اكتب العنوان الظاهر تحت الرمز في متصفح الهاتف.
- «رخصتك تسمح بـ N هواتف»: ألغِ أحد الهواتف من القائمة أو اطلب رخصة بعدد هواتف أكبر.

### للموزّع: صناعة التطبيق
المتطلبات: JDK 21 وSDK أندرويد (المنصة 36).
1. مرة واحدة: `cd mobile && npm install && npm run android:keystore`. ينشئ `mobile/android/release.keystore` و`mobile/android/keystore.properties` (مستثناة من git).
2. **احتفظ بنسخة احتياطية من الملفين خارج الجهاز.** لا يُثبَّت التحديث فوق التطبيق إلا إذا وُقّع بـ**نفس المفتاح إلى الأبد**. إذا ضاع المفتاح فعلى كل زبون حذف التطبيق وإعادة الاقتران.
3. الأمر `npm run android:apk` (داخل `mobile/`) يصنع ملف APK موقّعا وينسخه إلى `dist/phone-store-manager-mobile-<version>.apk` وإلى `build/mobile/` (يقدّمه الحاسوب على العنوان `/app.apk`). رقم النسخة يتبع نسخة البرنامج، ورقم إصدار أندرويد يزيد مع كل صناعة.
4. الأمر `npm run dist:win` (في المجلد الرئيسي) يضع الـAPK داخل مثبّت ويندوز.
5. GitHub Actions: أضف الأسرار `ANDROID_KEYSTORE_BASE64` (`base64 -i release.keystore`) و`ANDROID_KEYSTORE_PASSWORD` و`ANDROID_KEY_ALIAS` (القيمة `release`) و`ANDROID_KEY_PASSWORD`، ثم شغّل «Build signed Android APK». ويفعل ذلك تلقائيا سير عمل مثبّت ويندوز.
6. الرخصة: في أداة الرخص اجعل النسخة `lifetime+mobile3` لثلاثة هواتف (`lifetime+mobile` لعدد غير محدود).


## The phone on its own (phase 18)

Besides connecting to a shop PC, the Android app can run the whole shop by itself.

- **Two editions, two keys.** A license key says `shop` (the PC with up to three paired phones) or `phone` (the Android app on its own). The old `lifetime` counts as `shop`. The desktop accepts only shop keys, the stand-alone app only phone keys; the other kind is refused with *"This key is for the other edition"*. Create keys with `node tools/license-tool.mjs sign ... --edition shop|phone` or the Edition list in `tools/license-desk.html`.
- **First launch:** language, then *Connect to my shop PC* (the pairing flow) or *Use this phone alone*. The choice is saved. Connected to stand-alone only through *Reset app*; stand-alone to connected through Settings > *Move to a shop PC* (export a backup, restore it in the PC app, confirm: the phone's own data is then erased).
- **How it works:** the same Rust core as the PC (`core/`), built as `libpsm_android.so` (`mobile/core-android`, `npm run android:core`) and called through the `PsmCore` Capacitor plugin (JSON in, JSON out). `api()` has a third route, `local`, that calls `run_channel` as the owner. The device ID comes from `Settings.Secure.ANDROID_ID` and has the same `XXXX-XXXX-XXXX-XXXX` form; it survives reinstalling the app signed with the same key and changes after a factory reset. There is no LAN server, no Supabase and no sync in this mode.
- **Trial:** the same 14 days, then read-only. Uninstalling restarts the trial (accepted).
- **Backups:** Settings > Backup exports the desktop's zip to the share menu and restores one; the core keeps a daily automatic backup in the app folder; Home warns after 7 days without an export.
- **Receipts, repair slips and the closing report** are made as a picture and shared (WhatsApp to the customer's number first). Bluetooth thermal printing is not included: it needs a real printer to test.
