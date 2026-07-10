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

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'enchanter-data.json');
const MAX_BODY = 20 * 1024 * 1024;

const EMPTY_DATA = { clients: [], projects: [], tasks: [], entries: [] };
const DEFAULT_COLOR = '#7c5cff';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const REPEAT_VALUES = new Set(['daily', 'weekly', 'monthly']);
const TASK_STATUSES = new Set(['todo', 'waiting_review', 'done']);

function sanitizeImportance(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
}

// status未設定の旧データ(done: booleanのみ)を新形式へ変換する後方互換マイグレーション
function sanitizeStatus(t) {
  if (TASK_STATUSES.has(t.status)) return t.status;
  return t.done === true ? 'done' : 'todo';
}

// color/repeat/importanceは通常UI(color入力・select)で値が制限されるが、APIを直接叩いたり
// データファイルを手編集された場合にHTML属性コンテキストへ不正な文字列(XSS)が
// 混入しないよう、保存前にサーバー側でも値の形式を強制する
function sanitizeData(d) {
  return {
    clients: d.clients || [],
    projects: (d.projects || []).map((p) => ({
      ...p,
      color: COLOR_RE.test(p.color) ? p.color : DEFAULT_COLOR,
    })),
    tasks: (d.tasks || []).map((t) => {
      const { done, ...rest } = t; // 旧フィールドは保存先から除去する
      const status = sanitizeStatus(t);
      return {
        ...rest,
        status,
        completedAt: status === 'done'
          ? (Number.isFinite(t.completedAt) ? t.completedAt : Date.now())
          : null,
        repeat: REPEAT_VALUES.has(t.repeat) ? t.repeat : null,
        // estimateMinutesはvalue属性に埋め込まれるため正の整数のみ許可
        estimateMinutes: Number.isFinite(t.estimateMinutes) && t.estimateMinutes > 0
          ? Math.round(t.estimateMinutes)
          : null,
        importance: sanitizeImportance(t.importance),
        note: typeof t.note === 'string' && t.note !== '' ? t.note : null,
      };
    }),
    entries: d.entries || [],
  };
}

// ---- Google カレンダー連携 ----
const GOOGLE_CREDENTIALS_FILE = path.join(DATA_DIR, 'google-credentials.json');
const GOOGLE_TOKEN_FILE = path.join(DATA_DIR, 'google-token.json');
const GOOGLE_SYNC_MAP_FILE = path.join(DATA_DIR, 'google-sync-map.json');
const OAUTH_REDIRECT_PATH = '/oauth/callback';
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
let pendingOAuthState = null;

const STATIC_ROUTES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function readData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return sanitizeData(d);
  } catch (e) {
    return EMPTY_DATA;
  }
}

// 一時ファイルに書いてからリネームすることで、書き込み中のクラッシュでも
// 既存データが壊れないようにする
function writeData(obj) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, DATA_FILE);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
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

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function getGoogleCredentials() {
  return readJsonSafe(GOOGLE_CREDENTIALS_FILE, null);
}

function getGoogleToken() {
  return readJsonSafe(GOOGLE_TOKEN_FILE, null);
}

// アクセストークンが有効ならそのまま、期限切れ間近ならrefresh_tokenで更新して返す。
// 未連携・更新失敗時はnull(呼び出し側は「未連携」として扱う)。
async function getValidAccessToken() {
  const creds = getGoogleCredentials();
  const token = getGoogleToken();
  if (!creds || !token) return null;
  if (token.expiry - Date.now() > 60 * 1000) return token.access_token;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: token.refresh_token,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
    const tok = await res.json();
    const updated = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || token.refresh_token,
      expiry: Date.now() + tok.expires_in * 1000,
    };
    writeJsonAtomic(GOOGLE_TOKEN_FILE, updated);
    return updated.access_token;
  } catch (e) {
    console.error('Googleアクセストークンの更新に失敗しました', e);
    try { fs.unlinkSync(GOOGLE_TOKEN_FILE); } catch (e2) { /* 既に無い場合は無視 */ }
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
  const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const existingEventId = syncMap[entryId];
  if (existingEventId) {
    const res = await fetch(`${base}/${existingEventId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(event),
    });
    if (res.ok) {
      const json = await res.json();
      return json.id;
    }
    if (res.status !== 404 && res.status !== 410) {
      throw new Error(`calendar update failed: ${res.status}`);
    }
    // カレンダー側で予定が削除済み(404/410) → 新規作成にフォールバック
  }

  const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(event) });
  if (!res.ok) throw new Error(`calendar create failed: ${res.status}`);
  const json = await res.json();
  syncMap[entryId] = json.id;
  writeJsonAtomic(GOOGLE_SYNC_MAP_FILE, syncMap);
  return json.id;
}

async function handleOAuthCallback(url, res) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const creds = getGoogleCredentials();
  if (!code || !state || !creds || state !== pendingOAuthState) {
    res.writeHead(302, { Location: '/?google=error' });
    res.end();
    return;
  }
  pendingOAuthState = null;
  try {
    const redirectUri = `http://localhost:${PORT}${OAUTH_REDIRECT_PATH}`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
    const tok = await tokenRes.json();
    const existing = getGoogleToken();
    writeJsonAtomic(GOOGLE_TOKEN_FILE, {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || (existing && existing.refresh_token),
      expiry: Date.now() + tok.expires_in * 1000,
    });
    res.writeHead(302, { Location: '/?google=connected' });
    res.end();
  } catch (e) {
    console.error('Google OAuth トークン取得に失敗しました', e);
    res.writeHead(302, { Location: '/?google=error' });
    res.end();
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
  } catch (e) {
    console.error('Googleカレンダー同期に失敗しました', e);
    sendJson(res, 502, { error: '同期に失敗しました' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- API ----
  if (url.pathname === '/api/data') {
    if (req.method === 'GET') {
      sendJson(res, 200, readData());
      return;
    }
    if (req.method === 'PUT') {
      if (!requireCsrfHeader(req, res)) return;
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
        if (aborted) return;
        try {
          const d = JSON.parse(body);
          if (typeof d !== 'object' || d === null || Array.isArray(d)) {
            throw new Error('invalid shape');
          }
          writeData(sanitizeData(d));
          res.writeHead(204);
          res.end();
        } catch (e) {
          sendJson(res, 400, { error: '不正なJSONです' });
        }
      });
      return;
    }
    res.writeHead(405, { Allow: 'GET, PUT' });
    res.end();
    return;
  }

  // ---- Google カレンダー連携 ----
  if (url.pathname === '/api/google/status') {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    sendJson(res, 200, { configured: !!getGoogleCredentials(), connected: !!getGoogleToken() });
    return;
  }

  if (url.pathname === '/api/google/auth-url') {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    const creds = getGoogleCredentials();
    if (!creds) {
      sendJson(res, 400, { error: 'data/google-credentials.json が見つかりません' });
      return;
    }
    pendingOAuthState = crypto.randomBytes(16).toString('hex');
    const redirectUri = `http://localhost:${PORT}${OAUTH_REDIRECT_PATH}`;
    const params = new URLSearchParams({
      client_id: creds.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.events',
      access_type: 'offline',
      prompt: 'consent',
      state: pendingOAuthState,
    });
    sendJson(res, 200, { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    return;
  }

  if (url.pathname === OAUTH_REDIRECT_PATH) {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    handleOAuthCallback(url, res);
    return;
  }

  if (url.pathname === '/api/google/disconnect') {
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    if (!requireCsrfHeader(req, res)) return;
    try { fs.unlinkSync(GOOGLE_TOKEN_FILE); } catch (e) { /* 既に未連携なら無視 */ }
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/api/calendar/sync-entry') {
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    if (!requireCsrfHeader(req, res)) return;
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
      if (aborted) return;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        sendJson(res, 400, { error: '不正なJSONです' });
        return;
      }
      handleSyncEntry(payload, res);
    });
    return;
  }

  // ---- 静的ファイル ----
  const route = STATIC_ROUTES[url.pathname];
  if (req.method === 'GET' && route) {
    const [file, type] = route;
    fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': type });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`Enchanter が起動しました: http://localhost:${PORT} (bind: ${HOST})`);
  console.log(`データ保存先: ${DATA_FILE}`);
});
