'use strict';

// Enchanter: Todoタブの描画

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
          <input type="text" name="title" placeholder="サブタスクを追加...(複数行の貼り付けで一括追加)" aria-label="サブタスク名" required>
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
          <textarea name="links" rows="2" placeholder="資料リンク(1行に1件。「タイトル URL」またはURLのみ)" aria-label="資料リンク">${esc(linksToText(task.links))}</textarea>
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
    <li data-task-row="${esc(task.id)}" class="task-item ${statusClass}${isDueToday(task) ? ' due-today' : ''}">
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
          ${linkChips(task)}
          ${totalChip(task, totalMs)}
        </div>
        ${subtaskBlockHtml(task)}
      </div>
      <div class="task-actions">
        ${todoTimerControls(task, running, now)}
        ${task.status !== 'done' ? `<button class="btn" data-action="toggle-today" data-id="${esc(task.id)}" aria-pressed="${isToday}">${isToday ? '★ 今日やる' : '☆ 今日やる'}</button>` : ''}
        <button class="btn-icon" data-action="edit-task" data-id="${esc(task.id)}" title="タスクを編集" aria-label="${esc(task.title)}を編集">✎</button>
        ${taskDeleteButtonHtml(task)}
      </div>
    </li>`;
}

// タスクの削除ボタン。1回目のクリックで確認状態(.delete-armed)になり、2回目で削除する
function taskDeleteButtonHtml(task) {
  const entryCount = data.entries.filter((entry) => entry.taskId === task.id).length;
  const label = `${task.title}を削除`;
  const armedLabel = `もう一度クリックで「${task.title}」を削除${entryCount > 0 ? `(作業記録 ${entryCount} 件も削除)` : ''}`;
  const armed = armedDeleteTaskId === task.id;
  return `<button class="btn-icon danger task-delete${armed ? ' delete-armed' : ''}" data-action="del-task" data-id="${esc(task.id)}"
    data-label="${esc(label)}" data-armed-label="${esc(armedLabel)}"
    title="${armed ? esc(armedLabel) : 'タスクを削除'}" aria-label="${esc(armed ? armedLabel : label)}"><span class="task-delete-icon" aria-hidden="true">🗑</span><span class="task-delete-confirm" aria-hidden="true">削除?</span></button>`;
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
            <label class="field field-wide"><span class="field-label">資料リンク(1行に1件。「タイトル URL」またはURLのみ)</span>
              <textarea name="links" rows="2" placeholder="仕様書 https://example.com/spec"></textarea>
            </label>
          </div>
        </details>
      </form>
    </div>`;
}

// チェックリストを持つ進行中タスクの達成度を、残りが多い順に一覧する(Todoの絞り込みに従う)
function checklistProgressBoard(activeTasks) {
  const rows = activeTasks
    .filter((task) => (task.subtasks || []).length)
    .map((task) => {
      const total = task.subtasks.length;
      const doneCount = task.subtasks.filter((subtask) => subtask.done).length;
      return { task, total, doneCount, ratio: doneCount / total };
    })
    .sort((a, b) => a.ratio - b.ratio || parseLevel(b.task.importance) - parseLevel(a.task.importance) || (b.total - b.doneCount) - (a.total - a.doneCount));
  if (!rows.length) return '';
  const allTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const allDone = rows.reduce((sum, row) => sum + row.doneCount, 0);
  const percent = (value) => Math.round(value * 100);
  return `
    <details class="progress-board" data-details-key="progress-board">
      <summary>📊 チェックリストの進み具合 <span class="section-count">${allDone}/${allTotal}(${percent(allDone / allTotal)}%)</span></summary>
      <ul class="progress-board-list">
        ${rows.map(({ task, total, doneCount, ratio }) => `
          <li class="progress-board-row${doneCount === total ? ' complete' : ''}">
            <span class="chip-dot" style="background:${projectColor(task.projectId)}"></span>
            <button type="button" class="progress-board-title" data-action="jump-to-task" data-id="${esc(task.id)}" title="タスクの位置へ移動">${esc(task.title)}</button>
            <span class="progress" aria-hidden="true"><span class="progress-fill" style="width:${percent(ratio)}%"></span></span>
            <span class="progress-board-count">${doneCount}/${total}</span>
          </li>`).join('')}
      </ul>
    </details>`;
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
      ${checklistProgressBoard(activeTasks)}
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
