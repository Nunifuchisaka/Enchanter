'use strict';

// Enchanter: 委譲イベントリスナー(click/change/submit/pointer/keydown)

/* ---------- events ---------- */

// カンバンのドラッグ中に付けた挿入位置の目印(直前・直後のカード)を外す
function clearInsertMarkers() {
  document.querySelectorAll('.kanban-insert-before, .kanban-insert-after').forEach((card) => {
    card.classList.remove('kanban-insert-before', 'kanban-insert-after');
  });
}

/* ----- 画像候補の比較ボード ----- */

// 比較ボードのクリック操作。falseを返したら再描画しない
function handleCompareClick(action, id, element) {
  const task = taskById(ui.compareTaskId);
  switch (action) {
    case 'compare-open':
      openCompare(id);
      return true;
    case 'compare-close':
      closeCompare();
      return true;
  }
  if (!task) return false;
  switch (action) {
    case 'compare-focus':
      ui.compareFocusId = imageById(task, id) ? id : null;
      ui.compareActualSize = false;
      break;
    case 'compare-unfocus':
      ui.compareFocusId = null;
      break;
    case 'compare-step':
      stepCompareFocus(task, Number(element.dataset.delta));
      break;
    case 'compare-actual':
      ui.compareActualSize = !ui.compareActualSize;
      break;
    case 'compare-filter':
      if (!COMPARE_FILTERS.includes(element.dataset.value)) return false;
      ui.compareFilter = element.dataset.value;
      break;
    case 'compare-bg':
      if (!COMPARE_BACKGROUNDS[element.dataset.value]) return false;
      comparePrefs.bg = element.dataset.value;
      storeComparePrefs();
      break;
    case 'compare-complete':
      if (!pickedImage(task)) return false;
      setTaskStatus(task, 'done');
      closeCompare();
      save();
      break;
    case 'image-mark':
      if (!toggleImageMark(task, id, element.dataset.mark)) return false;
      save();
      break;
    case 'image-pick':
      if (!togglePickImage(task, id)) return false;
      save();
      break;
    case 'image-move':
      if (!moveTaskImage(task, id, Number(element.dataset.delta))) return false;
      save();
      break;
    case 'image-delete':
      if (armedDeleteImageId !== id) {
        armedDeleteImageId = id;
        break;
      }
      armedDeleteImageId = null;
      if (removeTaskImage(task, id)) save();
      break;
    case 'image-from-links':
      if (!addTaskImages(task, linkImageCandidates(task).map((link) => ({ url: link.url, label: link.title }))).length) return false;
      save();
      break;
    default:
      return false;
  }
  return true;
}

// 比較ボードを開いている間のキー操作。trueを返したら他のショートカットは処理しない
function handleCompareKey(event, isTextInput) {
  const task = taskById(ui.compareTaskId);
  if (!task) return false;
  if (event.key === 'Escape') {
    event.preventDefault();
    // 入力中ならまず入力欄を抜ける(changeで保存される)。描き直して入力途中の内容を消さない
    if (isTextInput) event.target.blur();
    else if (ui.compareFocusId) ui.compareFocusId = null;
    else closeCompare();
    if (!isTextInput) renderAll();
    return true;
  }
  if (isTextInput || event.ctrlKey || event.metaKey || event.altKey) return true;
  const key = event.key.toLowerCase();
  const images = taskImages(task);
  if (/^[1-9]$/.test(key)) {
    const image = images[Number(key) - 1];
    if (image) {
      ui.compareFocusId = image.id;
      ui.compareActualSize = false;
      renderAll();
    }
    return true;
  }
  if (!ui.compareFocusId) return true;
  const actions = {
    arrowleft: () => stepCompareFocus(task, -1),
    arrowright: () => stepCompareFocus(task, 1),
    g: () => toggleImageMark(task, ui.compareFocusId, 'good') && save(),
    x: () => toggleImageMark(task, ui.compareFocusId, 'out') && save(),
    p: () => togglePickImage(task, ui.compareFocusId) && save(),
    z: () => { ui.compareActualSize = !ui.compareActualSize; },
  };
  if (!actions[key]) return true;
  event.preventDefault();
  actions[key]();
  renderAll();
  return true;
}

// ドラッグ中のものが画像として取り込めるか(ファイル、または他のページからドラッグした画像・URL)
function isImageDrag(dataTransfer) {
  const types = dataTransfer ? [...dataTransfer.types] : [];
  return types.includes('Files') || types.includes('text/uri-list');
}

// 他のページからドラッグした画像のURL。<img>のsrcを優先し、リンクは画像を指すものだけを受け付ける
// (資料リンクのチップなどをうっかり落としても、画像でないページを候補にしない)
function droppedImageUrl(dataTransfer) {
  const html = dataTransfer.getData('text/html') || '';
  const match = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html);
  const src = match ? safeLinkUrl(match[1].replace(/&amp;/g, '&')) : null;
  if (src) return src;
  const uri = (dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  return uri && IMAGE_URL_RE.test(uri) ? safeLinkUrl(uri) : null;
}

function clearDropHighlight() {
  document.querySelectorAll('.image-drop-over').forEach((element) => element.classList.remove('image-drop-over'));
}

document.addEventListener('dragover', (event) => {
  if (!isImageDrag(event.dataTransfer)) return;
  const zone = event.target.closest ? event.target.closest('[data-image-drop]') : null;
  // 比較ボードを開いている間は、取りこぼしたドロップでブラウザが画像のページへ移らないようにする
  if (!zone && !ui.compareTaskId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = zone ? 'copy' : 'none';
  if (zone && !zone.classList.contains('image-drop-over')) {
    clearDropHighlight();
    zone.classList.add('image-drop-over');
  }
});

document.addEventListener('dragleave', (event) => {
  const zone = event.target.closest ? event.target.closest('[data-image-drop]') : null;
  if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('image-drop-over');
});

document.addEventListener('drop', (event) => {
  if (!isImageDrag(event.dataTransfer)) return;
  const zone = event.target.closest ? event.target.closest('[data-image-drop]') : null;
  if (!zone && !ui.compareTaskId) return;
  event.preventDefault();
  clearDropHighlight();
  if (!zone) return;
  const files = event.dataTransfer.files;
  if (files && files.length) {
    addImageFilesToTask(zone.dataset.id, files);
    return;
  }
  const url = droppedImageUrl(event.dataTransfer);
  if (!url || !addImageUrlToTask(zone.dataset.id, url)) return;
  openCompare(zone.dataset.id, ui.compareTaskId === zone.dataset.id ? ui.compareFocusId : null);
  renderAll();
});

// 比較ボードを開いている間は、スクリーンショットなどの画像の貼り付けで候補を追加する
document.addEventListener('paste', (event) => {
  if (!ui.compareTaskId || !event.clipboardData) return;
  const files = [...(event.clipboardData.files || [])].filter((file) => /^image\//.test(file.type));
  if (files.length) {
    event.preventDefault();
    addImageFilesToTask(ui.compareTaskId, files);
    return;
  }
  if (event.target.matches && event.target.matches('input, textarea')) return;
  const text = event.clipboardData.getData('text') || '';
  if (!/^\s*https?:\/\//i.test(text)) return;
  event.preventDefault();
  if (addImageUrlToTask(ui.compareTaskId, text)) renderAll();
});

// 比較ボードの大きさスライダーは、動かしている間も描き直さずに幅だけ変える
document.addEventListener('input', (event) => {
  const element = event.target.closest ? event.target.closest('[data-action-input]') : null;
  if (!element || element.dataset.actionInput !== 'compare-size') return;
  comparePrefs.size = clampCompareSize(element.value);
  storeComparePrefs();
  document.querySelectorAll('.compare-grid').forEach((grid) => grid.style.setProperty('--compare-size', `${comparePrefs.size}px`));
  document.querySelectorAll('.compare-size-value').forEach((output) => { output.textContent = `${comparePrefs.size}px`; });
});

// Todoの分類エリアのドラッグ中に付けた挿入位置の目印を外す
function clearTodoGroupMarkers() {
  document.querySelectorAll('.todo-group-insert-before, .todo-column-insert-end, .todo-column.drop-target').forEach((element) => {
    element.classList.remove('todo-group-insert-before', 'todo-column-insert-end', 'drop-target');
  });
}

// ポインター位置の列と、その列で直前に入れる分類エリアを求める(nullなら列の末尾)
// 列の外(列の間の隙間や、短い列の下の余白)で離しても、最も近い列に入れる
function todoGroupDropPosition(clientX, clientY, draggedKey) {
  const area = document.querySelector('.todo-columns');
  if (!area) return null;
  const areaRect = area.getBoundingClientRect();
  if (clientY < areaRect.top - 80 || clientY > areaRect.bottom + 200 ||
    clientX < areaRect.left - 80 || clientX > areaRect.right + 80) return null;
  const distanceTo = (rect) => Math.hypot(
    Math.max(rect.left - clientX, 0, clientX - rect.right),
    Math.max(rect.top - clientY, 0, clientY - rect.bottom),
  );
  const column = [...area.querySelectorAll('.todo-column')].reduce((best, item) => {
    const distance = distanceTo(item.getBoundingClientRect());
    return !best || distance < best.distance ? { item, distance } : best;
  }, null)?.item || null;
  if (!column) return null;
  const before = [...column.querySelectorAll(':scope > .task-group')]
    .filter((group) => group.dataset.groupKey !== draggedKey)
    .find((group) => {
      const rect = group.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    }) || null;
  return { column, before };
}

// 分類エリアを動かして保存し、操作したつまみにフォーカスを戻す
function commitTodoGroupMove(key, columnIndex, beforeKey) {
  if (!moveTodoGroup(key, columnIndex, beforeKey)) return;
  save();
  renderAll();
  const handle = document.querySelector(`.group-drag-handle[data-key="${key}"]`);
  if (handle) handle.focus({ preventScroll: true });
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  // 削除の確認状態は、そのゴミ箱以外のどこかをクリックしたら解除する
  if (armedDeleteTaskId && !(element && element.dataset.action === 'del-task' && element.dataset.id === armedDeleteTaskId)) {
    disarmTaskDelete();
  }
  // 画像候補の削除の確認状態も、同じボタン以外のクリックで解除する
  if (armedDeleteImageId && !(element && element.dataset.action === 'image-delete' && element.dataset.id === armedDeleteImageId)) {
    armedDeleteImageId = null;
    if (!element) renderAll();
  }
  if (!element) return;
  const action = element.dataset.action;
  const id = element.dataset.id;
  if (action.startsWith('compare-') || action.startsWith('image-')) {
    if (handleCompareClick(action, id, element) !== false) renderAll();
    return;
  }

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
    case 'reset-todo-layout':
      data.todoLayout = null;
      save();
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
    case 'image-label':
    case 'image-note': {
      // 入力欄を描き直すとTabで移った先のフォーカスが外れるので、保存だけして再描画しない
      const image = imageById(taskById(ui.compareTaskId), element.dataset.id);
      if (!image) return;
      const value = element.value.trim();
      image[element.dataset.actionChange === 'image-label' ? 'label' : 'note'] = value || null;
      save();
      return;
    }
    case 'image-files': {
      const files = [...(element.files || [])];
      element.value = '';
      if (files.length) addImageFilesToTask(element.dataset.id, files); // 保存・再描画はaddImageFilesToTask側で行う
      return;
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
    case 'image-url': {
      if (!addImageUrlToTask(id, formData.get('url'))) {
        alert('http(s)で始まる画像のURLを入力してください(すでに追加済みのURLは追加しません)');
        return;
      }
      break;
    }
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
        links: parseLinks(formData.get('links')),
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
      task.links = parseLinks(formData.get('links'));
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
  if (element.dataset.actionPointer === 'todo-group-drag') {
    const group = element.closest('.task-group');
    if (!group) return;
    event.preventDefault();
    todoGroupDrag = {
      element: group,
      handle: element,
      pointerId: event.pointerId,
      key: element.dataset.key,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
    element.setPointerCapture(event.pointerId);
    return;
  }
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
  if (todoGroupDrag && event.pointerId === todoGroupDrag.pointerId) {
    const dx = event.clientX - todoGroupDrag.startX;
    const dy = event.clientY - todoGroupDrag.startY;
    if (!todoGroupDrag.started && Math.hypot(dx, dy) > 4) {
      todoGroupDrag.started = true;
      todoGroupDrag.element.classList.add('dragging');
      document.querySelector('.todo-columns')?.classList.add('todo-columns-dragging');
    }
    if (todoGroupDrag.started) {
      todoGroupDrag.element.style.transform = `translate(${dx}px, ${dy}px)`;
      clearTodoGroupMarkers();
      const position = todoGroupDropPosition(event.clientX, event.clientY, todoGroupDrag.key);
      if (position) {
        position.column.classList.add('drop-target');
        if (position.before) position.before.classList.add('todo-group-insert-before');
        else position.column.classList.add('todo-column-insert-end');
      }
    }
    return;
  }
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

// 分類エリアのドラッグを終える。列の上で離したときだけ配置を保存する
function finishTodoGroupDrag(event, commit) {
  if (!todoGroupDrag || event.pointerId !== todoGroupDrag.pointerId) return;
  const drag = todoGroupDrag;
  const position = commit && drag.started ? todoGroupDropPosition(event.clientX, event.clientY, drag.key) : null;
  clearTodoGroupMarkers();
  todoGroupDrag = null;
  drag.element.classList.remove('dragging');
  drag.element.style.transform = '';
  document.querySelector('.todo-columns')?.classList.remove('todo-columns-dragging');
  if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  if (!position) return;
  commitTodoGroupMove(drag.key, Number(position.column.dataset.layoutColumn), position.before ? position.before.dataset.groupKey : null);
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

document.addEventListener('pointerup', (event) => {
  finishTodoGroupDrag(event, true);
  finishKanbanDrag(event, true);
  finishGanttDrag(event, true);
});
document.addEventListener('pointercancel', (event) => {
  finishTodoGroupDrag(event, false);
  finishKanbanDrag(event, false);
  finishGanttDrag(event, false);
});

// 戻る/進むやハッシュの手入力に追従する(renderAll内のreplaceStateでは発火しない)
window.addEventListener('hashchange', () => {
  applyHash();
  renderAll();
});

// 別のウィンドウ(CLIを動かしているターミナルなど)から戻ってきたら、外部の変更を取り込む
document.addEventListener('visibilitychange', checkExternalChange);

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
  if (ui.compareTaskId && handleCompareKey(event, isTextInput)) return;
  // 分類エリアのつまみ: Alt+↑↓で列内の順番、Alt+←→で隣の列へ移動する
  const groupHandle = target.closest ? target.closest('.group-drag-handle') : null;
  if (groupHandle && event.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const key = groupHandle.dataset.key;
    const layout = normalizeTodoLayout(data.todoLayout);
    const columnIndex = layout.findIndex((column) => column.includes(key));
    const column = layout[columnIndex];
    const index = column.indexOf(key);
    if (event.key === 'ArrowUp' && index > 0) commitTodoGroupMove(key, columnIndex, column[index - 1]);
    if (event.key === 'ArrowDown' && index < column.length - 1) commitTodoGroupMove(key, columnIndex, column[index + 2] || null);
    const nextColumn = columnIndex + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0);
    if (nextColumn !== columnIndex && layout[nextColumn]) commitTodoGroupMove(key, nextColumn, layout[nextColumn][index] || null);
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
