'use strict';

/* ============================================================
 * Enchanter - ローカルサーバー
 * 静的ファイル(index.html・js/・css/)の配信と、データのJSONファイル保存を行う。
 * 依存パッケージなし。`node server.js` で起動。
 * ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// テストはvm上でこのファイルを実行するため、相対パスではなく__dirname基準で読み込む
const { createStore, sanitizeData, readJsonSafe, writeJsonAtomic } = require(path.join(__dirname, 'store.js'));

// ---- 設定 ----
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_BODY = 20 * 1024 * 1024;
// 秘書(Claude)が置くタスクの受信箱。直下の*.jsonをアプリが開いたときに追加取り込みし、済んだものは下のフォルダーへ移す
const INBOX_DIR = process.env.INBOX_DIR || path.join(__dirname, 'imports');
const INBOX_DONE_DIR = path.join(INBOX_DIR, '取り込み済み');
const INBOX_NAME_RE = /^[^\\/:*?"<>|]+\.json$/;
const MAX_INBOX_FILE = 2 * 1024 * 1024;
const store = createStore(DATA_DIR);
const { writeData } = store;


const STATIC_ROUTES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
};
// js/・css/直下のファイルだけを配信する。名前を英小文字・数字・ハイフンに限定してパストラバーサルを防ぐ
const ASSET_RE = /^\/(js|css)\/[a-z0-9-]+\.\1$/;
const ASSET_TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

function staticRouteFor(pathname) {
  if (STATIC_ROUTES[pathname]) return STATIC_ROUTES[pathname];
  const match = ASSET_RE.exec(pathname);
  return match ? { file: pathname.slice(1), type: ASSET_TYPES[match[1]] } : null;
}


// ---- HTTP ヘルパー ----

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function sendInternalError(res, error) {
  console.error('リクエストの処理中にエラーが発生しました', error);
  if (!res.headersSent) sendJson(res, 500, { error: '内部エラーが発生しました' });
  else res.end();
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendMethodNotAllowed(res, allow) {
  res.writeHead(405, { Allow: allow });
  res.end();
}

// 許可されていないHTTPメソッドには405を返し、falseを返す
function allowMethod(req, res, method) {
  if (req.method === method) return true;
  sendMethodNotAllowed(res, method);
  return false;
}

// カスタムヘッダーの付与を必須にすることで、あらゆるメソッドでCORSプリフライトを
// 発生させる。このサーバーはプリフライト(OPTIONS)に応答しないため、外部サイトから
// ブラウザ経由で状態変更系エンドポイントを叩く(CSRF)ことができなくなる。
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'enchanter';

function requireCsrfHeader(req, res) {
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) {
    sendJson(res, 400, { error: '不正なリクエストです' });
    return false;
  }
  return true;
}

// リクエストボディを文字列として読み切ってから onEnd に渡す。
// MAX_BODY を超えた場合は413を返して接続を切り、onEnd は呼ばない。
function readBody(req, res, onEnd) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      aborted = true;
      sendJson(res, 413, { error: 'データが大きすぎます' });
      req.destroy();
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    // チャンク境界で多バイト文字が割れるため、バイト列を結合してから文字列にする
    if (!aborted) onEnd(Buffer.concat(chunks).toString('utf8'));
  });
}

// JSONとして読めて、かつオブジェクトであること(配列やnullは不可)を確認する
function parseJsonObject(text) {
  const value = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('JSONオブジェクトではありません');
  }
  return value;
}

// ---- データAPI ----

// ブラウザは読み込み時のリビジョンをIf-Matchで送る。CLIなど別の場所でファイルが
// 更新されていたら409を返し、ブラウザ側で最新を読み直させる(古い全体データでの上書きを防ぐ)
const REVISION_HEADER = 'X-Data-Revision';

function handleGetData(res) {
  const { data, revision } = store.readDataWithRevision();
  sendJson(res, 200, data, { [REVISION_HEADER]: revision });
}

function handlePutData(req, res) {
  if (!requireCsrfHeader(req, res)) return;
  readBody(req, res, (body) => {
    let payload;
    try {
      payload = parseJsonObject(body);
    } catch {
      sendJson(res, 400, { error: '不正なJSONです' });
      return;
    }
    const expected = req.headers['if-match'];
    const current = store.currentRevision();
    if (expected && expected !== current) {
      sendJson(res, 409, { error: '他の場所でデータが更新されています' }, { [REVISION_HEADER]: current });
      return;
    }
    // readBodyのコールバックは非同期なので、ここで投げた例外はcreateServer側では捕まらずプロセスが落ちる。
    // 形の崩れたペイロード(tasksが配列でない等)はsanitizeDataで例外になるため、必ずここで捕まえる
    let revision;
    try {
      revision = writeData(payload);
    } catch (error) {
      console.error('データの保存に失敗しました', error);
      sendJson(res, 400, { error: '不正なデータです' });
      return;
    }
    res.writeHead(204, { [REVISION_HEADER]: revision });
    res.end();
  });
}

// ---- Google カレンダー連携 ----
const GOOGLE_CREDENTIALS_FILE = path.join(DATA_DIR, 'google-credentials.json');
const GOOGLE_TOKEN_FILE = path.join(DATA_DIR, 'google-token.json');
const GOOGLE_SYNC_MAP_FILE = path.join(DATA_DIR, 'google-sync-map.json');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const OAUTH_REDIRECT_PATH = '/oauth/callback';
const OAUTH_REDIRECT_URI = `http://localhost:${PORT}${OAUTH_REDIRECT_PATH}`;
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// アクセストークンの期限がこの時間以内に迫ったら、更新してから使う
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
// 認可開始時に発行し、コールバックで一致を確認する(OAuthのstate検証)
let pendingOAuthState = null;

function getGoogleCredentials() {
  return readJsonSafe(GOOGLE_CREDENTIALS_FILE, null);
}

function getGoogleToken() {
  return readJsonSafe(GOOGLE_TOKEN_FILE, null);
}

// 連携トークンを削除する(既に無い場合は何もしない)
function deleteGoogleToken() {
  try { fs.unlinkSync(GOOGLE_TOKEN_FILE); } catch { /* 既に未連携なら無視 */ }
}

// Googleのトークンエンドポイントへ POST する。失敗時は label 付きのエラーを投げる
async function requestGoogleToken(params, label) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!response.ok) throw new Error(`${label}: ${response.status}`);
  return response.json();
}

// アクセストークンが有効ならそのまま返し、期限切れ間近なら refresh_token で更新する。
// 未連携・更新失敗時は null(呼び出し側は「未連携」として扱う)。
async function getValidAccessToken() {
  const creds = getGoogleCredentials();
  const token = getGoogleToken();
  if (!creds || !token) return null;
  if (token.expiry - Date.now() > TOKEN_REFRESH_MARGIN_MS) return token.access_token;

  try {
    const tokenResponse = await requestGoogleToken({
      refresh_token: token.refresh_token,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      grant_type: 'refresh_token',
    }, 'refresh failed');
    const updated = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || token.refresh_token,
      expiry: Date.now() + tokenResponse.expires_in * 1000,
    };
    writeJsonAtomic(GOOGLE_TOKEN_FILE, updated);
    return updated.access_token;
  } catch (error) {
    console.error('Googleアクセストークンの更新に失敗しました', error);
    deleteGoogleToken();
    return null;
  }
}

// エントリ1件をGoogleカレンダーの予定として作成、または既存の予定を更新する。
// entryId→googleイベントIDの対応はGOOGLE_SYNC_MAP_FILEに保持し、再同期時の重複作成を防ぐ。
async function upsertCalendarEvent(accessToken, { entryId, title, project, start, end }) {
  const syncMap = readJsonSafe(GOOGLE_SYNC_MAP_FILE, {});
  const event = {
    summary: title,
    description: project ? `プロジェクト: ${project}` : undefined,
    start: { dateTime: new Date(start).toISOString(), timeZone: TIMEZONE },
    end: { dateTime: new Date(end).toISOString(), timeZone: TIMEZONE },
  };
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const existingEventId = syncMap[entryId];
  if (existingEventId) {
    const response = await fetch(`${GOOGLE_EVENTS_URL}/${existingEventId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(event),
    });
    if (response.ok) {
      const updatedEvent = await response.json();
      return updatedEvent.id;
    }
    // カレンダー側で予定が削除済み(404/410)の場合は下の新規作成にフォールバックする
    if (response.status !== 404 && response.status !== 410) {
      throw new Error(`calendar update failed: ${response.status}`);
    }
  }

  const response = await fetch(GOOGLE_EVENTS_URL, { method: 'POST', headers, body: JSON.stringify(event) });
  if (!response.ok) throw new Error(`calendar create failed: ${response.status}`);
  const createdEvent = await response.json();
  syncMap[entryId] = createdEvent.id;
  writeJsonAtomic(GOOGLE_SYNC_MAP_FILE, syncMap);
  return createdEvent.id;
}

async function handleOAuthCallback(url, res) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const creds = getGoogleCredentials();
  if (!code || !state || !creds || state !== pendingOAuthState) {
    redirect(res, '/?google=error');
    return;
  }
  pendingOAuthState = null;
  try {
    const tokenResponse = await requestGoogleToken({
      code,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }, 'token exchange failed');
    const existing = getGoogleToken();
    writeJsonAtomic(GOOGLE_TOKEN_FILE, {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || (existing && existing.refresh_token),
      expiry: Date.now() + tokenResponse.expires_in * 1000,
    });
    redirect(res, '/?google=connected');
  } catch (error) {
    console.error('Google OAuth トークン取得に失敗しました', error);
    redirect(res, '/?google=error');
  }
}

async function handleSyncEntry(payload, res) {
  const { entryId, title, project, start, end } = payload;
  if (!entryId || !title || !Number.isFinite(start) || !Number.isFinite(end)) {
    sendJson(res, 400, { error: '不正なリクエストです' });
    return;
  }
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      sendJson(res, 409, { error: 'Google未連携です' });
      return;
    }
    const eventId = await upsertCalendarEvent(accessToken, { entryId, title, project, start, end });
    sendJson(res, 200, { ok: true, eventId });
  } catch (error) {
    console.error('Googleカレンダー同期に失敗しました', error);
    sendJson(res, 502, { error: '同期に失敗しました' });
  }
}

function handleGoogleStatus(res) {
  sendJson(res, 200, { configured: !!getGoogleCredentials(), connected: !!getGoogleToken() });
}

function handleGoogleAuthUrl(res) {
  const creds = getGoogleCredentials();
  if (!creds) {
    sendJson(res, 400, { error: 'data/google-credentials.json が見つかりません' });
    return;
  }
  pendingOAuthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: pendingOAuthState,
  });
  sendJson(res, 200, { url: `${GOOGLE_AUTH_URL}?${params}` });
}

function handleGoogleDisconnect(res) {
  deleteGoogleToken();
  sendNoContent(res);
}

function handleSyncEntryRequest(req, res) {
  readBody(req, res, (body) => {
    let payload;
    try {
      payload = parseJsonObject(body);
    } catch {
      sendJson(res, 400, { error: '不正なJSONです' });
      return;
    }
    handleSyncEntry(payload, res).catch((error) => sendInternalError(res, error));
  });
}

// ---- 受信箱(imports/) ----

function isInboxName(name) {
  return typeof name === 'string' && INBOX_NAME_RE.test(name) && path.basename(name) === name;
}

// 受信箱のファイルを読み、表示・取り込みに使う前にsanitizeDataで整える。読めないファイルはerrorとして返す
function listInbox() {
  if (!fs.existsSync(INBOX_DIR)) return [];
  return fs.readdirSync(INBOX_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && isInboxName(dirent.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => {
      const file = path.join(INBOX_DIR, name);
      try {
        if (fs.statSync(file).size > MAX_INBOX_FILE) return { name, error: 'too_large' };
        const parsed = parseJsonObject(fs.readFileSync(file, 'utf8'));
        return { name, content: sanitizeData(parsed) };
      } catch {
        return { name, error: 'invalid' };
      }
    });
}

// 取り込み済みのファイルを 取り込み済み/ へ移す。同名があれば時刻を付けて残す
function markInboxDone(name) {
  const source = path.join(INBOX_DIR, name);
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(INBOX_DONE_DIR, { recursive: true });
  let target = path.join(INBOX_DONE_DIR, name);
  if (fs.existsSync(target)) target = path.join(INBOX_DONE_DIR, name.replace(/\.json$/, `-${Date.now()}.json`));
  fs.renameSync(source, target);
  return true;
}

function handleInboxDoneRequest(req, res) {
  readBody(req, res, (body) => {
    let payload;
    try {
      payload = parseJsonObject(body);
    } catch {
      sendJson(res, 400, { error: '不正なJSONです' });
      return;
    }
    if (!isInboxName(payload.name)) {
      sendJson(res, 400, { error: '不正なファイル名です' });
      return;
    }
    // readBodyのコールバックは非同期なので、ファイル移動の例外をここで捕まえないとプロセスが落ちる
    try {
      sendJson(res, 200, { moved: markInboxDone(payload.name) });
    } catch (error) {
      sendInternalError(res, error);
    }
  });
}

// ---- 静的ファイル ----

function serveStatic(res, { file, type }) {
  fs.readFile(path.join(__dirname, file), (error, buffer) => {
    if (error) {
      const missing = error.code === 'ENOENT';
      res.writeHead(missing ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(missing ? 'Not Found' : 'Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(buffer);
  });
}

// ---- ルーティング ----

function routeRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- API ----
  if (url.pathname === '/api/data') {
    if (req.method === 'GET') {
      handleGetData(res);
    } else if (req.method === 'PUT') {
      handlePutData(req, res);
    } else {
      sendMethodNotAllowed(res, 'GET, PUT');
    }
    return;
  }

  // 画面を開いたまま他の場所(CLI)で変更されたかを確かめるための軽い問い合わせ
  if (url.pathname === '/api/data/revision') {
    if (allowMethod(req, res, 'GET')) sendJson(res, 200, { revision: store.currentRevision() });
    return;
  }

  // ---- Google カレンダー連携 ----
  if (url.pathname === '/api/google/status') {
    if (allowMethod(req, res, 'GET')) handleGoogleStatus(res);
    return;
  }

  if (url.pathname === '/api/google/auth-url') {
    if (allowMethod(req, res, 'GET')) handleGoogleAuthUrl(res);
    return;
  }

  if (url.pathname === OAUTH_REDIRECT_PATH) {
    if (allowMethod(req, res, 'GET')) handleOAuthCallback(url, res).catch((error) => sendInternalError(res, error));
    return;
  }

  if (url.pathname === '/api/inbox') {
    if (allowMethod(req, res, 'GET')) sendJson(res, 200, { files: listInbox() });
    return;
  }

  if (url.pathname === '/api/inbox/done') {
    if (allowMethod(req, res, 'POST') && requireCsrfHeader(req, res)) handleInboxDoneRequest(req, res);
    return;
  }

  if (url.pathname === '/api/google/disconnect') {
    if (allowMethod(req, res, 'POST') && requireCsrfHeader(req, res)) handleGoogleDisconnect(res);
    return;
  }

  if (url.pathname === '/api/calendar/sync-entry') {
    if (allowMethod(req, res, 'POST') && requireCsrfHeader(req, res)) handleSyncEntryRequest(req, res);
    return;
  }

  // ---- 静的ファイル ----
  const route = staticRouteFor(url.pathname);
  if (req.method === 'GET' && route) {
    serveStatic(res, route);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

const server = http.createServer((req, res) => {
  try {
    routeRequest(req, res);
  } catch (error) {
    sendInternalError(res, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Enchanter が起動しました: http://localhost:${PORT} (bind: ${HOST})`);
  console.log(`データ保存先: ${store.dataFile}`);
});
