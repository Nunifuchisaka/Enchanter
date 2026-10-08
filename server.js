'use strict';

/* ============================================================
 * Enchanter - ローカルサーバー
 * 静的ファイルの配信と、データのJSONファイル保存を行う。
 * 依存パッケージなし。`node server.js` で起動。
 * ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- 設定 ----
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'enchanter-data.json');
const MAX_BODY = 20 * 1024 * 1024;

const EMPTY_DATA = { clients: [], projects: [], tasks: [], entries: [] };
const DEFAULT_COLOR = '#7c5cff';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const REPEAT_VALUES = new Set(['daily', 'weekly', 'monthly']);
const TASK_STATUSES = new Set(['todo', 'in_progress', 'waiting_review', 'done']);
const FILTER_LEVELS = ['', '0', '1', '2', '3'];

const STATIC_ROUTES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- データの検証(読み込み時・保存時の両方で必ず通す) ----

// importance(重要度)/weight(重さ)共通の0-3段階バリデーション(0=指定なし)
function sanitizeLevel(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function ensureId(id) {
  return typeof id === 'string' && id ? id : crypto.randomUUID();
}

// タグはトリム済み・空要素なし・重複なしの文字列配列に強制する(表示は常にesc()経由)
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const sanitized = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    sanitized.push(trimmed);
  }
  return sanitized;
}

// status未設定の旧データ(done: booleanのみ)を新形式へ変換する後方互換マイグレーション
function sanitizeStatus(task) {
  if (TASK_STATUSES.has(task.status)) return task.status;
  return task.done === true ? 'done' : 'todo';
}

function sanitizeSubtasks(subtasks) {
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .filter((subtask) => subtask && isNonBlankString(subtask.title))
    .map((subtask) => ({ id: ensureId(subtask.id), title: subtask.title, done: subtask.done === true }));
}

// color/repeat/estimateMinutes等はHTML属性に埋め込まれる値があるため、通常UIの入力制限に頼らず
// 保存前にサーバー側でも形式を強制する(不正なAPIペイロードや手編集されたデータファイル対策)
function sanitizeTask(task) {
  const rest = { ...task };
  delete rest.done; // 旧フィールド(done)は保存先から除去する
  const status = sanitizeStatus(task);
  return {
    ...rest,
    status,
    todayDate: typeof task.todayDate === 'string' && DATE_RE.test(task.todayDate) ? task.todayDate : null,
    completedAt: status === 'done'
      ? (Number.isFinite(task.completedAt) ? task.completedAt : Date.now())
      : null,
    repeat: REPEAT_VALUES.has(task.repeat) ? task.repeat : null,
    // value属性に埋め込まれるため正の整数のみ許可
    estimateMinutes: Number.isFinite(task.estimateMinutes) && task.estimateMinutes > 0
      ? Math.round(task.estimateMinutes)
      : null,
    importance: sanitizeLevel(task.importance),
    weight: sanitizeLevel(task.weight),
    kanbanOrder: Number.isSafeInteger(task.kanbanOrder) && task.kanbanOrder >= 0 ? task.kanbanOrder : null,
    categoryId: typeof task.categoryId === 'string' && task.categoryId ? task.categoryId : null,
    note: typeof task.note === 'string' && task.note !== '' ? task.note : null,
    tags: sanitizeTags(task.tags),
    subtasks: sanitizeSubtasks(task.subtasks),
  };
}

function sanitizeProject(project) {
  return { ...project, color: COLOR_RE.test(project.color) ? project.color : DEFAULT_COLOR };
}

// カテゴリマスタ。nameが欠落/空の要素は除外する(名前の表示は常にesc()経由)
function sanitizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .filter((category) => category && isNonBlankString(category.name))
    .map((category) => ({ id: ensureId(category.id), name: category.name }));
}

// 保存済みフィルター。値はselect要素の照合にのみ使う列挙値に強制する
function sanitizeFilters(filters) {
  if (!Array.isArray(filters)) return [];
  return filters
    .filter((filter) => filter && isNonBlankString(filter.name))
    .map((filter) => ({
      id: ensureId(filter.id),
      name: filter.name,
      clientId: typeof filter.clientId === 'string' ? filter.clientId : null,
      projectId: typeof filter.projectId === 'string' ? filter.projectId : null,
      categoryId: typeof filter.categoryId === 'string' ? filter.categoryId : null,
      importance: FILTER_LEVELS.includes(filter.importance) ? filter.importance : '',
      weight: FILTER_LEVELS.includes(filter.weight) ? filter.weight : '',
      month: typeof filter.month === 'string' && MONTH_RE.test(filter.month) ? filter.month : '',
      tag: typeof filter.tag === 'string' ? filter.tag.trim() : '',
      search: typeof filter.search === 'string' ? filter.search : '',
    }));
}

function sanitizeData(raw) {
  return {
    clients: raw.clients || [],
    categories: sanitizeCategories(raw.categories),
    projects: (raw.projects || []).map(sanitizeProject),
    tasks: (raw.tasks || []).map(sanitizeTask),
    entries: raw.entries || [],
    filters: sanitizeFilters(raw.filters),
  };
}

// ---- データファイルの読み書き ----

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 一時ファイルに書いてからリネームすることで、書き込み中のクラッシュでも既存データが壊れないようにする
function writeTextAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function readData() {
  try {
    return sanitizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    return EMPTY_DATA;
  }
}

// 各日の最初の変更前データを backups/enchanter-YYYY-MM-DD.json に残す(認証情報はバックアップしない)
function backupDataFileOncePerDay() {
  const backupDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const backupFile = path.join(backupDir, `enchanter-${day}.json`);
  if (fs.existsSync(backupFile)) return;
  const previous = fs.readFileSync(DATA_FILE, 'utf8');
  JSON.parse(previous); // 壊れたデータをバックアップとして残さないため、読めることを確認する
  writeTextAtomic(backupFile, previous);
}

function writeData(data) {
  if (fs.existsSync(DATA_FILE)) backupDataFileOncePerDay();
  writeJsonAtomic(DATA_FILE, data);
}

// ---- HTTP ヘルパー ----

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
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
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) {
      aborted = true;
      sendJson(res, 413, { error: 'データが大きすぎます' });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!aborted) onEnd(body);
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

function handlePutData(req, res) {
  if (!requireCsrfHeader(req, res)) return;
  readBody(req, res, (body) => {
    try {
      writeData(sanitizeData(parseJsonObject(body)));
      sendNoContent(res);
    } catch {
      sendJson(res, 400, { error: '不正なJSONです' });
    }
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
      payload = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: '不正なJSONです' });
      return;
    }
    handleSyncEntry(payload, res);
  });
}

// ---- 静的ファイル ----

function serveStatic(res, { file, type }) {
  fs.readFile(path.join(__dirname, file), (error, buffer) => {
    if (error) {
      res.writeHead(500);
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(buffer);
  });
}

// ---- ルーティング ----

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- API ----
  if (url.pathname === '/api/data') {
    if (req.method === 'GET') {
      sendJson(res, 200, readData());
    } else if (req.method === 'PUT') {
      handlePutData(req, res);
    } else {
      sendMethodNotAllowed(res, 'GET, PUT');
    }
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
    if (allowMethod(req, res, 'GET')) handleOAuthCallback(url, res);
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
  const route = STATIC_ROUTES[url.pathname];
  if (req.method === 'GET' && route) {
    serveStatic(res, route);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`Enchanter が起動しました: http://localhost:${PORT} (bind: ${HOST})`);
  console.log(`データ保存先: ${DATA_FILE}`);
});
