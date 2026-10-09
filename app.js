'use strict';

/* ============================================================
 * Enchanter - タスク管理ツール
 * データは server.js 経由でローカルファイル(data/enchanter-data.json)に保存
 * ============================================================ */

/* ---------- constants ---------- */

// 旧バージョン(localStorage保存)からの移行用キー
const LEGACY_STORAGE_KEY = 'enchanter-data-v1';
const MIGRATED_FLAG_KEY = 'enchanter-data-v1-migrated';

// プロジェクトのデフォルト色。ライト/ダーク両サーフェスで
// 色覚特性・コントラストの検証を通した8色(固定順で割り当て)
const PALETTE = [
  '#3987e5', '#199e70', '#c98500', '#008300',
  '#9085e9', '#e66767', '#d55181', '#d95926',
];

const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const MINUTES_PER_DAY = 1440;
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 計測中がこの時間を超えたら「止め忘れ」の警告を出す
const LONG_TIMER_WARNING_MS = 8 * MS_PER_HOUR;

// タスクの状態。状態切替ボタンとカンバンの矢印キーはこの順で移動する
const TASK_STATUS_ORDER = ['todo', 'in_progress', 'waiting_review', 'done'];
const TASK_STATUS_LABELS = {
  todo: '未着手',
  in_progress: '作業中',
  waiting_review: '作業済み(確認待ち)',
  done: '完了',
};
// 状態を示す記号(予定の一覧・ガントのツールチップで共用)
const TASK_STATUS_ICONS = { in_progress: '▶', waiting_review: '⏳', done: '✔' };

// 重要度・重さは0〜3の段階値。表示名だけが違うので同じ仕組みで扱う
const LEVEL_FIELDS = {
  importance: { labels: ['指定なし', '低', '中', '高'], formLabel: '重要度', chipLabel: '重要度' },
  weight: { labels: ['指定なし', '軽い', 'ふつう', '重い'], formLabel: '重さ', chipLabel: '重さ' },
};

const REPEAT_LABELS = { daily: '毎日', weekly: '毎週', monthly: '毎月' };

/* ---------- state ---------- */

// 永続化されるデータ(data/enchanter-data.json と同じ形)
let data = { clients: [], categories: [], projects: [], tasks: [], entries: [], filters: [] };

// 表示状態。永続化しない。タブごとの日付・絞り込みはURLハッシュと相互に反映する
const ui = {
  tab: 'todo',
  timelineDate: todayStr(),
  ganttStart: toDateStr(startOfWeek(new Date())),
  ganttDays: 28,
  ganttDate: todayStr(),
  reportFrom: toDateStr(startOfWeek(new Date())),
  reportTo: todayStr(),
  todoSearch: '',
  todoFilterClient: '',
  todoFilterProject: '',
  todoFilterImportance: '',
  todoFilterWeight: '',
  todoFilterMonth: '',
  todoFilterTag: '',
  todoFilterCategory: '',
  activeFilterId: null,
  editingTask: null,
  editingEntry: null,
  editingClient: null,
  editingProject: null,
  editingCategory: null,
  googleStatus: { configured: false, connected: false },
};

// 進行中のドラッグ操作(ポインターイベントの途中経過)
let kanbanDrag = null;
let ganttDrag = null;
// 直前のガントのドラッグ移動。Ctrl+Zで元に戻すために使う
let lastGanttDragUndo = null;
// 削除の取り消し履歴(ページを開いている間のみ、最大20件)
const deletionHistory = [];
// 保存失敗の通知を連発しないためのフラグと、保存を直列化する連鎖
let saveWarned = false;
let saveChain = Promise.resolve();
// 変更操作で再描画された後に、同じ入力欄へフォーカスを戻すための情報
let pendingFocusState = null;

// 編集中の対象は常に1つだけにする
function clearEditing() {
  ui.editingTask = null;
  ui.editingEntry = null;
  ui.editingClient = null;
  ui.editingProject = null;
  ui.editingCategory = null;
}

/* ---------- persistence ---------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 項目が後から追加される前に保存されたデータにも対応するため、欠けている配列は空にする
function normalizeData(raw) {
  return {
    clients: raw.clients || [],
    categories: raw.categories || [],
    projects: raw.projects || [],
    tasks: raw.tasks || [],
    entries: raw.entries || [],
    filters: raw.filters || [],
  };
}

function hasRecords(source) {
  return source.clients.length > 0 || source.projects.length > 0 || source.tasks.length > 0 || source.entries.length > 0;
}

// 作業記録がある未着手タスクは、過去に計測済みなので作業中として扱う。変更があればtrue
function promoteStartedTasks() {
  const startedTaskIds = new Set(data.entries.map((entry) => entry.taskId));
  let changed = false;
  data.tasks.forEach((task) => {
    if (task.status === 'todo' && startedTaskIds.has(task.id)) {
      task.status = 'in_progress';
      changed = true;
    }
  });
  return changed;
}

async function loadFromServer() {
  const response = await fetch('/api/data');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return normalizeData(await response.json());
}

async function fetchGoogleStatus() {
  const response = await fetch('/api/google/status');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// 保存はサーバーに直列で送る(連打しても順序が入れ替わらないように)
function save() {
  const body = JSON.stringify(data);
  saveChain = saveChain
    .then(() => fetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'enchanter' },
      body,
    }))
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      saveWarned = false;
    })
    .catch((error) => {
      if (!saveWarned) {
        saveWarned = true;
        alert('データを保存できませんでした。サーバー(server.js)が起動しているか確認してください。');
      }
      console.error('保存に失敗しました', error);
    });
}

// 旧localStorage版のデータが残っていて、かつファイル側が空なら移行を提案する
function migrateFromLocalStorage() {
  try {
    if (localStorage.getItem(MIGRATED_FLAG_KEY)) return;
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw || hasRecords(data)) return;
    const legacy = normalizeData(JSON.parse(raw));
    if (!hasRecords(legacy)) return;
    if (!confirm('旧バージョン(ブラウザ内保存)のデータが見つかりました。ファイル保存に移行しますか?')) return;
    data = legacy;
    save();
    localStorage.setItem(MIGRATED_FLAG_KEY, '1');
  } catch (error) {
    console.error('旧データの移行に失敗しました', error);
  }
}

/* ---------- google calendar ---------- */

// Googleカレンダーに登録するタイトルを組み立てる
// プロジェクトIDがあれば「[ID]プロジェクト名：タスク名」、なければ「プロジェクト名：タスク名」、
// プロジェクト未設定なら「タスク名」のみ
function googleEventTitle(task, project) {
  const taskTitle = task ? task.title : '(不明なタスク)';
  if (!project) return taskTitle;
  const projectName = project.customId ? `[${project.customId}]${project.name}` : project.name;
  return `${projectName}：${taskTitle}`;
}

// 完了した作業記録をGoogleカレンダーに反映する(未連携なら何もしない、失敗しても計測機能はブロックしない)
function syncEntryToGoogle(entry) {
  if (!entry || entry.end === null || !ui.googleStatus.connected) return;
  const task = taskById(entry.taskId);
  const project = task ? projectById(task.projectId) : null;
  fetch('/api/calendar/sync-entry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'enchanter' },
    body: JSON.stringify({
      entryId: entry.id,
      title: googleEventTitle(task, project),
      project: project ? project.name : null,
      start: entry.start,
      end: entry.end,
    }),
  }).catch((error) => console.warn('Googleカレンダーへの同期に失敗しました', error));
}

async function connectGoogle() {
  try {
    const response = await fetch('/api/google/auth-url');
    const body = await response.json();
    if (!response.ok) {
      alert(body.error || 'Google連携用のURLを取得できませんでした');
      return;
    }
    location.href = body.url;
  } catch (error) {
    console.error('Google連携の開始に失敗しました', error);
    alert('Google連携を開始できませんでした');
  }
}

async function disconnectGoogle() {
  try {
    await fetch('/api/google/disconnect', { method: 'POST', headers: { 'X-Requested-With': 'enchanter' } });
    ui.googleStatus = await fetchGoogleStatus();
    renderAll();
  } catch (error) {
    console.error('Google連携の解除に失敗しました', error);
  }
}

/* ---------- lookup helpers ---------- */

function clientById(id) {
  return data.clients.find((client) => client.id === id) || null;
}

function categoryById(id) {
  return data.categories.find((category) => category.id === id) || null;
}

function projectById(id) {
  return data.projects.find((project) => project.id === id) || null;
}

function taskById(id) {
  return data.tasks.find((task) => task.id === id) || null;
}

function entryById(id) {
  return data.entries.find((entry) => entry.id === id) || null;
}

function runningEntries() {
  return data.entries.filter((entry) => entry.end === null);
}

function runningEntryForTask(taskId) {
  return data.entries.find((entry) => entry.end === null && entry.taskId === taskId) || null;
}

// style属性へ直接入れるため、エスケープ済みの色を返す
function projectColor(projectId) {
  const project = projectById(projectId);
  return esc(project ? project.color : '#9a95b3');
}

// 「クライアント / プロジェクト」形式の表示名
function projectLabel(projectId) {
  const project = projectById(projectId);
  if (!project) return 'プロジェクトなし';
  const client = clientById(project.clientId);
  return client ? `${client.name} / ${project.name}` : project.name;
}

/* ---------- date / time helpers ---------- */

// 数値を2桁の文字列にする(1桁なら先頭に0)
function pad2(value) {
  return String(value).padStart(2, '0');
}

// Date → "YYYY-MM-DD"(ローカル時刻。toISOString はUTCになるので使わない)
function toDateStr(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayStr() {
  return toDateStr(new Date());
}

// "YYYY-MM-DD" → ローカル時刻0時の Date
function fromDateStr(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(dateStr, days) {
  const date = fromDateStr(dateStr);
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

// 月曜始まりの週の開始日(0時)
function startOfWeek(date) {
  const start = new Date(date);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  return start;
}

// "2026-10-08" → "2026年10月8日(木)"
function fmtDateJa(dateStr) {
  const date = fromDateStr(dateStr);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${WEEKDAY_LABELS[date.getDay()]})`;
}

// "M/D"(年が違う場合のみ "YYYY/M/D")
function fmtShortDate(dateStr) {
  const date = fromDateStr(dateStr);
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}/`;
  return `${year}${date.getMonth() + 1}/${date.getDate()}`;
}

// タイムスタンプ → "HH:MM"
function fmtTime(timestamp) {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// 0時からの分数 → "HH:MM"(範囲外は0時〜23:59に丸める)
function minutesToTime(minuteOfDay) {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - 1, minuteOfDay));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

// "HH:MM" → タイムスタンプ(dayStart基準)
function timeToTimestamp(dayStart, hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return dayStart + hours * MS_PER_HOUR + minutes * MS_PER_MINUTE;
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

// 経過時間 → "1:23:45"
function fmtClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
}

// 合計時間 → "3時間25分" / "45分"
function fmtDur(ms) {
  const totalMin = Math.round(ms / MS_PER_MINUTE);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return `${minutes}分`;
  return `${hours}時間${minutes}分`;
}

// 作業記録の終了時刻。計測中(end が null)は現在時刻とみなす
function entryEnd(entry, now) {
  return entry.end === null ? now : entry.end;
}

function entryDur(entry, now) {
  return entryEnd(entry, now) - entry.start;
}

// 作業記録と期間[rangeStart, rangeEnd)の重なり時間(ms)。重ならなければ0以下
function overlapMs(entry, rangeStart, rangeEnd, now) {
  return Math.min(entryEnd(entry, now), rangeEnd) - Math.max(entry.start, rangeStart);
}

// 集計期間の開始・終了(ms)。開始日0時から終了日の翌0時まで(終了は含まない)
function reportRangeMs(fromStr, toStr) {
  return {
    start: fromDateStr(fromStr).getTime(),
    end: fromDateStr(toStr).getTime() + MS_PER_DAY,
  };
}

function endOfMonthStr(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  return toDateStr(new Date(year, month, 0));
}

/* ---------- domain helpers ---------- */

// フォームの段階値(重要度・重さ)入力を0〜3の整数へ正規化
function parseLevel(value) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 && num <= 3 ? num : 0;
}

// フォームの見積(分)入力を正の整数またはnullに正規化
function parseEstimate(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : null;
}

// フォームのタグ入力(カンマ/読点区切り)を、トリム済み・空要素なし・重複なしの配列へ正規化
function parseTags(value) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(value || '').split(/[,、]/)) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

// 全タスクで使われているタグの一覧(五十音順)。タグはタスク側にのみ持ち、マスタは持たない
function allTags() {
  const tags = new Set();
  for (const task of data.tasks) {
    for (const tag of task.tags || []) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'ja'));
}

// フォームの予定入力を正規化してタスクの予定フィールドを返す。
// 片方だけなら同日扱いにし、終了が開始より前なら入れ替える
function planFromForm(formData) {
  let start = { date: formData.get('plannedStart') || null, time: formData.get('plannedStartTime') || null };
  let end = { date: formData.get('plannedEnd') || null, time: formData.get('plannedEndTime') || null };
  if (!start.date && end.date) start = { ...end };
  if (start.date && !end.date) end = { ...start };
  const reversed = start.date && end.date && (
    end.date < start.date ||
    (end.date === start.date && start.time && end.time && end.time < start.time)
  );
  if (reversed) [start, end] = [end, start];
  return { plannedStart: start.date, plannedEnd: end.date, plannedStartTime: start.time, plannedEndTime: end.time };
}

// 予定日時のラベル("7/5" / "7/5 14:00" / "7/5〜7/6" / "7/5 14:00〜15:00")
function planLabel(task) {
  const startDate = fmtShortDate(task.plannedStart);
  const endDate = fmtShortDate(task.plannedEnd);
  const startTime = task.plannedStartTime ? ` ${task.plannedStartTime}` : '';
  const endTime = task.plannedEndTime ? ` ${task.plannedEndTime}` : '';
  if (task.plannedStart === task.plannedEnd) {
    return task.plannedStartTime && task.plannedEndTime
      ? `${startDate}${startTime}〜${task.plannedEndTime}`
      : `${startDate}${startTime}`;
  }
  return `${startDate}${startTime}〜${endDate}${endTime}`;
}

// 指定日において、タスクの開始/終了のうちその日にあたる側に時刻指定があるか
function hasTimeOnDay(task, day) {
  return (task.plannedStart === day && !!task.plannedStartTime) || (task.plannedEnd === day && !!task.plannedEndTime);
}

// 予定の期限を過ぎた未完了タスク(todayは比較用の "YYYY-MM-DD")
function isOverdue(task, today) {
  return task.status === 'todo' && task.plannedEnd < today;
}

function isDueToday(task) {
  return task.status === 'todo' && task.plannedEnd === todayStr();
}

// 重要度が高い順。同じ重要度なら予定日が近い順(予定なしは後ろ)、同条件なら新しい順
function compareActiveTasks(a, b) {
  const levelA = parseLevel(a.importance);
  const levelB = parseLevel(b.importance);
  if (levelA !== levelB) return levelB - levelA;
  const planA = a.plannedStart || '9999-99-99';
  const planB = b.plannedStart || '9999-99-99';
  if (planA !== planB) return planA < planB ? -1 : 1;
  return b.createdAt - a.createdAt;
}

// ui.todoFilter* のうち、クライアントとプロジェクトの組み合わせが矛盾する場合を整える
function reconcileTodoProjectFilter() {
  const project = projectById(ui.todoFilterProject);
  if (project && ui.todoFilterClient && project.clientId !== ui.todoFilterClient) {
    ui.todoFilterProject = '';
  } else if (project && !ui.todoFilterClient) {
    ui.todoFilterClient = project.clientId || '';
  }
}

// 一覧の絞り込み(検索語・クライアント・プロジェクト・重要度・重さ・年月・タグ・カテゴリ)。Todo/カンバン両タブで共有
function applyTodoFilters(tasks) {
  let result = tasks;
  const words = ui.todoSearch.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length) {
    result = result.filter((task) => {
      const text = [task.title, task.note, ...(task.tags || [])].join(' ').normalize('NFKC').toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    });
  }
  if (ui.todoFilterClient) {
    result = result.filter((task) => {
      const project = projectById(task.projectId);
      return project && project.clientId === ui.todoFilterClient;
    });
  }
  if (ui.todoFilterProject) {
    result = result.filter((task) => task.projectId === ui.todoFilterProject);
  }
  if (ui.todoFilterImportance !== '') {
    const importance = Number(ui.todoFilterImportance);
    result = result.filter((task) => parseLevel(task.importance) === importance);
  }
  if (ui.todoFilterWeight !== '') {
    const weight = Number(ui.todoFilterWeight);
    result = result.filter((task) => parseLevel(task.weight) === weight);
  }
  if (ui.todoFilterMonth) {
    const monthStart = `${ui.todoFilterMonth}-01`;
    const monthEnd = endOfMonthStr(ui.todoFilterMonth);
    result = result.filter((task) => task.plannedStart && task.plannedEnd && task.plannedStart <= monthEnd && task.plannedEnd >= monthStart);
  }
  if (ui.todoFilterTag) {
    result = result.filter((task) => (task.tags || []).includes(ui.todoFilterTag));
  }
  if (ui.todoFilterCategory) {
    result = result.filter((task) => task.categoryId === ui.todoFilterCategory);
  }
  return result;
}

// 状態切替ボタンの次の状態(最後の状態の次は最初へ戻る)
function nextTaskStatus(status) {
  const index = TASK_STATUS_ORDER.indexOf(status);
  return TASK_STATUS_ORDER[(index + 1) % TASK_STATUS_ORDER.length];
}

// 繰り返しの単位ぶん予定日を先送りする(毎月は月の繰り上がりをDateに任せる)
function shiftDateByRepeat(dateStr, repeat) {
  const date = fromDateStr(dateStr);
  if (repeat === 'daily') date.setDate(date.getDate() + 1);
  else if (repeat === 'weekly') date.setDate(date.getDate() + 7);
  else if (repeat === 'monthly') date.setMonth(date.getMonth() + 1);
  return toDateStr(date);
}

// 繰り返しタスクの完了時に、次回分のタスクを生成する
function createNextOccurrence(task) {
  const plannedStart = task.plannedStart ? shiftDateByRepeat(task.plannedStart, task.repeat) : null;
  const plannedEnd = task.plannedEnd ? shiftDateByRepeat(task.plannedEnd, task.repeat) : plannedStart;
  return {
    id: uid(),
    title: task.title,
    projectId: task.projectId,
    categoryId: task.categoryId || null,
    status: 'todo',
    createdAt: Date.now(),
    completedAt: null,
    plannedStart,
    plannedEnd,
    plannedStartTime: task.plannedStartTime || null,
    plannedEndTime: task.plannedEndTime || null,
    repeat: task.repeat,
    estimateMinutes: task.estimateMinutes || null,
    importance: parseLevel(task.importance),
    weight: parseLevel(task.weight),
    note: task.note || null,
    tags: [...(task.tags || [])],
  };
}

/* ---------- mutations ---------- */

// 削除を取り消せるよう、削除前のタスクと作業記録を退避する
function rememberDeletion(tasks, entries) {
  deletionHistory.push(structuredClone({ tasks, entries }));
  if (deletionHistory.length > 20) deletionHistory.shift();
}

// 既に存在する項目は重複させない。作業記録のタスクが無ければ戻さない。
// 同じタスクが今も計測中なら、戻す計測中の記録は現在時刻で止める
function undoDeletion() {
  const removed = deletionHistory.pop();
  if (!removed) return;
  data.tasks.push(...removed.tasks.filter((task) => !taskById(task.id)));
  for (const entry of removed.entries) {
    if (entryById(entry.id) || !taskById(entry.taskId)) continue;
    if (entry.end === null && runningEntryForTask(entry.taskId)) entry.end = Date.now();
    data.entries.push(entry);
  }
  save();
}

// 複数タスクの並行計測に対応(同じタスクの二重計測のみ防ぐ)
function startTimer(taskId) {
  if (runningEntryForTask(taskId)) return;
  const task = taskById(taskId);
  if (!task) return;
  if (task.status === 'todo') task.status = 'in_progress';
  data.entries.push({ id: uid(), taskId, start: Date.now(), end: null });
  save();
  renderAll();
}

function stopTimer(entryId) {
  const entry = entryById(entryId);
  if (entry && entry.end === null) {
    entry.end = Date.now();
    save();
    syncEntryToGoogle(entry);
  }
}

function stopAllTimers() {
  const now = Date.now();
  const stopped = runningEntries();
  stopped.forEach((entry) => { entry.end = now; });
  save();
  stopped.forEach(syncEntryToGoogle);
}

// ステータスを直接設定し、付随する副作用(完了時刻・計測停止・繰り返し次回生成)を適用する。
// 変更があればtrueを返す。save()/renderAll()は呼び出し側の責務
function setTaskStatus(task, status) {
  if (!TASK_STATUS_ORDER.includes(status) || task.status === status) return false;
  task.status = status;
  task.kanbanOrder = null;
  if (status === 'done') {
    task.completedAt = Date.now();
    const running = runningEntryForTask(task.id);
    if (running) stopTimer(running.id);
    if (task.repeat) data.tasks.push(createNextOccurrence(task));
  } else {
    task.completedAt = null;
  }
  return true;
}

// カンバンで複数タスクの並び順を変える。ドロップ先の前後にあるタスクのIDで位置を決める
function reorderKanbanTask(task, status, beforeId, afterId) {
  const tasks = data.tasks.filter((item) => item.status === status && item.id !== task.id).sort(compareKanbanTasks);
  let index = beforeId ? tasks.findIndex((item) => item.id === beforeId) : -1;
  if (index < 0 && afterId) index = tasks.findIndex((item) => item.id === afterId) + 1;
  if (index < 0) index = tasks.length;
  setTaskStatus(task, status);
  tasks.splice(index, 0, task);
  tasks.forEach((item, order) => { item.kanbanOrder = order; });
}

function deleteTask(id) {
  const entryCount = data.entries.filter((entry) => entry.taskId === id).length;
  const message = entryCount > 0
    ? `このタスクと ${entryCount} 件の作業記録を削除します。よろしいですか?`
    : 'このタスクを削除します。よろしいですか?';
  if (!confirm(message)) return;
  rememberDeletion(data.tasks.filter((task) => task.id === id), data.entries.filter((entry) => entry.taskId === id));
  data.tasks = data.tasks.filter((task) => task.id !== id);
  data.entries = data.entries.filter((entry) => entry.taskId !== id);
  save();
  renderAll();
}

function deleteSubtask(taskId, subtaskId) {
  const task = taskById(taskId);
  if (!task || !task.subtasks) return;
  task.subtasks = task.subtasks.filter((subtask) => subtask.id !== subtaskId);
  save();
  renderAll();
}

// 削除前の確認。参照元(refs)があれば、削除後は「なし」になる旨を伝えて参照を外す。
// 戻り値は削除を続けてよいかどうか
function confirmDeletionOf(kind, refs, refKey, refNoun, emptyLabel) {
  if (refs.length === 0) return confirm(`この${kind}を削除します。よろしいですか?`);
  if (!confirm(`この${kind}には ${refs.length} 件の${refNoun}があります。${refNoun}は「${emptyLabel}」になります。削除しますか?`)) return false;
  refs.forEach((ref) => { ref[refKey] = null; });
  return true;
}

function deleteClient(id) {
  const projects = data.projects.filter((project) => project.clientId === id);
  if (!confirmDeletionOf('クライアント', projects, 'clientId', 'プロジェクト', 'クライアントなし')) return;
  data.clients = data.clients.filter((client) => client.id !== id);
  save();
  renderAll();
}

function deleteCategory(id) {
  const tasks = data.tasks.filter((task) => task.categoryId === id);
  if (!confirmDeletionOf('カテゴリ', tasks, 'categoryId', 'タスク', 'カテゴリなし')) return;
  data.categories = data.categories.filter((category) => category.id !== id);
  if (ui.todoFilterCategory === id) ui.todoFilterCategory = '';
  save();
  renderAll();
}

function deleteProject(id) {
  const tasks = data.tasks.filter((task) => task.projectId === id);
  if (!confirmDeletionOf('プロジェクト', tasks, 'projectId', 'タスク', 'プロジェクトなし')) return;
  data.projects = data.projects.filter((project) => project.id !== id);
  save();
  renderAll();
}

// ガントのドラッグ移動の前後で、予定の値を元に戻せるように控える
function snapshotPlan(task) {
  return {
    taskId: task.id,
    plannedStart: task.plannedStart,
    plannedEnd: task.plannedEnd,
    plannedStartTime: task.plannedStartTime,
    plannedEndTime: task.plannedEndTime,
  };
}

function undoLastGanttDrag() {
  if (!lastGanttDragUndo) return false;
  const task = taskById(lastGanttDragUndo.taskId);
  if (!task) {
    lastGanttDragUndo = null;
    return false;
  }
  task.plannedStart = lastGanttDragUndo.plannedStart;
  task.plannedEnd = lastGanttDragUndo.plannedEnd;
  task.plannedStartTime = lastGanttDragUndo.plannedStartTime;
  task.plannedEndTime = lastGanttDragUndo.plannedEndTime;
  lastGanttDragUndo = null;
  save();
  renderAll();
  return true;
}

/* ----- URLハッシュ(タブ状態の保存/復元) ----- */

const HASH_TABS = ['todo', 'kanban', 'timeline', 'gantt', 'report', 'manage'];
const HASH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_MONTH_RE = /^\d{4}-\d{2}$/;

// 現在のuiから「#タブ?パラメータ」形式のハッシュを作る(タブごとに意味のある値のみ)
function buildHash() {
  const params = new URLSearchParams();
  if (ui.tab === 'todo' || ui.tab === 'kanban') {
    if (ui.todoSearch) params.set('q', ui.todoSearch);
    if (ui.todoFilterClient) params.set('client', ui.todoFilterClient);
    if (ui.todoFilterProject) params.set('project', ui.todoFilterProject);
    if (ui.todoFilterImportance !== '') params.set('importance', ui.todoFilterImportance);
    if (ui.todoFilterWeight !== '') params.set('weight', ui.todoFilterWeight);
    if (ui.todoFilterMonth) params.set('month', ui.todoFilterMonth);
    if (ui.todoFilterTag) params.set('tag', ui.todoFilterTag);
    if (ui.todoFilterCategory) params.set('category', ui.todoFilterCategory);
    if (ui.activeFilterId) params.set('filter', ui.activeFilterId);
  } else if (ui.tab === 'timeline') {
    params.set('date', ui.timelineDate);
  } else if (ui.tab === 'gantt') {
    params.set('date', ui.ganttDate);
    params.set('start', ui.ganttStart);
    params.set('days', ui.ganttDays);
  } else if (ui.tab === 'report') {
    params.set('from', ui.reportFrom);
    params.set('to', ui.reportTo);
  }
  const query = params.toString();
  return `#${ui.tab}${query ? `?${query}` : ''}`;
}

// Todo/カンバンのハッシュパラメータを、存在確認したうえでuiへ反映する
function applyTodoHash(params) {
  ui.todoSearch = params.get('q') || '';
  const clientId = params.get('client') || '';
  const projectId = params.get('project') || '';
  const importance = params.get('importance');
  const weight = params.get('weight');
  const month = params.get('month') || '';
  const tag = params.get('tag') || '';
  const categoryId = params.get('category') || '';
  const filterId = params.get('filter');
  ui.todoFilterClient = clientById(clientId) ? clientId : '';
  ui.todoFilterProject = projectById(projectId) ? projectId : '';
  ui.todoFilterImportance = ['0', '1', '2', '3'].includes(importance) ? importance : '';
  ui.todoFilterWeight = ['0', '1', '2', '3'].includes(weight) ? weight : '';
  ui.todoFilterMonth = HASH_MONTH_RE.test(month) ? month : '';
  ui.todoFilterTag = data.tasks.some((task) => (task.tags || []).includes(tag)) ? tag : '';
  ui.todoFilterCategory = categoryById(categoryId) ? categoryId : '';
  ui.activeFilterId = filterId && data.filters.some((filter) => filter.id === filterId) ? filterId : null;
  reconcileTodoProjectFilter();
}

// location.hashを検証しつつuiへ反映する(不正な値は無視して現状維持)
function applyHash() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!hash) return;
  const [tab, query] = hash.split('?');
  if (!HASH_TABS.includes(tab)) return;
  ui.tab = tab;
  const params = new URLSearchParams(query || '');
  const date = params.get('date');
  if (tab === 'todo' || tab === 'kanban') {
    applyTodoHash(params);
  } else if (tab === 'timeline' && HASH_DATE_RE.test(date || '')) {
    ui.timelineDate = date;
  } else if (tab === 'gantt') {
    if (HASH_DATE_RE.test(date || '')) ui.ganttDate = date;
    if (HASH_DATE_RE.test(params.get('start') || '')) ui.ganttStart = params.get('start');
    if ([7, 14, 28, 56].includes(Number(params.get('days')))) ui.ganttDays = Number(params.get('days'));
  } else if (tab === 'report') {
    if (HASH_DATE_RE.test(params.get('from') || '')) ui.reportFrom = params.get('from');
    if (HASH_DATE_RE.test(params.get('to') || '')) ui.reportTo = params.get('to');
    if (ui.reportFrom > ui.reportTo) ui.reportTo = ui.reportFrom;
  }
}

/* ---------- rendering ---------- */

// HTMLの本文・属性へ埋め込む前の値をエスケープする(ユーザー入力は必ずこれを通す)
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 割合(%)。合計が0の場合は0
function percentOf(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

/* ----- 共通の選択肢・チップ ----- */

// 名前順のselect用option。先頭は空値の選択肢(emptyOptionのHTML)
function namedOptions(items, selectedId, emptyOption) {
  let html = emptyOption;
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  for (const item of sorted) {
    html += `<option value="${esc(item.id)}"${item.id === selectedId ? ' selected' : ''}>${esc(item.name)}</option>`;
  }
  return html;
}

function clientOptions(selectedId, emptyLabel) {
  return namedOptions(data.clients, selectedId, `<option value="">${emptyLabel || 'クライアントなし'}</option>`);
}

function categoryOptions(selectedId, emptyLabel) {
  return namedOptions(data.categories, selectedId, `<option value="">${emptyLabel || 'カテゴリなし'}</option>`);
}

// 管理タブのクライアント選択。並べ替えず登録順のまま出す
function clientOptionsInRegistrationOrder(selectedId) {
  let html = '<option value="">クライアントなし</option>';
  for (const client of data.clients) {
    html += `<option value="${esc(client.id)}"${client.id === selectedId ? ' selected' : ''}>${esc(client.name)}</option>`;
  }
  return html;
}

// プロジェクト名は「クライアント / プロジェクト」の表示名で並べる。clientIdを指定するとそのクライアントのものだけ
function projectOptions(selectedId, emptyLabel, clientId = '') {
  let html = `<option value="">${emptyLabel || 'プロジェクトなし'}</option>`;
  const projects = clientId ? data.projects.filter((project) => project.clientId === clientId) : data.projects;
  const sorted = [...projects].sort((a, b) => projectLabel(a.id).localeCompare(projectLabel(b.id), 'ja'));
  for (const project of sorted) {
    html += `<option value="${esc(project.id)}"${project.id === selectedId ? ' selected' : ''}>${esc(projectLabel(project.id))}</option>`;
  }
  return html;
}

// 保存済みフィルターのselect用option(先頭は「フィルターなし」固定)
function savedFilterOptions() {
  const emptyOption = `<option value=""${ui.activeFilterId ? '' : ' selected'}>-- フィルターなし --</option>`;
  return namedOptions(data.filters, ui.activeFilterId, emptyOption);
}

function tagFilterOptions(selected) {
  const tags = allTags();
  // 保存済みフィルター等で、どのタスクにも残っていないタグが選択中でも選択肢に含める
  if (selected && !tags.includes(selected)) tags.push(selected);
  let html = `<option value=""${selected ? '' : ' selected'}>すべて</option>`;
  for (const tag of tags) {
    html += `<option value="${esc(tag)}"${tag === selected ? ' selected' : ''}>${esc(tag)}</option>`;
  }
  return html;
}

function repeatOptions(selected) {
  let html = '<option value="">限定的（繰り返しなし）</option>';
  for (const [value, label] of Object.entries(REPEAT_LABELS)) {
    html += `<option value="${value}"${value === selected ? ' selected' : ''}>恒常的（${label}）</option>`;
  }
  return html;
}

// 段階値(重要度・重さ)のフォーム用option。値は0〜3
function levelOptions(kind, selected) {
  const { labels, formLabel } = LEVEL_FIELDS[kind];
  const current = parseLevel(selected);
  return labels.map((label, value) =>
    `<option value="${value}"${value === current ? ' selected' : ''}>${formLabel}: ${label}</option>`).join('');
}

// 段階値の絞り込み用option(先頭の「すべて」は空値)
function levelFilterOptions(kind, selected) {
  const { labels } = LEVEL_FIELDS[kind];
  const allOption = `<option value=""${selected === '' ? ' selected' : ''}>すべて</option>`;
  return allOption + labels.map((label, value) => {
    const stringValue = String(value);
    return `<option value="${stringValue}"${stringValue === selected ? ' selected' : ''}>${label}</option>`;
  }).join('');
}

// 5分刻みの時刻<option>
function timeOptions(selected) {
  let html = '';
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute += 5) {
      const value = `${pad2(hour)}:${pad2(minute)}`;
      html += `<option value="${value}"${value === selected ? ' selected' : ''}>${value}</option>`;
    }
  }
  return html;
}

const TIME_SELECT_LABELS = {
  plannedStartTime: '予定開始時刻',
  plannedEndTime: '予定終了時刻',
  start: '開始時刻',
  end: '終了時刻',
};

function timeSelect(name, value, { required = false, disabled = false, label = '' } = {}) {
  const placeholder = value
    ? ''
    : `<option value="" selected${required ? ' disabled' : ''}>--:--</option>`;
  const ariaLabel = label || TIME_SELECT_LABELS[name] || '時刻';
  return `<select name="${name}" aria-label="${esc(ariaLabel)}"${required ? ' required' : ''}${disabled ? ' disabled' : ''}>${placeholder}${timeOptions(value)}</select>`;
}

function statusRowClass(task) {
  if (task.status === 'done') return 'done';
  if (task.status === 'in_progress') return 'in-progress';
  if (task.status === 'waiting_review') return 'waiting-review';
  return '';
}

function projectChip(projectId) {
  if (!projectId) return '';
  return `<span class="chip"><span class="chip-dot" style="background:${projectColor(projectId)}"></span>${esc(projectLabel(projectId))}</span>`;
}

function categoryChip(task) {
  const category = categoryById(task.categoryId);
  if (!category) return '';
  return `<span class="chip category-chip">📂 ${esc(category.name)}</span>`;
}

// 重要度・重さのチップ。指定なし(0)は表示しない
function levelChip(kind, task) {
  const level = parseLevel(task[kind]);
  if (!level) return '';
  const { labels, chipLabel } = LEVEL_FIELDS[kind];
  return `<span class="chip ${kind}-${level}">${chipLabel} ${labels[level]}</span>`;
}

function planChip(task) {
  if (!task.plannedStart) return '';
  const today = todayStr();
  let extraClass = '';
  let note = '';
  if (task.status === 'todo') {
    if (isOverdue(task, today)) {
      extraClass = ' plan-overdue';
      note = ' 超過';
    } else if (task.plannedEnd === today) {
      extraClass = ' plan-due-today';
      note = ' 本日締め切り';
    } else if (task.plannedStart <= today) {
      extraClass = ' plan-today';
    }
  }
  return `<span class="chip${extraClass}">📅 ${esc(planLabel(task))}${note}</span>`;
}

function repeatChip(task) {
  if (!task.repeat) return '';
  return `<span class="chip">🔁 ${REPEAT_LABELS[task.repeat] || esc(task.repeat)}</span>`;
}

function tagChips(task) {
  return (task.tags || []).map((tag) => `<span class="chip tag-chip">🏷 ${esc(tag)}</span>`).join('');
}

// 累計時間の表示(見積があれば「累計/見積」+進捗バー、超過時は警告色)
function totalChip(task, totalMs) {
  if (!task.estimateMinutes) {
    return totalMs > 0 ? `<span>累計 ${fmtDur(totalMs)}</span>` : '';
  }
  const estMs = task.estimateMinutes * MS_PER_MINUTE;
  const pct = (totalMs / estMs) * 100;
  return `
    <span class="estimate${pct > 100 ? ' over' : ''}">
      累計 ${fmtDur(totalMs)} / 見積 ${fmtDur(estMs)}
      <span class="progress"><span class="progress-fill" style="width:${Math.min(100, pct).toFixed(1)}%"></span></span>
      ${pct > 100 ? `<span class="over-note">+${fmtDur(totalMs - estMs)} 超過</span>` : ''}
    </span>`;
}

// タスク一覧とカンバンで共通のチップ(プロジェクト・カテゴリ・重要度・重さ・予定)
function commonTaskChips(task) {
  return [
    projectChip(task.projectId),
    categoryChip(task),
    levelChip('importance', task),
    levelChip('weight', task),
    planChip(task),
  ].join('');
}

/* ----- Todo/カンバン共通の絞り込みUI ----- */

// <label>の入力欄(ラベル文字とコントロールをまとめる)
function filterField(label, control, className = 'field') {
  return `<label class="${className}"><span class="field-label">${label}</span>${control}</label>`;
}

// Todo/カンバン両タブで共有するフィルタUI(クライアント/プロジェクト/重要度/重さ/年月/タグ+保存済みフィルター)
function todoFilterRow() {
  const hasTags = allTags().length > 0 || ui.todoFilterTag;
  const hasCategories = data.categories.length > 0 || ui.todoFilterCategory;
  const filterCount = [
    ui.todoSearch,
    ui.todoFilterClient,
    ui.todoFilterProject,
    ui.todoFilterCategory,
    ui.todoFilterImportance,
    ui.todoFilterWeight,
    ui.todoFilterMonth,
    ui.todoFilterTag,
  ].filter(Boolean).length;
  // 絞り込み中・保存済みフィルター適用中は開いたままにする。スマホ幅では初期状態を閉じておく
  const filtersOpen = filterCount > 0 || ui.activeFilterId ||
    (ui.tab === 'todo' && !window.matchMedia('(max-width: 720px)').matches);
  const fields = [
    filterField('検索（完了済みも対象）', `<input type="search" value="${esc(ui.todoSearch)}" data-action-change="todo-search" placeholder="タスク名・メモ・タグ">`),
    filterField('保存済み', `<select data-action-change="apply-saved-filter">${savedFilterOptions()}</select>`),
    filterField('クライアント', `<select data-action-change="todo-client-filter">${clientOptions(ui.todoFilterClient, 'すべて')}</select>`),
    filterField('プロジェクト', `<select data-action-change="todo-filter">${projectOptions(ui.todoFilterProject, 'すべて', ui.todoFilterClient)}</select>`, 'field field-project'),
    hasCategories ? filterField('カテゴリ', `<select data-action-change="todo-category-filter">${categoryOptions(ui.todoFilterCategory, 'すべて')}</select>`) : '',
    filterField('重要度', `<select data-action-change="todo-importance-filter">${levelFilterOptions('importance', ui.todoFilterImportance)}</select>`),
    filterField('重さ', `<select data-action-change="todo-weight-filter">${levelFilterOptions('weight', ui.todoFilterWeight)}</select>`),
    filterField('年月', `<input type="month" data-action-change="todo-month-filter" value="${esc(ui.todoFilterMonth)}">`),
    hasTags ? filterField('タグ', `<select data-action-change="todo-tag-filter">${tagFilterOptions(ui.todoFilterTag)}</select>`) : '',
  ].join('');
  return `
    <details class="filter-panel" data-details-key="${ui.tab}-filters"${filtersOpen ? ' open' : ''}>
      <summary class="filter-panel-heading">
        <div>
          <span class="section-eyebrow">表示条件</span>
          <strong>タスクを絞り込む</strong>
          <span class="filter-status">${filterCount ? `${filterCount}項目を指定中` : 'すべて表示中'}</span>
        </div>
      </summary>
      <div class="filter-panel-content">
        <div class="filter-grid">${fields}</div>
        <div class="filter-save-row">
          <form class="save-filter-form" data-action-submit="save-filter">
            <input type="text" name="name" placeholder="現在の条件を名前で保存..." maxlength="40" required>
            <button class="btn" type="submit" title="現在の絞り込み条件を保存">保存</button>
          </form>
          ${filterCount || ui.activeFilterId ? '<button class="btn btn-quiet" type="button" data-action="clear-todo-filters">条件をクリア</button>' : ''}
          ${ui.activeFilterId ? `<button class="btn-icon danger" data-action="delete-filter" data-id="${esc(ui.activeFilterId)}" title="この保存済みフィルターを削除" aria-label="この保存済みフィルターを削除">🗑</button>` : ''}
        </div>
      </div>
    </details>`;
}

/* ----- 画面全体の描画 ----- */

const TAB_RENDERERS = {
  todo: renderTodo,
  kanban: renderKanban,
  timeline: renderTimeline,
  gantt: renderGantt,
  report: renderReport,
};

function renderAll() {
  const previousView = document.getElementById('view');
  const focusedControl = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('#view [data-action-change]')
    : null;
  const focusState = pendingFocusState || (focusedControl ? {
    action: focusedControl.dataset.actionChange,
    id: focusedControl.dataset.id || '',
    subtaskId: focusedControl.dataset.subtaskId || '',
  } : null);
  pendingFocusState = null;
  // 再描画で折りたたみの開閉が元に戻らないよう、描画前の状態を覚えておく
  const detailStates = new Map(
    [...previousView.querySelectorAll('details[data-details-key]')]
      .map((detail) => [detail.dataset.detailsKey, detail.open])
  );

  renderRunningBox();
  document.querySelectorAll('.tab-btn').forEach((button) => {
    const active = button.dataset.tab === ui.tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const view = document.getElementById('view');
  view.classList.toggle('view-wide', ui.tab === 'todo' || ui.tab === 'gantt' || ui.tab === 'kanban');
  view.classList.toggle('view-kanban', ui.tab === 'kanban');
  const renderTab = TAB_RENDERERS[ui.tab] || renderManage;
  view.innerHTML = renderTab();

  view.querySelectorAll('details[data-details-key]').forEach((detail) => {
    if (detailStates.has(detail.dataset.detailsKey)) {
      detail.open = detailStates.get(detail.dataset.detailsKey);
    }
  });
  if (ui.tab === 'todo' && ui.todoSearch.trim()) {
    const doneSection = view.querySelector('[data-details-key="done-tasks"]');
    if (doneSection) doneSection.open = true;
  }
  if (focusState) {
    const candidates = [...view.querySelectorAll(`[data-action-change="${focusState.action}"]`)];
    const nextFocus = candidates.find((candidate) =>
      (candidate.dataset.id || '') === focusState.id &&
      (candidate.dataset.subtaskId || '') === focusState.subtaskId
    );
    if (nextFocus) nextFocus.focus({ preventScroll: true });
  }

  if (deletionHistory.length) {
    view.insertAdjacentHTML('afterbegin', '<div class="undo-banner" role="status">削除を取り消せます（ページを開いている間、最大20件） <button class="btn" data-action="undo-delete">直前の削除を取り消す</button></div>');
  }
  // 全ての状態変更はここを通るので、URLへの反映はこの1箇所だけでよい
  // (replaceStateはhashchangeを発火しないのでループしない)
  history.replaceState(null, '', location.pathname + location.search + buildHash());
}

// 計測中の作業を画面上部にまとめて表示する
function renderRunningBox() {
  const box = document.getElementById('running-box');
  const running = runningEntries();
  if (!running.length) {
    box.innerHTML = '';
    return;
  }
  const pills = running.map(runningPillHtml).join('');
  const stopAll = running.length > 1
    ? '<button class="btn btn-quiet danger" data-action="stop-all-timers">すべて停止</button>'
    : '';
  box.innerHTML = pills + stopAll;
}

function runningPillHtml(entry) {
  const task = taskById(entry.taskId);
  const project = task ? projectById(task.projectId) : null;
  const projectHtml = project
    ? `<span class="running-project"><span class="chip-dot" style="background:${esc(project.color)}"></span>${esc(project.name)}</span>`
    : '';
  const taskTitle = task ? task.title : 'タスク';
  return `
    <div class="running-inner">
      <span class="running-dot"></span>
      <span class="running-task">${esc(task ? task.title : '(削除済みタスク)')}</span>
      ${projectHtml}
      <span class="timer-warning" data-warning-since="${entry.start}" ${Date.now() - entry.start < LONG_TIMER_WARNING_MS ? 'hidden' : ''}>8時間以上計測中・止め忘れを確認</span>
      <details class="stop-at-details">
        <summary>終了日時を指定</summary>
        <form class="stop-at-form" data-action-submit="stop-at" data-id="${esc(entry.id)}">
        <label>終了日時 <input type="datetime-local" name="end" step="60" required aria-label="終了日時を指定"></label>
        <button class="btn" type="submit">指定して停止</button>
        </form>
      </details>
      <span class="running-elapsed" data-live-since="${entry.start}">${fmtClock(Date.now() - entry.start)}</span>
      <button class="btn-icon danger" data-action="stop-timer" data-id="${esc(entry.id)}" title="計測を停止" aria-label="${esc(taskTitle)}の計測を停止">■</button>
    </div>`;
}

/* ----- Todoタブ ----- */

// タスク1件のチェックリスト(サブタスク)。件数の有無で初期の開閉を変える
function subtaskBlockHtml(task) {
  const subtasks = task.subtasks || [];
  const doneCount = subtasks.filter((subtask) => subtask.done).length;
  return `
    <details class="subtask-block" data-details-key="subtask-${esc(task.id)}"${subtasks.length ? ' open' : ''}>
      <summary>${subtasks.length ? `チェックリスト <span>${doneCount}/${subtasks.length}</span>` : 'チェックリストを追加'}</summary>
      <div class="subtask-content">
        <ul class="subtask-list">
          ${subtasks.map((subtask) => `
            <li class="subtask-item ${subtask.done ? 'done' : ''}">
              <input type="checkbox" ${subtask.done ? 'checked' : ''} data-action-change="toggle-subtask" data-id="${esc(task.id)}" data-subtask-id="${esc(subtask.id)}" aria-label="${esc(subtask.title)}を${subtask.done ? '未完了に戻す' : '完了にする'}">
              <span class="subtask-title">${esc(subtask.title)}</span>
              <button class="btn-icon danger" data-action="del-subtask" data-id="${esc(task.id)}" data-subtask-id="${esc(subtask.id)}" title="サブタスクを削除" aria-label="${esc(subtask.title)}を削除">🗑</button>
            </li>`).join('')}
        </ul>
        <form class="subtask-add-form" data-action-submit="add-subtask" data-id="${esc(task.id)}">
          <input type="text" name="title" placeholder="サブタスクを追加..." aria-label="サブタスク名" required>
          <button class="btn-icon" type="submit" title="サブタスクを追加" aria-label="サブタスクを追加">＋</button>
        </form>
      </div>
    </details>`;
}

// タスク行を編集フォームに差し替えたもの
function todoTaskEditRow(task) {
  return `
    <li class="task-item task-item-editing">
      <div class="task-main editing-task-main">
        <form class="edit-form" data-action-submit="save-task" data-id="${esc(task.id)}">
          <input type="text" name="title" value="${esc(task.title)}" aria-label="タスク名" required>
          <select name="projectId" aria-label="プロジェクト">${projectOptions(task.projectId)}</select>
          ${data.categories.length ? `<select name="categoryId" aria-label="カテゴリ">${categoryOptions(task.categoryId)}</select>` : ''}
          <span class="plan-inputs">予定
            <input type="date" name="plannedStart" value="${esc(task.plannedStart || '')}" aria-label="予定開始日">
            ${timeSelect('plannedStartTime', task.plannedStartTime || '')}
            〜
            <input type="date" name="plannedEnd" value="${esc(task.plannedEnd || '')}" aria-label="予定終了日">
            ${timeSelect('plannedEndTime', task.plannedEndTime || '')}
          </span>
          <select name="importance" aria-label="重要度">${levelOptions('importance', task.importance)}</select>
          <select name="weight" aria-label="重さ">${levelOptions('weight', task.weight)}</select>
          <select name="repeat" aria-label="タスク種別">${repeatOptions(task.repeat || '')}</select>
          <span class="estimate-input">見積
            <input type="number" name="estimateMinutes" min="0" value="${task.estimateMinutes || ''}" placeholder="--" aria-label="見積時間（分）">分
          </span>
          <input type="text" name="tags" value="${esc((task.tags || []).join(', '))}" placeholder="タグ(カンマ区切り)" aria-label="タグ" autocomplete="off">
          <textarea name="note" rows="2" placeholder="メモ(任意)" aria-label="メモ">${esc(task.note || '')}</textarea>
          <button class="btn btn-primary" type="submit">保存</button>
          <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
        </form>
        ${subtaskBlockHtml(task)}
      </div>
    </li>`;
}

// タスク行の計測ボタン。計測中なら停止と開始時刻の編集、完了済みは出さない
function timerStopButton(running, now) {
  return `<button class="timer-btn stop" data-action="stop-timer" data-id="${esc(running.id)}">■ <span data-live-since="${running.start}">${fmtClock(now - running.start)}</span></button>`;
}

function timerStartButton(task) {
  return `<button class="timer-btn start" data-action="start-timer" data-id="${esc(task.id)}">▶ 計測</button>`;
}

function todoTimerControls(task, running, now) {
  if (task.status === 'done') return '';
  if (running && ui.editingEntry === running.id) {
    return `
      <form class="edit-form" data-action-submit="save-running-start" data-id="${esc(running.id)}">
        開始
        <input type="date" name="startDate" value="${toDateStr(new Date(running.start))}" required>
        <input type="time" name="startTime" step="60" value="${fmtTime(running.start)}" required>
        <button class="btn btn-primary" type="submit">保存</button>
        <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
      </form>`;
  }
  if (running) {
    return `
      ${timerStopButton(running, now)}
      <button class="btn-icon" data-action="edit-entry" data-id="${esc(running.id)}" title="開始時刻を編集" aria-label="${esc(task.title)}の開始時刻を編集">✎</button>`;
  }
  return timerStartButton(task);
}

// タスク一覧の1行。編集中ならフォームに差し替える
function todoTaskRow(task, now) {
  if (ui.editingTask === task.id) return todoTaskEditRow(task);
  const totalMs = data.entries
    .filter((entry) => entry.taskId === task.id)
    .reduce((sum, entry) => sum + entryDur(entry, now), 0);
  const running = runningEntryForTask(task.id);
  const statusClass = statusRowClass(task);
  const isToday = task.todayDate === todayStr();
  return `
    <li class="task-item ${statusClass}${isDueToday(task) ? ' due-today' : ''}">
      <button type="button" class="status-toggle${statusClass ? ' status-' + statusClass : ''}"
        data-action="cycle-status" data-id="${esc(task.id)}"
        aria-label="ステータス: ${TASK_STATUS_LABELS[task.status]}(クリックで次の状態へ)"
        title="クリックで状態を切り替え(未着手 → 作業中 → 作業済み → 完了)"></button>
      <div class="task-main">
        <button type="button" class="task-title" data-action="edit-task" data-id="${esc(task.id)}" title="タスク名を変更" aria-label="${esc(task.title)}のタスク名を変更">${esc(task.title)}</button>
        ${task.note ? `<div class="task-note">${esc(task.note)}</div>` : ''}
        <div class="task-meta">
          ${commonTaskChips(task)}
          ${repeatChip(task)}
          ${tagChips(task)}
          ${totalChip(task, totalMs)}
        </div>
        ${subtaskBlockHtml(task)}
      </div>
      <div class="task-actions">
        ${todoTimerControls(task, running, now)}
        ${task.status !== 'done' ? `<button class="btn" data-action="toggle-today" data-id="${esc(task.id)}" aria-pressed="${isToday}">${isToday ? '★ 今日やる' : '☆ 今日やる'}</button>` : ''}
        <button class="btn-icon" data-action="edit-task" data-id="${esc(task.id)}" title="タスクを編集" aria-label="${esc(task.title)}を編集">✎</button>
        <button class="btn-icon danger" data-action="del-task" data-id="${esc(task.id)}" title="タスクを削除" aria-label="${esc(task.title)}を削除">🗑</button>
      </div>
    </li>`;
}

// 状態ごとの節。未着手は常に出し、作業中・確認待ちは該当がある時だけ出す
function todoTaskGroup(group, now) {
  const byStatus = {
    todo: group.tasks.filter((task) => task.status === 'todo'),
    in_progress: group.tasks.filter((task) => task.status === 'in_progress'),
    waiting_review: group.tasks.filter((task) => task.status === 'waiting_review'),
  };
  const rowsOf = (tasks) => tasks.map((task) => todoTaskRow(task, now)).join('');
  return `
    <section class="task-group task-group-${group.key}">
      <div class="task-group-heading">
        <div>
          <h3>${group.title} <span class="section-count">${group.tasks.length}</span></h3>
          <p>${group.description}</p>
        </div>
      </div>
      <section class="task-section todo-section">
        <h4 class="task-section-heading"><span class="status-dot status-todo"></span>未着手 <span class="section-count">${byStatus.todo.length}</span></h4>
        <ul class="task-list">
          ${byStatus.todo.length ? rowsOf(byStatus.todo) : '<li class="empty compact">未着手のタスクはありません</li>'}
        </ul>
      </section>
      ${byStatus.in_progress.length ? `
        <section class="task-section in-progress-section">
          <h4 class="task-section-heading"><span class="status-dot status-progress"></span>作業中 <span class="section-count">${byStatus.in_progress.length}</span></h4>
          <ul class="task-list">${rowsOf(byStatus.in_progress)}</ul>
        </section>` : ''}
      ${byStatus.waiting_review.length ? `
        <section class="task-section waiting-review-section">
          <h4 class="task-section-heading"><span class="status-dot status-review"></span>作業済み・確認待ち <span class="section-count">${byStatus.waiting_review.length}</span></h4>
          <ul class="task-list">${rowsOf(byStatus.waiting_review)}</ul>
        </section>` : ''}
    </section>`;
}

// 新しいタスクの追加カード(タスク名・プロジェクト・カテゴリは常時表示、その他は折りたたむ)
function todoCreateCard() {
  return `
    <div class="card create-card">
      <div class="card-heading">
        <div>
          <span class="section-eyebrow">Quick add</span>
          <h2>新しいタスク</h2>
        </div>
        <span class="shortcut-hint"><kbd>N</kbd> ですぐ入力</span>
      </div>
      <form class="add-form task-create-form" data-action-submit="add-task">
        <div class="create-primary${data.categories.length ? '' : ' no-category'}">
          <label class="field field-title"><span class="field-label">タスク名</span>
            <input type="text" name="title" placeholder="次に取り組むことは？" required autocomplete="off">
          </label>
          <label class="field field-project"><span class="field-label">プロジェクト</span>
            <select name="projectId">${projectOptions(ui.todoFilterProject || '', undefined, ui.todoFilterClient)}</select>
          </label>
          ${data.categories.length ? `<label class="field"><span class="field-label">カテゴリ</span>
            <select name="categoryId">${categoryOptions(ui.todoFilterCategory || '')}</select>
          </label>` : ''}
          <button class="btn btn-primary create-submit" type="submit">タスクを追加</button>
        </div>
        <details class="create-details" data-details-key="task-create">
          <summary>予定・重要度・タスク種別などを設定</summary>
          <div class="create-details-grid">
            <fieldset class="field field-wide plan-field">
              <legend class="field-label">予定</legend>
              <span class="plan-inputs">
                <input type="date" name="plannedStart" aria-label="予定開始日">
                ${timeSelect('plannedStartTime', '')}
                <span aria-hidden="true">〜</span>
                <input type="date" name="plannedEnd" aria-label="予定終了日">
                ${timeSelect('plannedEndTime', '')}
              </span>
            </fieldset>
            <label class="field"><span class="field-label">重要度</span>
              <select name="importance">${levelOptions('importance', 0)}</select>
            </label>
            <label class="field"><span class="field-label">重さ</span>
              <select name="weight">${levelOptions('weight', 0)}</select>
            </label>
            <label class="field"><span class="field-label">タスク種別</span>
              <select name="repeat">${repeatOptions('')}</select>
            </label>
            <label class="field"><span class="field-label">見積時間（分）</span>
              <input type="number" name="estimateMinutes" min="0" placeholder="例: 60">
            </label>
            <label class="field field-tags"><span class="field-label">タグ</span>
              <input type="text" name="tags" placeholder="デザイン, 急ぎ" autocomplete="off">
            </label>
          </div>
        </details>
      </form>
    </div>`;
}

function renderTodo() {
  const now = Date.now();
  reconcileTodoProjectFilter();

  const tasks = applyTodoFilters(data.tasks);
  const active = tasks.filter((task) => task.status === 'todo').sort(compareActiveTasks);
  const inProgress = tasks.filter((task) => task.status === 'in_progress').sort(compareActiveTasks);
  const waitingReview = tasks.filter((task) => task.status === 'waiting_review').sort(compareActiveTasks);
  const done = tasks.filter((task) => task.status === 'done').sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  const activeTasks = [...active, ...inProgress, ...waitingReview];
  const todayTasks = activeTasks.filter((task) => task.todayDate === toDateStr(new Date(now)));
  const remainingTasks = activeTasks.filter((task) => !todayTasks.includes(task));
  // 予定の開始日時をまだ迎えていないか
  const isUpcoming = (task) => task.plannedStart &&
    timeToTimestamp(fromDateStr(task.plannedStart).getTime(), task.plannedStartTime || '00:00') > now;

  const todayGroup = { key: 'today', title: '今日やる', description: '今日取り組むタスクを★で指定', tasks: todayTasks };
  const limitedGroup = {
    key: 'limited',
    title: '限定的なタスク',
    description: '今取り組んで消化するタスク',
    tasks: remainingTasks.filter((task) => !task.repeat && !isUpcoming(task)),
  };
  const upcomingGroup = {
    key: 'upcoming',
    title: '開始前のタスク',
    description: '予定の開始日時をまだ迎えていないタスク',
    tasks: remainingTasks.filter((task) => !task.repeat && isUpcoming(task)),
  };
  const recurringGroup = {
    key: 'recurring',
    title: '恒常的なタスク',
    description: '繰り返し取り組むタスク',
    tasks: remainingTasks.filter((task) => task.repeat),
  };

  return `
    ${todoCreateCard()}
    <div class="card task-card">
      <div class="card-heading">
        <div>
          <span class="section-eyebrow">Tasks</span>
          <h2>タスク一覧</h2>
        </div>
        <span class="task-overview">${active.length + inProgress.length + waitingReview.length}件の進行中タスク</span>
      </div>
      ${todoFilterRow()}
      <div class="todo-columns">
        <div class="todo-column">
          ${todoTaskGroup(todayGroup, now)}
          ${todoTaskGroup(limitedGroup, now)}
        </div>
        <div class="todo-column">
          ${todoTaskGroup(upcomingGroup, now)}
          ${todoTaskGroup(recurringGroup, now)}
        </div>
      </div>
      ${done.length ? `
        <details class="done-section" data-details-key="done-tasks"${ui.todoSearch ? ' open' : ''}>
          <summary><span class="status-dot status-done"></span>完了済み <span class="section-count">${done.length}</span></summary>
          <ul class="task-list">${done.map((task) => todoTaskRow(task, now)).join('')}</ul>
        </details>` : ''}
    </div>`;
}

/* ----- カンバンタブ ----- */

const KANBAN_DONE_LIMIT = 20;

// カンバン内の並び順。手動で並べた順(kanbanOrder)を優先し、無ければ既定の順
function compareKanbanTasks(a, b) {
  const orderA = Number.isFinite(a.kanbanOrder) ? a.kanbanOrder : Infinity;
  const orderB = Number.isFinite(b.kanbanOrder) ? b.kanbanOrder : Infinity;
  if (orderA !== orderB) return orderA - orderB;
  return a.status === 'done'
    ? (b.completedAt || 0) - (a.completedAt || 0)
    : compareActiveTasks(a, b);
}

// ドラッグ中のY座標から、列内でカードを挿入する位置(直前・直後のカード)を求める。ドラッグ中のカード自身は除く
function kanbanDropPosition(column, taskId, y) {
  const cards = [...column.querySelectorAll('.kanban-card')].filter((card) => card.dataset.id !== taskId);
  const before = cards.find((card) => {
    const rect = card.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
  return { before, after: before ? null : cards[cards.length - 1] };
}

function kanbanCard(task) {
  const subtasks = task.subtasks || [];
  const doneCount = subtasks.filter((subtask) => subtask.done).length;
  const running = runningEntryForTask(task.id);
  const statusIndex = TASK_STATUS_ORDER.indexOf(task.status);
  return `
    <li class="kanban-card ${statusRowClass(task)}${isDueToday(task) ? ' due-today' : ''}"
      data-action-pointer="kanban-drag" data-id="${esc(task.id)}">
      <div class="kanban-card-control" tabindex="0" role="slider"
        aria-label="${esc(task.title)}のステータス" aria-valuemin="0" aria-valuemax="${TASK_STATUS_ORDER.length - 1}"
        aria-valuenow="${statusIndex}" aria-valuetext="${TASK_STATUS_LABELS[task.status]}"
        aria-orientation="horizontal" aria-keyshortcuts="ArrowLeft ArrowRight">
        <div class="kanban-card-title">${esc(task.title)}</div>
        <div class="kanban-card-meta">
          ${commonTaskChips(task)}
          ${tagChips(task)}
          ${subtasks.length ? `<span class="chip">☑ ${doneCount}/${subtasks.length}</span>` : ''}
          ${running ? '<span class="chip kanban-running">● 計測中</span>' : ''}
        </div>
      </div>
    </li>`;
}

function renderKanban() {
  const tasks = applyTodoFilters(data.tasks);
  const byStatus = Object.fromEntries(TASK_STATUS_ORDER.map((status) => [
    status,
    tasks.filter((task) => task.status === status).sort(compareKanbanTasks),
  ]));

  const columns = TASK_STATUS_ORDER.map((status) => {
    const columnTasks = byStatus[status];
    const shown = status === 'done' ? columnTasks.slice(0, KANBAN_DONE_LIMIT) : columnTasks;
    return `
      <section class="kanban-column" data-status="${status}">
        <h3 class="kanban-column-header">${TASK_STATUS_LABELS[status]}<span class="kanban-count">${columnTasks.length}</span></h3>
        <ul class="kanban-cards">
          ${shown.length ? shown.map(kanbanCard).join('') : '<li class="kanban-empty">タスクなし</li>'}
        </ul>
      </section>`;
  }).join('');

  return `
    <div class="card kanban-card-shell">
      <div class="card-heading">
        <div>
          <span class="section-eyebrow">Board</span>
          <h2>カンバンボード</h2>
        </div>
        <span class="task-overview">ドラッグして並び順・ステータスを変更</span>
      </div>
      ${todoFilterRow()}
      <div class="kanban-board">${columns}</div>
      ${byStatus.done.length > KANBAN_DONE_LIMIT ? `<p class="kanban-limit-note">完了は先頭${KANBAN_DONE_LIMIT}件を表示しています（全${byStatus.done.length}件）</p>` : ''}
    </div>`;
}

/* ----- タイムラインタブ ----- */

const TIMELINE_LANE_WIDTH = 136;
const TIMELINE_LANE_PAD = 4;

// 時間が重なる項目を横方向のレーンへ振り分ける。各項目にlaneを設定し、必要なレーン数を返す
function assignLanes(items) {
  const lanes = [];
  const sorted = [...items].sort((a, b) => a.start - b.start);
  for (const item of sorted) {
    let placed = false;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i][lanes[i].length - 1].clipEnd <= item.clipStart) {
        lanes[i].push(item);
        item.lane = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      item.lane = lanes.length;
      lanes.push([item]);
    }
  }
  return lanes.length;
}

function laneLeftPx(lane) {
  return TIMELINE_LANE_PAD + lane * TIMELINE_LANE_WIDTH;
}

// 時間軸上のブロックの位置と高さ(日の範囲に対する%)。極端に短い項目も見えるよう高さに下限を設ける
function timelineBlockPosition(item, dayStart) {
  const top = ((item.clipStart - dayStart) / MS_PER_DAY) * 100;
  const height = ((item.clipEnd - item.clipStart) / MS_PER_DAY) * 100;
  return `top:${top}%;height:${Math.max(height, 0.4)}%;left:${laneLeftPx(item.lane)}px`;
}

// 指定日の予定一覧。untimedOnlyなら時刻指定のないタスクだけを出す
function renderPlannedForDay(day, { untimedOnly = false, label = '📅 この日の予定:' } = {}) {
  let tasks = data.tasks.filter((task) => task.plannedStart && task.plannedStart <= day && day <= task.plannedEnd);
  if (untimedOnly) tasks = tasks.filter((task) => !hasTimeOnDay(task, day));
  tasks = tasks.sort((a, b) =>
    TASK_STATUS_ORDER.indexOf(a.status) - TASK_STATUS_ORDER.indexOf(b.status) || b.createdAt - a.createdAt);
  if (!tasks.length) return '';
  const items = tasks.map((task) => `
    <span class="plan-task ${statusRowClass(task)}">
      <span class="chip-dot" style="background:${projectColor(task.projectId)}"></span>
      ${TASK_STATUS_ICONS[task.status] ? `${TASK_STATUS_ICONS[task.status]} ` : ''}${esc(task.title)}
    </span>`).join('');
  return `<div class="plan-day-row"><span class="plan-day-label">${label}</span>${items}</div>`;
}

// 指定した間隔(時間)おきの時刻ラベル(タイムライン・ガント1日表示で共用)
function hourLabels(stepHours = 2) {
  const count = 24 / stepHours;
  return Array.from({ length: count }, (_, i) => `<div class="tl-hour">${i * stepHours}時</div>`).join('');
}

// 指定日に重なる作業記録を、日の範囲に切り詰めた項目にする(計測中は現在時刻まで)
function timelineItemsForDay(dayStart, now) {
  const dayEnd = dayStart + MS_PER_DAY;
  return data.entries
    .map((entry) => ({ ...entry, effEnd: entryEnd(entry, now) }))
    .filter((entry) => entry.start < dayEnd && entry.effEnd > dayStart)
    .map((entry) => ({
      ...entry,
      clipStart: Math.max(entry.start, dayStart),
      clipEnd: Math.min(entry.effEnd, dayEnd),
    }));
}

// この日のプロジェクト別内訳(時間の多い順)
function timelineSummaryHtml(items) {
  if (!items.length) return '';
  const byProject = new Map();
  for (const item of items) {
    const task = taskById(item.taskId);
    const projectId = task && projectById(task.projectId) ? task.projectId : '';
    byProject.set(projectId, (byProject.get(projectId) || 0) + (item.clipEnd - item.clipStart));
  }
  return `
    <div class="tl-summary">${[...byProject.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([projectId, ms]) => `<span class="chip"><span class="chip-dot" style="background:${projectColor(projectId)}"></span>${esc(projectLabel(projectId))} <b>${fmtDur(ms)}</b></span>`)
      .join('')}</div>`;
}

// 作業記録を時間軸上のブロックにする(計測中は枠線で区別)
function timelineBlocksHtml(items, dayStart) {
  return items.map((item) => {
    const task = taskById(item.taskId);
    const color = projectColor(task ? task.projectId : null);
    const label = task ? task.title : '(削除済み)';
    const tip = `${label}\n${fmtTime(item.clipStart)} - ${item.end === null ? '計測中' : fmtTime(item.clipEnd)} (${fmtDur(item.clipEnd - item.clipStart)})`;
    return `<div class="tl-block ${item.end === null ? 'running' : ''}"
      style="${timelineBlockPosition(item, dayStart)};background:${color}"
      title="${esc(tip)}">${esc(label)}</div>`;
  }).join('');
}

// 作業記録1件の編集行(開始・終了の日時入力と削除ボタン)
function timelineEntryRowHtml(item) {
  const task = taskById(item.taskId);
  return `
      <li class="entry-item">
        <form class="edit-form timeline-entry-form" data-action-submit="save-entry" data-id="${esc(item.id)}">
          <span class="entry-task">${esc(task ? task.title : '(削除済みタスク)')} ${projectChip(task ? task.projectId : null)}</span>
          <label>開始 <input type="datetime-local" name="start" step="60" value="${toDateStr(new Date(item.start))}T${fmtTime(item.start)}" required></label>
          ${item.end === null ? '<span class="task-meta">計測中</span>' : `<label>終了 <input type="datetime-local" name="end" step="60" value="${toDateStr(new Date(item.end))}T${fmtTime(item.end)}" required></label>`}
          <span class="entry-dur">${fmtDur(item.clipEnd - item.clipStart)}</span>
          <button class="btn btn-primary" type="submit">保存</button>
          <button class="btn-icon danger" type="button" data-action="del-entry" data-id="${esc(item.id)}" title="作業記録を削除" aria-label="${esc(task ? task.title : '削除済みタスク')}の作業記録を削除">🗑</button>
        </form>
      </li>`;
}

// 作業記録を手動で追加するカード(選択中の日付に入る)
function manualEntryCardHtml() {
  const taskChoices = [...data.tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((task) => `<option value="${esc(task.id)}">${esc(task.title)}${task.status === 'done' ? '（完了）' : ''}</option>`)
    .join('');
  return `
    <div class="card">
      <h2>➕ 作業記録を手動追加</h2>
      ${data.tasks.length ? `
        <form class="add-form" data-action-submit="add-entry">
          <select name="taskId" aria-label="タスク" required>${taskChoices}</select>
          <input type="time" name="start" step="60" aria-label="開始時刻" required>
          〜
          <input type="time" name="end" step="60" aria-label="終了時刻" required>
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <p class="task-meta" style="margin-top:8px">※ 選択中の日付(${fmtDateJa(ui.timelineDate)})に追加されます。終了が開始より前の場合は翌日扱いになります。</p>
      ` : '<p class="empty">タスクがありません。先にTodoタブでタスクを作成してください。</p>'}
    </div>`;
}

function renderTimeline() {
  const now = Date.now();
  const dayStart = fromDateStr(ui.timelineDate).getTime();
  const items = timelineItemsForDay(dayStart, now);
  const totalMs = items.reduce((sum, item) => sum + (item.clipEnd - item.clipStart), 0);
  const laneCount = Math.max(1, assignLanes(items));
  const sortedItems = [...items].sort((a, b) => a.start - b.start);

  return `${manualEntryCardHtml()}
    <div class="card">
      <div class="tl-header">
        <span class="tl-date-label">${fmtDateJa(ui.timelineDate)}</span>
        <span class="tl-total">合計 ${fmtDur(totalMs)}</span>
        <button class="btn" data-action="tl-shift" data-days="-1">◀ 前日</button>
        <input type="date" value="${esc(ui.timelineDate)}" data-action-change="tl-date" aria-label="表示日">
        <button class="btn" data-action="tl-shift" data-days="1">翌日 ▶</button>
        <button class="btn" data-action="tl-today">今日</button>
      </div>
      ${timelineSummaryHtml(items)}
      ${renderPlannedForDay(ui.timelineDate)}
      <ul class="entry-list">
        ${sortedItems.length ? sortedItems.map(timelineEntryRowHtml).join('') : '<li class="empty">この日の作業記録はありません</li>'}
      </ul>
      <div class="timeline-wrap">
        <div class="timeline">
          <div class="tl-hours">${hourLabels()}</div>
          <div class="tl-lanes" style="width:${laneCount * TIMELINE_LANE_WIDTH}px">${timelineBlocksHtml(items, dayStart)}</div>
        </div>
      </div>
    </div>`;
}

/* ----- ガントチャートタブ ----- */

const GANTT_LABEL_WIDTH = 160;
const GANTT_DAY_WIDTH = 56;
const GANTT_MONTH_HEIGHT = 26;
const GANTT_HEAD_HEIGHT = 44;
const GANTT_ROW_HEIGHT = 32;

function renderGantt() {
  return `<div class="gantt-board">
    ${renderGanttWeek()}
    ${renderGanttDay()}
  </div>`;
}

// 1日表示のブロックに付ける状態クラス(未着手は付けない)
function planStatusClass(status) {
  switch (status) {
    case 'done': return ' plan-done';
    case 'waiting_review': return ' plan-waiting';
    case 'in_progress': return ' plan-in-progress';
    default: return '';
  }
}

// ツールチップに付ける期限超過・状態の行(未着手で期限内なら何も付けない)
function ganttTipStatus(task, overdue) {
  if (overdue) return '\n⚠ 期限超過';
  if (task.status === 'todo') return '';
  return `\n${TASK_STATUS_ICONS[task.status]} ${TASK_STATUS_LABELS[task.status]}`;
}

// 1日表示: 指定日に時刻付きで予定が入るタスクを、その日の範囲に切り詰めた項目にする
function ganttDayItems(day) {
  const dayStart = fromDateStr(day).getTime();
  const dayEnd = dayStart + MS_PER_DAY;
  return data.tasks
    .filter((task) => task.plannedStart && task.plannedStart <= day && day <= task.plannedEnd && hasTimeOnDay(task, day))
    .map((task) => {
      let start = dayStart;
      let end = dayEnd;
      if (task.plannedStart === day && task.plannedStartTime) start = timeToTimestamp(dayStart, task.plannedStartTime);
      if (task.plannedEnd === day && task.plannedEndTime) end = timeToTimestamp(dayStart, task.plannedEndTime);
      if (end <= start) end = dayEnd;
      return { task, start, clipStart: start, clipEnd: end };
    });
}

// 1日単位: 時刻に沿ってタスクを配置するガントチャート(タイムラインと同じ時間軸UIを再利用)
function renderGanttDay() {
  const day = ui.ganttDate;
  const dayStart = fromDateStr(day).getTime();
  const today = todayStr();
  const items = ganttDayItems(day);
  const laneCount = Math.max(1, assignLanes(items));

  const blocks = items.map((item) => {
    const task = item.task;
    const project = projectById(task.projectId);
    const startMin = Math.round((item.clipStart - dayStart) / MS_PER_MINUTE);
    const endMin = Math.round((item.clipEnd - dayStart) / MS_PER_MINUTE);
    // 予定が1日に収まるタスクだけ、時刻をドラッグで動かせる
    const draggable = task.plannedStart === day && task.plannedEnd === day;
    const overdue = isOverdue(task, today);
    const stateClasses = `${planStatusClass(task.status)}${overdue ? ' plan-overdue' : ''}${draggable ? ' gantt-day-draggable' : ''}`;
    const tip = `${task.title}${project ? ` (${project.name})` : ''}\n${fmtTime(item.clipStart)} 〜 ${fmtTime(item.clipEnd)}${ganttTipStatus(task, overdue)}`;
    const label = project ? `${esc(task.title)} <span class="tl-block-project">・${esc(project.name)}</span>` : esc(task.title);
    return `<div class="tl-block${stateClasses}"
      style="${timelineBlockPosition(item, dayStart)};background:${projectColor(task.projectId)}"
      ${draggable ? `data-action-pointer="gantt-day-drag" data-id="${esc(task.id)}" data-day="${esc(day)}" data-start-min="${startMin}" data-end-min="${endMin}"` : ''}
      title="${esc(tip)}">${label}</div>`;
  }).join('');

  return `
    <div class="card">
      <div class="tl-header">
        <span class="tl-date-label">🕐 1日</span>
        <span class="tl-total">${fmtDateJa(day)}</span>
        <button class="btn" data-action="gantt-day-shift" data-days="-1">◀ 前日</button>
        <input type="date" value="${esc(day)}" data-action-change="gantt-date" aria-label="1日表示の日付">
        <button class="btn" data-action="gantt-day-shift" data-days="1">翌日 ▶</button>
        <button class="btn" data-action="gantt-day-today">今日</button>
      </div>
      ${renderPlannedForDay(day, { untimedOnly: true, label: '📅 終日:' })}
      <div class="timeline-wrap">
        <div class="timeline">
          <div class="tl-hours">${hourLabels(1)}</div>
          <div class="tl-lanes" style="width:${laneCount * TIMELINE_LANE_WIDTH}px">${blocks}</div>
        </div>
      </div>
    </div>`;
}

// 週表示の行。表示期間と重なる予定付きタスクを、プロジェクトごとにまとめて並べる(未所属は最後)
function ganttWeekColumns(startStr, endStr) {
  const inWindow = data.tasks.filter((task) => task.plannedStart && task.plannedStart <= endStr && task.plannedEnd >= startStr);
  const byPlan = (a, b) => (a.plannedStart !== b.plannedStart
    ? (a.plannedStart < b.plannedStart ? -1 : 1)
    : a.createdAt - b.createdAt);
  const columns = [];
  const sortedProjects = [...data.projects]
    .sort((a, b) => projectLabel(a.id).localeCompare(projectLabel(b.id), 'ja'));
  for (const project of sortedProjects) {
    for (const task of inWindow.filter((item) => item.projectId === project.id).sort(byPlan)) {
      columns.push({ task, project });
    }
  }
  for (const task of inWindow.filter((item) => !projectById(item.projectId)).sort(byPlan)) {
    columns.push({ task, project: null });
  }
  return columns;
}

// 週表示の月見出し(最上段)。同じ月が続く日付を1つのセルにまとめる
function ganttWeekMonthHeadings(start, days) {
  const runs = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const last = runs[runs.length - 1];
    if (last && last.year === date.getFullYear() && last.month === date.getMonth()) {
      last.end = i + 3;
    } else {
      runs.push({ year: date.getFullYear(), month: date.getMonth(), begin: i + 2, end: i + 3 });
    }
  }
  return runs.map((run, index) => {
    const yearPrefix = index === 0 || run.month === 0 ? `${run.year}年` : '';
    return `<div class="gantt-month-v" style="grid-column:${run.begin} / ${run.end};grid-row:1"><span>${esc(`${yearPrefix}${run.month + 1}月`)}</span></div>`;
  }).join('');
}

// 週表示の日付見出し(上段)と背景の縦ストライプ(日付ごとの列)
function ganttWeekDayHeadings(start, days, today) {
  let dayHeads = '';
  let backgroundCols = '';
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const weekday = date.getDay();
    const dayClasses = `${weekday === 0 || weekday === 6 ? ' weekend' : ''}${toDateStr(date) === today ? ' today' : ''}`;
    const label = (i === 0 || date.getDate() === 1) ? `${date.getMonth() + 1}/${date.getDate()}` : date.getDate();
    dayHeads += `<div class="gantt-day-v${dayClasses}" style="grid-column:${i + 2};top:${GANTT_MONTH_HEIGHT}px"><span>${label}</span><span class="wd">${WEEKDAY_LABELS[weekday]}</span></div>`;
    backgroundCols += `<div class="gantt-grid-row${dayClasses}" style="grid-column:${i + 2}"></div>`;
  }
  return { dayHeads, backgroundCols };
}

// ガントの行ラベル用の計測ボタン。インライン編集フォームは行の高さに収まらないため出さない(開始時刻の編集はTodoタブで行う)
function ganttTimerControl(task, running, now) {
  if (task.status === 'done') return '';
  return running ? timerStopButton(running, now) : timerStartButton(task);
}

// 週表示のタスク行(左端の見出し + 日付軸上の横棒)
function ganttWeekRowsHtml(columns, { start, startStr, endStr, days, today }) {
  const dayIndex = (dateStr) => Math.round((fromDateStr(dateStr) - start) / MS_PER_DAY);
  const now = Date.now();
  let rowLabels = '';
  let bars = '';
  columns.forEach((column, index) => {
    const task = column.task;
    const row = index + 3;
    const running = runningEntryForTask(task.id);
    const startIdx = Math.max(dayIndex(task.plannedStart), 0);
    const endIdx = Math.min(dayIndex(task.plannedEnd), days - 1);
    const overdue = isOverdue(task, today);
    const statusClass = statusRowClass(task);
    const statusSuffix = statusClass ? ' ' + statusClass : '';
    const barClasses = `${statusSuffix}${overdue ? ' overdue' : ''}` +
      `${task.plannedStart < startStr ? ' clip-left' : ''}${task.plannedEnd > endStr ? ' clip-right' : ''}`;
    const totalDays = dayIndex(task.plannedEnd) - dayIndex(task.plannedStart) + 1;
    const tip = `${task.title}${column.project ? ` (${column.project.name})` : ''}\n${planLabel(task)} (${totalDays}日間)${ganttTipStatus(task, overdue)}`;
    rowLabels += `
      <div class="gantt-col-label${statusSuffix}" style="grid-row:${row};line-height:${GANTT_ROW_HEIGHT}px" title="${esc(tip)}">
        <span class="gantt-col-name">
          <span class="chip-dot" style="background:${projectColor(task.projectId)}"></span>
          ${overdue ? '<span class="overdue-mark">⚠</span> ' : ''}${esc(task.title)}
          ${column.project ? `<span class="gantt-col-project">・${esc(column.project.name)}</span>` : ''}
        </span>
        ${ganttTimerControl(task, running, now)}
      </div>`;
    bars += `<div class="gantt-bar-v${barClasses}" style="grid-column:${startIdx + 2} / ${endIdx + 3};grid-row:${row};background:${projectColor(task.projectId)}"
        data-action-pointer="gantt-drag" data-id="${esc(task.id)}" data-day-width="${GANTT_DAY_WIDTH}"
        title="${esc(tip)}"></div>`;
  });
  return { rowLabels, bars };
}

// 週(複数日)単位: プロジェクトごとにまとめたタスクを日付軸に沿って表示するガントチャート
function renderGanttWeek() {
  const days = ui.ganttDays;
  const rangeLabel = { 7: '1週間', 14: '2週間', 28: '4週間', 56: '8週間' }[days] || `${days}日間`;
  const start = fromDateStr(ui.ganttStart);
  const startStr = ui.ganttStart;
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + days - 1);
  const endStr = toDateStr(endDate);
  const today = todayStr();
  const columns = ganttWeekColumns(startStr, endStr);
  const monthHeads = ganttWeekMonthHeadings(start, days);
  const { dayHeads, backgroundCols } = ganttWeekDayHeadings(start, days, today);
  const { rowLabels, bars } = ganttWeekRowsHtml(columns, { start, startStr, endStr, days, today });

  return `
    <div class="card">
      <div class="tl-header">
        <span class="tl-date-label">📅 ${rangeLabel}</span>
        <span class="tl-total">${fmtDateJa(startStr)} 〜 ${fmtDateJa(endStr)}</span>
        <select data-action-change="gantt-days" aria-label="ガントの表示期間">
          <option value="7"${days === 7 ? ' selected' : ''}>1週間</option>
          <option value="14"${days === 14 ? ' selected' : ''}>2週間</option>
          <option value="28"${days === 28 ? ' selected' : ''}>4週間</option>
          <option value="56"${days === 56 ? ' selected' : ''}>8週間</option>
        </select>
        <button class="btn" data-action="gantt-shift" data-days="-7">◀ 前週</button>
        <button class="btn" data-action="gantt-today">今日</button>
        <button class="btn" data-action="gantt-shift" data-days="7">翌週 ▶</button>
      </div>
      ${columns.length ? `
        <div class="gantt-wrap">
          <div class="gantt-v" style="grid-template-columns:${GANTT_LABEL_WIDTH}px repeat(${days}, ${GANTT_DAY_WIDTH}px);grid-template-rows:${GANTT_MONTH_HEIGHT}px ${GANTT_HEAD_HEIGHT}px repeat(${columns.length}, ${GANTT_ROW_HEIGHT}px)">
            ${backgroundCols}
            <div class="gantt-corner-top"></div>
            ${monthHeads}
            <div class="gantt-corner" style="top:${GANTT_MONTH_HEIGHT}px">タスク</div>
            ${dayHeads}
            ${rowLabels}
            ${bars}
          </div>
        </div>` : '<p class="empty">この期間に予定日程が設定されたタスクはありません。Todoタブでタスクに予定を設定してください。</p>'}
    </div>`;
}

/* ----- エクスポート(CSV・バックアップ) ----- */

function csvEscape(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// 先頭のBOMはExcelでの文字化け対策
function toCsv(rows) {
  return '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// 集計タブの階層集計をフラットなCSVにして保存する
function exportReportCsv() {
  const tree = buildReportTree(ui.reportFrom, ui.reportTo);
  const rows = [['クライアント', 'プロジェクト', 'タスク', '時間(分)', '時間(h)']];
  const sortedClients = [...tree.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [clientId, clientNode] of sortedClients) {
    const client = clientById(clientId);
    const sortedProjects = [...clientNode.projects.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [projectId, projectNode] of sortedProjects) {
      const project = projectById(projectId);
      for (const task of [...projectNode.tasks].sort((a, b) => b.ms - a.ms)) {
        rows.push([
          client ? client.name : 'クライアントなし',
          project ? project.name : 'プロジェクトなし',
          task.title,
          Math.round(task.ms / MS_PER_MINUTE),
          (task.ms / MS_PER_HOUR).toFixed(2),
        ]);
      }
    }
  }
  downloadFile(`enchanter-report_${ui.reportFrom}_${ui.reportTo}.csv`, toCsv(rows), 'text/csv');
}

// 期間内の作業記録の明細CSV(期間でクリップするので集計と合計が一致する)
function exportEntriesCsv() {
  const now = Date.now();
  const { start: rangeStart, end: rangeEnd } = reportRangeMs(ui.reportFrom, ui.reportTo);
  const rows = [['日付', '開始', '終了', '時間(分)', 'タスク', 'プロジェクト', 'クライアント']];
  for (const entry of [...data.entries].sort((a, b) => a.start - b.start)) {
    const clipStart = Math.max(entry.start, rangeStart);
    const clipEnd = Math.min(entryEnd(entry, now), rangeEnd);
    if (clipEnd <= clipStart) continue;
    const task = taskById(entry.taskId);
    const project = task ? projectById(task.projectId) : null;
    const client = project ? clientById(project.clientId) : null;
    rows.push([
      toDateStr(new Date(clipStart)),
      fmtTime(clipStart),
      entry.end === null ? '計測中' : fmtTime(clipEnd),
      Math.round((clipEnd - clipStart) / MS_PER_MINUTE),
      task ? task.title : '(削除済みタスク)',
      project ? project.name : '',
      client ? client.name : '',
    ]);
  }
  downloadFile(`enchanter-entries_${ui.reportFrom}_${ui.reportTo}.csv`, toCsv(rows), 'text/csv');
}

// バックアップJSONを読み込み、確認のうえ全データを置き換える
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid shape');
      for (const key of ['clients', 'categories', 'projects', 'tasks', 'entries', 'filters']) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error('invalid shape');
      }
      const next = normalizeData(parsed);
      const message = '現在のデータをインポート内容で【全て置き換え】ます。\n'
        + `現在: タスク ${data.tasks.length} 件・作業記録 ${data.entries.length} 件\n`
        + `インポート: タスク ${next.tasks.length} 件・作業記録 ${next.entries.length} 件\n`
        + 'よろしいですか?';
      if (!confirm(message)) return;
      data = next;
      deletionHistory.length = 0;
      save();
      renderAll();
    } catch (error) {
      console.error('バックアップの読み込みに失敗しました', error);
      alert('バックアップファイルを読み込めませんでした。エクスポートしたJSONファイルか確認してください。');
    }
  };
  reader.readAsText(file);
}

/* ----- 集計タブ ----- */

// 期間内の作業時間を client → project → task の階層に集計する
function buildReportTree(fromStr, toStr) {
  const now = Date.now();
  const { start: rangeStart, end: rangeEnd } = reportRangeMs(fromStr, toStr);

  // taskId → 合計ms
  const byTask = new Map();
  for (const entry of data.entries) {
    const overlap = overlapMs(entry, rangeStart, rangeEnd, now);
    if (overlap <= 0) continue;
    byTask.set(entry.taskId, (byTask.get(entry.taskId) || 0) + overlap);
  }

  const tree = new Map();
  for (const [taskId, ms] of byTask) {
    const task = taskById(taskId);
    const project = task ? projectById(task.projectId) : null;
    const clientId = project ? (project.clientId || '') : '';
    const projectId = project ? project.id : '';
    if (!tree.has(clientId)) tree.set(clientId, { total: 0, projects: new Map() });
    const clientNode = tree.get(clientId);
    clientNode.total += ms;
    if (!clientNode.projects.has(projectId)) clientNode.projects.set(projectId, { total: 0, tasks: [] });
    const projectNode = clientNode.projects.get(projectId);
    projectNode.total += ms;
    projectNode.tasks.push({ title: task ? task.title : '(削除済みタスク)', ms });
  }
  return tree;
}

// 期間内の作業時間を、タスクごとのキー(カテゴリ/タグなど)で集計する。
// keysOf(task)が返す各キーに同じ時間を計上するため、複数キーを持つタスクの時間は重複する
function sumByKeys(fromStr, toStr, keysOf) {
  const now = Date.now();
  const { start: rangeStart, end: rangeEnd } = reportRangeMs(fromStr, toStr);

  // key → { ms, taskIds }
  const byKey = new Map();
  for (const entry of data.entries) {
    const overlap = overlapMs(entry, rangeStart, rangeEnd, now);
    if (overlap <= 0) continue;
    const task = taskById(entry.taskId);
    for (const key of keysOf(task)) {
      if (!byKey.has(key)) byKey.set(key, { ms: 0, taskIds: new Set() });
      const node = byKey.get(key);
      node.ms += overlap;
      node.taskIds.add(entry.taskId);
    }
  }
  return byKey;
}

// 日別(範囲が62日を超えたら週別)の作業時間バケットを作る
function trendBuckets(fromStr, toStr) {
  const now = Date.now();
  const rangeStart = fromDateStr(fromStr);
  const totalDays = Math.round((fromDateStr(toStr) - rangeStart) / MS_PER_DAY) + 1;
  const bucketDays = totalDays > 62 ? 7 : 1;
  const buckets = [];
  for (let i = 0; i < totalDays; i += bucketDays) {
    const bucketStart = new Date(rangeStart);
    bucketStart.setDate(bucketStart.getDate() + i);
    const bucketEnd = new Date(bucketStart);
    bucketEnd.setDate(bucketEnd.getDate() + Math.min(bucketDays, totalDays - i));
    buckets.push({ day: toDateStr(bucketStart), start: bucketStart.getTime(), end: bucketEnd.getTime(), ms: 0 });
  }
  for (const entry of data.entries) {
    for (const bucket of buckets) {
      const overlap = overlapMs(entry, bucket.start, bucket.end, now);
      if (overlap > 0) bucket.ms += overlap;
    }
  }
  return { buckets, bucketDays };
}

// 日別/週別の推移バーチャート
function renderTrendChart(fromStr, toStr) {
  const { buckets, bucketDays } = trendBuckets(fromStr, toStr);
  if (!buckets.length) return '';
  const maxMs = Math.max(1, ...buckets.map((bucket) => bucket.ms));
  const labelStep = Math.max(1, Math.ceil(buckets.length / 10));
  const cols = buckets.map((bucket, i) => {
    const pct = bucket.ms > 0 ? Math.max((bucket.ms / maxMs) * 100, 3) : 0;
    const rangeEndStr = toDateStr(new Date(bucket.end - MS_PER_DAY));
    const tip = bucketDays === 1
      ? `${fmtDateJa(bucket.day)}\n${fmtDur(bucket.ms)}`
      : `${fmtShortDate(bucket.day)} 〜 ${fmtShortDate(rangeEndStr)}\n${fmtDur(bucket.ms)}`;
    const showLabel = i % labelStep === 0 || i === buckets.length - 1;
    return `<div class="chart-col" title="${esc(tip)}">
      <div class="chart-col-track"><div class="chart-col-bar" style="height:${pct}%"></div></div>
      <div class="chart-col-label">${showLabel ? esc(fmtShortDate(bucket.day)) : ''}</div>
    </div>`;
  }).join('');
  return `
    <div class="chart-block">
      <h3 class="chart-title">📈 ${bucketDays === 1 ? '日別' : '週別'}の推移</h3>
      <div class="chart-trend-wrap"><div class="chart-trend" style="min-width:${Math.max(buckets.length * 22, 100)}px">${cols}</div></div>
    </div>`;
}

// 内訳バーの行。割合は全体(grandTotal)に対するもの、バーの長さは行どうしの最大値に対するもの
function breakdownBarsHtml(rows, grandTotal) {
  const maxMs = Math.max(1, ...rows.map((row) => row.ms));
  return rows.map((row) => {
    const widthPct = Math.max((row.ms / maxMs) * 100, 2);
    return `<div class="chart-bar-row">
      <span class="chart-bar-label" title="${esc(row.label)}">${esc(row.label)}</span>
      <span class="chart-bar-track"><span class="chart-bar-fill" style="width:${widthPct}%;background:${row.color}"></span></span>
      <span class="chart-bar-value">${fmtDur(row.ms)}<small>(${percentOf(row.ms, grandTotal)}%${row.detail})</small></span>
    </div>`;
  }).join('');
}

function breakdownChartBlock(title, barsHtml, noteHtml = '') {
  return `
    <div class="chart-block">
      <h3 class="chart-title">${title}</h3>
      <div class="chart-bars">${barsHtml}</div>${noteHtml}
    </div>`;
}

// プロジェクト別内訳(上位8件 + その他)
function renderProjectBreakdownChart(tree, grandTotal) {
  const list = [];
  for (const [, clientNode] of tree) {
    for (const [projectId, projectNode] of clientNode.projects) list.push({ projectId, ms: projectNode.total });
  }
  list.sort((a, b) => b.ms - a.ms);
  if (!list.length) return '';
  const TOP_N = 8;
  const rows = list.slice(0, TOP_N).map((item) => ({
    label: projectLabel(item.projectId),
    color: projectColor(item.projectId),
    ms: item.ms,
    detail: '',
  }));
  const restMs = list.slice(TOP_N).reduce((sum, item) => sum + item.ms, 0);
  if (restMs > 0) rows.push({ label: 'その他', color: 'var(--text-sub)', ms: restMs, detail: '' });
  return breakdownChartBlock('📁 プロジェクト別の内訳', breakdownBarsHtml(rows, grandTotal));
}

// カテゴリ別内訳。タスクのカテゴリはひとつなので重複計上はない。カテゴリの無い時間は「カテゴリなし」
function renderCategoryBreakdownChart(fromStr, toStr, grandTotal) {
  const byCategory = sumByKeys(fromStr, toStr, (task) => [
    task && categoryById(task.categoryId) ? task.categoryId : '',
  ]);
  // カテゴリ付きの時間がひとつも無ければチャート自体を出さない
  if (![...byCategory.keys()].some((categoryId) => categoryId !== '')) return '';
  const rows = [...byCategory.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([categoryId, node]) => {
      const category = categoryById(categoryId);
      return {
        label: category ? `📂 ${category.name}` : 'カテゴリなし',
        color: category ? 'var(--review)' : 'var(--text-sub)',
        ms: node.ms,
        detail: `・${node.taskIds.size}タスク`,
      };
    });
  return breakdownChartBlock('📂 カテゴリ別の内訳', breakdownBarsHtml(rows, grandTotal));
}

// タグ別内訳。複数タグを持つタスクの時間は各タグに重複計上されるため、割合の合計は100%を超えることがある。
// タグの付いていない時間は「タグなし」に計上する
function renderTagBreakdownChart(fromStr, toStr, grandTotal) {
  const byTag = sumByKeys(fromStr, toStr, (task) => (task && task.tags && task.tags.length ? task.tags : ['']));
  // タグ付きの時間がひとつも無ければチャート自体を出さない
  if (![...byTag.keys()].some((tag) => tag !== '')) return '';
  const rows = [...byTag.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([tag, node]) => ({
      label: tag ? `🏷 ${tag}` : 'タグなし',
      color: tag ? 'var(--accent)' : 'var(--text-sub)',
      ms: node.ms,
      detail: `・${node.taskIds.size}タスク`,
    }));
  return breakdownChartBlock(
    '🏷 タグ別の内訳',
    breakdownBarsHtml(rows, grandTotal),
    '\n      <p class="chart-note">※ 複数のタグが付いたタスクの時間は各タグに重複して計上されます</p>',
  );
}

// 期間ボタン(今日・昨日など)の開始日・終了日(YYYY-MM-DD)。不明な範囲ならnull
function quickRangeDates(range) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let from = new Date(today);
  let to = new Date(today);
  switch (range) {
    case 'today':
      break;
    case 'yesterday':
      from.setDate(from.getDate() - 1);
      to = new Date(from);
      break;
    case 'week':
      from = startOfWeek(today);
      break;
    case 'lastweek':
      from = startOfWeek(today);
      from.setDate(from.getDate() - 7);
      to = new Date(from);
      to.setDate(to.getDate() + 6);
      break;
    case 'month':
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      break;
    case 'lastmonth':
      from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      to = new Date(today.getFullYear(), today.getMonth(), 0);
      break;
    default:
      return null;
  }
  return { from: toDateStr(from), to: toDateStr(to) };
}

function quickRangeButtonsHtml() {
  return [
    ['today', '今日'],
    ['yesterday', '昨日'],
    ['week', '今週'],
    ['lastweek', '先週'],
    ['month', '今月'],
    ['lastmonth', '先月'],
  ].map(([range, label]) => {
    const dates = quickRangeDates(range);
    const active = dates.from === ui.reportFrom && dates.to === ui.reportTo;
    return `<button class="btn${active ? ' active' : ''}" data-action="quick-range" data-range="${range}" aria-pressed="${active}">${label}</button>`;
  }).join('');
}

// 集計テーブルの行(クライアント → プロジェクト → タスク)
function reportTableRows(tree, grandTotal) {
  const rows = [];
  const sortedClients = [...tree.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [clientId, clientNode] of sortedClients) {
    const client = clientById(clientId);
    rows.push(`<tr class="row-client">
      <td>${esc(client ? client.name : 'クライアントなし')}</td>
      <td class="num">${fmtDur(clientNode.total)}</td>
      <td class="num">${percentOf(clientNode.total, grandTotal)}%</td>
    </tr>`);
    const sortedProjects = [...clientNode.projects.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [projectId, projectNode] of sortedProjects) {
      const project = projectById(projectId);
      const dot = project ? `<span class="chip-dot" style="background:${esc(project.color)};display:inline-block;margin-right:6px"></span>` : '';
      rows.push(`<tr class="row-project">
        <td>${dot}${esc(project ? project.name : 'プロジェクトなし')}</td>
        <td class="num">${fmtDur(projectNode.total)}</td>
        <td class="num">${percentOf(projectNode.total, grandTotal)}%</td>
      </tr>`);
      for (const task of [...projectNode.tasks].sort((a, b) => b.ms - a.ms)) {
        rows.push(`<tr class="row-task">
          <td>${esc(task.title)}</td>
          <td class="num">${fmtDur(task.ms)}</td>
          <td class="num"></td>
        </tr>`);
      }
    }
  }
  return rows;
}

// 見積を設定したタスクを、プロジェクト別に「見積」と「実績」で比べる(全期間の累計)
function estimateRowsHtml() {
  const now = Date.now();
  const actualByTask = new Map();
  for (const entry of data.entries) {
    actualByTask.set(entry.taskId, (actualByTask.get(entry.taskId) || 0) + entryDur(entry, now));
  }
  const estimates = new Map();
  for (const task of data.tasks) {
    if (!task.estimateMinutes) continue;
    const projectId = projectById(task.projectId) ? task.projectId : '';
    if (!estimates.has(projectId)) estimates.set(projectId, { estimate: 0, actual: 0, count: 0 });
    const row = estimates.get(projectId);
    row.estimate += task.estimateMinutes * MS_PER_MINUTE;
    row.actual += actualByTask.get(task.id) || 0;
    row.count++;
  }
  return [...estimates].map(([projectId, row]) => {
    const diff = row.actual - row.estimate;
    return `<tr>
    <td>${esc(projectLabel(projectId))}（${row.count}件）</td>
    <td class="num">${fmtDur(row.estimate)}</td>
    <td class="num">${fmtDur(row.actual)}</td>
    <td class="num">${diff > 0 ? '+' : diff < 0 ? '−' : ''}${fmtDur(Math.abs(diff))}</td>
  </tr>`;
  }).join('');
}

function renderReport() {
  const tree = buildReportTree(ui.reportFrom, ui.reportTo);
  const grandTotal = [...tree.values()].reduce((sum, clientNode) => sum + clientNode.total, 0);
  const tableRows = reportTableRows(tree, grandTotal);
  const hours = (grandTotal / MS_PER_HOUR).toFixed(2);
  const estimateRows = estimateRowsHtml();

  return `
    <div class="card">
      <h2>📊 作業時間の集計</h2>
      <div class="report-controls">
        <input type="date" value="${esc(ui.reportFrom)}" data-action-change="agg-from" aria-label="集計開始日">
        〜
        <input type="date" value="${esc(ui.reportTo)}" data-action-change="agg-to" aria-label="集計終了日">
      </div>
      <div class="quick-ranges">
        ${quickRangeButtonsHtml()}
        <span class="export-btns">
          <button class="btn" data-action="export-report-csv" title="集計結果をCSVでダウンロード">⬇ 集計CSV</button>
          <button class="btn" data-action="export-entries-csv" title="作業記録の明細をCSVでダウンロード">⬇ 明細CSV</button>
        </span>
      </div>
      <div class="report-total">${fmtDur(grandTotal)}<small>(${hours}h) ${fmtDateJa(ui.reportFrom)} 〜 ${fmtDateJa(ui.reportTo)}</small></div>
      ${tableRows.length ? `
        ${renderTrendChart(ui.reportFrom, ui.reportTo)}
        ${renderProjectBreakdownChart(tree, grandTotal)}
        ${renderCategoryBreakdownChart(ui.reportFrom, ui.reportTo, grandTotal)}
        ${renderTagBreakdownChart(ui.reportFrom, ui.reportTo, grandTotal)}
        <div class="report-table-wrap">
          <table class="report-table">
            <thead><tr><th>クライアント / プロジェクト / タスク</th><th class="num">時間</th><th class="num">割合</th></tr></thead>
            <tbody>${tableRows.join('')}</tbody>
          </table>
        </div>` : '<p class="empty">この期間の作業記録はありません</p>'}
    </div>
    <div class="card">
      <h2>プロジェクト別 見積と実績</h2>
      <p class="task-meta">見積を設定したタスクのみ、全期間の累計で比較します（上の日付範囲とは独立）。未完了・繰り返しタスクも含むため、差は最終的な見積誤差とは限りません。</p>
      ${estimateRows ? `<div class="report-table-wrap"><table class="report-table">
        <thead><tr><th>プロジェクト</th><th>見積</th><th>実績</th><th>実績 − 見積</th></tr></thead>
        <tbody>${estimateRows}</tbody></table></div>` : '<p class="empty">見積時間を設定したタスクがありません</p>'}
    </div>`;
}

/* ----- 管理タブ ----- */

// クライアント・カテゴリの名前編集フォーム(名前だけを編集する)
function renameItemForm(submitAction, id, name) {
  return `
    <li class="manage-item">
      <form class="edit-form" data-action-submit="${submitAction}" data-id="${esc(id)}">
        <input type="text" name="name" value="${esc(name)}" required>
        <button class="btn btn-primary" type="submit">保存</button>
        <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
      </form>
    </li>`;
}

// 一覧行の編集・削除ボタン。keyは data-action の接尾辞(client など)、kindは表示名(クライアント など)
function manageItemButtons(kind, key, id, name) {
  return `
    <button class="btn-icon" data-action="edit-${key}" data-id="${esc(id)}" title="${kind}を編集" aria-label="${esc(name)}を編集">✎</button>
    <button class="btn-icon danger" data-action="del-${key}" data-id="${esc(id)}" title="${kind}を削除" aria-label="${esc(name)}を削除">🗑</button>`;
}

function manageClientItem(client) {
  if (ui.editingClient === client.id) return renameItemForm('save-client', client.id, client.name);
  const projectCount = data.projects.filter((project) => project.clientId === client.id).length;
  return `
    <li class="manage-item">
      <span class="name">${esc(client.name)}</span>
      <span class="sub">${projectCount} プロジェクト</span>
      ${manageItemButtons('クライアント', 'client', client.id, client.name)}
    </li>`;
}

function manageCategoryItem(category) {
  if (ui.editingCategory === category.id) return renameItemForm('save-category', category.id, category.name);
  const taskCount = data.tasks.filter((task) => task.categoryId === category.id).length;
  return `
    <li class="manage-item">
      <span class="name">${esc(category.name)}</span>
      <span class="sub">${taskCount} タスク</span>
      ${manageItemButtons('カテゴリ', 'category', category.id, category.name)}
    </li>`;
}

function manageProjectItem(project) {
  if (ui.editingProject === project.id) {
    return `
      <li class="manage-item">
        <form class="edit-form" data-action-submit="save-project" data-id="${esc(project.id)}">
          <input type="text" name="name" value="${esc(project.name)}" required>
          <input type="text" name="customId" value="${esc(project.customId || '')}" placeholder="ID(任意)">
          <select name="clientId">${clientOptionsInRegistrationOrder(project.clientId)}</select>
          <input type="color" name="color" value="${esc(project.color)}" title="カラー">
          <button class="btn btn-primary" type="submit">保存</button>
          <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
        </form>
      </li>`;
  }
  const client = clientById(project.clientId);
  const taskCount = data.tasks.filter((task) => task.projectId === project.id).length;
  return `
    <li class="manage-item">
      <span class="chip-dot" style="background:${esc(project.color)}"></span>
      <span class="name">${esc(project.name)}</span>
      ${project.customId ? `<span class="chip">${esc(project.customId)}</span>` : ''}
      <span class="sub">${client ? esc(client.name) : 'クライアントなし'} ・ ${taskCount} タスク</span>
      ${manageItemButtons('プロジェクト', 'project', project.id, project.name)}
    </li>`;
}

function manageGoogleCard() {
  const status = ui.googleStatus;
  let statusHtml;
  let actionHtml;
  if (!status.configured) {
    statusHtml = '<span class="sub">data/google-credentials.json が未設定です</span>';
    actionHtml = '';
  } else if (!status.connected) {
    statusHtml = '<span class="sub">未連携</span>';
    actionHtml = '<button class="btn btn-primary" data-action="google-connect">連携する</button>';
  } else {
    statusHtml = '<span class="sub">連携済み</span>';
    actionHtml = '<button class="btn" data-action="google-disconnect">連携を解除</button>';
  }
  return `
    <div class="card">
      <h2>🗓️ Googleカレンダー連携</h2>
      <p>${statusHtml}</p>
      ${actionHtml}
    </div>`;
}

function manageBackupCard() {
  return `
    <div class="card">
      <h2>💾 バックアップ</h2>
      <p class="backup-note">全データ(クライアント・プロジェクト・カテゴリ・タスク・作業記録)をJSONで書き出し/読み込みできます。インポートは現在のデータを全て置き換えます。</p>
      <p class="backup-note">自動バックアップ：各日の最初の保存前データをサーバーのデータフォルダー内の backups/enchanter-日付.json に保持します。復元はそのファイルをインポートしてください。自動削除はしません。</p>
      <div class="backup-actions">
        <button class="btn" data-action="export-backup">⬇ エクスポート</button>
        <label class="btn file-btn" role="button" tabindex="0">⬆ インポート<input type="file" accept=".json,application/json" data-action-change="import-backup" hidden></label>
      </div>
    </div>`;
}

function manageShortcutCard() {
  return `
    <div class="card">
      <h2>⌨️ キーボードショートカット</h2>
      <ul class="shortcut-list">
        <li><kbd>1</kbd>〜<kbd>6</kbd> タブ切替(Todo / カンバン / タイムライン / ガント / 集計 / 管理)</li>
        <li><kbd>N</kbd> 新しいタスクを追加(Todoタブのタスク名入力へ)</li>
        <li><kbd>Esc</kbd> 編集をキャンセル</li>
      </ul>
    </div>`;
}

function renderManage() {
  return `
    <div class="manage-grid">
      <div class="card">
        <h2>👤 クライアント</h2>
        <form class="add-form" data-action-submit="add-client" style="margin-bottom:12px">
          <input type="text" name="name" placeholder="クライアント名..." required autocomplete="off">
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <ul class="manage-list">
          ${data.clients.length ? data.clients.map(manageClientItem).join('') : '<li class="empty">クライアントがありません</li>'}
        </ul>
      </div>
      <div class="card">
        <h2>📁 プロジェクト</h2>
        <form class="add-form" data-action-submit="add-project" style="margin-bottom:12px">
          <input type="text" name="name" placeholder="プロジェクト名..." required autocomplete="off">
          <input type="text" name="customId" placeholder="ID(任意)" autocomplete="off">
          <select name="clientId">${clientOptionsInRegistrationOrder('')}</select>
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <ul class="manage-list">
          ${data.projects.length ? data.projects.map(manageProjectItem).join('') : '<li class="empty">プロジェクトがありません</li>'}
        </ul>
      </div>
      <div class="card">
        <h2>📂 カテゴリ</h2>
        <form class="add-form" data-action-submit="add-category" style="margin-bottom:12px">
          <input type="text" name="name" placeholder="カテゴリ名..." required autocomplete="off">
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <ul class="manage-list">
          ${data.categories.length ? data.categories.map(manageCategoryItem).join('') : '<li class="empty">カテゴリがありません</li>'}
        </ul>
      </div>
      ${manageGoogleCard()}
      ${manageBackupCard()}
      ${manageShortcutCard()}
    </div>`;
}

/* ---------- events ---------- */

// カンバンのドラッグ中に付けた挿入位置の目印(直前・直後のカード)を外す
function clearInsertMarkers() {
  document.querySelectorAll('.kanban-insert-before, .kanban-insert-after').forEach((card) => {
    card.classList.remove('kanban-insert-before', 'kanban-insert-after');
  });
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  const action = element.dataset.action;
  const id = element.dataset.id;

  switch (action) {
    case 'undo-delete':
      undoDeletion();
      break;
    case 'toggle-today': {
      const task = taskById(id);
      if (!task) return;
      const today = todayStr();
      task.todayDate = task.todayDate === today ? null : today;
      save();
      break;
    }
    case 'tab':
      ui.tab = element.dataset.tab;
      clearEditing();
      break;
    case 'clear-todo-filters':
      ui.todoSearch = '';
      ui.todoFilterClient = '';
      ui.todoFilterProject = '';
      ui.todoFilterCategory = '';
      ui.todoFilterImportance = '';
      ui.todoFilterWeight = '';
      ui.todoFilterMonth = '';
      ui.todoFilterTag = '';
      ui.activeFilterId = null;
      break;
    case 'start-timer':
      startTimer(id);
      return;
    case 'stop-timer':
      stopTimer(id);
      break;
    case 'stop-all-timers':
      stopAllTimers();
      break;
    case 'edit-task':
      clearEditing();
      ui.editingTask = id;
      renderAll();
      document.querySelector('[data-action-submit="save-task"] input[name="title"]')?.focus();
      return;
    case 'cycle-status': {
      const task = taskById(id);
      if (!task) return;
      setTaskStatus(task, nextTaskStatus(task.status));
      save();
      break;
    }
    case 'del-task':
      deleteTask(id);
      return;
    case 'delete-filter': {
      if (!confirm('この保存済みフィルターを削除します。よろしいですか?')) return;
      data.filters = data.filters.filter((filter) => filter.id !== id);
      if (ui.activeFilterId === id) ui.activeFilterId = null;
      save();
      break;
    }
    case 'del-subtask':
      deleteSubtask(id, element.dataset.subtaskId);
      return;
    case 'edit-entry':
      clearEditing();
      ui.editingEntry = id;
      break;
    case 'del-entry':
      if (!confirm('この作業記録を削除します。よろしいですか?')) return;
      rememberDeletion([], data.entries.filter((entry) => entry.id === id));
      data.entries = data.entries.filter((entry) => entry.id !== id);
      save();
      break;
    case 'edit-client':
      clearEditing();
      ui.editingClient = id;
      break;
    case 'del-client':
      deleteClient(id);
      return;
    case 'edit-project':
      clearEditing();
      ui.editingProject = id;
      break;
    case 'del-project':
      deleteProject(id);
      return;
    case 'edit-category':
      clearEditing();
      ui.editingCategory = id;
      break;
    case 'del-category':
      deleteCategory(id);
      return;
    case 'cancel-edit':
      clearEditing();
      break;
    case 'google-connect':
      connectGoogle();
      return;
    case 'google-disconnect':
      disconnectGoogle();
      return;
    case 'export-report-csv':
      exportReportCsv();
      return;
    case 'export-entries-csv':
      exportEntriesCsv();
      return;
    case 'export-backup':
      downloadFile(`enchanter-backup-${todayStr()}.json`, JSON.stringify(data, null, 2), 'application/json');
      return;
    case 'tl-shift':
      ui.timelineDate = addDays(ui.timelineDate, Number(element.dataset.days));
      break;
    case 'tl-today':
      ui.timelineDate = todayStr();
      break;
    case 'gantt-shift':
      ui.ganttStart = addDays(ui.ganttStart, Number(element.dataset.days));
      break;
    case 'gantt-today':
      ui.ganttStart = toDateStr(startOfWeek(new Date()));
      break;
    case 'gantt-day-shift':
      ui.ganttDate = addDays(ui.ganttDate, Number(element.dataset.days));
      break;
    case 'gantt-day-today':
      ui.ganttDate = todayStr();
      break;
    case 'quick-range': {
      const dates = quickRangeDates(element.dataset.range);
      if (!dates) return;
      ui.reportFrom = dates.from;
      ui.reportTo = dates.to;
      break;
    }
    default:
      return;
  }
  renderAll();
});

document.addEventListener('change', (event) => {
  const element = event.target.closest('[data-action-change]');
  if (!element) return;
  switch (element.dataset.actionChange) {
    case 'todo-search':
      ui.todoSearch = element.value;
      renderAll();
      return;
    case 'toggle-subtask': {
      const task = taskById(element.dataset.id);
      if (!task) return;
      const subtask = (task.subtasks || []).find((item) => item.id === element.dataset.subtaskId);
      if (!subtask) return;
      subtask.done = element.checked;
      save();
      break;
    }
    case 'todo-client-filter': {
      ui.todoFilterClient = element.value;
      ui.activeFilterId = null;
      const project = projectById(ui.todoFilterProject);
      if (project && ui.todoFilterClient && project.clientId !== ui.todoFilterClient) {
        ui.todoFilterProject = '';
      }
      break;
    }
    case 'todo-filter':
      ui.todoFilterProject = element.value;
      ui.activeFilterId = null;
      if (ui.todoFilterProject) {
        const project = projectById(ui.todoFilterProject);
        ui.todoFilterClient = project ? (project.clientId || '') : ui.todoFilterClient;
      }
      break;
    case 'todo-importance-filter':
      ui.todoFilterImportance = element.value;
      ui.activeFilterId = null;
      break;
    case 'todo-weight-filter':
      ui.todoFilterWeight = element.value;
      ui.activeFilterId = null;
      break;
    case 'todo-month-filter':
      ui.todoFilterMonth = HASH_MONTH_RE.test(element.value) ? element.value : '';
      ui.activeFilterId = null;
      break;
    case 'todo-tag-filter':
      ui.todoFilterTag = element.value;
      ui.activeFilterId = null;
      break;
    case 'todo-category-filter':
      ui.todoFilterCategory = element.value;
      ui.activeFilterId = null;
      break;
    case 'apply-saved-filter': {
      const filter = element.value ? data.filters.find((item) => item.id === element.value) : null;
      ui.todoSearch = filter ? (filter.search || '') : '';
      if (element.value && !filter) return; // 削除済みなどで見つからない場合は何もしない
      ui.todoFilterClient = filter ? (filter.clientId || '') : '';
      ui.todoFilterProject = filter ? (filter.projectId || '') : '';
      ui.todoFilterImportance = filter ? filter.importance : '';
      ui.todoFilterWeight = filter ? (filter.weight || '') : '';
      ui.todoFilterMonth = filter ? filter.month : '';
      ui.todoFilterTag = filter ? (filter.tag || '') : '';
      ui.todoFilterCategory = filter ? (filter.categoryId || '') : '';
      ui.activeFilterId = filter ? filter.id : null;
      break;
    }
    case 'import-backup': {
      const file = element.files && element.files[0];
      element.value = '';
      if (file) importBackup(file); // 確認・保存・再描画はimportBackup側で行う
      return;
    }
    case 'tl-date':
      if (element.value) ui.timelineDate = element.value;
      break;
    case 'gantt-days':
      ui.ganttDays = Number(element.value);
      break;
    case 'gantt-date':
      if (element.value) ui.ganttDate = element.value;
      break;
    case 'agg-from':
      if (element.value) {
        ui.reportFrom = element.value;
        if (ui.reportFrom > ui.reportTo) ui.reportTo = ui.reportFrom;
      }
      break;
    case 'agg-to':
      if (element.value) {
        ui.reportTo = element.value;
        if (ui.reportTo < ui.reportFrom) ui.reportFrom = ui.reportTo;
      }
      break;
    default:
      return;
  }
  pendingFocusState = {
    action: element.dataset.actionChange,
    id: element.dataset.id || '',
    subtaskId: element.dataset.subtaskId || '',
  };
  renderAll();
});

// フォームの入力値を前後の空白を除いた文字列で取り出す
function trimmedField(formData, name) {
  return String(formData.get(name)).trim();
}

document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-action-submit]');
  if (!form) return;
  event.preventDefault();
  const formData = new FormData(form);
  const id = form.dataset.id;
  let syncEntry = null;

  switch (form.dataset.actionSubmit) {
    case 'stop-at': {
      const entry = entryById(id);
      if (!entry || entry.end !== null) return;
      const end = new Date(String(formData.get('end'))).getTime();
      if (!Number.isFinite(end) || end <= entry.start || end > Date.now()) {
        alert('終了日時は開始より後、現在以前にしてください');
        return;
      }
      entry.end = end;
      syncEntry = entry;
      break;
    }
    case 'add-task': {
      const title = trimmedField(formData, 'title');
      if (!title) return;
      data.tasks.push({
        id: uid(),
        title,
        projectId: formData.get('projectId') || null,
        categoryId: formData.get('categoryId') || null,
        status: 'todo',
        createdAt: Date.now(),
        completedAt: null,
        repeat: formData.get('repeat') || null,
        estimateMinutes: parseEstimate(formData.get('estimateMinutes')),
        importance: parseLevel(formData.get('importance')),
        weight: parseLevel(formData.get('weight')),
        note: null,
        tags: parseTags(formData.get('tags')),
        subtasks: [],
        ...planFromForm(formData),
      });
      break;
    }
    case 'save-task': {
      const task = taskById(id);
      if (!task) return;
      const title = trimmedField(formData, 'title');
      if (title) task.title = title;
      task.projectId = formData.get('projectId') || null;
      task.categoryId = formData.get('categoryId') || null;
      task.repeat = formData.get('repeat') || null;
      task.estimateMinutes = parseEstimate(formData.get('estimateMinutes'));
      task.importance = parseLevel(formData.get('importance'));
      task.weight = parseLevel(formData.get('weight'));
      task.note = String(formData.get('note') || '').trim() || null;
      task.tags = parseTags(formData.get('tags'));
      Object.assign(task, planFromForm(formData));
      clearEditing();
      break;
    }
    case 'save-filter': {
      const name = trimmedField(formData, 'name');
      if (!name) return;
      const snapshot = {
        clientId: ui.todoFilterClient || null,
        projectId: ui.todoFilterProject || null,
        categoryId: ui.todoFilterCategory || null,
        importance: ui.todoFilterImportance || '',
        weight: ui.todoFilterWeight || '',
        month: ui.todoFilterMonth || '',
        tag: ui.todoFilterTag || '',
        search: ui.todoSearch,
      };
      const existing = data.filters.find((filter) => filter.name === name);
      if (existing) {
        Object.assign(existing, snapshot);
        ui.activeFilterId = existing.id;
      } else {
        const created = { id: uid(), name, ...snapshot };
        data.filters.push(created);
        ui.activeFilterId = created.id;
      }
      break;
    }
    case 'add-subtask': {
      const title = trimmedField(formData, 'title');
      if (!title) return;
      const task = taskById(id);
      if (!task) return;
      if (!task.subtasks) task.subtasks = [];
      task.subtasks.push({ id: uid(), title, done: false });
      break;
    }
    case 'add-entry': {
      const taskId = formData.get('taskId');
      const dayStart = fromDateStr(ui.timelineDate).getTime();
      const start = timeToTimestamp(dayStart, String(formData.get('start')));
      let end = timeToTimestamp(dayStart, String(formData.get('end')));
      if (end <= start) end += MS_PER_DAY; // 日をまたぐ場合
      const newEntry = { id: uid(), taskId, start, end };
      data.entries.push(newEntry);
      syncEntry = newEntry;
      break;
    }
    case 'save-entry': {
      const entry = entryById(id);
      if (!entry) return;
      // 入力が表示時の値のままなら元の値を使う(分単位の入力欄では秒が落ちてしまうため)
      const readTime = (name, original) => {
        const value = String(formData.get(name));
        const currentValue = `${toDateStr(new Date(original))}T${fmtTime(original)}`;
        return value === currentValue ? original : new Date(value).getTime();
      };
      const start = readTime('start', entry.start);
      const end = entry.end === null ? null : readTime('end', entry.end);
      if (!Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end <= start))) {
        alert('終了日時は開始日時より後にしてください');
        return;
      }
      if (end === null && start > Date.now()) {
        alert('開始時刻は現在時刻より前にしてください');
        return;
      }
      entry.start = start;
      entry.end = end;
      if (end !== null) syncEntry = entry;
      clearEditing();
      break;
    }
    case 'save-running-start': {
      const entry = entryById(id);
      if (!entry || entry.end !== null) return;
      const dayStart = fromDateStr(String(formData.get('startDate'))).getTime();
      const newStart = timeToTimestamp(dayStart, String(formData.get('startTime')));
      if (newStart > Date.now()) {
        alert('開始時刻は現在時刻より前にしてください');
        return;
      }
      entry.start = newStart;
      clearEditing();
      break;
    }
    case 'add-client': {
      const name = trimmedField(formData, 'name');
      if (!name) return;
      data.clients.push({ id: uid(), name });
      break;
    }
    case 'save-client': {
      const client = clientById(id);
      if (!client) return;
      const name = trimmedField(formData, 'name');
      if (name) client.name = name;
      clearEditing();
      break;
    }
    case 'add-category': {
      const name = trimmedField(formData, 'name');
      if (!name) return;
      data.categories.push({ id: uid(), name });
      break;
    }
    case 'save-category': {
      const category = categoryById(id);
      if (!category) return;
      const name = trimmedField(formData, 'name');
      if (name) category.name = name;
      clearEditing();
      break;
    }
    case 'add-project': {
      const name = trimmedField(formData, 'name');
      if (!name) return;
      data.projects.push({
        id: uid(),
        name,
        customId: String(formData.get('customId') || '').trim() || null,
        clientId: formData.get('clientId') || null,
        color: PALETTE[data.projects.length % PALETTE.length],
      });
      break;
    }
    case 'save-project': {
      const project = projectById(id);
      if (!project) return;
      const name = trimmedField(formData, 'name');
      if (name) project.name = name;
      project.customId = String(formData.get('customId') || '').trim() || null;
      project.clientId = formData.get('clientId') || null;
      project.color = String(formData.get('color')) || project.color;
      clearEditing();
      break;
    }
    default:
      return;
  }
  save();
  renderAll();
  if (syncEntry) syncEntryToGoogle(syncEntry);
});

document.addEventListener('pointerdown', (event) => {
  const element = event.target.closest('[data-action-pointer]');
  if (!element || event.button !== 0) return;
  if (element.dataset.actionPointer === 'kanban-drag') {
    // ボタンや入力欄から始まった操作はドラッグにしない
    if (event.target.closest('button, a, input, select, textarea')) return;
    event.preventDefault();
    kanbanDrag = {
      element,
      pointerId: event.pointerId,
      taskId: element.dataset.id,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      overColumn: null,
    };
    element.setPointerCapture(event.pointerId);
    return;
  }
  const task = taskById(element.dataset.id);
  if (!task || !task.plannedStart || !task.plannedEnd) return;
  event.preventDefault();
  const timeline = element.closest('.timeline');
  // 時間軸が取れない場合(非表示など)は、1日の高さを960pxとして換算する
  const timelineHeight = timeline ? timeline.getBoundingClientRect().height : 960;
  ganttDrag = {
    element,
    action: element.dataset.actionPointer,
    pointerId: event.pointerId,
    startY: event.clientY,
    startX: event.clientX,
    dayWidth: Number(element.dataset.dayWidth),
    taskId: task.id,
    day: element.dataset.day || null,
    startMin: Number(element.dataset.startMin),
    endMin: Number(element.dataset.endMin),
    minuteHeight: timelineHeight / MINUTES_PER_DAY,
  };
  element.classList.add('dragging');
  element.setPointerCapture(event.pointerId);
});

document.addEventListener('pointermove', (event) => {
  if (kanbanDrag && event.pointerId === kanbanDrag.pointerId) {
    const dx = event.clientX - kanbanDrag.startX;
    const dy = event.clientY - kanbanDrag.startY;
    // 4px未満の移動はクリック扱いにする(少し触れただけでドラッグ表示になるのを防ぐ)
    if (!kanbanDrag.started && Math.hypot(dx, dy) > 4) {
      kanbanDrag.started = true;
      kanbanDrag.element.classList.add('dragging');
    }
    if (kanbanDrag.started) {
      kanbanDrag.element.style.transform = `translate(${dx}px, ${dy}px)`;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const column = target ? target.closest('.kanban-column') : null;
      clearInsertMarkers();
      if (column) {
        const { before, after } = kanbanDropPosition(column, kanbanDrag.taskId, event.clientY);
        if (before) before.classList.add('kanban-insert-before');
        if (after) after.classList.add('kanban-insert-after');
      }
      if (column !== kanbanDrag.overColumn) {
        if (kanbanDrag.overColumn) kanbanDrag.overColumn.classList.remove('drop-target');
        if (column) column.classList.add('drop-target');
        kanbanDrag.overColumn = column;
      }
    }
    return;
  }
  if (!ganttDrag || event.pointerId !== ganttDrag.pointerId) return;
  if (ganttDrag.action === 'gantt-day-drag') {
    const deltaMin = roundToStep((event.clientY - ganttDrag.startY) / ganttDrag.minuteHeight, 5);
    ganttDrag.element.style.transform = `translateY(${deltaMin * ganttDrag.minuteHeight}px)`;
  } else {
    const deltaDays = Math.round((event.clientX - ganttDrag.startX) / ganttDrag.dayWidth);
    ganttDrag.element.style.transform = `translateX(${deltaDays * ganttDrag.dayWidth}px)`;
  }
});

// ガントのドラッグを終える。commitがtrueなら移動量に応じて予定を更新する
function finishGanttDrag(event, commit) {
  if (!ganttDrag || event.pointerId !== ganttDrag.pointerId) return;
  const drag = ganttDrag;
  ganttDrag = null;
  drag.element.classList.remove('dragging');
  drag.element.style.transform = '';
  if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
  if (!commit) return;
  const task = taskById(drag.taskId);
  if (!task) return;
  if (drag.action === 'gantt-day-drag') {
    const deltaMin = roundToStep((event.clientY - drag.startY) / drag.minuteHeight, 5);
    if (!deltaMin) return;
    const duration = drag.endMin - drag.startMin;
    const newStart = Math.max(0, Math.min(MINUTES_PER_DAY - duration, drag.startMin + deltaMin));
    const newEnd = newStart + duration;
    lastGanttDragUndo = snapshotPlan(task);
    task.plannedStartTime = minutesToTime(newStart);
    task.plannedEndTime = newEnd >= MINUTES_PER_DAY ? '23:59' : minutesToTime(newEnd);
    save();
    renderAll();
    return;
  }
  const deltaDays = Math.round((event.clientX - drag.startX) / drag.dayWidth);
  if (!deltaDays) return;
  lastGanttDragUndo = snapshotPlan(task);
  task.plannedStart = addDays(task.plannedStart, deltaDays);
  task.plannedEnd = addDays(task.plannedEnd, deltaDays);
  save();
  renderAll();
}

// カンバンのドラッグを終える。列の上で離したときだけ、ステータスと並び順を更新する
function finishKanbanDrag(event, commit) {
  if (!kanbanDrag || event.pointerId !== kanbanDrag.pointerId) return;
  const drag = kanbanDrag;
  // カードがヒットテスト対象に戻る前に、背後のドロップ先を確定する
  const target = commit && drag.started ? document.elementFromPoint(event.clientX, event.clientY) : null;
  const column = target ? target.closest('.kanban-column') : null;
  const position = column ? kanbanDropPosition(column, drag.taskId, event.clientY) : null;
  clearInsertMarkers();
  kanbanDrag = null;
  drag.element.classList.remove('dragging');
  drag.element.style.transform = '';
  if (drag.overColumn) drag.overColumn.classList.remove('drop-target');
  if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
  if (!commit || !drag.started || !column) return;
  const task = taskById(drag.taskId);
  if (!task) return;
  reorderKanbanTask(task, column.dataset.status, position.before?.dataset.id, position.after?.dataset.id);
  save();
  renderAll();
}

document.addEventListener('pointerup', (event) => { finishKanbanDrag(event, true); finishGanttDrag(event, true); });
document.addEventListener('pointercancel', (event) => { finishKanbanDrag(event, false); finishGanttDrag(event, false); });

// 戻る/進むやハッシュの手入力に追従する(renderAll内のreplaceStateでは発火しない)
window.addEventListener('hashchange', () => {
  applyHash();
  renderAll();
});

// 数字キーで開くタブ
const SHORTCUT_TABS = { 1: 'todo', 2: 'kanban', 3: 'timeline', 4: 'gantt', 5: 'report', 6: 'manage' };

document.addEventListener('keydown', (event) => {
  if (event.isComposing) return; // 日本語入力の変換中は無視
  const target = event.target;
  const isTextInput = target.matches && target.matches('input, textarea, select') || target.isContentEditable;
  if (target.matches && target.matches('.file-btn') && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    const input = target.querySelector('input[type="file"]');
    if (input) input.click();
    return;
  }
  const kanbanCardTarget = target.closest ? target.closest('.kanban-card') : null;
  if (kanbanCardTarget && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const task = taskById(kanbanCardTarget.dataset.id);
    if (!task) return;
    const currentIndex = TASK_STATUS_ORDER.indexOf(task.status);
    const nextIndex = currentIndex + (event.key === 'ArrowRight' ? 1 : -1);
    if (nextIndex < 0 || nextIndex >= TASK_STATUS_ORDER.length) return;
    event.preventDefault();
    if (setTaskStatus(task, TASK_STATUS_ORDER[nextIndex])) {
      save();
      renderAll();
      const movedCard = [...document.querySelectorAll('.kanban-card')]
        .find((card) => card.dataset.id === task.id);
      const movedCardControl = movedCard ? movedCard.querySelector('.kanban-card-control') : null;
      if (movedCardControl) movedCardControl.focus({ preventScroll: true });
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && !isTextInput) {
    if (undoLastGanttDrag()) event.preventDefault();
    return;
  }
  if (event.key === 'Escape') {
    if (ui.editingTask || ui.editingEntry || ui.editingClient || ui.editingProject || ui.editingCategory) {
      clearEditing();
      renderAll();
    }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTextInput) return;
  if (SHORTCUT_TABS[event.key]) {
    ui.tab = SHORTCUT_TABS[event.key];
    clearEditing();
    renderAll();
  } else if (event.key === 'n' || event.key === 'N') {
    event.preventDefault();
    ui.tab = 'todo';
    clearEditing();
    renderAll();
    const input = document.querySelector('.add-form input[name="title"]');
    if (input) input.focus();
  }
});

/* ---------- ticker ---------- */

// 計測中の経過時間と、止め忘れ警告の表示を1秒ごとに更新する
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-warning-since]').forEach((element) => {
    element.hidden = now - Number(element.dataset.warningSince) < LONG_TIMER_WARNING_MS;
  });
  document.querySelectorAll('[data-live-since]').forEach((element) => {
    element.textContent = fmtClock(now - Number(element.dataset.liveSince));
  });
}, 1000);

/* ---------- init ---------- */

async function init() {
  const view = document.getElementById('view');
  if (location.protocol === 'file:') {
    view.innerHTML = `
      <div class="card">
        <h2>⚠ サーバー経由で開いてください</h2>
        <p>このバージョンはデータをローカルファイルに保存するため、サーバーの起動が必要です。</p>
        <p style="margin-top:8px">
          <code>start.cmd</code> をダブルクリック(または <code>node server.js</code> を実行)して、
          <a href="http://localhost:8787">http://localhost:8787</a> を開いてください。<br>
          Dockerの場合は <code>docker compose up -d</code> で起動できます。
        </p>
      </div>`;
    return;
  }
  try {
    data = await loadFromServer();
  } catch (error) {
    console.error('データの読み込みに失敗しました', error);
    view.innerHTML = `
      <div class="card">
        <h2>⚠ データを読み込めませんでした</h2>
        <p>サーバー(server.js)との通信に失敗しました。ページを再読み込みしてください。</p>
      </div>`;
    return;
  }
  migrateFromLocalStorage();
  if (promoteStartedTasks()) save();
  try {
    ui.googleStatus = await fetchGoogleStatus();
  } catch (error) {
    console.error('Google連携状態の取得に失敗しました', error);
  }
  applyHash();
  const params = new URLSearchParams(location.search);
  if (params.has('google')) {
    ui.tab = 'manage';
    history.replaceState(null, '', location.pathname);
  }
  renderAll();
}

init();
