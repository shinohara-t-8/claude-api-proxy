# claude-api-proxy

Anthropic Claude API の中継サービス（Cloud Run）。APIキーは GCP Secret Manager にツール別に保管し、コード・GitHub・Docker イメージには含めない。

## アーキテクチャ

```
[altplus / design-search / ...]
  → Cloud Run (claude-proxy)  ※ X-Tool-Id でツール識別
    → Secret Manager（ツール別キー）
    → Claude API
```

## 管理ツール（ローカルUI）

`start-admin.cmd` をダブルクリックするか:

```powershell
cd C:\Users\user\Documents\claude-api-proxy
node admin\server.js
```

ブラウザで http://127.0.0.1:8787 を開き、Tool ID と APIキーを入力して登録します（localhost のみ待受）。

## 新しいツールを追加（CLI）

tool id と APIキーを渡すだけで、Secret 作成・権限付与・マップ更新まで行えます。

```powershell
cd C:\Users\user\Documents\claude-api-proxy
.\scripts\add-tool.ps1 -ToolId "auditor" -ApiKey "sk-ant-..." -Push
```

`-Push` を付けると commit & push まで行い、GitHub Actions が Cloud Run をデプロイします。

Cursor では「〇〇ツールの APIキーを追加して」と伝えると、スキル `add-claude-tool` が同じ手順を実行します。

## ツール別シークレット

| Tool ID (`X-Tool-Id`) | Secret Manager 名 |
|---|---|
| `altplus` | `claude-api-key-altplus` |
| `design-search` | `claude-api-key-design-search` |

新しいツールを足すとき:

1. Secret Manager に `claude-api-key-<tool-id>` を作成
2. 実行 SA に `secretAccessor` を付与
3. プロキシの `TOOL_SECRET_MAP`（または `index.js` のデフォルト）に追加してデプロイ
4. 呼び出し側で `X-Tool-Id: <tool-id>` を付ける

## 使い方

```js
fetch('https://claude-proxy-xxxxx-an.a.run.app', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Tool-Id': 'altplus'
  },
  body: JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: '...' }]
  })
})
```

## GitHub Actions 認証

| 項目 | 値 |
|---|---|
| Deploy SA | `github-actions-deploy@t8studio-infra-jp.iam.gserviceaccount.com` |
| WIF Provider | `projects/970630623430/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| 許可リポジトリ | `T8-Studio/claude-api-proxy` |

## ローカル起動

```bash
npm install
GCP_PROJECT=t8studio-infra-jp npm start
```
