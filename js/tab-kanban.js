'use strict';

// Enchanter: カンバンタブの描画

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
      ${kanbanImageCover(task)}
      <div class="kanban-card-control" tabindex="0" role="slider"
        aria-label="${esc(task.title)}のステータス" aria-valuemin="0" aria-valuemax="${TASK_STATUS_ORDER.length - 1}"
        aria-valuenow="${statusIndex}" aria-valuetext="${TASK_STATUS_LABELS[task.status]}"
        aria-orientation="horizontal" aria-keyshortcuts="ArrowLeft ArrowRight">
        <div class="kanban-card-title">${esc(task.title)}</div>
        <div class="kanban-card-meta">
          ${commonTaskChips(task)}
          ${tagChips(task)}
          ${(task.links || []).length ? `<span class="chip" title="資料リンク">🔗 ${task.links.length}</span>` : ''}
          ${kanbanImageChip(task)}
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
