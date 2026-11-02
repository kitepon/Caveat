# keyserver-lite

Caveat の封緘公開層（sealed public tier）向け、鍵配布専用の最小 Cloudflare Worker。
設計は [docs/archive/07_sealed_public_and_autosync.md](../docs/archive/07_sealed_public_and_autosync.md) の
Track B。**このディレクトリは repo ルートの pnpm workspace（`pnpm-workspace.yaml`）に含まれない
独立パッケージ**。`corepack pnpm -r test` / `-r build` の対象外で、依存も本体側 `@caveat/*` を
一切持たない。

## これは何をするものか

`GET /v1/keys/<id>` に対して、Cloudflare KV に保存された base64 32B の鍵をそのまま返すだけの
Worker。無認証・CORS 設定なし・レート制限は Cloudflare の既定に任せる。ロジック本体は
[src/worker.ts](src/worker.ts) の `handleKeyRequest`（純粋関数、`fetch` ハンドラはこれを呼ぶだけ）。

### クライアント契約（バイト互換・変更禁止）

購読側クライアントは `packages/core/src/sealedKeys.ts` の `fetchKey`（`createKeyserverKeyProvider`
内）。この Worker が返すレスポンスは以下を**1 バイトも外してはいけない**——外すと全購読者が
復号不能になる:

- リクエスト: `GET <keyserverUrl>/v1/keys/<encodeURIComponent(bareId)>`
- レスポンス: `response.ok`（2xx）かつ JSON `{"keyId": "<bareId>", "key": "<base64>"}`
  - `keyId` は要求 id と厳密一致していること
  - `key` は base64 デコードして正確に 32 バイトであること

## デプロイ手順

前提: `wrangler` にログイン済み（`wrangler login`）、Cloudflare アカウントに Workers KV が
使える状態であること（無料枠で足りる）。

```sh
cd keyserver
pnpm install   # または npm install（独立パッケージなので npm でも可）

# 1. 鍵を生成する（32 バイト、base64 エンコード）
openssl rand -base64 32
# 出力例: 8f3Jc9k+Qy1v...（実際にはこのファイルに残さない。控えたら端末履歴もクリアする）

# 2. KV namespace を作成する
wrangler kv namespace create KEYS
# 出力された id を wrangler.toml の [[kv_namespaces]] id = "<REPLACE_WITH_KV_NAMESPACE_ID>" に書く

# 3. 鍵を KV に登録する（keyId は ~/.caveatrc.json の sealedKeyId と一致させる。既定は "v1"）
wrangler kv key put --binding=KEYS v1 "<手順1で生成した base64 鍵>"

# 4. デプロイする
wrangler deploy
```

デプロイ後に表示される URL（例: `https://caveat-keyserver.<account>.workers.dev`）を、
購読者端末の `~/.caveatrc.json` の `sealedKeyserverUrl` に設定する。

**重要**: `wrangler.toml` に実鍵・実 KV namespace id をコミットしない。namespace id は
public repo に置いても実害は薄い（KV へのアクセスは Cloudflare API トークン側で制御される）が、
本テンプレートはプレースホルダのまま残す運用を前提にしている。

## 鍵ローテーション手順

Worker は **旧 keyId も返し続ける**（削除しない）ことで、購読者の旧バンドル（ローテ前に
publish されたもの）の読み取りを壊さない。

1. 新しい鍵を生成: `openssl rand -base64 32`
2. 新しい keyId（例 `v2`）で KV に登録: `wrangler kv key put --binding=KEYS v2 "<新鍵>"`
3. `~/.caveatrc.json` の `sealedKeyId` を `v2` に更新
4. `caveat publish` を実行（新しい publish 以降は `keyserver:v2` を使う）
5. 旧 keyId（`v1`）の KV エントリは**削除しない**——旧バンドルを持つ購読者が復号できなくなる

## 脅威モデル

守るもの: **カジュアル閲覧・コピー・LLM 学習クローラ・GitHub 自身の AI 学習からの遮断**。

守らないもの: **動機ある人間の解析**。この Worker は無認証で誰でも鍵を取得できる。
Caveat の手順（`GET /v1/keys/<id>`）を再現すれば、人間は封緘バンドルを復号できる。
これは意図した設計であり、バグではない（詳細は `docs/archive/07_sealed_public_and_autosync.md` の「脅威モデル」節）。

本物のアクセス制御が必要になった場合は、下記「将来の昇格経路」でトークン制へ移行できる。
それまでは、この Worker は「静的コンテンツを平文で置かない」ための最小限の摩擦として機能する。

## 将来の昇格経路（設計メモ・実装しない）

同じ `/v1/keys/<id>` エンドポイントに Bearer token 検証を足せば、無認証配布からトークン制
（give-to-get 型の購読制御等）へ昇格できる形を保っている:

- `handleKeyRequest` の先頭で `Authorization: Bearer <token>` ヘッダを検証するステップを挿入
- トークンの発行・検証ロジックは別 KV namespace（例 `TOKENS`）または外部 IdP に委譲
- レスポンス形式（`{keyId, key}`）とクライアント側 `fetchKey` の契約は変更不要——認可層は
  リクエストの手前に挿入するだけで済む

現時点ではこの昇格は行わない（YAGNI。実需が出るまで keyserver-lite は無認証のまま）。

## 独立keyserverの検証

keyserverはroot workspaceへ含めず、製品full CIの3OSで独立して検証する。実KVや公開操作は使わない。

```sh
corepack pnpm --dir keyserver install --frozen-lockfile
corepack pnpm --dir keyserver typecheck
corepack pnpm --dir keyserver test
```
