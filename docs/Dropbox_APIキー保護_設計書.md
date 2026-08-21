# Dropbox APIキー保護 設計書

Claude 用プロキシと同じ考え方で、Dropbox API のトークン／キーをコードに直書きしないための設計です。

---

## 1. 結論（先に）

| 質問 | 答え |
|---|---|
| 今の Claude プロキシはそのまま使える？ | **不可**（API仕様が違う） |
| 同じ運用パターンは使える？ | **可** |
| 何を新しく作る？ | Dropbox 専用の中継（Cloud Run）+ Secret |

---

## 2. 全体像

```
[各ツール（ブラウザ / PHP）]
   ↓ トークンは送らない
[Cloud Run: dropbox-proxy]
   ↓ Secret Manager からトークン取得
[Dropbox API]
```

Claude 側との対応関係:

| Claude | Dropbox（本案） |
|---|---|
| `claude-proxy` | `dropbox-proxy`（新規） |
| `claude-api-key-<tool-id>` | `dropbox-token-<tool-id>` |
| `X-Tool-Id` | `X-Tool-Id`（同じ運用） |
| Anthropic Messages API | Dropbox REST API |

---

## 3. Dropbox で扱う秘密情報

Dropbox は用途で種類が分かれます。

| 種類 | 内容 | 備考 |
|---|---|---|
| Access Token | API呼び出し用 | 短期の場合あり |
| Refresh Token | 再発行用 | **本番推奨**（期限切れ対策） |
| App key / App secret | アプリ識別 | 中継サーバー側のみ |

### 推奨（本番）

Secret Manager にツールごと JSON で保管する。

シークレット名例: `dropbox-token-genspark-aun`

```json
{
  "app_key": "...",
  "app_secret": "...",
  "refresh_token": "...",
  "access_token": "..."
}
```

中継サーバーは:

1. Secret を読む  
2. access_token が切れていれば refresh  
3. Dropbox API を呼ぶ  
4. 必要なら新しい access_token を Secret に書き戻す  

※ Claude の `sk-ant-...` より運用が少し重い（更新があるため）。

---

## 4. 中継APIの設計（案）

### サービス

- 名前: `dropbox-proxy`
- リージョン: `asia-northeast1`
- 公開: HTTP（社内ツール向け。必要なら後で認証強化）
- 実行SA: 既存 Compute SA でも可（Secret Accessor 付与）

### 呼び出し方（ツール側）

```http
POST https://dropbox-proxy-xxxxx-an.a.run.app/v1/rpc
Content-Type: application/json
X-Tool-Id: genspark-aun

{
  "endpoint": "files/list_folder",
  "body": {
    "path": "/AUN"
  }
}
```

または用途を絞った薄いAPI:

```http
POST /v1/upload
POST /v1/download
POST /v1/list
```

**最初は「よく使う操作だけ」に絞る方が安全で簡単**です。

例（最小セット）:

| パス | 用途 |
|---|---|
| `POST /v1/list` | フォルダ一覧 |
| `POST /v1/upload` | ファイルアップロード |
| `POST /v1/download` | ファイルダウンロード |
| `GET /health` | 疎通確認 |

### やってはいけないこと

- フロントから Dropbox へ直叩き（トークン露出）
- 汎用プロキシで「任意URL転送」を許す（悪用リスク大）
  - → **許可した Dropbox API だけ**に限定する

---

## 5. Tool ID と Secret の対応

| Tool ID (`X-Tool-Id`) | Secret名 |
|---|---|
| `genspark-aun` | `dropbox-token-genspark-aun` |
| `syomen`（もし使うなら） | `dropbox-token-syomen` |

命名規則:

```
dropbox-token-<tool-id>
```

Claude と同様、管理画面 or スクリプトで登録できるようにする。

---

## 6. 管理ツール（登録UI）

現状の Claude Key Admin を拡張する案:

### 案A（おすすめ）: 同じ画面に「種別」を追加

```
種別: [ Claude | Dropbox ]
Tool ID: ....
秘密情報: ....
```

- Claude → 既存フロー  
- Dropbox → `dropbox-token-<id>` を作成 + Dropbox プロキシのマップ更新  

### 案B: Dropbox 専用の管理画面を別途作成

混在を避けたい場合。

---

## 7. 実装ステップ（推奨順）

### Phase 1（最小）

1. Secret Manager に `dropbox-token-<tool-id>` を1つ作る  
2. Cloud Run `dropbox-proxy` を作成（list / upload / download）  
3. 1つの既存ツールから接続確認  

### Phase 2

4. Refresh Token 対応（期限切れ自動更新）  
5. 管理UIで Dropbox 登録できるようにする  
6. 他ツールへ展開  

### Phase 3（任意）

7. 呼び出し元制限（共有トークン / IAP / IP制限）  
8. 監査ログ（誰がいつどの操作をしたか）  

---

## 8. Claude 基盤との共通点・差分

### 共通（流用）

- GCPプロジェクト `t8studio-infra-jp`
- Secret Manager
- Cloud Run + GitHub Actions デプロイ
- `X-Tool-Id` 運用
- 「コードに秘密情報を書かない」ルール
- 個人PCの管理ツール起動方式

### 差分（新規）

| 項目 | Claude | Dropbox |
|---|---|---|
| 秘密の形 | APIキー1本 | token + 場合により refresh |
| API | `/v1/messages` 固定 | 複数エンドポイント |
| プロキシ | 既存 `claude-proxy` | **新規 `dropbox-proxy`** |
| リスク | プロンプト送信の悪用 | ファイル操作の悪用（より注意） |

Dropbox はファイルを触れるため、**許可操作を最初から絞る**ことが重要です。

---

## 9. セキュリティ上の注意

1. フロントに App secret / Refresh token を置かない  
2. プロキシは「許可したAPIだけ」呼ぶ  
3. Tool ID だけで公開運用する場合、URLが知られると悪用されうる  
   - 必要ならツールごとの `X-Proxy-Token` を追加  
4. 本番トークンと開発トークンを分ける（可能なら）  

---

## 10. 既存 Claude 手順との関係

- Claude 用手順書・管理UIはそのまま維持  
- Dropbox は並行して別プロキシを追加  
- 「APIキー保護」の考え方は共通、実装はプロバイダ別に分ける  

---

## 11. 次の実装判断

実装に進む場合、最初に決めること:

1. **最初に繋ぐツール名（Tool ID）**  
2. **必要な操作**（list / upload / download のどれか）  
3. **持っている認証情報**（access token のみか、refresh token まであるか）  

これが分かれば、Phase 1（最小プロキシ）から着手できます。
