# devradar — Cloudflare Workers + Durable Objects

Çok-IDE'li geliştirici "presence" sunucusu. Kim hangi IDE'de, hangi dosyada,
online mi offline mı — hepsi tek bir WebSocket bağlantısı üzerinden.

- Hosting: **Cloudflare Workers** (ücretsiz plan, kredi kartı gerekmez)
- Durum: **Durable Object** (`PresenceRoom`), SQLite destekli — free plan'da çalışır
- Dil: TypeScript

## Local çalıştırma

```bash
npm install
npm run dev          # wrangler dev — http://localhost:8787
```

Local'de `SHARED_TOKEN` değeri `.dev.vars` dosyasından okunur (varsayılan: `test123`).

### Test

`npm run dev` açıkken başka bir terminalde:

```bash
node test-clients.mjs
```

İki sahte client bağlanır, dosya değiştirir, biri ayrılır — presence akışını görürsün.

## Cloudflare'e deploy (ilk kez)

1. **Cloudflare hesabı aç** (ücretsiz, kart istemez): https://dash.cloudflare.com/sign-up

2. **Wrangler ile giriş yap** (tarayıcı açılır, "Allow" dersin):
   ```bash
   cd ~/Desktop/devradar
   npx wrangler login
   ```

3. **Paylaşılan token'ı secret olarak ata** (takıma vereceğin gizli dize):
   ```bash
   npx wrangler secret put SHARED_TOKEN
   # sorunca güçlü bir değer yapıştır, mesela: openssl rand -hex 24 çıktısı
   ```

4. **Deploy**:
   ```bash
   npm run deploy
   ```
   Çıktıda şuna benzer bir URL göreceksin:
   `https://devradar.<senin-subdomain>.workers.dev`

5. WebSocket bağlantı adresi:
   `wss://devradar.<senin-subdomain>.workers.dev/ws`
   Health kontrolü: `https://devradar.<senin-subdomain>.workers.dev/health` → `devradar ok`

   **Bu URL'i bana söyle** — IDE eklentilerine onu yazacağım.

## Sonraki güncellemeler

```bash
npm run deploy
```

## Loglar

```bash
npx wrangler tail
```

## Protokol

WebSocket adresi: `wss://.../ws`

Client → Server (JSON):

```jsonc
// 1) İlk mesaj — kayıt (token doğrulanır)
{ "type": "hello", "token": "...", "userId": "u1", "userName": "Mert", "ide": "vscode", "project": "azure-proj" }

// 2) Aktif dosya değişti (istediğin sıklıkta)
{ "type": "update", "file": "src/index.ts", "line": 42, "project": "azure-proj" }

// 3) Heartbeat — opsiyonel; bağlantının canlılığı zaten yeterli
{ "type": "heartbeat" }
```

Server → Client (JSON):

```jsonc
{ "type": "welcome", "userId": "u1" }

{ "type": "presence", "users": [
  { "userId": "u1", "userName": "Mert", "ide": "vscode", "project": "azure-proj",
    "file": "src/index.ts", "line": 42, "status": "online" },
  { "userId": "u2", "userName": "Ayse", "ide": "rider", "project": "azure-proj",
    "file": null, "line": null, "status": "offline" }
] }

{ "type": "error", "message": "invalid token" }
```

Notlar:
- IDE uygulaması kapanınca / bilgisayar uyuyunca WebSocket kopar → kullanıcı **offline** olur ama listede kalır (geçmişte bağlanmış herkes hatırlanır).
- Aynı kullanıcı birden fazla cihazdan bağlanabilir; biri kopsa diğeri açıkken **online** kalır.
- `userId` Azure DevOps / Entra kullanıcı kimliğin olabilir (eklenti aşamasında bağlarız).
