'use strict';

// Enchanter: dataを変更する関数群とURLハッシュの保存/復元

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

// 分類エリアを移動する。columnIndexの列のbeforeKeyの直前(nullなら末尾)に入れ、変わったらtrue
function moveTodoGroup(key, columnIndex, beforeKey) {
  const current = normalizeTodoLayout(data.todoLayout);
  if (!TODO_GROUP_KEYS.includes(key) || !current[columnIndex] || key === beforeKey) return false;
  const next = current.map((column) => column.filter((item) => item !== key));
  const target = next[columnIndex];
  const index = beforeKey ? target.indexOf(beforeKey) : -1;
  target.splice(index === -1 ? target.length : index, 0, key);
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  data.todoLayout = next;
  return true;
}

// 分類エリアの列数(1か2)を変える。変わったらtrue
function setTodoColumnCount(count) {
  if (count !== 1 && count !== 2) return false;
  if (normalizeTodoLayout(data.todoLayout).length === count) return false;
  data.todoLayout = relayoutTodoColumns(data.todoLayout, count);
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

// 確認ダイアログは出さない。ゴミ箱の2回クリック(armTaskDelete)で確認し、取り消しバナーで戻せる
function deleteTask(id) {
  rememberDeletion(data.tasks.filter((task) => task.id === id), data.entries.filter((entry) => entry.taskId === id));
  data.tasks = data.tasks.filter((task) => task.id !== id);
  data.entries = data.entries.filter((entry) => entry.taskId !== id);
  save();
  renderAll();
}

// ゴミ箱の1回目のクリック。ボタンを目立たせ、一定時間内にもう一度押されたら削除する
function armTaskDelete(id) {
  disarmTaskDelete();
  armedDeleteTaskId = id;
  const button = taskDeleteButton(id);
  if (button) {
    button.classList.add('delete-armed');
    button.setAttribute('aria-label', button.dataset.armedLabel);
    button.title = button.dataset.armedLabel;
  }
  armedDeleteTimer = setTimeout(disarmTaskDelete, ARMED_DELETE_MS);
}

// 確認状態を解除する。再描画せずにボタンの見た目だけ戻す
function disarmTaskDelete() {
  clearTimeout(armedDeleteTimer);
  armedDeleteTimer = null;
  if (!armedDeleteTaskId) return;
  const button = taskDeleteButton(armedDeleteTaskId);
  armedDeleteTaskId = null;
  if (button) {
    button.classList.remove('delete-armed');
    button.setAttribute('aria-label', button.dataset.label);
    button.title = 'タスクを削除';
  }
}

function taskDeleteButton(id) {
  return [...document.querySelectorAll('[data-action="del-task"]')].find((button) => button.dataset.id === id) || null;
}

// ゴミ箱の2回目のクリック。行を消すアニメーションを見せてから削除する
function removeTaskWithAnimation(id, button) {
  disarmTaskDelete();
  const row = button ? button.closest('.task-item') : null;
  if (!row || row.classList.contains('task-removing')) {
    if (!row) deleteTask(id);
    return;
  }
  row.style.setProperty('--row-height', `${row.offsetHeight}px`);
  row.classList.add('task-removing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    deleteTask(id);
  };
  row.addEventListener('animationend', (event) => { if (event.target === row) finish(); });
  setTimeout(finish, TASK_REMOVE_ANIMATION_MS + 150); // animationendが来ない場合の保険
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
