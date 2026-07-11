# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## これは何か

Enchanterは、セルフホスト・単一ユーザー向けのタスク/時間管理ツール(Todo管理 + 作業時間計測)です。ビルド不要・フレームワーク不使用・依存パッケージなしのバニラJS SPAで、依存パッケージなしの小さなNode HTTPサーバーがすべてを1つのJSONファイルに永続化します。

## コマンド

- サーバー起動: `node server.js`(Windowsは`start.cmd`をダブルクリックでも可。ブラウザも自動で開く)
- Dockerで起動: `docker compose up -d`
- ビルドステップ・バンドラー・テストスイート・リンターなし — `app.js`/`style.css`/`index.html`はそのまま配信される
- 既定ポートは`8787`(`PORT`環境変数で上書き可)。データディレクトリは既定`./data`(`DATA_DIR`で上書き可)。待受アドレスは既定`127.0.0.1`(認証機能がないためループバックのみ。LANに公開する場合は`HOST`環境変数で上書き)
- アプリは必ずサーバー経由(`http://localhost:8787`)でアクセスする必要がある。`index.html`を直接開く(`file://`)と保存にHTTP APIが必要なため動作せず、`app.js`側でもこのケースを検知してブロックしている

## アーキテクチャ

アプリ全体は4つのファイルで構成され、それぞれ役割が1つに限定されている:

- `server.js` — フレームワークなしの`http`サーバー。3つの静的ファイル(`index.html`, `style.css`, `app.js`)を固定ルートで配信し、`GET /api/data` / `PUT /api/data`で全データセットを1つのJSONブロブとして扱うAPIを公開し、Googleカレンダーのoauth/同期エンドポイントもホストする(後述)。書き込みはアトミック(`.tmp`に書いてから`fs.renameSync`)なので、書き込み中のクラッシュでもデータが壊れない
- `app.js` — クライアントアプリ本体一式。state・mutation・rendering・event handlingの順に並んでいる(`/* ---------- rendering ---------- */`のようなセクションマーカーを参照)。モジュール/バンドラーなし。すべてトップレベル関数と、モジュールスコープのオブジェクトが2つあるのみ
- `style.css` — `prefers-color-scheme`によるライト/ダークテーマ切替、プリプロセッサなし
- `index.html` — 骨格のみ。`<main id="view">`が唯一のレンダーターゲットで、タブボタンはヘッダーにある

### 認証なしのセキュリティモデル

ログイン/セッション機構は存在せず、信頼境界は「ポートに到達できる者すべて」となっている。この境界を保つために2つの仕組みがあり、`server.js`/`app.js`を触る際は必ず維持すること:
- 状態変更系エンドポイント(`PUT /api/data`, `POST /api/google/disconnect`, `POST /api/calendar/sync-entry`)はすべて`X-Requested-With: enchanter`ヘッダーを要求する(`requireCsrfHeader()`でチェック)。これによりメソッドを問わずすべてのリクエストでCORSプリフライトが発生する。サーバーは`OPTIONS`に応答せず`Access-Control-Allow-Origin`も送らないため、悪意あるページからブラウザ経由でこれらのエンドポイントを叩く(drive-by CSRF)ことができない。新しく状態変更系エンドポイントを追加する場合は必ず`requireCsrfHeader()`を呼び、`app.js`側の対応する`fetch()`呼び出しにも同ヘッダーを付けること
- `PUT /api/data`(および読み込み時の`readData()`)はペイロードを`sanitizeData()`に通し、`project.color`を`/^#[0-9a-fA-F]{6}$/`に、`task.repeat`を`daily`/`weekly`/`monthly`/`null`のいずれかに、`task.status`を`todo`/`waiting_review`/`done`のいずれかに(旧`task.done`真偽値からのフォールバックあり。後述)、`task.estimateMinutes`を正の整数または`null`に強制する(`task.note`は文字列/`null`に補正されるがそれ以外はそのまま通す — 常に`esc()`経由で描画される)。`task.subtasks`は`{ id, title, done }`の形に整った要素だけにフィルタされる(タイトルが欠落/非文字列の要素は除外、idが無ければ`crypto.randomUUID()`で補完)。`data.filters`(保存済みフィルター)も同様に、`name`が欠落/空文字の要素は除外し、`importance`/`month`を許可された値の集合に強制する。`color`/`estimateMinutes`のようなフィールドはクライアント側で`style="background:..."` / `value="..."`属性に無エスケープで埋め込まれるため、不正なAPIペイロードや手編集された`data/enchanter-data.json`が属性からの脱出を許してしまう可能性がある。HTML属性に描画される新しい列挙型フィールドを追加する場合は、同様の対処(サーバー側バリデーションまたはクライアント側`esc()`)が必要

### クライアントの状態構造

`app.js`内のモジュールレベルのグローバル変数2つがすべてを保持する:
- `data` — 永続化されるドメインモデル: `{ clients[], projects[], tasks[], entries[] }`。`data/enchanter-data.json`と完全に一致する(スキーマは`README.md`参照)。`end: null`の`entries`は計測中のタイマーを表し、複数タスクを同時に計測できる。`task.status`は`'todo' | 'waiting_review' | 'done'`(ステータス切替ボタンをクリックするたびにこの順で巡回する。実装は`nextTaskStatus()`。ネイティブのcheckboxでは3状態を表現できないため)。`todo → done`への遷移時のみ、計測中タイマーの自動停止と繰り返しタスクの次回分生成が発火する — `waiting_review`を経由してもどちらも発火しない。各タスクは`subtasks[]`チェックリスト(`{ id, title, done }`)も持つ
- `ui` — 一時的な表示状態(アクティブなタブ、timeline/gantt/reportの日付範囲、現在編集中の項目など)。永続化されない

### レンダー/更新/保存サイクル

差分検出や仮想DOMは存在しない。全体を通して使われるパターンは:
1. mutation関数が`data`または`ui`を直接変更する(例: `startTimer`, `deleteTask`)
2. `save()`を呼ぶ。`data`全体をシリアライズして`/api/data`に`PUT`する。保存は単一のPromiseチェーン(`saveChain`)を通るため、連続した編集がサーバー側で競合・順序逆転することがない
3. `renderAll()`を呼ぶ。アクティブなタブのマークアップをテンプレートリテラルのHTML文字列として`#view`にまるごと再描画する(タブごとに1つの`render*`関数: `renderTodo`, `renderTimeline`, `renderGantt`, `renderReport`, `renderManage`)

### イベントハンドリング

インタラクティブな要素はすべて、`app.js`末尾(`/* ---------- events ---------- */`)にある**DOMイベント種別ごとに1つの委譲リスナー**で処理される。要素ごとの個別ハンドラは使わない:
- `click` → `[data-action]` / `el.dataset.action`に基づき大きな`switch`で分岐
- `change`と`submit` → 別々の委譲リスナーで、同じく`data-action`/`data-*`属性の規約に従う

新しいインタラクティブなコントロールを追加する場合は、この規約に従うこと: テンプレート文字列に`data-action="..."`(および必要に応じて`data-id`などの`data-*`)属性を追加し、新しいリスナーをアタッチするのではなく、該当する委譲リスナーに`case`を追加する

### タブ

各タブ(`todo`, `timeline`, `gantt`, `report`, `manage`)は独立した`render*`関数で、`#view`向けの完全なHTML文字列を生成する。タブ切替は`ui.tab`を変更して`renderAll()`を呼ぶだけ。タブの状態(および現在のタブの日付・期間)は`buildHash()`によってURLハッシュ(`#timeline?date=...`)に反映され、`renderAll()`の最後で`history.replaceState`により一度だけ適用される — すべての状態変更が`renderAll()`を経由するため、mutationごとにハッシュを更新する必要はない。`applyHash()`(`init()`時と`hashchange`時に呼ばれる)がハッシュをパース・検証して`ui`に反映するため、リロード/ブックマーク/戻る・進むでも表示状態が復元される

### 編集パターン

インライン編集フォーム(モーダルではない)は、`ui.editingTask`/`ui.editingEntry`/`ui.editingClient`/`ui.editingProject`をid(または`null`)に設定することでトグルされる。該当する`render*`関数がこの値を見て、行をフォームに差し替える。`clearEditing()`は新しい編集状態に入る前にこの4つすべてをリセットするため、アプリ全体で常に1つのものしか編集状態にならない

### 旧バージョンからの移行

`app.js`には、ブラウザの`localStorage`(`enchanter-data-v1`)にデータを保存していた旧バージョン向けの一回限りの移行ロジック(`migrateFromLocalStorage`)が残っている。`init()`時に一度だけ実行され、サーバー側のファイルが空の場合のみ動作し、実行後は`localStorage`のフラグで自身をゲートする — このパスにまだ依存しているユーザーがいないか確認せずに削除しないこと

### Googleカレンダー連携(任意機能)

すべて`server.js`内に閉じている(npmパッケージは追加せず、`fetch`でGoogleのREST APIを直接呼び出す)。`app.js`側は`/api/google/*`と`/api/calendar/sync-entry`エンドポイントを呼ぶだけで、Googleの認証情報に直接触れることはない。エンドユーザー向けのセットアップ手順は`README.md`の「Googleカレンダー連携」セクションを参照

- 設定は`data/`配下(gitignore対象、コミットされない)に置かれる: `google-credentials.json`(ユーザーがGoogle Cloud ConsoleからOAuthクライアントID/シークレットを取得して保存)、`google-token.json`(アクセス/リフレッシュトークン、サーバーが書き込む)。`google-sync-map.json`はローカルの`entryId` → GoogleイベントIDの対応を保持し、同じ作業記録を再同期した際に重複作成せず既存イベントを更新する
- OAuthは「デスクトップアプリ」フロー: `GET /api/google/auth-url`が同意画面URLを組み立て(ランダムな`state`をメモリ上の`pendingOAuthState`に保存)、ブラウザがGoogleにリダイレクトされ、`GET /oauth/callback`が`state`の一致を確認したうえで認可コードをトークンに交換する。`getValidAccessToken()`はアクセストークンの期限が近づくとリフレッシュトークンを使って透過的に更新する
- `app.js`の`syncEntryToGoogle()`は、作業記録の`end`が非nullになるたび(タイマー停止、または手動での作業記録追加/編集)に`POST /api/calendar/sync-entry`を呼ぶ(呼び出し元は「レンダー/更新/保存サイクル」を参照)。これはfire-and-forgetで、失敗してもログに記録されるだけでローカルの保存/描画サイクルをブロックしない
- `data/google-credentials.json`が存在しない場合、`ui.googleStatus.configured`は`false`になり、この機能はどこにおいても不活性になる — Googleが設定済みであることを前提とするコードパスは存在しない

## Claude Codeの運用指示

- このリポジトリでplan-modeの設計作業をPlan(またはその他の設計系)サブエージェントに委任する場合は、`model: "fable"`を指定して起動すること
