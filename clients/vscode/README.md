# devradar

Aynı repoyu açan takım arkadaşlarının **şu an kod yazıp yazmadığını** gösterir — IDE'den ve işletim sisteminden bağımsız.

- **Kim online, kim offline** — durum çubuğunda canlı sayı
- **Kim hangi dosyada** — üstüne gelince görürsün
- **Sıfır ayar**: token yok, giriş yok, isim girmek yok. Eklenti git'ten adını/e-postanı, repodan da "odanı" otomatik bulur.
- **Otomatik eşleştirme**: aynı git reposunu açan herkes aynı odada. Farklı repodakiler görünmez.

## Nasıl çalışır

Eklenti, çalıştığın klasörün git `remote.origin.url` adresini okur, ondan bir oda anahtarı türetir ve devradar sunucusuna bağlanır. Aynı repoyu klonlamış başka biri de eklentiyi kurmuşsa, ikiniz aynı odada birbirinizi görürsünüz. Kimliğin git'teki `user.name` (görünen isim) ve `user.email` (gizli kimlik — laptop'a değil sana bağlı).

Git remote'u olmayan bir klasör açtığında eklenti sessizce devre dışı kalır.

## Ayarlar

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `devradar.serverUrl` | `wss://devradar.mrt-kntt53.workers.dev/ws` | Presence sunucusu. Kendi sunucunu çalıştırıyorsan değiştir. |
| `devradar.displayName` | _(boş)_ | Görünen ismi elle ayarla. Boşsa git `user.name` kullanılır. |
| `devradar.teamKey` | _(boş)_ | Gizlilik için ortak bir kelime. Aynı repodaki herkes aynısını girerse, repo adresini bilen yabancılar odaya giremez. |

## Komutlar

- **devradar: Kimler online?** — bu repoda kimin nerede olduğunu listeler
- **devradar: Yeniden bağlan** — bağlantıyı tazeler

## Kendi sunucun

Sunucu açık kaynak (Cloudflare Workers + Durable Objects): https://github.com/mertkont/devradar

## Lisans

GPL-3.0-or-later
