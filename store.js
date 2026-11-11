'use strict';

/* ============================================================
 * Enchanter - データファイルの検証・読み書き
 * server.js(ブラウザからのAPI)とcli.js(サーバー無しでの操作)の両方が使う。
 * 書き込みは必ずここを通すことで、検証(sanitizeData)・日次バックアップ・
 * アトミック書き込み・リビジョン(同時編集の検出)が共通になる。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMPTY_DATA = { clients: [], projects: [], tasks: [], entries: [] };
const DEFAULT_COLOR = '#7c5cff';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const REPEAT_VALUES = new Set(['daily', 'weekly', 'monthly']);
const TASK_STATUSES = new Set(['todo', 'in_progress', 'waiting_review', 'done']);
const FILTER_LEVELS = ['', '0', '1', '2', '3'];

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

// 資料リンクのURLを正規化して返す。使えないものはnull(js/domain.jsのsafeLinkUrlと同じ規則・同じ結果にすること)。
// urlはhref属性に入るのでhttp/httpsとローカルファイル(file:)だけを許可する(javascript:等を防ぐ)。
// Windowsの絶対パスとfile:のURLはfile:///D:/a/b.mp4の形(url.pathToFileURL相当。[ ] ^ ~ はエンコードしない)にそろえる
function safeLinkUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;
  if (/^[A-Za-z]:[\\/]/.test(text)) return localPathToFileUrl(text.replace(/\\/g, '/'));
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  // ホスト付き(UNC)・クエリ・フラグメント付き・区切り文字をエンコードしたものは受け付けない
  if (url.protocol !== 'file:' || url.host || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(pathname)) return null;
  return localPathToFileUrl(/^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname);
}

// 区切りが/のローカルパス(D:/a/b.mp4 または /home/a.mp4)をfile URLにする
function localPathToFileUrl(slashPath) {
  const escaped = slashPath.replace(/^\/+/, '').replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
  try {
    const url = new URL(`file:///${escaped}`);
    return url.host || url.search || url.hash ? null : url.href;
  } catch {
    return null;
  }
}

// 資料リンクは[{ url, title }]。urlはsafeLinkUrlで正規化し、使えないものは捨てる
function sanitizeLinks(links) {
  if (!Array.isArray(links)) return [];
  const seen = new Set();
  const sanitized = [];
  for (const link of links) {
    if (!link || typeof link.url !== 'string') continue;
    const url = safeLinkUrl(link.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof link.title === 'string' && link.title.trim() ? link.title.trim() : null;
    sanitized.push({ url, title });
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
    links: sanitizeLinks(task.links),
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

// ファイル内容のハッシュ。ブラウザとCLIが互いの変更を上書きしないよう、書き込み前に照合する
function revisionOf(text) {
  return text === null ? 'empty' : crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function createStore(dataDir) {
  const dataFile = path.join(dataDir, 'enchanter-data.json');
  fs.mkdirSync(dataDir, { recursive: true });

  function readText() {
    try {
      return fs.readFileSync(dataFile, 'utf8');
    } catch {
      return null;
    }
  }

  // { data, revision }。ファイルが無い・壊れている場合は空データ
  function readDataWithRevision() {
    const text = readText();
    let data = EMPTY_DATA;
    try {
      if (text !== null) data = sanitizeData(JSON.parse(text));
    } catch { /* 壊れたファイルは空として扱う */ }
    return { data, revision: revisionOf(text) };
  }

  function readData() {
    return readDataWithRevision().data;
  }

  function currentRevision() {
    return revisionOf(readText());
  }

  // 各日の最初の変更前データを backups/enchanter-YYYY-MM-DD.json に残す(認証情報はバックアップしない)
  function backupDataFileOncePerDay() {
    const backupDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const backupFile = path.join(backupDir, `enchanter-${day}.json`);
    if (fs.existsSync(backupFile)) return;
    const previous = fs.readFileSync(dataFile, 'utf8');
    JSON.parse(previous); // 壊れたデータをバックアップとして残さないため、読めることを確認する
    writeTextAtomic(backupFile, previous);
  }

  // 検証してから書き込み、新しいリビジョンを返す
  function writeData(data) {
    if (fs.existsSync(dataFile)) backupDataFileOncePerDay();
    const text = JSON.stringify(sanitizeData(data), null, 2) + '\n';
    writeTextAtomic(dataFile, text);
    return revisionOf(text);
  }

  return { dataDir, dataFile, readData, readDataWithRevision, currentRevision, writeData };
}

module.exports = { createStore, sanitizeData, safeLinkUrl, readJsonSafe, writeJsonAtomic };
