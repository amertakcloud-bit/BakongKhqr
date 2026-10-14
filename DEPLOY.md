# ការណែនាំ Deploy: Bakong KHQR Backend លើ Render

## 1. រចនាសម្ព័ន្ធគម្រោង

```
bakong-khqr/
├── public/index.html      # Frontend (បង្កើត QR, រាប់ថយក្រោយ, ស្ទង់ស្ថានភាព)
├── src/
│   ├── server.js          # Express server + routes
│   ├── bakongClient.js    # Bakong Relay API client
│   ├── webhook.js         # ផ្ទៀងផ្ទាត់ HMAC-SHA256 webhook
│   └── orders.js          # កន្លែងរក្សាទុក order (ក្នុង memory)
├── render.yaml            # Render Blueprint
├── package.json
└── .env.example
```

Backend បម្រើ `public/index.html` ដោយខ្លួនឯង (same-origin) ដូច្នេះមិនចាំបាច់តាំង CORS ទេ។

## 2. សាកល្បងលើ Local

```bash
npm install
cp .env.example .env      # បំពេញ RBK_TOKEN និង RBK_WEBHOOK_SECRET
npm start                 # បើក http://localhost:3000
```

សាកល្បង API ដោយ curl:

```bash
curl -X POST http://localhost:3000/api/payments \
  -H "Content-Type: application/json" \
  -d '{"orderId":"TEST-1","amount":0.01}'
```

> Webhook មិនអាចមកដល់ `localhost` បានទេ។ ដើម្បីសាកល្បង webhook លើ local សូមប្រើ tunnel (ឧ. ngrok ឬ Cloudflare Tunnel) ហើយដាក់ URL សាធារណៈនោះក្នុង Dashboard។

## 3. Deploy លើ Render

### ជំហានទី 1: ដាក់កូដលើ GitHub
```bash
git init && git add . && git commit -m "KHQR integration"
git remote add origin https://github.com/<you>/bakong-khqr.git
git push -u origin main
```
`.env` ត្រូវបានមិនអើពើដោយ `.gitignore` រួចហើយ។ **កុំ push token ឡើង GitHub ជាដាច់ខាត។**

### ជំហានទី 2: បង្កើត Web Service

**វិធី A (ងាយស្រួលបំផុត): Blueprint**
1. Render Dashboard → **New +** → **Blueprint** → ជ្រើស repo របស់អ្នក
2. Render នឹងអានឯកសារ `render.yaml` ដោយស្វ័យប្រវត្តិ
3. បំពេញតម្លៃ `RBK_TOKEN` និង `RBK_WEBHOOK_SECRET` ហើយចុច **Apply**

**វិធី B: Manual**
1. **New +** → **Web Service** → ភ្ជាប់ repo
2. Runtime: `Node` · Build Command: `npm install` · Start Command: `npm start`
3. Health Check Path: `/healthz`
4. បន្ថែម Environment Variables តាមតារាងខាងក្រោម

### Environment Variables

| ឈ្មោះ | ចាំបាច់ | ការពន្យល់ |
|---|---|---|
| `RBK_TOKEN` | ✅ | Store permanent token ពី Bakong Relay Dashboard |
| `RBK_WEBHOOK_SECRET` | ✅ | Webhook Secret របស់ store |
| `PORT` | ❌ | Render កំណត់ឲ្យដោយស្វ័យប្រវត្តិ (លំនាំដើម 10000) · កុំកំណត់ដោយដៃ |
| `NODE_VERSION` | ❌ | ណែនាំ `20` |

Server ចងជាមួយ `0.0.0.0:$PORT` ដូចដែល Render ត្រូវការ ហើយបិទដោយស្អាតពេលទទួល `SIGTERM`។

### ជំហានទី 3: កំណត់ Webhook URL

បន្ទាប់ពី deploy ជោគជ័យ អ្នកនឹងទទួលបាន URL ដូចជា `https://bakong-khqr.onrender.com`។ ចូល Bakong Relay Dashboard ហើយដាក់ Webhook URL:

```
https://<your-service>.onrender.com/webhooks/bakong
```

ធីកព្រឹត្តិការណ៍ `payment.success`, `payment.scanned`, `payment.expired`។

### ជំហានទី 4: សាកល្បង

1. បើក `https://<your-service>.onrender.com` ដាក់ចំនួន `0.01` ហើយចុច **បង្កើត QR**
2. ស្កេនបង់ក្នុងកម្មវិធីធនាគារ
3. ពិនិត្យ **Logs** លើ Render ត្រូវឃើញ `[order] FULFILLED ...`

## 4. សំខាន់មុនប្រើ Production

- **Free plan ដេក (spin down) ពេលគ្មានចរាចរណ៍ជាច្រើននាទី**។ ការភ្ញាក់ឡើងយឺត ដូច្នេះ webhook ឬ request ដំបូងអាចយឺត។ សម្រាប់ប្រព័ន្ធទូទាត់ពិត សូមប្រើ paid plan ដែលមិនដេក។
- **Order store ជា memory**៖ restart ឬ deploy ថ្មីនឹងលុបទិន្នន័យ។ ត្រូវប្តូរ `src/orders.js` ទៅ database (Render Postgres, MongoDB Atlas ឬ Redis) ហើយ `markPaid` ត្រូវជា atomic (`UPDATE ... WHERE status <> 'paid'`)។
- **ប្រើតែ 1 instance** ដរាបណា order ស្ថិតក្នុង memory។ បើ scale ច្រើន instance ត្រូវប្រើ database រួម។
- **កុំទុកចិត្ត amount ពី browser**៖ `index.html` នេះគ្រាន់តែជា demo។ នៅក្នុងហាងពិត server ត្រូវគណនា `amount` និង `orderId` ពីកន្ត្រកទំនិញ។
- **Rate limit ចែករំលែក**៖ `check_transaction_by_md5` មាន 180 ដង/នាទី ក្នុង token តែមួយ។ Server ទប់ស្កាត់ឲ្យហើយ (យ៉ាងតិច 3 វិនាទី/order) ហើយ webhook ជាប្រភពសំខាន់។
- បង្វិល (rotate) token និង webhook secret ភ្លាមៗ ប្រសិនបើវារំលាយចេញ។

## 5. ដោះស្រាយបញ្ហា

| រោគសញ្ញា | មូលហេតុ / ដំណោះស្រាយ |
|---|---|
| Deploy បរាជ័យ: `Missing RBK_TOKEN...` | មិនទាន់កំណត់ Environment Variables |
| Webhook ឆ្លើយ `401 invalid_webhook` (Logs: `signature_mismatch`) | `RBK_WEBHOOK_SECRET` ខុស ឬមានដកឃ្លាលើស |
| Logs: `timestamp_out_of_tolerance` | ម៉ោងលើសពី 5 នាទី (webhook ចាស់/replay ឬ delivery យឺតខ្លាំង) |
| Logs: `raw_body_unavailable` / `not a Buffer` | មាន `express.json()` នៅមុន route `/webhooks/bakong` |
| API ឆ្លើយ `502 payment_provider_unavailable` | មើល Logs: `auth` = token ខុស/អស់ quota · `config` = មិនទាន់កំណត់ Payment Link ក្នុង Dashboard |
| API ឆ្លើយ `429` | ហួសកំណត់ rate limit · ឆ្លើយមកជាមួយ `Retry-After` |
| API ឆ្លើយ `503` | Bakong Relay កំពុងថែទាំ |
| ទូទាត់ហើយ ប៉ុន្តែមិនឃើញ FULFILLED | ពិនិត្យ Webhook URL ក្នុង Dashboard និង Logs · ក្រោយ restart order ក្នុង memory បាត់ (មើលចំណុច 4) |
