'use strict';

// Enchanter: 委譲イベントリスナー(click/change/submit/pointer/keydown)

/* ---------- events ---------- */

// カンバンのドラッグ中に付けた挿入位置の目印(直前・直後のカード)を外す
function clearInsertMarkers() {
  document.querySelectorAll('.kanban-insert-before, .kanban-insert-after').forEach((card) => {
    card.classList.remove('kanban-insert-before', 'kanban-insert-after');
  });
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  // 削除の確認状態は、そのゴミ箱以外のどこかをクリックしたら解除する
  if (armedDeleteTaskId && !(element && element.dataset.action === 'del-task' && element.dataset.id === armedDeleteTaskId)) {
    disarmTaskDelete();
  }
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
      if (armedDeleteTaskId === id) removeTaskWithAnimation(id, element);
      else armTaskDelete(id);
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
    if (armedDeleteTaskId) {
      disarmTaskDelete();
      return;
    }
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
