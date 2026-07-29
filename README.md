# claude-api-proxy

Anthropic Claude API の中継サービス（Cloud Run）。APIキーは GCP Secret Manager (`claude-api-key`) にのみ保管し、コード・GitHub・Docker イメージには含めない。

## アーキテクチャ

```
[ブラウザ JS]
  → Cloud Run (claude-proxy)  ※キーなし
    → Secret Manager からキー取得
    → Claude API
```

デプロイは GitHub Actions 側で Docker ビルドまで完了し、完成イメージを Artifact Registry → Cloud Run へ載せる（GCP Cloud Build でソースビルドしない）。

## 使い方（フロントエンド）

```js
fetch('https://claude-proxy-xxxxx-an.a.run.app', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: '...' }]
  })
})
```

レスポンス形式は Anthropic Messages API と同じ。

## 必要な GCP 権限

| 対象 | ロール | 用途 |
|---|---|---|
| 実行 SA `970630623430-compute@developer.gserviceaccount.com` | `roles/secretmanager.secretAccessor`（シークレット `claude-api-key`） | 実行時にキー取得 |
| GitHub Actions 用 SA | `roles/run.admin` など | イメージ push + Cloud Run デプロイ |

## GitHub Actions 認証（実施済み）

組織ポリシー `iam.disableServiceAccountKeyCreation` により SA キー作成が禁止されているため、**Workload Identity Federation (WIF)** を使用する（キー不要）。

| 項目 | 値 |
|---|---|
| Deploy SA | `github-actions-deploy@t8studio-infra-jp.iam.gserviceaccount.com` |
| 付与ロール | `run.admin` / `artifactregistry.writer` / `artifactregistry.admin` / `iam.serviceAccountUser` |
| WIF Pool | `github-pool` |
| WIF Provider | `projects/970630623430/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| 許可リポジトリ | `T8-Studio/claude-api-proxy` |

GitHub Secrets へのキー登録は不要。リポジトリ名は必ず `claude-api-proxy` にする（WIF の許可条件と一致させる）。

## ローカル起動

```bash
npm install
GCP_PROJECT=t8studio-infra-jp npm start
```

（ローカルでは Application Default Credentials が必要）
