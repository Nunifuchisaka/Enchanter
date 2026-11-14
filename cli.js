#!/usr/bin/env node
'use strict';

/* ============================================================
 * Enchanter CLI - サーバーを起動しなくてもタスクを操作できるコマンド
 * データファイルを store.js 経由で直接読み書きする(検証・日次バックアップ・
 * アトミック書き込みはサーバーと共通)。状態変更の副作用(完了時の計測停止・
 * 繰り返しの次回分生成など)は画面と同じ js/ のロジックをvmで読み込んで使う。
 * 出力はClaude Codeが少ないトークンで読めるよう、1件1行の短い形式にしている。
 * 使い方: node cli.js help
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { createStore } = require('./store.js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT) || 8787;
// DOMに依存しない画面側のロジック(読み込み順はindex.htmlと同じ)
const LOGIC_FILES = ['js/constants.js', 'js/time.js', 'js/state.js', 'js/domain.js', 'js/mutations.js', 'js/image-compare.js'];

const HELP = `Enchanter CLI (サーバー不要。起動中の画面には数秒で反映)
一覧  ls [-a 完了も] [--done] [--today] [-p プロジェクト] [-t タグ] [-q 検索語] [-s 状態] [-n 件数]
詳細  show <id>
追加  add <タイトル> [オプション]
編集  edit <id> [--title 新タイトル] [オプション]   値に - を渡すと消去
状態  status <id> <todo|wip|review|done>   / done <id>   (完了で計測停止・繰り返し次回分を生成)
今日  pin <id>  (☆今日やるの切替)
計測  start <id> / stop [id] (省略で全停止) / running
記録  log <id> <開始> <終了>   例: log ab12 10:00 11:30 / log ab12 11/5T10:00 11/5T12:00
小項  sub <id> <タイトル> / subdone <id> <番号>
画像  img <id>  (画像候補の一覧) / img <id> add <画像ファイル|フォルダ|URL>...
      img <id> pick|good|out|rm <番号> / img <id> name <番号> <名前> / img <id> note <番号> <メモ>
削除  rm <id>  (作業記録も削除)
集計  sum [--from 日付] [--to 日付]  (既定は今日)
マスタ projects  (クライアント/プロジェクト/カテゴリ)
オプション: -p プロジェクト -c カテゴリ --start 日付[T時刻] --end 日付[T時刻] -i 重要度0-3 -w 重さ0-3
  -e 見積(分) -t タグ(カンマ区切り) --note メモ -r daily|weekly|monthly
  -l 資料リンク("URL" か "タイトル URL"。複数回可。editでは追加、-l - で全消去) --unlink 番号(editで削除)
日付: YYYY-MM-DD, M/D, today, tomorrow, +N, -N   id/プロジェクト名は一意なら前方一致・部分一致で可
一覧の形式: id 状態 [!重要度] タイトル [@プロジェクト] [#タグ] [予定] [実績/見積] [☆今日] [▶計測中] [🔗リンク数] [🖼画像候補数(🏆採用済み)] [小項目 済/全]
画像候補の形式: 番号 [🏆採用|◎有力|✕外す] 名前 ファイル名|URL [— メモ]`;

const STATUS_ALIASES = {
  todo: 'todo', wip: 'in_progress', doing: 'in_progress', in_progress: 'in_progress',
  review: 'waiting_review', waiting_review: 'waiting_review', done: 'done',
};
const VALUE_OPTIONS = {
  p: 'project', project: 'project', c: 'category', category: 'category', start: 'start', end: 'end',
  i: 'importance', importance: 'importance', w: 'weight', weight: 'weight', e: 'estimate', estimate: 'estimate',
  t: 'tags', tags: 'tags', tag: 'tags', note: 'note', l: 'links', link: 'links', unlink: 'unlink', r: 'repeat', repeat: 'repeat', title: 'title',
  q: 'query', s: 'status', status: 'status', n: 'limit', limit: 'limit', from: 'from', to: 'to',
};
const FLAG_OPTIONS = { a: 'all', all: 'all', done: 'doneOnly', today: 'today' };

class CliError extends Error {}
const fail = (message) => { throw new CliError(message); };

/* ---------- 引数 ---------- */

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const match = /^--?([a-z_-]+)(?:=(.*))?$/i.exec(token);
    if (!match || token === '-') {
      positional.push(token);
      continue;
    }
    const name = match[1];
    if (FLAG_OPTIONS[name]) {
      options[FLAG_OPTIONS[name]] = true;
    } else if (VALUE_OPTIONS[name]) {
      const value = match[2] !== undefined ? match[2] : argv[++i];
      if (value === undefined) fail(`${token} に値がありません`);
      const key = VALUE_OPTIONS[name];
      // 資料リンクは複数回指定できる
      if (key === 'links') (options.links = options.links || []).push(value);
      else options[key] = value;
    } else {
      fail(`不明なオプション: ${token}`);
    }
  }
  return { positional, options };
}

/* ---------- 画面側ロジックの読み込み ---------- */

function loadLogic(rawData) {
  const synced = [];
  const context = vm.createContext({ console, structuredClone, URL, __input: structuredClone(rawData), __synced: synced });
  for (const file of LOGIC_FILES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  }
  // 保存・描画はCLI側で行い、Google同期は書き込み後にまとめて送る
  vm.runInContext(`data = normalizeData(__input);
    save = () => {}; renderAll = () => {};
    syncEntryToGoogle = (entry) => { if (entry && entry.end !== null) __synced.push(entry); };`, context);
  const logic = vm.runInContext(`({
    get data() { return data; }, uid, taskById, projectById, clientById, categoryById, runningEntries,
    runningEntryForTask, startTimer, stopTimer, stopAllTimers, setTaskStatus, compareActiveTasks,
    taskImages, imageLabel, addTaskImages, toggleImageMark, togglePickImage, removeTaskImage,
    parseTags, parseLinks, parseLevel, parseEstimate, planLabel, isOverdue, isDueToday, todayStr, toDateStr,
    fromDateStr, addDays, entryDur, overlapMs, reportRangeMs, timeToTimestamp, googleEventTitle,
  })`, context);
  return { logic, synced };
}

/* ---------- 値の解釈 ---------- */

function parseDate(value, L) {
  const text = String(value).trim();
  const today = L.todayStr();
  if (text === 'today') return today;
  if (text === 'tomorrow') return L.addDays(today, 1);
  if (text === 'yesterday') return L.addDays(today, -1);
  if (/^[+-]\d+$/.test(text)) return L.addDays(today, Number(text));
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text) || /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]), value, L);
  match = /^(\d{1,2})[/-](\d{1,2})$/.exec(text);
  if (match) return validDate(Number(today.slice(0, 4)), Number(match[1]), Number(match[2]), value, L);
  return fail(`日付を解釈できません: ${value}`);
}

function validDate(year, month, day, original, L) {
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) fail(`日付を解釈できません: ${original}`);
  return L.toDateStr(date);
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) fail(`時刻を解釈できません: ${value}`);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

// "日付", "日付T時刻", "時刻"(日付は今日)を { date, time } に
function parseDateTime(value, L) {
  const text = String(value).trim();
  if (/^\d{1,2}:\d{2}$/.test(text)) return { date: L.todayStr(), time: parseTime(text) };
  const [datePart, timePart] = text.split(/[T@]/);
  return { date: parseDate(datePart, L), time: timePart ? parseTime(timePart) : null };
}

function parseLevelOption(value, label) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 3) fail(`${label}は0〜3で指定してください: ${value}`);
  return num;
}

const isClear = (value) => value === '-' || value === '';

// 完全一致 → 前方一致 → 後方一致の順で、一意に決まるものを返す
function resolveId(items, query, noun) {
  const text = String(query || '').trim();
  if (!text) fail(`${noun}のidを指定してください`);
  const exact = items.find((item) => item.id === text);
  if (exact) return exact;
  for (const matches of [items.filter((item) => item.id.startsWith(text)), items.filter((item) => item.id.endsWith(text))]) {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) fail(`${noun}のidが曖昧です: ${text} → ${matches.slice(0, 5).map((item) => item.id).join(' ')}`);
  }
  return fail(`${noun}が見つかりません: ${text}`);
}

function resolveNamed(items, query, noun, extraNames = () => []) {
  const text = String(query).trim();
  const lower = text.toLowerCase();
  const names = (item) => [item.name, ...extraNames(item)].filter(Boolean).map((name) => String(name).toLowerCase());
  const exact = items.filter((item) => item.id === text || names(item).includes(lower));
  if (exact.length === 1) return exact[0];
  const partial = items.filter((item) => names(item).some((name) => name.includes(lower)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) fail(`${noun}が曖昧です: ${text} → ${partial.slice(0, 5).map((item) => item.name).join(', ')}`);
  return fail(`${noun}が見つかりません: ${text} (node cli.js projects で一覧)`);
}

function resolveProject(L, query) {
  return resolveNamed(L.data.projects, query, 'プロジェクト', (project) => {
    const client = L.clientById(project.clientId);
    return [project.customId, client ? `${client.name}/${project.name}` : null];
  });
}

/* ---------- 表示 ---------- */

function dur(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes}m`;
  return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
}

function taskSpentMs(L, taskId, now) {
  return L.data.entries.filter((entry) => entry.taskId === taskId).reduce((sum, entry) => sum + L.entryDur(entry, now), 0);
}

function taskLine(L, task, now = Date.now()) {
  const parts = [task.id, task.status];
  if (task.importance > 0) parts.push(`!${task.importance}`);
  parts.push(task.title);
  const project = L.projectById(task.projectId);
  if (project) parts.push(`@${project.name}`);
  (task.tags || []).forEach((tag) => parts.push(`#${tag}`));
  if (task.plannedStart) parts.push(L.planLabel(task) + (task.status !== 'done' && L.isOverdue(task, L.todayStr()) ? '(超過)' : ''));
  const spent = taskSpentMs(L, task.id, now);
  if (spent > 0 || task.estimateMinutes) {
    parts.push(task.estimateMinutes ? `${dur(spent)}/${dur(task.estimateMinutes * 60000)}` : dur(spent));
  }
  if (task.todayDate === L.todayStr()) parts.push('☆');
  if (L.runningEntryForTask(task.id)) parts.push('▶');
  if ((task.links || []).length) parts.push(`🔗${task.links.length}`);
  if ((task.images || []).length) parts.push(`${task.pickedImageId ? '🏆' : '🖼'}${task.images.length}`);
  const subtasks = task.subtasks || [];
  if (subtasks.length) parts.push(`${subtasks.filter((subtask) => subtask.done).length}/${subtasks.length}`);
  return parts.join(' ');
}

function fmtDateTime(L, timestamp) {
  const date = new Date(timestamp);
  return `${L.toDateStr(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/* ---------- コマンド ---------- */

function applyTaskOptions(L, task, options) {
  if (options.title !== undefined) {
    if (!options.title.trim()) fail('タイトルを空にはできません');
    task.title = options.title.trim();
  }
  if (options.project !== undefined) task.projectId = isClear(options.project) ? null : resolveProject(L, options.project).id;
  if (options.category !== undefined) {
    task.categoryId = isClear(options.category) ? null : resolveNamed(L.data.categories, options.category, 'カテゴリ').id;
  }
  if (options.importance !== undefined) task.importance = isClear(options.importance) ? 0 : parseLevelOption(options.importance, '重要度');
  if (options.weight !== undefined) task.weight = isClear(options.weight) ? 0 : parseLevelOption(options.weight, '重さ');
  if (options.estimate !== undefined) {
    task.estimateMinutes = isClear(options.estimate) ? null : L.parseEstimate(options.estimate);
    if (!isClear(options.estimate) && task.estimateMinutes === null) fail(`見積は分単位の正の数で指定してください: ${options.estimate}`);
  }
  if (options.tags !== undefined) task.tags = isClear(options.tags) ? [] : L.parseTags(options.tags);
  if (options.note !== undefined) task.note = isClear(options.note) ? null : options.note;
  if (options.unlink !== undefined) {
    const index = Number(options.unlink) - 1;
    const links = task.links || [];
    if (!Number.isInteger(index) || !links[index]) fail(`削除するリンクの番号が不正です: ${options.unlink}`);
    task.links = links.filter((_, i) => i !== index);
  }
  if (options.links !== undefined) applyLinks(L, task, options.links);
  if (options.repeat !== undefined) {
    if (!isClear(options.repeat) && !['daily', 'weekly', 'monthly'].includes(options.repeat)) fail(`繰り返しは daily/weekly/monthly: ${options.repeat}`);
    task.repeat = isClear(options.repeat) ? null : options.repeat;
  }
  if (options.start !== undefined || options.end !== undefined) applyPlan(L, task, options);
}

// -l は既存のリンクに追加する(addでは空から)。- で全消去。http/https以外は弾く
function applyLinks(L, task, values) {
  let links = [...(task.links || [])];
  for (const value of values) {
    if (isClear(value)) {
      links = [];
      continue;
    }
    const parsed = L.parseLinks(value);
    if (!parsed.length) fail(`http(s)のURLが見つかりません: ${value}`);
    for (const link of parsed) {
      links = links.filter((existing) => existing.url !== link.url);
      links.push(link);
    }
  }
  task.links = links;
}

// 画面の予定入力(planFromForm)と同じく、片方だけなら同じ日にそろえ、逆順なら入れ替える
function applyPlan(L, task, options) {
  const current = (date, time) => ({ date: date || null, time: time || null });
  let start = options.start === undefined ? current(task.plannedStart, task.plannedStartTime)
    : isClear(options.start) ? current() : parseDateTime(options.start, L);
  let end = options.end === undefined ? current(task.plannedEnd, task.plannedEndTime)
    : isClear(options.end) ? current() : parseDateTime(options.end, L);
  if (options.start !== undefined && isClear(options.start) && options.end === undefined) end = current();
  if (!start.date && end.date) start = { ...end };
  if (start.date && !end.date) end = { ...start };
  const reversed = start.date && end.date && (end.date < start.date || (end.date === start.date && start.time && end.time && end.time < start.time));
  if (reversed) [start, end] = [end, start];
  Object.assign(task, { plannedStart: start.date, plannedEnd: end.date, plannedStartTime: start.time, plannedEndTime: end.time });
}

function imageLine(L, task, image, number = L.taskImages(task).indexOf(image) + 1) {
  const mark = task.pickedImageId === image.id ? '🏆' : image.mark === 'good' ? '◎' : image.mark === 'out' ? '✕' : '';
  const parts = [number];
  if (mark) parts.push(mark);
  parts.push(L.imageLabel(task, image), image.file || image.url);
  if (image.note) parts.push(`— ${image.note.replace(/\s+/g, ' ')}`);
  return parts.join(' ');
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif)$/i;

// URLはそのまま、ファイルは保存してファイル名に、フォルダは中の画像を名前順にすべて取り込む
function imageSources(store, value) {
  if (/^https?:\/\//i.test(value)) return [{ url: value }];
  let stat;
  try {
    stat = fs.statSync(value);
  } catch {
    fail(`ファイルが見つかりません: ${value}`);
  }
  if (stat.isDirectory()) {
    const files = fs.readdirSync(value).filter((name) => IMAGE_EXT_RE.test(name)).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
    if (!files.length) fail(`フォルダに画像がありません: ${value}`);
    return files.flatMap((name) => imageSources(store, path.join(value, name)));
  }
  const file = store.saveImage(fs.readFileSync(value));
  if (!file) fail(`対応していない形式です(PNG・JPEG・GIF・WebP・AVIF): ${value}`);
  return [{ file, label: path.basename(value).replace(/\.[^.]+$/, '') }];
}

function findTask(L, query) {
  return resolveId(L.data.tasks, query, 'タスク');
}

const COMMANDS = {
  help: () => ({ output: HELP }),

  ls(L, { options }) {
    const today = L.todayStr();
    let tasks = L.data.tasks;
    if (options.doneOnly) tasks = tasks.filter((task) => task.status === 'done');
    else if (!options.all) tasks = tasks.filter((task) => task.status !== 'done');
    if (options.status) {
      const status = STATUS_ALIASES[options.status] || fail(`不明な状態: ${options.status}`);
      tasks = tasks.filter((task) => task.status === status);
    }
    if (options.project) {
      const project = resolveProject(L, options.project);
      tasks = tasks.filter((task) => task.projectId === project.id);
    }
    if (options.tags) tasks = tasks.filter((task) => (task.tags || []).includes(options.tags.trim()));
    if (options.query) {
      const words = options.query.toLowerCase().split(/\s+/).filter(Boolean);
      tasks = tasks.filter((task) => {
        const haystack = [task.title, task.note, ...(task.tags || []), ...(task.links || []).flatMap((link) => [link.title, link.url])].filter(Boolean).join(' ').toLowerCase();
        return words.every((word) => haystack.includes(word));
      });
    }
    if (options.today) {
      tasks = tasks.filter((task) => task.todayDate === today || L.runningEntryForTask(task.id) ||
        (task.plannedStart && task.plannedStart <= today && task.status !== 'done'));
    }
    tasks = options.doneOnly
      ? [...tasks].sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      : [...tasks].sort((a, b) => (a.status === 'done') - (b.status === 'done') || L.compareActiveTasks(a, b));
    const limit = options.limit ? Number(options.limit) : (options.doneOnly ? 20 : Infinity);
    const total = tasks.length;
    const now = Date.now();
    const lines = tasks.slice(0, limit).map((task) => taskLine(L, task, now));
    if (!lines.length) return { output: '(該当なし)' };
    if (total > lines.length) lines.push(`…ほか${total - lines.length}件`);
    return { output: lines.join('\n') };
  },

  show(L, { positional }) {
    const task = findTask(L, positional[0]);
    const project = L.projectById(task.projectId);
    const client = project ? L.clientById(project.clientId) : null;
    const category = L.categoryById(task.categoryId);
    const entries = L.data.entries.filter((entry) => entry.taskId === task.id).sort((a, b) => a.start - b.start);
    const now = Date.now();
    const rows = [
      ['id', task.id], ['title', task.title], ['status', task.status],
      ['project', project ? `${project.name}${client ? ` (${client.name})` : ''}` : null],
      ['category', category ? category.name : null],
      ['importance', task.importance || null], ['weight', task.weight || null],
      ['plan', task.plannedStart ? L.planLabel(task) : null], ['repeat', task.repeat],
      ['estimate', task.estimateMinutes ? dur(task.estimateMinutes * 60000) : null],
      ['spent', entries.length ? `${dur(taskSpentMs(L, task.id, now))} (${entries.length}件, 最終 ${fmtDateTime(L, entries.at(-1).start)})` : null],
      ['tags', (task.tags || []).join(', ') || null], ['today', task.todayDate === L.todayStr() ? 'yes' : null],
      ['running', L.runningEntryForTask(task.id) ? 'yes' : null], ['note', task.note],
    ];
    const lines = rows.filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => `${key}: ${value}`);
    (task.links || []).forEach((link, index) => lines.push(`link ${index + 1}: ${link.title ? `${link.title} ` : ''}${link.url}`));
    (task.subtasks || []).forEach((subtask, index) => lines.push(`  ${index + 1} [${subtask.done ? 'x' : ' '}] ${subtask.title}`));
    L.taskImages(task).forEach((image) => lines.push(`image ${imageLine(L, task, image)}`));
    return { output: lines.join('\n') };
  },

  // 画像候補。ファイルはサーバーと同じく data/images/ に保存し、形式は中身で判定する
  img(L, { positional, store }) {
    const task = findTask(L, positional[0]);
    const [sub, ...rest] = positional.slice(1);
    if (!sub) {
      const images = L.taskImages(task);
      return { output: images.length ? images.map((image) => imageLine(L, task, image)).join('\n') : '(画像候補なし。img <id> add <ファイル> で追加)' };
    }
    if (sub === 'add') {
      if (!rest.length) fail('img <id> add <画像ファイル|フォルダ|URL>...');
      const sources = rest.flatMap((value) => imageSources(store, value));
      const added = L.addTaskImages(task, sources);
      if (!added.length) fail('追加できる画像がありませんでした(PNG・JPEG・GIF・WebP・AVIF、または追加済みでないURL)');
      return { changed: true, output: added.map((image) => imageLine(L, task, image)).join('\n') };
    }
    const image = L.taskImages(task)[Number(rest[0]) - 1] || fail(`画像候補の番号が不正です: ${rest[0] || ''}(img <id> で確認)`);
    const text = rest.slice(1).join(' ').trim();
    if (sub === 'pick') L.togglePickImage(task, image.id);
    else if (sub === 'good' || sub === 'out') L.toggleImageMark(task, image.id, sub);
    else if (sub === 'name') image.label = text || null;
    else if (sub === 'note') image.note = text || null;
    else if (sub === 'rm') {
      L.removeTaskImage(task, image.id);
      return { changed: true, output: `removed ${imageLine(L, task, image, '-')}` };
    } else fail(`不明な操作: img ${sub}(add/pick/good/out/name/note/rm)`);
    return { changed: true, output: imageLine(L, task, image) };
  },

  add(L, { positional, options }) {
    const title = positional.join(' ').trim();
    if (!title) fail('タイトルを指定してください: add <タイトル>');
    const task = {
      id: L.uid(), title, projectId: null, categoryId: null, status: 'todo', createdAt: Date.now(), completedAt: null,
      repeat: null, estimateMinutes: null, importance: 0, weight: 0, note: null, tags: [], links: [], subtasks: [],
      plannedStart: null, plannedEnd: null, plannedStartTime: null, plannedEndTime: null,
    };
    applyTaskOptions(L, task, options);
    L.data.tasks.push(task);
    return { changed: true, output: `added ${taskLine(L, task)}` };
  },

  edit(L, { positional, options }) {
    const task = findTask(L, positional[0]);
    if (!Object.keys(options).length) fail('変更するオプションを指定してください(node cli.js help)');
    applyTaskOptions(L, task, options);
    return { changed: true, output: taskLine(L, task) };
  },

  status(L, { positional }) {
    const task = findTask(L, positional[0]);
    const status = STATUS_ALIASES[positional[1]] || fail(`状態は todo|wip|review|done: ${positional[1] || ''}`);
    const before = L.data.tasks.length;
    const changed = L.setTaskStatus(task, status);
    const lines = [taskLine(L, task)];
    if (L.data.tasks.length > before) lines.push(`next ${taskLine(L, L.data.tasks.at(-1))}`);
    return { changed, output: lines.join('\n') };
  },

  done: (L, { positional }) => COMMANDS.status(L, { positional: [positional[0], 'done'] }),

  pin(L, { positional }) {
    const task = findTask(L, positional[0]);
    const today = L.todayStr();
    task.todayDate = task.todayDate === today ? null : today;
    return { changed: true, output: taskLine(L, task) };
  },

  start(L, { positional }) {
    const task = findTask(L, positional[0]);
    if (task.status === 'done') fail('完了済みのタスクは計測できません');
    if (L.runningEntryForTask(task.id)) return { output: `計測中です ${taskLine(L, task)}` };
    L.startTimer(task.id);
    return { changed: true, output: taskLine(L, task) };
  },

  stop(L, { positional }) {
    const targets = positional[0]
      ? [L.runningEntryForTask(findTask(L, positional[0]).id) || fail('このタスクは計測中ではありません')]
      : L.runningEntries();
    if (!targets.length) return { output: '計測中のタスクはありません' };
    if (positional[0]) L.stopTimer(targets[0].id);
    else L.stopAllTimers();
    const lines = targets.map((entry) => {
      const task = L.taskById(entry.taskId);
      return `stopped ${entry.taskId} ${task ? task.title : '?'} ${dur(entry.end - entry.start)}`;
    });
    return { changed: true, output: lines.join('\n') };
  },

  running(L) {
    const now = Date.now();
    const lines = L.runningEntries().map((entry) => {
      const task = L.taskById(entry.taskId);
      return `${entry.taskId} ${task ? task.title : '?'} ${dur(now - entry.start)}`;
    });
    return { output: lines.length ? lines.join('\n') : '計測中のタスクはありません' };
  },

  log(L, { positional }) {
    const task = findTask(L, positional[0]);
    if (!positional[1] || !positional[2]) fail('log <id> <開始> <終了>');
    const toMs = (value, fallbackDate) => {
      const text = String(value).trim();
      const { date, time } = /^\d{1,2}:\d{2}$/.test(text) ? { date: fallbackDate, time: parseTime(text) } : parseDateTime(text, L);
      if (!time) fail(`時刻を含めてください: ${value}`);
      return { date, ms: L.timeToTimestamp(L.fromDateStr(date).getTime(), time) };
    };
    const start = toMs(positional[1], L.todayStr());
    const end = toMs(positional[2], start.date);
    if (end.ms <= start.ms) fail('終了は開始より後にしてください');
    if (end.ms > Date.now()) fail('未来の時刻は記録できません');
    const entry = { id: L.uid(), taskId: task.id, start: start.ms, end: end.ms };
    L.data.entries.push(entry);
    if (task.status === 'todo') task.status = 'in_progress';
    // 画面と同じく、終了が確定した作業記録はGoogleカレンダーへ同期する
    return { changed: true, synced: [entry], output: `logged ${entry.id} ${fmtDateTime(L, entry.start)}-${fmtDateTime(L, entry.end).slice(11)} ${dur(entry.end - entry.start)} ${task.title}` };
  },

  sub(L, { positional }) {
    const task = findTask(L, positional[0]);
    const title = positional.slice(1).join(' ').trim();
    if (!title) fail('sub <id> <タイトル>');
    task.subtasks = task.subtasks || [];
    task.subtasks.push({ id: L.uid(), title, done: false });
    return { changed: true, output: taskLine(L, task) };
  },

  subdone(L, { positional }) {
    const task = findTask(L, positional[0]);
    const subtask = (task.subtasks || [])[Number(positional[1]) - 1] || fail(`小項目の番号が不正です: ${positional[1] || ''}(show で確認)`);
    subtask.done = !subtask.done;
    return { changed: true, output: `${subtask.done ? '[x]' : '[ ]'} ${subtask.title}` };
  },

  rm(L, { positional }) {
    const task = findTask(L, positional[0]);
    const entryCount = L.data.entries.filter((entry) => entry.taskId === task.id).length;
    L.data.tasks.splice(L.data.tasks.indexOf(task), 1);
    for (let i = L.data.entries.length - 1; i >= 0; i--) {
      if (L.data.entries[i].taskId === task.id) L.data.entries.splice(i, 1);
    }
    return { changed: true, output: `removed ${task.id} ${task.title} (作業記録${entryCount}件)` };
  },

  sum(L, { options }) {
    const from = options.from ? parseDate(options.from, L) : L.todayStr();
    const to = options.to ? parseDate(options.to, L) : from;
    const range = L.reportRangeMs(from, to);
    const now = Date.now();
    const byTask = new Map();
    L.data.entries.forEach((entry) => {
      const ms = L.overlapMs(entry, range.start, range.end, now);
      if (ms > 0) byTask.set(entry.taskId, (byTask.get(entry.taskId) || 0) + ms);
    });
    const rows = [...byTask].sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((sum, [, ms]) => sum + ms, 0);
    const lines = rows.map(([taskId, ms]) => {
      const task = L.taskById(taskId);
      const project = task ? L.projectById(task.projectId) : null;
      return `${dur(ms)} ${task ? task.title : '(削除済み)'}${project ? ` @${project.name}` : ''}`;
    });
    lines.unshift(`${from === to ? from : `${from}〜${to}`} 合計 ${dur(total)}`);
    return { output: lines.join('\n') };
  },

  projects(L) {
    const lines = [];
    L.data.clients.forEach((client) => lines.push(`client ${client.id} ${client.name}`));
    L.data.projects.forEach((project) => {
      const client = L.clientById(project.clientId);
      lines.push(`project ${project.id} ${project.name}${client ? ` (${client.name})` : ''}${project.customId ? ` [${project.customId}]` : ''}`);
    });
    L.data.categories.forEach((category) => lines.push(`category ${category.id} ${category.name}`));
    return { output: lines.length ? lines.join('\n') : '(未登録。画面の管理タブで作成)' };
  },
};

/* ---------- Googleカレンダー同期(任意) ---------- */

// 同期はGoogleの認証情報を持つサーバーが行う。サーバーが起動していなければ何もしない
function syncEntriesViaServer(L, entries) {
  if (!entries.length || !fs.existsSync(path.join(DATA_DIR, 'google-token.json'))) return Promise.resolve(null);
  const post = (entry) => new Promise((resolve) => {
    const task = L.taskById(entry.taskId);
    const project = task ? L.projectById(task.projectId) : null;
    const body = JSON.stringify({
      entryId: entry.id,
      title: L.googleEventTitle(task, project),
      project: project ? project.name : null,
      start: entry.start,
      end: entry.end,
    });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/calendar/sync-entry', method: 'POST', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'enchanter', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
  return Promise.all(entries.map(post)).then((results) => results.every(Boolean));
}

/* ---------- 実行 ---------- */

async function main(argv) {
  const [name = 'help', ...rest] = argv;
  const command = COMMANDS[name] || fail(`不明なコマンド: ${name}(node cli.js help)`);
  const args = parseArgs(rest);
  const store = createStore(DATA_DIR);
  const { data, revision } = store.readDataWithRevision();
  const { logic, synced } = loadLogic(data);
  const result = command(logic, { ...args, store });
  if (result.changed) {
    // 読み込んでから書くまでの間に、画面など別の場所で保存されていたら上書きしない
    if (store.currentRevision() !== revision) fail('同時に別の場所でデータが更新されました。もう一度実行してください');
    store.writeData(JSON.parse(JSON.stringify(logic.data)));
  }
  const output = [result.output];
  const syncResult = result.changed ? await syncEntriesViaServer(logic, [...synced, ...(result.synced || [])]) : null;
  if (syncResult === false) output.push('(Googleカレンダー未同期: サーバー未起動または同期失敗)');
  return output.join('\n');
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (output) => { if (output) console.log(output); },
    (error) => {
      console.error(error instanceof CliError ? `error: ${error.message}` : error);
      process.exitCode = 1;
    }
  );
}

module.exports = { main };
