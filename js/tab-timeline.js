'use strict';

// Enchanter: タイムラインタブの描画

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
