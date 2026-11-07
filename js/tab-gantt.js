'use strict';

// Enchanter: ガントタブの描画

/* ----- ガントチャートタブ ----- */

const GANTT_LABEL_WIDTH = 160;
const GANTT_DAY_WIDTH = 56;
const GANTT_MONTH_HEIGHT = 26;
const GANTT_HEAD_HEIGHT = 44;
const GANTT_ROW_HEIGHT = 32;

function renderGantt() {
  return `<div class="gantt-board">
    ${renderGanttWeek()}
    ${renderGanttDay()}
  </div>`;
}

// 1日表示のブロックに付ける状態クラス(未着手は付けない)
function planStatusClass(status) {
  switch (status) {
    case 'done': return ' plan-done';
    case 'waiting_review': return ' plan-waiting';
    case 'in_progress': return ' plan-in-progress';
    default: return '';
  }
}

// ツールチップに付ける期限超過・状態の行(未着手で期限内なら何も付けない)
function ganttTipStatus(task, overdue) {
  if (overdue) return '\n⚠ 期限超過';
  if (task.status === 'todo') return '';
  return `\n${TASK_STATUS_ICONS[task.status]} ${TASK_STATUS_LABELS[task.status]}`;
}

// 1日表示: 指定日に時刻付きで予定が入るタスクを、その日の範囲に切り詰めた項目にする
function ganttDayItems(day) {
  const dayStart = fromDateStr(day).getTime();
  const dayEnd = dayStart + MS_PER_DAY;
  return data.tasks
    .filter((task) => task.plannedStart && task.plannedStart <= day && day <= task.plannedEnd && hasTimeOnDay(task, day))
    .map((task) => {
      let start = dayStart;
      let end = dayEnd;
      if (task.plannedStart === day && task.plannedStartTime) start = timeToTimestamp(dayStart, task.plannedStartTime);
      if (task.plannedEnd === day && task.plannedEndTime) end = timeToTimestamp(dayStart, task.plannedEndTime);
      if (end <= start) end = dayEnd;
      return { task, start, clipStart: start, clipEnd: end };
    });
}

// 1日単位: 時刻に沿ってタスクを配置するガントチャート(タイムラインと同じ時間軸UIを再利用)
function renderGanttDay() {
  const day = ui.ganttDate;
  const dayStart = fromDateStr(day).getTime();
  const today = todayStr();
  const items = ganttDayItems(day);
  const laneCount = Math.max(1, assignLanes(items));

  const blocks = items.map((item) => {
    const task = item.task;
    const project = projectById(task.projectId);
    const startMin = Math.round((item.clipStart - dayStart) / MS_PER_MINUTE);
    const endMin = Math.round((item.clipEnd - dayStart) / MS_PER_MINUTE);
    // 予定が1日に収まるタスクだけ、時刻をドラッグで動かせる
    const draggable = task.plannedStart === day && task.plannedEnd === day;
    const overdue = isOverdue(task, today);
    const stateClasses = `${planStatusClass(task.status)}${overdue ? ' plan-overdue' : ''}${draggable ? ' gantt-day-draggable' : ''}`;
    const tip = `${task.title}${project ? ` (${project.name})` : ''}\n${fmtTime(item.clipStart)} 〜 ${fmtTime(item.clipEnd)}${ganttTipStatus(task, overdue)}`;
    const label = project ? `${esc(task.title)} <span class="tl-block-project">・${esc(project.name)}</span>` : esc(task.title);
    return `<div class="tl-block${stateClasses}"
      style="${timelineBlockPosition(item, dayStart)};background:${projectColor(task.projectId)}"
      ${draggable ? `data-action-pointer="gantt-day-drag" data-id="${esc(task.id)}" data-day="${esc(day)}" data-start-min="${startMin}" data-end-min="${endMin}"` : ''}
      title="${esc(tip)}">${label}</div>`;
  }).join('');

  return `
    <div class="card">
      <div class="tl-header">
        <span class="tl-date-label">🕐 1日</span>
        <span class="tl-total">${fmtDateJa(day)}</span>
        <button class="btn" data-action="gantt-day-shift" data-days="-1">◀ 前日</button>
        <input type="date" value="${esc(day)}" data-action-change="gantt-date" aria-label="1日表示の日付">
        <button class="btn" data-action="gantt-day-shift" data-days="1">翌日 ▶</button>
        <button class="btn" data-action="gantt-day-today">今日</button>
      </div>
      ${renderPlannedForDay(day, { untimedOnly: true, label: '📅 終日:' })}
      <div class="timeline-wrap">
        <div class="timeline">
          <div class="tl-hours">${hourLabels(1)}</div>
          <div class="tl-lanes" style="width:${laneCount * TIMELINE_LANE_WIDTH}px">${blocks}</div>
        </div>
      </div>
    </div>`;
}

// 週表示の行。表示期間と重なる予定付きタスクを、プロジェクトごとにまとめて並べる(未所属は最後)
function ganttWeekColumns(startStr, endStr) {
  const inWindow = data.tasks.filter((task) => task.plannedStart && task.plannedStart <= endStr && task.plannedEnd >= startStr);
  const byPlan = (a, b) => (a.plannedStart !== b.plannedStart
    ? (a.plannedStart < b.plannedStart ? -1 : 1)
    : a.createdAt - b.createdAt);
  const columns = [];
  const sortedProjects = [...data.projects]
    .sort((a, b) => projectLabel(a.id).localeCompare(projectLabel(b.id), 'ja'));
  for (const project of sortedProjects) {
    for (const task of inWindow.filter((item) => item.projectId === project.id).sort(byPlan)) {
      columns.push({ task, project });
    }
  }
  for (const task of inWindow.filter((item) => !projectById(item.projectId)).sort(byPlan)) {
    columns.push({ task, project: null });
  }
  return columns;
}

// 週表示の月見出し(最上段)。同じ月が続く日付を1つのセルにまとめる
function ganttWeekMonthHeadings(start, days) {
  const runs = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const last = runs[runs.length - 1];
    if (last && last.year === date.getFullYear() && last.month === date.getMonth()) {
      last.end = i + 3;
    } else {
      runs.push({ year: date.getFullYear(), month: date.getMonth(), begin: i + 2, end: i + 3 });
    }
  }
  return runs.map((run, index) => {
    const yearPrefix = index === 0 || run.month === 0 ? `${run.year}年` : '';
    return `<div class="gantt-month-v" style="grid-column:${run.begin} / ${run.end};grid-row:1"><span>${esc(`${yearPrefix}${run.month + 1}月`)}</span></div>`;
  }).join('');
}

// 週表示の日付見出し(上段)と背景の縦ストライプ(日付ごとの列)
function ganttWeekDayHeadings(start, days, today) {
  let dayHeads = '';
  let backgroundCols = '';
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const weekday = date.getDay();
    const dayClasses = `${weekday === 0 || weekday === 6 ? ' weekend' : ''}${toDateStr(date) === today ? ' today' : ''}`;
    const label = (i === 0 || date.getDate() === 1) ? `${date.getMonth() + 1}/${date.getDate()}` : date.getDate();
    dayHeads += `<div class="gantt-day-v${dayClasses}" style="grid-column:${i + 2};top:${GANTT_MONTH_HEIGHT}px"><span>${label}</span><span class="wd">${WEEKDAY_LABELS[weekday]}</span></div>`;
    backgroundCols += `<div class="gantt-grid-row${dayClasses}" style="grid-column:${i + 2}"></div>`;
  }
  return { dayHeads, backgroundCols };
}

// ガントの行ラベル用の計測ボタン。インライン編集フォームは行の高さに収まらないため出さない(開始時刻の編集はTodoタブで行う)
function ganttTimerControl(task, running, now) {
  if (task.status === 'done') return '';
  return running ? timerStopButton(running, now) : timerStartButton(task);
}

// 週表示のタスク行(左端の見出し + 日付軸上の横棒)
function ganttWeekRowsHtml(columns, { start, startStr, endStr, days, today }) {
  const dayIndex = (dateStr) => Math.round((fromDateStr(dateStr) - start) / MS_PER_DAY);
  const now = Date.now();
  let rowLabels = '';
  let bars = '';
  columns.forEach((column, index) => {
    const task = column.task;
    const row = index + 3;
    const running = runningEntryForTask(task.id);
    const startIdx = Math.max(dayIndex(task.plannedStart), 0);
    const endIdx = Math.min(dayIndex(task.plannedEnd), days - 1);
    const overdue = isOverdue(task, today);
    const statusClass = statusRowClass(task);
    const statusSuffix = statusClass ? ' ' + statusClass : '';
    const barClasses = `${statusSuffix}${overdue ? ' overdue' : ''}` +
      `${task.plannedStart < startStr ? ' clip-left' : ''}${task.plannedEnd > endStr ? ' clip-right' : ''}`;
    const totalDays = dayIndex(task.plannedEnd) - dayIndex(task.plannedStart) + 1;
    const tip = `${task.title}${column.project ? ` (${column.project.name})` : ''}\n${planLabel(task)} (${totalDays}日間)${ganttTipStatus(task, overdue)}`;
    rowLabels += `
      <div class="gantt-col-label${statusSuffix}" style="grid-row:${row};line-height:${GANTT_ROW_HEIGHT}px" title="${esc(tip)}">
        <span class="gantt-col-name">
          <span class="chip-dot" style="background:${projectColor(task.projectId)}"></span>
          ${overdue ? '<span class="overdue-mark">⚠</span> ' : ''}${esc(task.title)}
          ${column.project ? `<span class="gantt-col-project">・${esc(column.project.name)}</span>` : ''}
        </span>
        ${ganttTimerControl(task, running, now)}
      </div>`;
    bars += `<div class="gantt-bar-v${barClasses}" style="grid-column:${startIdx + 2} / ${endIdx + 3};grid-row:${row};background:${projectColor(task.projectId)}"
        data-action-pointer="gantt-drag" data-id="${esc(task.id)}" data-day-width="${GANTT_DAY_WIDTH}"
        title="${esc(tip)}"></div>`;
  });
  return { rowLabels, bars };
}

// 週(複数日)単位: プロジェクトごとにまとめたタスクを日付軸に沿って表示するガントチャート
function renderGanttWeek() {
  const days = ui.ganttDays;
  const rangeLabel = { 7: '1週間', 14: '2週間', 28: '4週間', 56: '8週間' }[days] || `${days}日間`;
  const start = fromDateStr(ui.ganttStart);
  const startStr = ui.ganttStart;
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + days - 1);
  const endStr = toDateStr(endDate);
  const today = todayStr();
  const columns = ganttWeekColumns(startStr, endStr);
  const monthHeads = ganttWeekMonthHeadings(start, days);
  const { dayHeads, backgroundCols } = ganttWeekDayHeadings(start, days, today);
  const { rowLabels, bars } = ganttWeekRowsHtml(columns, { start, startStr, endStr, days, today });

  return `
    <div class="card">
      <div class="tl-header">
        <span class="tl-date-label">📅 ${rangeLabel}</span>
        <span class="tl-total">${fmtDateJa(startStr)} 〜 ${fmtDateJa(endStr)}</span>
        <select data-action-change="gantt-days" aria-label="ガントの表示期間">
          <option value="7"${days === 7 ? ' selected' : ''}>1週間</option>
          <option value="14"${days === 14 ? ' selected' : ''}>2週間</option>
          <option value="28"${days === 28 ? ' selected' : ''}>4週間</option>
          <option value="56"${days === 56 ? ' selected' : ''}>8週間</option>
        </select>
        <button class="btn" data-action="gantt-shift" data-days="-7">◀ 前週</button>
        <button class="btn" data-action="gantt-today">今日</button>
        <button class="btn" data-action="gantt-shift" data-days="7">翌週 ▶</button>
      </div>
      ${columns.length ? `
        <div class="gantt-wrap">
          <div class="gantt-v" style="grid-template-columns:${GANTT_LABEL_WIDTH}px repeat(${days}, ${GANTT_DAY_WIDTH}px);grid-template-rows:${GANTT_MONTH_HEIGHT}px ${GANTT_HEAD_HEIGHT}px repeat(${columns.length}, ${GANTT_ROW_HEIGHT}px)">
            ${backgroundCols}
            <div class="gantt-corner-top"></div>
            ${monthHeads}
            <div class="gantt-corner" style="top:${GANTT_MONTH_HEIGHT}px">タスク</div>
            ${dayHeads}
            ${rowLabels}
            ${bars}
          </div>
        </div>` : '<p class="empty">この期間に予定日程が設定されたタスクはありません。Todoタブでタスクに予定を設定してください。</p>'}
    </div>`;
}
