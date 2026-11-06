# CLAUDE.md

常に日本語で応答する。コミットメッセージも日本語で書く。

Enchanterはセルフホスト・単一ユーザー向けのタスク管理 + 作業時間計測ツール。ビルド不要・フレームワークなし・依存パッケージなしのバニラJS SPAで、Node標準の`http`だけで書いた`server.js`が全データを1つのJSONファイルに保存する。

## コマンド

- テスト: `npm test`(= `node --test`。`tests/*.test.js`を実行。数秒で終わる)
- 起動: `node server.js` → `http://localhost:8787`(`PORT`/`DATA_DIR`(既定`./data`)/`HOST`(既定`127.0.0.1`。認証がないためループバックのみ)で上書き)
- ビルド・バンドラー・リンターはない。`file://`で直接開くと動かない(`js/main.js`の`init()`が検知してブロック)

## トークンを節約するための作業ルール

- `data/`配下は読まない(`enchanter-data.json`は`.claude/settings.json`でdeny済み。`backups/`やGoogle認証情報も同様に読まない)。ユーザーの個人データが入っている。動作確認には一時ディレクトリを`DATA_DIR`に指定してサンプルデータを使う
- 変更したい画面・機能から下の「ファイルマップ」で対象ファイルを決め、そのファイルだけを読む。関数を探すときは`Grep`で定義行(`^function 名前`)を見つけてから`Read`の`offset`/`limit`で必要な範囲だけ読む
- `README.md`はエンドユーザー向け。データ構造(スキーマ)を確認するとき以外は読まなくてよい

## ファイルマップ

フロントエンドは通常の`<script>`/`<link>`を`index.html`に並べて読み込む(モジュールではない)。トップレベルの宣言は全ファイルで共有されるので`import`は不要。**ファイルを追加・削除したら`index.html`の読み込みリストも更新する**(`tests/static-assets.test.js`が不一致を検出する)。読み込み時に実行されるコード(トップレベルの`const`の初期化など)は、それより前のファイルで定義されたものしか参照できない。

| 変更したいもの | ファイル |
| --- | --- |
| 定数・表示名(状態・重要度・繰り返し) | `js/constants.js` |
| 日付・時刻の計算/表示 | `js/time.js` |
| `data`/`ui`の定義、保存(`save`)、読み込み、Google連携のクライアント側、`taskById`などの検索 | `js/state.js` |
| 絞り込み・並び順・繰り返し生成・タグ解析など純粋なロジック | `js/domain.js` |
| データを変更する操作(タイマー・状態変更・削除/取り消し)、URLハッシュ | `js/mutations.js` |
| 描画の共通部品(`esc`、選択肢、チップ、Todo/カンバン共通の絞り込みUI) | `js/render-common.js` |
| 各タブの描画 | `js/tab-todo.js` / `tab-kanban.js` / `tab-timeline.js` / `tab-gantt.js` / `tab-report.js` / `tab-manage.js` |
| CSV出力・バックアップのインポート | `js/export.js` |
| `renderAll`(画面全体の再描画)・計測中表示 | `js/render-app.js`(全タブより後に読み込む) |
| クリック・入力・送信・ドラッグ・キーボードの処理 | `js/events.js` |
| 経過時間の毎秒更新・`init()` | `js/main.js`(最後に読み込む) |
| スタイル | `css/base.css`(トークン・共通部品) / `css/<タブ名>.css` / `css/responsive.css`(最後。全タブを上書き) |
| API・保存・バリデーション・Googleカレンダー連携 | `server.js` |
| テスト | `tests/task-improvements.test.js`(画面・ロジック) / `tests/static-assets.test.js`(配信) |

テストは`index.html`の順にフロントのファイルを`vm`へ読み込み、`save`/`renderAll`をスタブにして`renderTodo()`などの戻り値(HTML文字列)を検証する。

## アーキテクチャ

### 状態と描画サイクル

- `data` — 永続化されるモデル`{ clients, categories, projects, tasks, entries, filters }`。`data/enchanter-data.json`と同じ形(詳細は`README.md`の「データ構造」)。`end: null`の`entries`は計測中で、複数タスクを同時に計測できる
- `ui` — タブ・日付範囲・絞り込み・編集中のidなど一時的な表示状態。永続化しない
- 更新は必ず「`data`/`ui`を直接変更 → `save()` → `renderAll()`」。`save()`は`data`全体を`PUT /api/data`し、`saveChain`で直列化される。`renderAll()`はアクティブなタブの`render*()`が返すHTML文字列で`#view`を丸ごと置き換える(仮想DOMなし)。最後に`buildHash()`の結果を`history.replaceState`でURLに反映するので、変更ごとにハッシュを更新する必要はない。`applyHash()`が`init()`と`hashchange`でハッシュを検証して`ui`へ戻す
- `task.status`は`todo`→`in_progress`→`waiting_review`→`done`の順に巡回する(`TASK_STATUS_ORDER`)。`done`になったとき(`setTaskStatus`)だけ、計測中タイマーの停止と繰り返しタスクの次回分生成が起きる。タイマー開始で`todo`は`in_progress`になる
- カテゴリはマスタ(`data.categories`)を`task.categoryId`で参照する。タグはマスタなしの文字列配列(`allTags()`で導出)

### イベントと編集

- イベントは`js/events.js`の**イベント種別ごとに1つの委譲リスナー**で処理する。新しいコントロールは、テンプレートに`data-action="..."`(と`data-id`など)を付け、該当リスナーの`switch`に`case`を足す。要素ごとにリスナーを付けない
- 編集はモーダルではなくインラインフォーム。`ui.editingTask`などにidを入れると該当`render*`が行をフォームに差し替える。`clearEditing()`で全編集状態を戻してから新しい編集に入るので、編集中は常に1つだけ

### 認証なしのセキュリティモデル(必ず維持する)

信頼境界は「ポートに到達できる者すべて」。

- 状態変更系エンドポイント(`PUT /api/data`、`POST /api/google/disconnect`、`POST /api/calendar/sync-entry`)は`requireCsrfHeader()`で`X-Requested-With: enchanter`を必須にしている。サーバーは`OPTIONS`に応答せずCORSヘッダーも返さないので、外部サイトからのCSRFを防げる。新しい状態変更系エンドポイントも同じチェックを入れ、クライアントの`fetch()`にも同ヘッダーを付ける
- `PUT /api/data`と`readData()`は`sanitizeData()`を通す。`color`・`estimateMinutes`などクライアントが`esc()`なしでHTML属性に埋め込む値はここで形式を強制している。HTML属性に描画する列挙型の項目を追加するときは、サーバー側で検証するか描画時に`esc()`する
- 静的ファイルは`/`・`/index.html`と、`/js/`・`/css/`直下の英小文字・数字・ハイフン名のファイルだけを配信する(`staticRouteFor()`)

### その他

- `js/state.js`の`migrateFromLocalStorage`は旧localStorage版からの一回限りの移行。サーバー側が空のときだけ動く。利用者がいないか確認せずに削除しない
- Googleカレンダー連携は任意機能で、Googleとの通信はすべて`server.js`(`fetch`でREST APIを直接呼ぶ)。認証情報は`data/google-credentials.json`/`google-token.json`、作業記録とイベントの対応は`google-sync-map.json`。クライアントは作業記録の`end`が確定するたびに`syncEntryToGoogle()`でfire-and-forget同期する。認証情報が無ければ`ui.googleStatus.configured`が`false`になり、どこでも不活性

## Claude Codeの運用指示

- このリポジトリでplan-modeの設計作業をPlan(またはその他の設計系)サブエージェントに委任する場合は、`model: "fable"`を指定して起動すること
