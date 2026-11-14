'use strict';

// Enchanter: 画面全体の描画(renderAll)と計測中表示。全タブの描画関数を参照するのでタブより後に読み込む

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

  renderCompareRoot();

  if (deletionHistory.length) {
    view.insertAdjacentHTML('afterbegin', '<div class="undo-banner" role="status">削除を取り消せます（ページを開いている間、最大20件） <button class="btn" data-action="undo-delete">直前の削除を取り消す</button></div>');
  }
  // 全ての状態変更はここを通るので、URLへの反映はこの1箇所だけでよい
  // (replaceStateはhashchangeを発火しないのでループしない)
  history.replaceState(null, '', location.pathname + location.search + buildHash());
}

// 画像候補の比較ボード(全画面)。再描画で一覧のスクロール位置とフォーカスが飛ばないよう引き継ぐ
function renderCompareRoot() {
  const root = document.getElementById('compare-root');
  if (!root) return;
  const body = root.querySelector('.compare-body');
  const scrollTop = body ? body.scrollTop : 0;
  const active = document.activeElement;
  const focused = active && root.contains(active) && active.dataset && active.dataset.action ? {
    action: active.dataset.action, id: active.dataset.id || '', mark: active.dataset.mark || '', value: active.dataset.value || '',
  } : null;
  const html = renderCompareOverlay();
  root.innerHTML = html;
  document.body.classList.toggle('compare-open', Boolean(html));
  // 全画面で開いている間は、背後の画面にTabでフォーカスが移らないようにする
  document.querySelectorAll('.app-header, #view').forEach((element) => { element.inert = Boolean(html); });
  const nextBody = root.querySelector('.compare-body');
  if (nextBody) nextBody.scrollTop = scrollTop;
  if (focused) {
    const next = [...root.querySelectorAll(`[data-action="${focused.action}"]`)].find((element) =>
      (element.dataset.id || '') === focused.id && (element.dataset.mark || '') === focused.mark && (element.dataset.value || '') === focused.value);
    if (next) next.focus({ preventScroll: true });
  } else if (html && !root.contains(document.activeElement)) {
    // 開いた直後はボード内にフォーカスを移し、キー操作(Esc・矢印)がすぐ効くようにする
    const overlay = root.querySelector('.compare-overlay');
    if (overlay) overlay.focus({ preventScroll: true });
  }
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
