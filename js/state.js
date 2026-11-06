'use strict';

// Enchanter: state(data/ui)・保存(persistence)・Googleカレンダー連携・lookup helpers
// データは server.js 経由でローカルファイル(data/enchanter-data.json)に保存する

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
// ゴミ箱を1回押して「もう一度押すと削除」の状態になっているタスクのid。一定時間で解除する
let armedDeleteTaskId = null;
let armedDeleteTimer = null;
const ARMED_DELETE_MS = 3000;
// 削除アニメーションの長さ(css/todo.cssの.task-removingと合わせる)
const TASK_REMOVE_ANIMATION_MS = 450;
// 保存失敗の通知を連発しないためのフラグと、保存を直列化する連鎖
let saveWarned = false;
let saveChain = Promise.resolve();
// サーバー上のデータのリビジョン。保存時にIf-Matchで送り、CLIなど他の場所での変更を上書きしない
let dataRevision = null;
// 外部の変更を読み直すたびに増やす。読み直す前に積まれた保存は古いデータなので送らない
let dataGeneration = 0;
// 画面を開いたまま他の場所(CLI)で変更されていないかを確かめる間隔
const EXTERNAL_CHANGE_CHECK_MS = 5000;
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
  dataRevision = response.headers.get('X-Data-Revision');
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
  const generation = dataGeneration;
  saveChain = saveChain
    .then(async () => {
      if (generation !== dataGeneration) return;
      const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'enchanter' };
      if (dataRevision) headers['If-Match'] = dataRevision;
      const response = await fetch('/api/data', { method: 'PUT', headers, body });
      if (response.status === 409) {
        await reloadAfterExternalChange();
        alert('別の場所(CLIなど)でデータが更新されていたため、最新の内容を読み込みました。直前の操作は保存されていないので、もう一度行ってください。');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      dataRevision = response.headers.get('X-Data-Revision') || dataRevision;
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

// 他の場所(CLIなど)で変更されたデータを読み直して再描画する。取り消し履歴は古いデータを指すので捨てる
async function reloadAfterExternalChange() {
  dataGeneration += 1;
  data = await loadFromServer();
  deletionHistory.length = 0;
  lastGanttDragUndo = null;
  renderAll();
}

// 編集中・ドラッグ中・入力途中に再描画すると内容が消えるので、外部変更の取り込みは次の確認に回す
function isUserBusy() {
  const active = document.activeElement;
  const typing = active && active.matches && (
    active.matches('select') || (active.matches('input, textarea') && active.value !== '')
  );
  return Boolean(
    ui.editingTask || ui.editingEntry || ui.editingClient || ui.editingProject || ui.editingCategory ||
    kanbanDrag || ganttDrag || typing
  );
}

// 画面を開いたまま他の場所で変更されていたら取り込む。保存と順序が入れ替わらないよう同じ連鎖に積む
function checkExternalChange() {
  if (dataRevision === null || document.hidden) return;
  saveChain = saveChain
    .then(async () => {
      if (isUserBusy()) return;
      const response = await fetch('/api/data/revision');
      if (!response.ok) return;
      const { revision } = await response.json();
      if (revision !== dataRevision) await reloadAfterExternalChange();
    })
    .catch((error) => console.warn('データの更新確認に失敗しました', error));
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
