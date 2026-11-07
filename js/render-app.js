'use strict';

// Enchanter: 画面全体の描画(renderAll)と計測中表示・祝福演出。全タブの描画関数を参照するのでタブより後に読み込む

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

  if (ui.inboxNotice) {
    view.insertAdjacentHTML('afterbegin', `<div class="undo-banner inbox-banner" role="status">${esc(ui.inboxNotice)} <button class="btn" data-action="dismiss-inbox-notice">閉じる</button></div>`);
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

/* ---------- celebration ---------- */

// 粒子数・飛散幅・寿命(ms)。完了 > 停止 > 開始の順に派手にする
const CELEBRATIONS = {
  complete: { particles: 60, spread: 360, life: 1800, rings: 2, flash: 0.6, label: '完了!' },
  stop: { particles: 30, spread: 240, life: 1400, rings: 1, flash: 0.4, label: '停止' },
  start: { particles: 18, spread: 160, life: 1100, rings: 1, flash: 0, label: '開始' },
};
// 連打で演出が増え続けないよう、同時に残すのは最新の2つまで
const CELEBRATION_MAX_LAYERS = 2;
const CELEBRATION_CLEANUP_MARGIN = 300;
const celebrationLayers = [];

// 演出の起点は押されたボタンの中心。描画で要素が消える前に取得すること
function centerOf(element) {
  if (!element || !element.getBoundingClientRect) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function removeCelebrationLayer(item) {
  clearTimeout(item.timer);
  item.layer.remove();
  const index = celebrationLayers.indexOf(item);
  if (index >= 0) celebrationLayers.splice(index, 1);
}

// 祝福演出を body 直下のレイヤーとして出す。#view の再描画では消えない。操作は妨げない(pointer-events: none)
function celebrate(kind, origin, detail) {
  const config = CELEBRATIONS[kind];
  if (!config) return;
  while (celebrationLayers.length >= CELEBRATION_MAX_LAYERS) removeCelebrationLayer(celebrationLayers[0]);
  const rand = (min, max) => min + Math.random() * (max - min);
  const layer = document.createElement('div');
  layer.className = `celebrate-layer celebrate-layer--${kind}`;
  layer.setAttribute('aria-hidden', 'true');
  // 画面外の起点（スクロールで隠れたボタン等）でも演出が見えるよう、画面内に丸める
  const clampTo = (value, max) => Math.min(Math.max(value, 0), max);
  layer.style.setProperty('--x', `${clampTo(origin ? origin.x : window.innerWidth / 2, window.innerWidth)}px`);
  layer.style.setProperty('--y', `${clampTo(origin ? origin.y : window.innerHeight / 2, window.innerHeight)}px`);
  layer.style.setProperty('--life', `${config.life}ms`);
  if (config.flash) {
    const flash = document.createElement('div');
    flash.className = 'celebrate-flash';
    flash.style.setProperty('--peak', String(config.flash));
    layer.appendChild(flash);
  }
  for (let i = 0; i < config.rings; i++) {
    const ring = document.createElement('div');
    ring.className = 'celebrate-ring';
    ring.style.setProperty('--delay', `${i * 180}ms`);
    layer.appendChild(ring);
  }
  for (let i = 0; i < config.particles; i++) {
    const piece = document.createElement('i');
    piece.className = Math.random() < 0.4 ? 'celebrate-particle celebrate-particle--round' : 'celebrate-particle';
    piece.style.setProperty('--dx', `${rand(-config.spread, config.spread)}px`);
    piece.style.setProperty('--dy', `${rand(-config.spread, config.spread * 0.3)}px`);
    piece.style.setProperty('--fall', `${rand(80, 200)}px`);
    piece.style.setProperty('--rot', `${rand(-720, 720)}deg`);
    piece.style.setProperty('--hue', String(Math.floor(rand(0, 360))));
    piece.style.setProperty('--size', `${rand(6, 12)}px`);
    piece.style.setProperty('--delay', `${rand(0, 150)}ms`);
    piece.style.setProperty('--life', `${Math.round(config.life * rand(0.8, 1))}ms`);
    layer.appendChild(piece);
  }
  const text = document.createElement('div');
  text.className = 'celebrate-text';
  text.textContent = detail ? `${config.label} ${detail}` : config.label;
  layer.appendChild(text);
  const item = { layer, timer: null };
  item.timer = setTimeout(() => removeCelebrationLayer(item), config.life + CELEBRATION_CLEANUP_MARGIN);
  celebrationLayers.push(item);
  document.body.appendChild(layer);
}

// 各要素は自分のアニメーション終了時に外す(レイヤー単位の後始末はcelebrateのタイマーが担う)
document.addEventListener('animationend', (event) => {
  const target = event.target;
  if (!target.closest || target.classList.contains('celebrate-layer')) return;
  if (target.closest('.celebrate-layer')) target.remove();
});
