# SOS Discord Notifier

SOSのお知らせAPIをCloudflare Workers Cronでポーリングし、新しいお知らせだけDiscord Webhookへ投稿します。

## How It Works

1. Firebase Authのメール/パスワードでSOSへログインします。
2. `GET /project/:projectId/notices` でお知らせ一覧を取得します。
3. Workers KVの `seen-notice-ids` と比較し、未保存のIDだけ新規扱いにします。
4. 新規分だけ `GET /project/:projectId/notices/:noticeId` で本文を取得します。
5. Discord Webhookへ投稿し、現在の一覧IDをKVへ保存します。

初回実行時は、既存のお知らせをKVに保存するだけでDiscordへ投稿しません。初回以降に増えたお知らせだけ投稿します。

## Config

個人ごとに変わる値:

| Name | Where | Required | How to get it |
| --- | --- | --- | --- |
| `SOS_EMAIL` | Secret / `.dev.vars` | Yes | SOSログインに使うメールアドレス |
| `SOS_PASSWORD` | Secret / `.dev.vars` | Yes | SOSログインに使うパスワード |
| `SOS_PROJECT_ID` | `wrangler.jsonc` vars / `.dev.vars` | Yes | ブラウザDevToolsのNetworkで `/project/<projectId>/notices` のURLから取得 |
| `DISCORD_WEBHOOK_URL` | Secret / `.dev.vars` | Yes | Discordチャンネル設定 > 連携サービス > ウェブフック |
| `MANUAL_TRIGGER_TOKEN` | Secret / `.dev.vars` | No | 手動実行URLを保護したい場合に任意の長い文字列を設定 |

基本的に変えなくてよい値:

| Name | Default |
| --- | --- |
| `FIREBASE_API_KEY` | SOS26 frontendで使われているFirebase API key |
| `SOS_API_BASE_URL` | `https://sos26-api.sohosai.com` |
| `NOTICE_STATE_KEY` | `seen-notice-ids` |

`SOS_PROJECT_ID` の探し方:

1. SOSで対象企画のお知らせページを開きます。
2. ブラウザDevToolsのNetworkを開きます。
3. お知らせ一覧取得リクエストを探します。
4. URLが `https://sos26-api.sohosai.com/project/<projectId>/notices` になっているので、`<projectId>` 部分を使います。

## Local Setup

```bash
pnpm install
cp .env.example .dev.vars
```

`.dev.vars` にローカル実行用の値を入れます。このファイルはGit管理しません。

```env
SOS_EMAIL=
SOS_PASSWORD=
SOS_PROJECT_ID=
DISCORD_WEBHOOK_URL=
MANUAL_TRIGGER_TOKEN=
```

ローカル実行:

```bash
pnpm dev
```

別ターミナルで手動実行:

```bash
curl "http://localhost:8787/"
```

`MANUAL_TRIGGER_TOKEN` を設定している場合:

```bash
curl "http://localhost:8787/?token=<MANUAL_TRIGGER_TOKEN>"
```

Cron相当のローカル実行:

```bash
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

## Deploy

Cloudflareへログインします。

```bash
pnpm wrangler login
```

KV namespaceを作成します。

```bash
pnpm wrangler kv namespace create NOTICE_STATE
```

表示された `id` を `wrangler.jsonc` の `kv_namespaces[0].id` に設定してください。

本番Secretsを登録します。

```bash
pnpm wrangler secret put SOS_EMAIL
pnpm wrangler secret put SOS_PASSWORD
pnpm wrangler secret put DISCORD_WEBHOOK_URL
```

手動実行URLを保護したい場合だけ、これも登録します。

```bash
pnpm wrangler secret put MANUAL_TRIGGER_TOKEN
```

デプロイします。

```bash
pnpm deploy:worker
```

`wrangler.jsonc` の `triggers.crons` は `*/15 * * * *` なので、15分ごとに実行されます。Cloudflare Cron TriggersはUTC基準です。

## Manual Trigger

本番URLにアクセスすると、Cronと同じチェック処理を手動実行できます。

```bash
curl "https://<worker-name>.<workers-dev-subdomain>.workers.dev/"
```

`MANUAL_TRIGGER_TOKEN` を設定している場合:

```bash
curl "https://<worker-name>.<workers-dev-subdomain>.workers.dev/?token=<MANUAL_TRIGGER_TOKEN>"
```

または:

```bash
curl -H "Authorization: Bearer <MANUAL_TRIGGER_TOKEN>" \
  "https://<worker-name>.<workers-dev-subdomain>.workers.dev/"
```

## Troubleshooting

### TLS handshake failure on workers.dev

`curl: (35) ... sslv3 alert handshake failure` は、WorkerコードやSecret権限のエラーではありません。TLS接続がWorkerに届く前に失敗しています。

よくある原因:

- workers.devサブドメイン作成直後でDNS/証明書がまだ反映中
- `pnpm deploy:worker` が表示したURLと違うURLを叩いている
- Cloudflare Dashboard側でworkers.dev routeが無効

数分待って、`pnpm deploy:worker` が表示したURLをそのまま叩いてください。

### First run does not post old notices

仕様です。初回は既存IDをKVに保存するだけです。初回以降に増えたIDだけ投稿します。

### Send one existing notice as a test

Cloudflare DashboardのKVで `seen-notice-ids` のJSONから1件だけIDを削除し、Worker URLを手動実行してください。その1件だけ新規扱いで投稿されます。

## Commands

```bash
pnpm dev           # wrangler dev
pnpm deploy:worker # Cloudflare Workersへデプロイ
pnpm lint          # Biome lint / format チェック
pnpm lint:fix      # Biome lint / format 自動修正
pnpm check         # TypeScript型チェック
pnpm build         # distへビルド
```

## Git Hooks

リポジトリルートの `lefthook.yml` でpre-commit hookを設定しています。

```bash
lefthook install
```

pre-commitでは `pnpm lint:fix` と `pnpm check` を実行します。
