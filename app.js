'use strict';

/* ============================================================
 * Enchanter - タスク管理ツール
 * データは server.js 経由でローカルファイル(data/enchanter-data.json)に保存
 * ============================================================ */

// 旧バージョン(localStorage保存)からの移行用キー
const LEGACY_STORAGE_KEY = 'enchanter-data-v1';
const MIGRATED_FLAG_KEY = 'enchanter-data-v1-migrated';

// プロジェクトのデフォルト色。ライト/ダーク両サーフェスで
// 色覚特性・コントラストの検証を通した8色(固定順で割り当て)
const PALETTE = [
  '#3987e5', '#199e70', '#c98500', '#008300',
  '#9085e9', '#e66767', '#d55181', '#d95926',
];

/* ---------- state ---------- */

let data = { clients: [], projects: [], tasks: [], entries: [] };

const ui = {
  tab: 'todo',
  timelineDate: toDateStr(new Date()),
  ganttView: 'week',
  ganttStart: toDateStr(startOfWeek(new Date())),
  ganttDays: 28,
  ganttDate: toDateStr(new Date()),
  aggFrom: toDateStr(startOfWeek(new Date())),
  aggTo: toDateStr(new Date()),
  todoFilterProject: '',
  editingTask: null,
  editingEntry: null,
  editingClient: null,
  editingProject: null,
  googleStatus: { configured: false, connected: false },
};

function normalize(d) {
  return {
    clients: d.clients || [],
    projects: d.projects || [],
    tasks: d.tasks || [],
    entries: d.entries || [],
  };
}

async function loadFromServer() {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalize(await res.json());
}

async function fetchGoogleStatus() {
  const res = await fetch('/api/google/status');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Googleカレンダーに登録するタイトルを組み立てる
// プロジェクトIDがあれば「[ID]プロジェクト名:タスク名」、なければ「プロジェクト名:タスク名」、
// プロジェクト未設定なら「タスク名」のみ
function googleEventTitle(task, project) {
  const taskTitle = task ? task.title : '(不明なタスク)';
  if (!project) return taskTitle;
  const prefix = project.customId ? `[${project.customId}]${project.name}` : project.name;
  return `${prefix}：${taskTitle}`;
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
  }).catch((e) => console.warn('Googleカレンダーへの同期に失敗しました', e));
}

async function connectGoogle() {
  try {
    const res = await fetch('/api/google/auth-url');
    const body = await res.json();
    if (!res.ok) {
      alert(body.error || 'Google連携用のURLを取得できませんでした');
      return;
    }
    location.href = body.url;
  } catch (e) {
    console.error('Google連携の開始に失敗しました', e);
    alert('Google連携を開始できませんでした');
  }
}

async function disconnectGoogle() {
  try {
    await fetch('/api/google/disconnect', { method: 'POST', headers: { 'X-Requested-With': 'enchanter' } });
    ui.googleStatus = await fetchGoogleStatus();
    renderAll();
  } catch (e) {
    console.error('Google連携の解除に失敗しました', e);
  }
}

let saveWarned = false;
let saveChain = Promise.resolve();

// 保存はサーバーに直列で送る(連打しても順序が入れ替わらないように)
function save() {
  const body = JSON.stringify(data);
  saveChain = saveChain
    .then(() => fetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'enchanter' },
      body,
    }))
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      saveWarned = false;
    })
    .catch((e) => {
      if (!saveWarned) {
        saveWarned = true;
        alert('データを保存できませんでした。サーバー(server.js)が起動しているか確認してください。');
      }
      console.error('保存に失敗しました', e);
    });
}

// 旧localStorage版のデータが残っていて、かつファイル側が空なら移行を提案する
function migrateFromLocalStorage() {
  try {
    if (localStorage.getItem(MIGRATED_FLAG_KEY)) return;
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return;
    const hasData = data.clients.length || data.projects.length || data.tasks.length || data.entries.length;
    if (hasData) return;
    const old = normalize(JSON.parse(raw));
    if (!(old.clients.length || old.projects.length || old.tasks.length || old.entries.length)) return;
    if (!confirm('旧バージョン(ブラウザ内保存)のデータが見つかりました。ファイル保存に移行しますか?')) return;
    data = old;
    save();
    localStorage.setItem(MIGRATED_FLAG_KEY, '1');
  } catch (e) {
    console.error('旧データの移行に失敗しました', e);
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- lookup helpers ---------- */

function clientById(id) {
  return data.clients.find((c) => c.id === id) || null;
}

function projectById(id) {
  return data.projects.find((p) => p.id === id) || null;
}

function taskById(id) {
  return data.tasks.find((t) => t.id === id) || null;
}

function entryById(id) {
  return data.entries.find((e) => e.id === id) || null;
}

function runningEntries() {
  return data.entries.filter((e) => e.end === null);
}

function runningEntryForTask(taskId) {
  return data.entries.find((e) => e.end === null && e.taskId === taskId) || null;
}

function projectColor(projectId) {
  const p = projectById(projectId);
  return esc(p ? p.color : '#9a95b3');
}

function projectLabel(projectId) {
  const p = projectById(projectId);
  if (!p) return 'プロジェクトなし';
  const c = clientById(p.clientId);
  return c ? `${c.name} / ${p.name}` : p.name;
}

/* ---------- date / time helpers ---------- */

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfWeek(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}

function fmtDateJa(s) {
  const d = fromDateStr(s);
  const week = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${week})`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function toTimeStr(ts) {
  return fmtTime(ts);
}

// 経過時間 → "1:23:45"
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// 合計時間 → "3時間25分" / "45分"
function fmtDur(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}分`;
  return `${h}時間${m}分`;
}

function entryDur(e, now) {
  return (e.end === null ? now : e.end) - e.start;
}

// "M/D"(年が違う場合のみ "YYYY/M/D")
function fmtShortDate(s) {
  const d = fromDateStr(s);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}/`;
  return `${y}${d.getMonth() + 1}/${d.getDate()}`;
}

// フォーム入力の予定日程(+時刻)を正規化(片方だけなら同日、逆順なら入れ替え)
function planRange(ps, pe, pts, pte) {
  let start = { date: ps || null, time: pts || null };
  let end = { date: pe || null, time: pte || null };
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
function planLabel(t) {
  const sDate = fmtShortDate(t.plannedStart);
  const eDate = fmtShortDate(t.plannedEnd);
  const sTime = t.plannedStartTime ? ` ${t.plannedStartTime}` : '';
  const eTime = t.plannedEndTime ? ` ${t.plannedEndTime}` : '';
  if (t.plannedStart === t.plannedEnd) {
    return t.plannedStartTime && t.plannedEndTime ? `${sDate}${sTime}〜${t.plannedEndTime}` : `${sDate}${sTime}`;
  }
  return `${sDate}${sTime}〜${eDate}${eTime}`;
}

// フォームの見積(分)入力を正の整数またはnullに正規化
function parseEstimate(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// 指定日において、タスクの開始/終了のうちその日にあたる側に時刻指定があるか
function hasTimeOnDay(t, day) {
  return (t.plannedStart === day && !!t.plannedStartTime) || (t.plannedEnd === day && !!t.plannedEndTime);
}

const REPEAT_LABELS = { daily: '毎日', weekly: '毎週', monthly: '毎月' };

function repeatOptions(selected) {
  let html = '<option value="">繰り返しなし</option>';
  for (const [value, label] of Object.entries(REPEAT_LABELS)) {
    html += `<option value="${value}"${value === selected ? ' selected' : ''}>🔁 ${label}</option>`;
  }
  return html;
}

function repeatChip(t) {
  if (!t.repeat) return '';
  return `<span class="chip">🔁 ${REPEAT_LABELS[t.repeat] || esc(t.repeat)}</span>`;
}

// 予定日を繰り返し単位ぶんだけ先送りする
function shiftDate(dateStr, repeat) {
  const d = fromDateStr(dateStr);
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  return toDateStr(d);
}

// 繰り返しタスクの完了時に、次回分のタスクを複製生成する
function nextOccurrence(t) {
  const plannedStart = t.plannedStart ? shiftDate(t.plannedStart, t.repeat) : null;
  const plannedEnd = t.plannedEnd ? shiftDate(t.plannedEnd, t.repeat) : plannedStart;
  return {
    id: uid(),
    title: t.title,
    projectId: t.projectId,
    done: false,
    createdAt: Date.now(),
    completedAt: null,
    plannedStart,
    plannedEnd,
    plannedStartTime: t.plannedStartTime || null,
    plannedEndTime: t.plannedEndTime || null,
    repeat: t.repeat,
    estimateMinutes: t.estimateMinutes || null,
    note: t.note || null,
  };
}

/* ---------- mutations ---------- */

// 複数タスクの並行計測に対応(同じタスクの二重計測のみ防ぐ)
function startTimer(taskId) {
  if (runningEntryForTask(taskId)) return;
  data.entries.push({ id: uid(), taskId, start: Date.now(), end: null });
  save();
  renderAll();
}

function stopTimer(entryId) {
  const e = entryById(entryId);
  if (e && e.end === null) {
    e.end = Date.now();
    save();
    syncEntryToGoogle(e);
  }
}

function stopAllTimers() {
  const now = Date.now();
  const stopped = runningEntries();
  stopped.forEach((e) => { e.end = now; });
  save();
  stopped.forEach(syncEntryToGoogle);
}

function deleteTask(id) {
  const count = data.entries.filter((e) => e.taskId === id).length;
  const msg = count > 0
    ? `このタスクと ${count} 件の作業記録を削除します。よろしいですか?`
    : 'このタスクを削除します。よろしいですか?';
  if (!confirm(msg)) return;
  data.tasks = data.tasks.filter((t) => t.id !== id);
  data.entries = data.entries.filter((e) => e.taskId !== id);
  save();
  renderAll();
}

function deleteClient(id) {
  const projects = data.projects.filter((p) => p.clientId === id);
  if (projects.length > 0) {
    if (!confirm(`このクライアントには ${projects.length} 件のプロジェクトがあります。プロジェクトは「クライアントなし」になります。削除しますか?`)) return;
    projects.forEach((p) => { p.clientId = null; });
  } else if (!confirm('このクライアントを削除します。よろしいですか?')) {
    return;
  }
  data.clients = data.clients.filter((c) => c.id !== id);
  save();
  renderAll();
}

function deleteProject(id) {
  const tasks = data.tasks.filter((t) => t.projectId === id);
  if (tasks.length > 0) {
    if (!confirm(`このプロジェクトには ${tasks.length} 件のタスクがあります。タスクは「プロジェクトなし」になります。削除しますか?`)) return;
    tasks.forEach((t) => { t.projectId = null; });
  } else if (!confirm('このプロジェクトを削除します。よろしいですか?')) {
    return;
  }
  data.projects = data.projects.filter((p) => p.id !== id);
  save();
  renderAll();
}

/* ---------- rendering ---------- */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function projectOptions(selectedId, includeEmptyLabel) {
  let html = `<option value="">${includeEmptyLabel || 'プロジェクトなし'}</option>`;
  const sorted = [...data.projects].sort((a, b) => projectLabel(a.id).localeCompare(projectLabel(b.id), 'ja'));
  for (const p of sorted) {
    const sel = p.id === selectedId ? ' selected' : '';
    html += `<option value="${p.id}"${sel}>${esc(projectLabel(p.id))}</option>`;
  }
  return html;
}

function planChip(t) {
  if (!t.plannedStart) return '';
  const today = toDateStr(new Date());
  let cls = '';
  let note = '';
  if (!t.done) {
    if (t.plannedEnd < today) {
      cls = ' plan-overdue';
      note = ' 超過';
    } else if (t.plannedStart <= today) {
      cls = ' plan-today';
    }
  }
  return `<span class="chip${cls}">📅 ${planLabel(t)}${note}</span>`;
}

function projectChip(projectId) {
  if (!projectId) return '';
  const color = projectColor(projectId);
  return `<span class="chip"><span class="chip-dot" style="background:${color}"></span>${esc(projectLabel(projectId))}</span>`;
}

// 累計時間の表示(見積があれば「累計/見積」+進捗バー、超過時は警告色)
function totalChip(t, totalMs) {
  if (!t.estimateMinutes) {
    return totalMs > 0 ? `<span>累計 ${fmtDur(totalMs)}</span>` : '';
  }
  const estMs = t.estimateMinutes * 60000;
  const pct = (totalMs / estMs) * 100;
  return `
    <span class="estimate${pct > 100 ? ' over' : ''}">
      累計 ${fmtDur(totalMs)} / 見積 ${fmtDur(estMs)}
      <span class="progress"><span class="progress-fill" style="width:${Math.min(100, pct).toFixed(1)}%"></span></span>
      ${pct > 100 ? `<span class="over-note">+${fmtDur(totalMs - estMs)} 超過</span>` : ''}
    </span>`;
}

/* ----- URLハッシュ(タブ状態の保存/復元) ----- */

const HASH_TABS = ['todo', 'timeline', 'gantt', 'report', 'manage'];
const HASH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 現在のuiから「#タブ?パラメータ」形式のハッシュを作る(タブごとに意味のある値のみ)
function buildHash() {
  const params = new URLSearchParams();
  if (ui.tab === 'timeline') {
    params.set('date', ui.timelineDate);
  } else if (ui.tab === 'gantt') {
    params.set('view', ui.ganttView);
    if (ui.ganttView === 'day') {
      params.set('date', ui.ganttDate);
    } else {
      params.set('start', ui.ganttStart);
      params.set('days', ui.ganttDays);
    }
  } else if (ui.tab === 'report') {
    params.set('from', ui.aggFrom);
    params.set('to', ui.aggTo);
  }
  const qs = params.toString();
  return `#${ui.tab}${qs ? `?${qs}` : ''}`;
}

// location.hashを検証しつつuiへ反映する(不正な値は無視して現状維持)
function applyHash() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!hash) return;
  const [tab, qs] = hash.split('?');
  if (!HASH_TABS.includes(tab)) return;
  ui.tab = tab;
  const params = new URLSearchParams(qs || '');
  const date = params.get('date');
  if (tab === 'timeline' && HASH_DATE_RE.test(date || '')) {
    ui.timelineDate = date;
  } else if (tab === 'gantt') {
    const view = params.get('view');
    if (view === 'day' || view === 'week') ui.ganttView = view;
    if (HASH_DATE_RE.test(date || '')) ui.ganttDate = date;
    if (HASH_DATE_RE.test(params.get('start') || '')) ui.ganttStart = params.get('start');
    if ([14, 28, 56].includes(Number(params.get('days')))) ui.ganttDays = Number(params.get('days'));
  } else if (tab === 'report') {
    if (HASH_DATE_RE.test(params.get('from') || '')) ui.aggFrom = params.get('from');
    if (HASH_DATE_RE.test(params.get('to') || '')) ui.aggTo = params.get('to');
    if (ui.aggFrom > ui.aggTo) ui.aggTo = ui.aggFrom;
  }
}

function renderAll() {
  renderRunningBox();
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === ui.tab);
  });
  const view = document.getElementById('view');
  if (ui.tab === 'todo') view.innerHTML = renderTodo();
  else if (ui.tab === 'timeline') view.innerHTML = renderTimeline();
  else if (ui.tab === 'gantt') view.innerHTML = renderGantt();
  else if (ui.tab === 'report') view.innerHTML = renderReport();
  else view.innerHTML = renderManage();
  // 全ての状態変更はここを通るので、URLへの反映はこの1箇所だけでよい
  // (replaceStateはhashchangeを発火しないのでループしない)
  history.replaceState(null, '', location.pathname + location.search + buildHash());
}

function renderRunningBox() {
  const box = document.getElementById('running-box');
  const running = runningEntries();
  if (!running.length) {
    box.innerHTML = '';
    return;
  }
  const pills = running.map((r) => {
    const task = taskById(r.taskId);
    const project = task ? projectById(task.projectId) : null;
    const projectHtml = project
      ? `<span class="running-project"><span class="chip-dot" style="background:${esc(project.color)}"></span>${esc(project.name)}</span>`
      : '';
    return `
      <span class="running-inner">
        <span class="running-dot"></span>
        <span class="running-task">${esc(task ? task.title : '(削除済みタスク)')}</span>
        ${projectHtml}
        <span class="running-elapsed" data-live-since="${r.start}">${fmtClock(Date.now() - r.start)}</span>
        <button class="btn-icon danger" data-action="stop-timer" data-id="${r.id}" title="計測を停止">■</button>
      </span>`;
  }).join('');
  const stopAll = running.length > 1
    ? '<button class="btn-icon danger" data-action="stop-all-timers">すべて停止</button>'
    : '';
  box.innerHTML = pills + stopAll;
}

/* ----- Todoタブ ----- */

function renderTodo() {
  const now = Date.now();

  const taskRow = (t) => {
    if (ui.editingTask === t.id) {
      return `
        <li class="task-item">
          <form class="edit-form" data-action-submit="save-task" data-id="${t.id}">
            <input type="text" name="title" value="${esc(t.title)}" required>
            <select name="projectId">${projectOptions(t.projectId)}</select>
            <span class="plan-inputs">予定
              <input type="date" name="plannedStart" value="${t.plannedStart || ''}">
              <input type="time" name="plannedStartTime" step="600" value="${t.plannedStartTime || ''}">
              〜
              <input type="date" name="plannedEnd" value="${t.plannedEnd || ''}">
              <input type="time" name="plannedEndTime" step="600" value="${t.plannedEndTime || ''}">
            </span>
            <select name="repeat">${repeatOptions(t.repeat || '')}</select>
            <span class="estimate-input">見積
              <input type="number" name="estimateMinutes" min="0" value="${t.estimateMinutes || ''}" placeholder="--">分
            </span>
            <textarea name="note" rows="2" placeholder="メモ(任意)">${esc(t.note || '')}</textarea>
            <button class="btn btn-primary" type="submit">保存</button>
            <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
          </form>
        </li>`;
    }
    const totalMs = data.entries
      .filter((e) => e.taskId === t.id)
      .reduce((sum, e) => sum + entryDur(e, now), 0);
    const running = runningEntryForTask(t.id);
    let timerBtn;
    if (t.done) {
      timerBtn = '';
    } else if (running && ui.editingEntry === running.id) {
      timerBtn = `
        <form class="edit-form" data-action-submit="save-running-start" data-id="${running.id}">
          開始
          <input type="date" name="startDate" value="${toDateStr(new Date(running.start))}" required>
          <input type="time" name="startTime" step="60" value="${toTimeStr(running.start)}" required>
          <button class="btn btn-primary" type="submit">保存</button>
          <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
        </form>`;
    } else if (running) {
      timerBtn = `
        <button class="timer-btn stop" data-action="stop-timer" data-id="${running.id}">■ <span data-live-since="${running.start}">${fmtClock(now - running.start)}</span></button>
        <button class="btn-icon" data-action="edit-entry" data-id="${running.id}" title="開始時刻を編集">✎</button>`;
    } else {
      timerBtn = `<button class="timer-btn start" data-action="start-timer" data-id="${t.id}">▶ 計測</button>`;
    }
    return `
      <li class="task-item ${t.done ? 'done' : ''}">
        <input type="checkbox" ${t.done ? 'checked' : ''} data-action-change="toggle-done" data-id="${t.id}">
        <div class="task-main">
          <div class="task-title">${esc(t.title)}</div>
          ${t.note ? `<div class="task-note">${esc(t.note)}</div>` : ''}
          <div class="task-meta">
            ${projectChip(t.projectId)}
            ${planChip(t)}
            ${repeatChip(t)}
            ${totalChip(t, totalMs)}
          </div>
        </div>
        <div class="task-actions">
          ${timerBtn}
          <button class="btn-icon" data-action="edit-task" data-id="${t.id}" title="編集">✎</button>
          <button class="btn-icon danger" data-action="del-task" data-id="${t.id}" title="削除">🗑</button>
        </div>
      </li>`;
  };

  let tasks = [...data.tasks];
  if (ui.todoFilterProject) {
    tasks = tasks.filter((t) => t.projectId === ui.todoFilterProject);
  }
  // 予定日が近い順(予定なしは後ろ)、同条件なら新しい順
  const active = tasks.filter((t) => !t.done).sort((a, b) => {
    const ap = a.plannedStart || '9999-99-99';
    const bp = b.plannedStart || '9999-99-99';
    if (ap !== bp) return ap < bp ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
  const done = tasks.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  return `
    <div class="card">
      <h2>➕ タスクを追加</h2>
      <form class="add-form" data-action-submit="add-task">
        <input type="text" name="title" placeholder="タスク名を入力..." required autocomplete="off">
        <select name="projectId">${projectOptions(ui.todoFilterProject || '')}</select>
        <span class="plan-inputs">予定
          <input type="date" name="plannedStart">
          <input type="time" name="plannedStartTime" step="600">
          〜
          <input type="date" name="plannedEnd">
          <input type="time" name="plannedEndTime" step="600">
        </span>
        <select name="repeat">${repeatOptions('')}</select>
        <span class="estimate-input">見積
          <input type="number" name="estimateMinutes" min="0" placeholder="--">分
        </span>
        <button class="btn btn-primary" type="submit">追加</button>
      </form>
    </div>
    <div class="card">
      <h2>📋 Todoリスト</h2>
      <div class="filter-row">
        <label>プロジェクト:
          <select data-action-change="todo-filter">${projectOptions(ui.todoFilterProject, 'すべて')}</select>
        </label>
      </div>
      <ul class="task-list">
        ${active.length ? active.map(taskRow).join('') : '<li class="empty">未完了のタスクはありません</li>'}
      </ul>
      ${done.length ? `
        <details class="done-section">
          <summary>完了済み (${done.length})</summary>
          <ul class="task-list">${done.map(taskRow).join('')}</ul>
        </details>` : ''}
    </div>`;
}

/* ----- タイムラインタブ ----- */

// 重なるエントリをレーンに振り分ける
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

// 指定日が予定日程に含まれるタスクの一覧(ガント1日表示では時刻指定なしのタスクのみに絞れる)
function renderPlannedForDay(day, opts = {}) {
  let planned = data.tasks
    .filter((t) => t.plannedStart && t.plannedStart <= day && day <= t.plannedEnd);
  if (opts.untimedOnly) planned = planned.filter((t) => !hasTimeOnDay(t, day));
  planned = planned.sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
  if (!planned.length) return '';
  const items = planned.map((t) => `
    <span class="plan-task ${t.done ? 'done' : ''}">
      <span class="chip-dot" style="background:${projectColor(t.projectId)}"></span>
      ${t.done ? '✔ ' : ''}${esc(t.title)}
    </span>`).join('');
  return `<div class="plan-day-row"><span class="plan-day-label">${opts.label || '📅 この日の予定:'}</span>${items}</div>`;
}

// 指定した間隔(時間)おきの時刻ラベル(タイムライン・ガント1日表示で共用)
function hourLabels(stepHours = 2) {
  const count = 24 / stepHours;
  return Array.from({ length: count }, (_, i) => `<div class="tl-hour">${i * stepHours}時</div>`).join('');
}

function renderTimeline() {
  const now = Date.now();
  const dayStart = fromDateStr(ui.timelineDate).getTime();
  const dayEnd = dayStart + 86400000;

  const items = data.entries
    .map((e) => ({ ...e, effEnd: e.end === null ? now : e.end }))
    .filter((e) => e.start < dayEnd && e.effEnd > dayStart)
    .map((e) => ({
      ...e,
      clipStart: Math.max(e.start, dayStart),
      clipEnd: Math.min(e.effEnd, dayEnd),
    }));

  const totalMs = items.reduce((sum, e) => sum + (e.clipEnd - e.clipStart), 0);
  const laneCount = Math.max(1, assignLanes(items));

  // この日のプロジェクト別内訳(時間の多い順)
  const byProject = new Map();
  for (const e of items) {
    const task = taskById(e.taskId);
    const pid = task && projectById(task.projectId) ? task.projectId : '';
    byProject.set(pid, (byProject.get(pid) || 0) + (e.clipEnd - e.clipStart));
  }
  const summary = items.length ? `
    <div class="tl-summary">${[...byProject.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([pid, ms]) => `<span class="chip"><span class="chip-dot" style="background:${projectColor(pid)}"></span>${esc(projectLabel(pid))} <b>${fmtDur(ms)}</b></span>`)
      .join('')}</div>` : '';

  const blocks = items.map((e) => {
    const task = taskById(e.taskId);
    const top = ((e.clipStart - dayStart) / 86400000) * 100;
    const height = ((e.clipEnd - e.clipStart) / 86400000) * 100;
    const color = projectColor(task ? task.projectId : null);
    const label = task ? task.title : '(削除済み)';
    const tip = `${label}\n${fmtTime(e.clipStart)} - ${e.end === null ? '計測中' : fmtTime(e.clipEnd)} (${fmtDur(e.clipEnd - e.clipStart)})`;
    return `<div class="tl-block ${e.end === null ? 'running' : ''}"
      style="top:${top}%;height:${Math.max(height, 0.4)}%;left:${4 + e.lane * 136}px;background:${color}"
      title="${esc(tip)}">${esc(label)}</div>`;
  }).join('');

  const sortedItems = [...items].sort((a, b) => a.start - b.start);
  const entryRow = (e) => {
    if (ui.editingEntry === e.id) {
      return `
        <li class="entry-item">
          <form class="edit-form" data-action-submit="save-entry" data-id="${e.id}">
            <input type="time" name="start" value="${toTimeStr(e.clipStart)}" step="600" required>
            〜
            <input type="time" name="end" value="${e.end === null ? '' : toTimeStr(e.clipEnd)}" step="600" ${e.end === null ? 'disabled' : 'required'}>
            <button class="btn btn-primary" type="submit">保存</button>
            <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
          </form>
        </li>`;
    }
    const task = taskById(e.taskId);
    return `
      <li class="entry-item">
        <span class="entry-time">${fmtTime(e.clipStart)} 〜 ${e.end === null ? '計測中' : fmtTime(e.effEnd)}</span>
        <span class="entry-dur">${fmtDur(e.clipEnd - e.clipStart)}</span>
        <span class="entry-task">${esc(task ? task.title : '(削除済みタスク)')} ${projectChip(task ? task.projectId : null)}</span>
        <span class="task-actions">
          <button class="btn-icon" data-action="edit-entry" data-id="${e.id}" title="編集">✎</button>
          <button class="btn-icon danger" data-action="del-entry" data-id="${e.id}" title="削除">🗑</button>
        </span>
      </li>`;
  };

  const activeTasks = data.tasks.filter((t) => !t.done);
  const taskOpts = activeTasks
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => `<option value="${t.id}">${esc(t.title)}</option>`)
    .join('');

  return `
    <div class="card">
      <div class="tl-header">
        <span class="tl-date-label">${fmtDateJa(ui.timelineDate)}</span>
        <span class="tl-total">合計 ${fmtDur(totalMs)}</span>
        <button class="btn" data-action="tl-shift" data-days="-1">◀ 前日</button>
        <input type="date" value="${ui.timelineDate}" data-action-change="tl-date">
        <button class="btn" data-action="tl-shift" data-days="1">翌日 ▶</button>
        <button class="btn" data-action="tl-today">今日</button>
      </div>
      ${summary}
      ${renderPlannedForDay(ui.timelineDate)}
      <div class="timeline-wrap">
        <div class="timeline">
          <div class="tl-hours">${hourLabels()}</div>
          <div class="tl-lanes" style="width:${laneCount * 136}px">${blocks}</div>
        </div>
      </div>
      <ul class="entry-list">
        ${sortedItems.length ? sortedItems.map(entryRow).join('') : '<li class="empty">この日の作業記録はありません</li>'}
      </ul>
    </div>
    <div class="card">
      <h2>➕ 作業記録を手動追加</h2>
      ${activeTasks.length ? `
        <form class="add-form" data-action-submit="add-entry">
          <select name="taskId" required>${taskOpts}</select>
          <input type="time" name="start" step="600" required>
          〜
          <input type="time" name="end" step="600" required>
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <p class="task-meta" style="margin-top:8px">※ 上で選択中の日付(${fmtDateJa(ui.timelineDate)})に追加されます。終了が開始より前の場合は翌日扱いになります。</p>
      ` : '<p class="empty">未完了のタスクがありません。先にTodoタブでタスクを作成してください。</p>'}
    </div>`;
}

/* ----- ガントチャートタブ ----- */

function ganttViewToggle() {
  return `<div class="view-toggle">
    <button class="btn${ui.ganttView === 'week' ? ' btn-primary' : ''}" data-action="gantt-view" data-view="week">📅 1週間</button>
    <button class="btn${ui.ganttView === 'day' ? ' btn-primary' : ''}" data-action="gantt-view" data-view="day">🕐 1日</button>
  </div>`;
}

function renderGantt() {
  return ui.ganttView === 'day' ? renderGanttDay() : renderGanttWeek();
}

// 1日単位: 時刻に沿ってタスクを配置するガントチャート(タイムラインと同じ時間軸UIを再利用)
function renderGanttDay() {
  const day = ui.ganttDate;
  const dayStart = fromDateStr(day).getTime();
  const dayEnd = dayStart + 86400000;
  const todayStr = toDateStr(new Date());

  const tasks = data.tasks.filter(
    (t) => t.plannedStart && t.plannedStart <= day && day <= t.plannedEnd && hasTimeOnDay(t, day)
  );

  const items = tasks.map((t) => {
    let start = dayStart;
    let end = dayEnd;
    if (t.plannedStart === day && t.plannedStartTime) start = timeToTs(dayStart, t.plannedStartTime);
    if (t.plannedEnd === day && t.plannedEndTime) end = timeToTs(dayStart, t.plannedEndTime);
    if (end <= start) end = dayEnd;
    return { task: t, start, clipStart: start, clipEnd: end };
  });

  const laneCount = Math.max(1, assignLanes(items));

  const blocks = items.map((it) => {
    const t = it.task;
    const project = projectById(t.projectId);
    const top = ((it.clipStart - dayStart) / 86400000) * 100;
    const height = ((it.clipEnd - it.clipStart) / 86400000) * 100;
    const overdue = !t.done && t.plannedEnd < todayStr;
    const cls = `${t.done ? ' plan-done' : ''}${overdue ? ' plan-overdue' : ''}`;
    const tip = `${t.title}${project ? ` (${project.name})` : ''}\n${fmtTime(it.clipStart)} 〜 ${fmtTime(it.clipEnd)}` +
      `${overdue ? '\n⚠ 期限超過' : ''}${t.done ? '\n✔ 完了' : ''}`;
    const label = project ? `${esc(t.title)} <span class="tl-block-project">・${esc(project.name)}</span>` : esc(t.title);
    return `<div class="tl-block${cls}"
      style="top:${top}%;height:${Math.max(height, 0.4)}%;left:${4 + it.lane * 136}px;background:${projectColor(t.projectId)}"
      title="${esc(tip)}">${label}</div>`;
  }).join('');

  return `
    <div class="card">
      <div class="tl-header">
        <span class="tl-date-label">ガントチャート</span>
        ${ganttViewToggle()}
        <span class="tl-total">${fmtDateJa(day)}</span>
        <button class="btn" data-action="gantt-day-shift" data-days="-1">◀ 前日</button>
        <input type="date" value="${day}" data-action-change="gantt-date">
        <button class="btn" data-action="gantt-day-shift" data-days="1">翌日 ▶</button>
        <button class="btn" data-action="gantt-day-today">今日</button>
      </div>
      ${renderPlannedForDay(day, { untimedOnly: true, label: '📅 終日:' })}
      <div class="timeline-wrap">
        <div class="timeline">
          <div class="tl-hours">${hourLabels(1)}</div>
          <div class="tl-lanes" style="width:${laneCount * 136}px">${blocks}</div>
        </div>
      </div>
    </div>`;
}

// 週(複数日)単位: プロジェクトごとにまとめたタスクを日付軸に沿って表示するガントチャート
function renderGanttWeek() {
  const days = ui.ganttDays;
  const start = fromDateStr(ui.ganttStart);
  const startStr = ui.ganttStart;
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + days - 1);
  const endStr = toDateStr(endDate);
  const todayStr = toDateStr(new Date());
  const dayIdx = (s) => Math.round((fromDateStr(s) - start) / 86400000);

  // 表示期間と重なる予定付きタスクを、プロジェクトごとにまとめて1列に並べる
  const inWindow = data.tasks.filter(
    (t) => t.plannedStart && t.plannedStart <= endStr && t.plannedEnd >= startStr
  );
  const byPlan = (a, b) => (a.plannedStart !== b.plannedStart
    ? (a.plannedStart < b.plannedStart ? -1 : 1)
    : a.createdAt - b.createdAt);
  const groups = [];
  const sortedProjects = [...data.projects]
    .sort((a, b) => projectLabel(a.id).localeCompare(projectLabel(b.id), 'ja'));
  for (const p of sortedProjects) {
    const tasks = inWindow.filter((t) => t.projectId === p.id).sort(byPlan);
    if (tasks.length) groups.push({ project: p, tasks });
  }
  const noProj = inWindow.filter((t) => !projectById(t.projectId)).sort(byPlan);
  if (noProj.length) groups.push({ project: null, tasks: noProj });

  const cols = [];
  for (const g of groups) {
    for (const t of g.tasks) cols.push({ task: t, project: g.project });
  }

  // 日付ラベル(縦)と背景の行
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  let dayLabels = '';
  let bgRows = '';
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dow = d.getDay();
    const cls = `${dow === 0 || dow === 6 ? ' weekend' : ''}${toDateStr(d) === todayStr ? ' today' : ''}`;
    const label = (i === 0 || d.getDate() === 1) ? `${d.getMonth() + 1}/${d.getDate()}` : d.getDate();
    dayLabels += `<div class="gantt-day-v${cls}" style="grid-row:${i + 2}"><span>${label}</span><span class="wd">${WEEK[dow]}</span></div>`;
    bgRows += `<div class="gantt-grid-row${cls}" style="grid-row:${i + 2}"></div>`;
  }

  // タスク列(縦書きの見出し + 縦棒)
  let colHeads = '';
  let bars = '';
  cols.forEach((c, idx) => {
    const t = c.task;
    const col = idx + 2;
    const sIdx = Math.max(dayIdx(t.plannedStart), 0);
    const eIdx = Math.min(dayIdx(t.plannedEnd), days - 1);
    const overdue = !t.done && t.plannedEnd < todayStr;
    const cls = `${t.done ? ' done' : ''}${overdue ? ' overdue' : ''}` +
      `${t.plannedStart < startStr ? ' clip-top' : ''}${t.plannedEnd > endStr ? ' clip-bottom' : ''}`;
    const totalDays = dayIdx(t.plannedEnd) - dayIdx(t.plannedStart) + 1;
    const tip = `${t.title}${c.project ? ` (${c.project.name})` : ''}\n${planLabel(t)} (${totalDays}日間)` +
      `${overdue ? '\n⚠ 期限超過' : ''}${t.done ? '\n✔ 完了' : ''}`;
    colHeads += `
      <div class="gantt-col-label${t.done ? ' done' : ''}" style="grid-column:${col}" title="${esc(tip)}">
        <span class="chip-dot" style="background:${projectColor(t.projectId)}"></span>
        ${overdue ? '<span class="overdue-mark">⚠</span> ' : ''}${esc(t.title)}
        ${c.project ? `<span class="gantt-col-project">・${esc(c.project.name)}</span>` : ''}
      </div>`;
    bars += `<div class="gantt-bar-v${cls}" style="grid-column:${col};grid-row:${sIdx + 2} / ${eIdx + 3};background:${projectColor(t.projectId)}"
        title="${esc(tip)}"></div>`;
  });

  return `
    <div class="card">
      <div class="tl-header">
        <span class="tl-date-label">ガントチャート</span>
        ${ganttViewToggle()}
        <span class="tl-total">${fmtDateJa(startStr)} 〜 ${fmtDateJa(endStr)}</span>
        <select data-action-change="gantt-days">
          <option value="14"${days === 14 ? ' selected' : ''}>2週間</option>
          <option value="28"${days === 28 ? ' selected' : ''}>4週間</option>
          <option value="56"${days === 56 ? ' selected' : ''}>8週間</option>
        </select>
        <button class="btn" data-action="gantt-shift" data-days="-7">◀ 前週</button>
        <button class="btn" data-action="gantt-today">今日</button>
        <button class="btn" data-action="gantt-shift" data-days="7">翌週 ▶</button>
      </div>
      ${cols.length ? `
        <div class="gantt-wrap">
          <div class="gantt-v" style="grid-template-columns:56px repeat(${cols.length}, 34px);grid-template-rows:150px repeat(${days}, 22px)">
            ${bgRows}
            ${dayLabels}
            ${colHeads}
            ${bars}
          </div>
        </div>` : '<p class="empty">この期間に予定日程が設定されたタスクはありません。Todoタブでタスクに予定を設定してください。</p>'}
    </div>`;
}

/* ----- エクスポート(CSV・バックアップ) ----- */

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 先頭のBOMはExcelでの文字化け対策
function toCsv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// 集計タブの階層集計をフラットなCSVにして保存する
function exportReportCsv() {
  const tree = aggregate(ui.aggFrom, ui.aggTo);
  const rows = [['クライアント', 'プロジェクト', 'タスク', '時間(分)', '時間(h)']];
  const sortedClients = [...tree.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [clientId, cNode] of sortedClients) {
    const client = clientById(clientId);
    const sortedProjects = [...cNode.projects.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [projectId, pNode] of sortedProjects) {
      const project = projectById(projectId);
      for (const t of [...pNode.tasks].sort((a, b) => b.ms - a.ms)) {
        rows.push([
          client ? client.name : 'クライアントなし',
          project ? project.name : 'プロジェクトなし',
          t.title,
          Math.round(t.ms / 60000),
          (t.ms / 3600000).toFixed(2),
        ]);
      }
    }
  }
  downloadFile(`enchanter-report_${ui.aggFrom}_${ui.aggTo}.csv`, toCsv(rows), 'text/csv');
}

// 期間内の作業記録の明細CSV(期間でクリップするので集計と合計が一致する)
function exportEntriesCsv() {
  const now = Date.now();
  const rangeStart = fromDateStr(ui.aggFrom).getTime();
  const rangeEnd = fromDateStr(ui.aggTo).getTime() + 86400000;
  const rows = [['日付', '開始', '終了', '時間(分)', 'タスク', 'プロジェクト', 'クライアント']];
  for (const e of [...data.entries].sort((a, b) => a.start - b.start)) {
    const effEnd = e.end === null ? now : e.end;
    const clipStart = Math.max(e.start, rangeStart);
    const clipEnd = Math.min(effEnd, rangeEnd);
    if (clipEnd <= clipStart) continue;
    const task = taskById(e.taskId);
    const project = task ? projectById(task.projectId) : null;
    const client = project ? clientById(project.clientId) : null;
    rows.push([
      toDateStr(new Date(clipStart)),
      fmtTime(clipStart),
      e.end === null ? '計測中' : fmtTime(clipEnd),
      Math.round((clipEnd - clipStart) / 60000),
      task ? task.title : '(削除済みタスク)',
      project ? project.name : '',
      client ? client.name : '',
    ]);
  }
  downloadFile(`enchanter-entries_${ui.aggFrom}_${ui.aggTo}.csv`, toCsv(rows), 'text/csv');
}

// バックアップJSONを読み込み、確認のうえ全データを置き換える
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid shape');
      for (const key of ['clients', 'projects', 'tasks', 'entries']) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error('invalid shape');
      }
      const next = normalize(parsed);
      const msg = '現在のデータをインポート内容で【全て置き換え】ます。\n'
        + `現在: タスク ${data.tasks.length} 件・作業記録 ${data.entries.length} 件\n`
        + `インポート: タスク ${next.tasks.length} 件・作業記録 ${next.entries.length} 件\n`
        + 'よろしいですか?';
      if (!confirm(msg)) return;
      data = next;
      save();
      renderAll();
    } catch (e) {
      console.error('バックアップの読み込みに失敗しました', e);
      alert('バックアップファイルを読み込めませんでした。エクスポートしたJSONファイルか確認してください。');
    }
  };
  reader.readAsText(file);
}

/* ----- 集計タブ ----- */

function aggregate(fromStr, toStr) {
  const now = Date.now();
  const rangeStart = fromDateStr(fromStr).getTime();
  const rangeEnd = fromDateStr(toStr).getTime() + 86400000;

  // taskId → 合計ms
  const byTask = new Map();
  for (const e of data.entries) {
    const effEnd = e.end === null ? now : e.end;
    const overlap = Math.min(effEnd, rangeEnd) - Math.max(e.start, rangeStart);
    if (overlap <= 0) continue;
    byTask.set(e.taskId, (byTask.get(e.taskId) || 0) + overlap);
  }

  // client → project → task の階層に集約
  const tree = new Map();
  for (const [taskId, ms] of byTask) {
    const task = taskById(taskId);
    const project = task ? projectById(task.projectId) : null;
    const clientId = project ? (project.clientId || '') : '';
    const projectId = project ? project.id : '';
    if (!tree.has(clientId)) tree.set(clientId, { total: 0, projects: new Map() });
    const cNode = tree.get(clientId);
    cNode.total += ms;
    if (!cNode.projects.has(projectId)) cNode.projects.set(projectId, { total: 0, tasks: [] });
    const pNode = cNode.projects.get(projectId);
    pNode.total += ms;
    pNode.tasks.push({ title: task ? task.title : '(削除済みタスク)', ms });
  }
  return tree;
}

function renderReport() {
  const tree = aggregate(ui.aggFrom, ui.aggTo);
  let grandTotal = 0;
  tree.forEach((c) => { grandTotal += c.total; });

  const rows = [];
  const sortedClients = [...tree.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [clientId, cNode] of sortedClients) {
    const client = clientById(clientId);
    rows.push(`<tr class="row-client">
      <td>${esc(client ? client.name : 'クライアントなし')}</td>
      <td class="num">${fmtDur(cNode.total)}</td>
      <td class="num">${grandTotal ? Math.round((cNode.total / grandTotal) * 100) : 0}%</td>
    </tr>`);
    const sortedProjects = [...cNode.projects.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [projectId, pNode] of sortedProjects) {
      const project = projectById(projectId);
      const dot = project ? `<span class="chip-dot" style="background:${esc(project.color)};display:inline-block;margin-right:6px"></span>` : '';
      rows.push(`<tr class="row-project">
        <td>${dot}${esc(project ? project.name : 'プロジェクトなし')}</td>
        <td class="num">${fmtDur(pNode.total)}</td>
        <td class="num">${grandTotal ? Math.round((pNode.total / grandTotal) * 100) : 0}%</td>
      </tr>`);
      for (const t of pNode.tasks.sort((a, b) => b.ms - a.ms)) {
        rows.push(`<tr class="row-task">
          <td>${esc(t.title)}</td>
          <td class="num">${fmtDur(t.ms)}</td>
          <td class="num"></td>
        </tr>`);
      }
    }
  }

  const hours = (grandTotal / 3600000).toFixed(2);

  return `
    <div class="card">
      <h2>📊 作業時間の集計</h2>
      <div class="report-controls">
        <input type="date" value="${ui.aggFrom}" data-action-change="agg-from">
        〜
        <input type="date" value="${ui.aggTo}" data-action-change="agg-to">
      </div>
      <div class="quick-ranges">
        <button class="btn" data-action="quick-range" data-range="today">今日</button>
        <button class="btn" data-action="quick-range" data-range="yesterday">昨日</button>
        <button class="btn" data-action="quick-range" data-range="week">今週</button>
        <button class="btn" data-action="quick-range" data-range="lastweek">先週</button>
        <button class="btn" data-action="quick-range" data-range="month">今月</button>
        <button class="btn" data-action="quick-range" data-range="lastmonth">先月</button>
        <span class="export-btns">
          <button class="btn" data-action="export-report-csv" title="集計結果をCSVでダウンロード">⬇ 集計CSV</button>
          <button class="btn" data-action="export-entries-csv" title="作業記録の明細をCSVでダウンロード">⬇ 明細CSV</button>
        </span>
      </div>
      <div class="report-total">${fmtDur(grandTotal)}<small>(${hours}h) ${fmtDateJa(ui.aggFrom)} 〜 ${fmtDateJa(ui.aggTo)}</small></div>
      ${rows.length ? `
        <table class="report-table">
          <thead><tr><th>クライアント / プロジェクト / タスク</th><th class="num">時間</th><th class="num">割合</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>` : '<p class="empty">この期間の作業記録はありません</p>'}
    </div>`;
}

/* ----- 管理タブ ----- */

function renderManage() {
  const clientRow = (c) => {
    if (ui.editingClient === c.id) {
      return `
        <li class="manage-item">
          <form class="edit-form" data-action-submit="save-client" data-id="${c.id}">
            <input type="text" name="name" value="${esc(c.name)}" required>
            <button class="btn btn-primary" type="submit">保存</button>
            <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
          </form>
        </li>`;
    }
    const count = data.projects.filter((p) => p.clientId === c.id).length;
    return `
      <li class="manage-item">
        <span class="name">${esc(c.name)}</span>
        <span class="sub">${count} プロジェクト</span>
        <button class="btn-icon" data-action="edit-client" data-id="${c.id}" title="編集">✎</button>
        <button class="btn-icon danger" data-action="del-client" data-id="${c.id}" title="削除">🗑</button>
      </li>`;
  };

  const clientOpts = (selectedId) => {
    let html = '<option value="">クライアントなし</option>';
    for (const c of data.clients) {
      html += `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}</option>`;
    }
    return html;
  };

  const projectRow = (p) => {
    if (ui.editingProject === p.id) {
      return `
        <li class="manage-item">
          <form class="edit-form" data-action-submit="save-project" data-id="${p.id}">
            <input type="text" name="name" value="${esc(p.name)}" required>
            <input type="text" name="customId" value="${esc(p.customId || '')}" placeholder="ID(任意)">
            <select name="clientId">${clientOpts(p.clientId)}</select>
            <input type="color" name="color" value="${esc(p.color)}" title="カラー">
            <button class="btn btn-primary" type="submit">保存</button>
            <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
          </form>
        </li>`;
    }
    const client = clientById(p.clientId);
    const count = data.tasks.filter((t) => t.projectId === p.id).length;
    return `
      <li class="manage-item">
        <span class="chip-dot" style="background:${esc(p.color)}"></span>
        <span class="name">${esc(p.name)}</span>
        ${p.customId ? `<span class="chip">${esc(p.customId)}</span>` : ''}
        <span class="sub">${client ? esc(client.name) : 'クライアントなし'} ・ ${count} タスク</span>
        <button class="btn-icon" data-action="edit-project" data-id="${p.id}" title="編集">✎</button>
        <button class="btn-icon danger" data-action="del-project" data-id="${p.id}" title="削除">🗑</button>
      </li>`;
  };

  const googleCard = () => {
    const s = ui.googleStatus;
    let status;
    let action;
    if (!s.configured) {
      status = '<span class="sub">data/google-credentials.json が未設定です</span>';
      action = '';
    } else if (!s.connected) {
      status = '<span class="sub">未連携</span>';
      action = '<button class="btn btn-primary" data-action="google-connect">連携する</button>';
    } else {
      status = '<span class="sub">連携済み</span>';
      action = '<button class="btn" data-action="google-disconnect">連携を解除</button>';
    }
    return `
      <div class="card">
        <h2>🗓️ Googleカレンダー連携</h2>
        <p>${status}</p>
        ${action}
      </div>`;
  };

  const backupCard = () => `
    <div class="card">
      <h2>💾 バックアップ</h2>
      <p class="backup-note">全データ(クライアント・プロジェクト・タスク・作業記録)をJSONで書き出し/読み込みできます。インポートは現在のデータを全て置き換えます。</p>
      <div class="backup-actions">
        <button class="btn" data-action="export-backup">⬇ エクスポート</button>
        <label class="btn file-btn">⬆ インポート<input type="file" accept=".json,application/json" data-action-change="import-backup" hidden></label>
      </div>
    </div>`;

  const shortcutCard = () => `
    <div class="card">
      <h2>⌨️ キーボードショートカット</h2>
      <ul class="shortcut-list">
        <li><kbd>1</kbd>〜<kbd>5</kbd> タブ切替(Todo / タイムライン / ガント / 集計 / 管理)</li>
        <li><kbd>N</kbd> 新しいタスクを追加(Todoタブのタスク名入力へ)</li>
        <li><kbd>Esc</kbd> 編集をキャンセル</li>
      </ul>
    </div>`;

  return `
    <div class="manage-grid">
      <div class="card">
        <h2>👤 クライアント</h2>
        <form class="add-form" data-action-submit="add-client" style="margin-bottom:12px">
          <input type="text" name="name" placeholder="クライアント名..." required autocomplete="off">
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <ul class="manage-list">
          ${data.clients.length ? data.clients.map(clientRow).join('') : '<li class="empty">クライアントがありません</li>'}
        </ul>
      </div>
      <div class="card">
        <h2>📁 プロジェクト</h2>
        <form class="add-form" data-action-submit="add-project" style="margin-bottom:12px">
          <input type="text" name="name" placeholder="プロジェクト名..." required autocomplete="off">
          <input type="text" name="customId" placeholder="ID(任意)" autocomplete="off">
          <select name="clientId">${clientOpts('')}</select>
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <ul class="manage-list">
          ${data.projects.length ? data.projects.map(projectRow).join('') : '<li class="empty">プロジェクトがありません</li>'}
        </ul>
      </div>
      ${googleCard()}
      ${backupCard()}
      ${shortcutCard()}
    </div>`;
}

/* ---------- events ---------- */

function clearEditing() {
  ui.editingTask = null;
  ui.editingEntry = null;
  ui.editingClient = null;
  ui.editingProject = null;
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'tab':
      ui.tab = el.dataset.tab;
      clearEditing();
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
      break;
    case 'del-task':
      deleteTask(id);
      return;
    case 'edit-entry':
      clearEditing();
      ui.editingEntry = id;
      break;
    case 'del-entry':
      if (!confirm('この作業記録を削除します。よろしいですか?')) return;
      data.entries = data.entries.filter((e) => e.id !== id);
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
      downloadFile(`enchanter-backup-${toDateStr(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json');
      return;
    case 'tl-shift': {
      const d = fromDateStr(ui.timelineDate);
      d.setDate(d.getDate() + Number(el.dataset.days));
      ui.timelineDate = toDateStr(d);
      break;
    }
    case 'tl-today':
      ui.timelineDate = toDateStr(new Date());
      break;
    case 'gantt-shift': {
      const d = fromDateStr(ui.ganttStart);
      d.setDate(d.getDate() + Number(el.dataset.days));
      ui.ganttStart = toDateStr(d);
      break;
    }
    case 'gantt-today':
      ui.ganttStart = toDateStr(startOfWeek(new Date()));
      break;
    case 'gantt-view':
      ui.ganttView = el.dataset.view;
      break;
    case 'gantt-day-shift': {
      const d = fromDateStr(ui.ganttDate);
      d.setDate(d.getDate() + Number(el.dataset.days));
      ui.ganttDate = toDateStr(d);
      break;
    }
    case 'gantt-day-today':
      ui.ganttDate = toDateStr(new Date());
      break;
    case 'quick-range': {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let from = new Date(today);
      let to = new Date(today);
      switch (el.dataset.range) {
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
      }
      ui.aggFrom = toDateStr(from);
      ui.aggTo = toDateStr(to);
      break;
    }
    default:
      return;
  }
  renderAll();
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-action-change]');
  if (!el) return;
  switch (el.dataset.actionChange) {
    case 'toggle-done': {
      const t = taskById(el.dataset.id);
      if (!t) return;
      t.done = el.checked;
      t.completedAt = el.checked ? Date.now() : null;
      // 計測中のタスクを完了したらそのタスクの計測を停止
      const r = runningEntryForTask(t.id);
      if (el.checked && r) stopTimer(r.id);
      // 繰り返しタスクを完了したら次回分を自動生成
      if (el.checked && t.repeat) {
        data.tasks.push(nextOccurrence(t));
      }
      save();
      break;
    }
    case 'todo-filter':
      ui.todoFilterProject = el.value;
      break;
    case 'import-backup': {
      const file = el.files && el.files[0];
      el.value = '';
      if (file) importBackup(file); // 確認・保存・再描画はimportBackup側で行う
      return;
    }
    case 'tl-date':
      if (el.value) ui.timelineDate = el.value;
      break;
    case 'gantt-days':
      ui.ganttDays = Number(el.value);
      break;
    case 'gantt-date':
      if (el.value) ui.ganttDate = el.value;
      break;
    case 'agg-from':
      if (el.value) {
        ui.aggFrom = el.value;
        if (ui.aggFrom > ui.aggTo) ui.aggTo = ui.aggFrom;
      }
      break;
    case 'agg-to':
      if (el.value) {
        ui.aggTo = el.value;
        if (ui.aggTo < ui.aggFrom) ui.aggFrom = ui.aggTo;
      }
      break;
    default:
      return;
  }
  renderAll();
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-action-submit]');
  if (!form) return;
  ev.preventDefault();
  const fd = new FormData(form);
  const id = form.dataset.id;
  let syncEntry = null;

  switch (form.dataset.actionSubmit) {
    case 'add-task': {
      const title = String(fd.get('title')).trim();
      if (!title) return;
      data.tasks.push({
        id: uid(),
        title,
        projectId: fd.get('projectId') || null,
        done: false,
        createdAt: Date.now(),
        completedAt: null,
        repeat: fd.get('repeat') || null,
        estimateMinutes: parseEstimate(fd.get('estimateMinutes')),
        note: null,
        ...planRange(fd.get('plannedStart'), fd.get('plannedEnd'), fd.get('plannedStartTime'), fd.get('plannedEndTime')),
      });
      break;
    }
    case 'save-task': {
      const t = taskById(id);
      if (!t) return;
      const title = String(fd.get('title')).trim();
      if (title) t.title = title;
      t.projectId = fd.get('projectId') || null;
      t.repeat = fd.get('repeat') || null;
      t.estimateMinutes = parseEstimate(fd.get('estimateMinutes'));
      t.note = String(fd.get('note') || '').trim() || null;
      Object.assign(t, planRange(fd.get('plannedStart'), fd.get('plannedEnd'), fd.get('plannedStartTime'), fd.get('plannedEndTime')));
      clearEditing();
      break;
    }
    case 'add-entry': {
      const taskId = fd.get('taskId');
      const dayStart = fromDateStr(ui.timelineDate).getTime();
      const start = timeToTs(dayStart, String(fd.get('start')));
      let end = timeToTs(dayStart, String(fd.get('end')));
      if (end <= start) end += 86400000; // 日をまたぐ場合
      const newEntry = { id: uid(), taskId, start, end };
      data.entries.push(newEntry);
      syncEntry = newEntry;
      break;
    }
    case 'save-entry': {
      const e = entryById(id);
      if (!e) return;
      const dayStart = fromDateStr(ui.timelineDate).getTime();
      e.start = timeToTs(dayStart, String(fd.get('start')));
      if (e.end !== null) {
        let end = timeToTs(dayStart, String(fd.get('end')));
        if (end <= e.start) end += 86400000;
        e.end = end;
        syncEntry = e;
      }
      clearEditing();
      break;
    }
    case 'save-running-start': {
      const e = entryById(id);
      if (!e || e.end !== null) return;
      const dayStart = fromDateStr(String(fd.get('startDate'))).getTime();
      const newStart = timeToTs(dayStart, String(fd.get('startTime')));
      if (newStart > Date.now()) {
        alert('開始時刻は現在時刻より前にしてください');
        return;
      }
      e.start = newStart;
      clearEditing();
      break;
    }
    case 'add-client': {
      const name = String(fd.get('name')).trim();
      if (!name) return;
      data.clients.push({ id: uid(), name });
      break;
    }
    case 'save-client': {
      const c = clientById(id);
      if (!c) return;
      const name = String(fd.get('name')).trim();
      if (name) c.name = name;
      clearEditing();
      break;
    }
    case 'add-project': {
      const name = String(fd.get('name')).trim();
      if (!name) return;
      data.projects.push({
        id: uid(),
        name,
        customId: String(fd.get('customId') || '').trim() || null,
        clientId: fd.get('clientId') || null,
        color: PALETTE[data.projects.length % PALETTE.length],
      });
      break;
    }
    case 'save-project': {
      const p = projectById(id);
      if (!p) return;
      const name = String(fd.get('name')).trim();
      if (name) p.name = name;
      p.customId = String(fd.get('customId') || '').trim() || null;
      p.clientId = fd.get('clientId') || null;
      p.color = String(fd.get('color')) || p.color;
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

// 戻る/進むやハッシュの手入力に追従する(renderAll内のreplaceStateでは発火しない)
window.addEventListener('hashchange', () => {
  applyHash();
  renderAll();
});

const SHORTCUT_TABS = { 1: 'todo', 2: 'timeline', 3: 'gantt', 4: 'report', 5: 'manage' };

document.addEventListener('keydown', (ev) => {
  if (ev.isComposing) return; // 日本語入力の変換中は無視
  if (ev.key === 'Escape') {
    if (ui.editingTask || ui.editingEntry || ui.editingClient || ui.editingProject) {
      clearEditing();
      renderAll();
    }
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  if (t.matches && t.matches('input, textarea, select') || t.isContentEditable) return;
  if (SHORTCUT_TABS[ev.key]) {
    ui.tab = SHORTCUT_TABS[ev.key];
    clearEditing();
    renderAll();
  } else if (ev.key === 'n' || ev.key === 'N') {
    ev.preventDefault();
    ui.tab = 'todo';
    clearEditing();
    renderAll();
    const input = document.querySelector('.add-form input[name="title"]');
    if (input) input.focus();
  }
});

// "HH:MM" → タイムスタンプ(dayStart基準)
function timeToTs(dayStart, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return dayStart + (h * 3600 + m * 60) * 1000;
}

/* ---------- ticker ---------- */

setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-live-since]').forEach((el) => {
    el.textContent = fmtClock(now - Number(el.dataset.liveSince));
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
  } catch (e) {
    console.error('データの読み込みに失敗しました', e);
    view.innerHTML = `
      <div class="card">
        <h2>⚠ データを読み込めませんでした</h2>
        <p>サーバー(server.js)との通信に失敗しました。ページを再読み込みしてください。</p>
      </div>`;
    return;
  }
  migrateFromLocalStorage();
  try {
    ui.googleStatus = await fetchGoogleStatus();
  } catch (e) {
    console.error('Google連携状態の取得に失敗しました', e);
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
