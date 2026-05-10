# devradar — Cloudflare Workers + Durable Objects

Çok-IDE'li geliştirici "presence" sunucusu. Kim hangi IDE'de, hangi dosyada,
online mı offline mı — hepsi tek bir WebSocket bağlantısı üzerinden.

**Eşleştirme modeli:** oda anahtarı = içinde bulunduğun git reposu. Aynı repoyu
açan herkes otomatik aynı odada. Token yok, giriş yok. (İstenirse opsiyonel bir
"team key" odanın anahtarına karıştırılır — repo adresini bilen yabancılar girmesin diye.)

- Hosting: **Cloudflare Workers** (ücretsiz plan, kredi kartı gerekmez)
- Durum: **Durable Object** (`PresenceRoom`), SQLite destekli — free plan'da çalışır
- Dil: TypeScript

## Local çalıştırma

```bash
npm install
npm run dev          # wrangler dev — http://localhost:8787
```

### Test

`npm run dev` açıkken başka bir terminalde:

```bash
node test-clients.mjs                          # room=test-room
DEVRADAR_ROOM=baska-oda node test-clients.mjs  # farklı oda
```

İki sahte client bağlanır, dosya değiştirir, biri ayrılır — presence akışını görürsün.

Bir odayı sıfırlamak (üye listesini temizlemek):

```bash
curl -X DELETE "http://localhost:8787/room?room=test-room"
```

## Cloudflare'e deploy

GitHub'a bağlı olduğu için her `git push` otomatik deploy eder (Cloudflare Workers Builds).
Manuel deploy de mümkün:

```bash
npx wrangler login     # ilk kez — tarayıcı açılır
npm run deploy
```

> **Not:** Eski `SHARED_TOKEN` secret'ı artık kullanılmıyor — Cloudflare dashboard'dan silebilirsin.

URL: `https://devradar.<subdomain>.workers.dev`
Health: `.../health` → `devradar ok`

## Loglar

```bash
npx wrangler tail
```

## Protokol

WebSocket adresi: `wss://devradar.<subdomain>.workers.dev/ws?room=<oda-anahtarı>`
— `room` zorunlu, yoksa 400 döner.

Client → Server (JSON):

```jsonc
// 1) İlk mesaj — kayıt
{ "type": "hello", "userId": "e:ab12…", "userName": "Mert Kont", "ide": "vscode", "project": "github.com/mertkont/devradar" }

// 2) Aktif dosya değişti
{ "type": "update", "file": "src/index.ts", "line": 42, "project": "github.com/mertkont/devradar" }

// 3) Heartbeat — opsiyonel; bağlantının canlılığı zaten yeterli
{ "type": "heartbeat" }
```

Server → Client (JSON):

```jsonc
{ "type": "welcome", "userId": "e:ab12…" }

{ "type": "presence", "users": [
  { "userId": "e:ab12…", "userName": "Mert Kont", "ide": "vscode",
    "project": "github.com/mertkont/devradar", "file": "src/index.ts", "line": 42, "status": "online" },
  { "userId": "e:cd34…", "userName": "Ayşe Y.", "ide": "rider",
    "project": "github.com/mertkont/devradar", "file": null, "line": null, "status": "offline" }
] }

{ "type": "error", "message": "missing userId or userName" }
```

Yönetim:

```
DELETE /room?room=<oda-anahtarı>   →  o odanın üye listesini ve bağlantılarını sıfırlar
```

Notlar:
- `userId` git e-postasının hash'i (`e:` öneki). Aynı kişi laptop'ta da masaüstünde de
  aynı git e-postasını kullandığı için **tek bir kişi** olarak görünür; biri kopsa diğeri
  açıkken **online** kalır. Git e-postası yoksa rastgele bir kimlik (`x:` öneki) üretilir.
- `userName` git'teki `user.name`. Eklentide `devradar.displayName` ile değiştirilebilir.
- IDE kapanınca / bilgisayar uyuyunca WebSocket kopar → kullanıcı **offline** olur ama
  o odada görünmeye devam eder (geçmişte bağlanmış herkes hatırlanır).
- Oda anahtarı eklentide şöyle üretilir: `sha256(normalize(remote.origin.url) [+ "|" + teamKey])`.
