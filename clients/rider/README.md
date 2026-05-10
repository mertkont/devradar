# devradar — JetBrains eklentisi (Rider, IntelliJ, PyCharm, …)

VS Code eklentisinin JetBrains karşılığı. Aynı git reposunu açan takım arkadaşlarının
şu an kod yazıp yazmadığını durum çubuğunda gösterir. Sıfır ayar — kimlik git'ten, oda
repodan.

IntelliJ Platform üzerine kurulu olduğu için Rider, IntelliJ IDEA, PyCharm, GoLand,
WebStorm vb. hepsinde çalışır (plugin sadece genel platform API'lerini kullanır).

## Geliştirme / derleme

Gradle wrapper repoda gömülü. Build için **JDK 17–21** gerekir.

```bash
cd clients/rider
./gradlew buildPlugin        # build/distributions/devradar-0.1.0.zip üretir
./gradlew runIde             # eklentiyi geçici bir IDE sandbox'ında açar (deneme için)
```

> **JDK 23+ kullanıyorsan**: Gradle 8.10 + Kotlin DSL JDK 25'i tanımıyor. Build'i
> bir JDK 17–21 ile çalıştır:
> ```bash
> JAVA_HOME="/JDK17-21/yolun" ./gradlew buildPlugin
> ```
> Herhangi bir JetBrains IDE veya Android Studio kuruluysa içinde gömülü bir JBR 21 vardır
> (`/Applications/Android Studio.app/Contents/jbr/Contents/Home` gibi) — onu kullanabilirsin.
> (Alternatif: wrapper'ı Gradle 9.1+'a yükseltmek de sorunu çözer.)

`runIde` ilk seferde bir IDE indirir (büyük). Gerçek Rider'ında denemek için:
**Settings → Plugins → ⚙ → Install Plugin from Disk…** → `build/distributions/devradar-0.1.0.zip`.

## JetBrains Marketplace'e publish

1. https://plugins.jetbrains.com → "Sign In" (JetBrains hesabı) → ilk kez bir **vendor profili** oluştur.
2. **Upload plugin** → `build/distributions/devradar-0.1.0.zip` dosyasını yükle. İlk gönderim
   JetBrains tarafından incelenir (birkaç gün sürebilir).
3. CLI ile de yapılabilir: bir **permanent token** al (Marketplace → profil → "My Tokens"),
   sonra:
   ```bash
   ./gradlew publishPlugin -Ppublish.token=<TOKEN>
   ```
   (Bunun için `build.gradle.kts`'e `publishing { token = ... }` bloğu eklenir — ilk
   yüklemeyi web'den yapıp pluginId aldıktan sonra.)

## Sunucu

Açık kaynak, Cloudflare Workers + Durable Objects: https://github.com/mertkont/devradar

## Notlar / şimdilik eksikler

- Sunucu adresi şu an sabit (`DevradarService.kt` içinde). Özel sunucu için kendin değiştir;
  ileride bir Settings paneli eklenebilir (VS Code tarafında zaten ayar var).
- `devradar.teamKey` (gizlilik anahtarı) bu sürümde yok — repo adresi tek başına oda anahtarı.
