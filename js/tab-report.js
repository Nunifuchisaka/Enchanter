'use strict';

// Enchanter: 集計タブの描画

/* ----- 集計タブ ----- */

// 期間内の作業時間を client → project → task の階層に集計する
function buildReportTree(fromStr, toStr) {
  const now = Date.now();
  const { start: rangeStart, end: rangeEnd } = reportRangeMs(fromStr, toStr);

  // taskId → 合計ms
  const byTask = new Map();
  for (const entry of data.entries) {
    const overlap = overlapMs(entry, rangeStart, rangeEnd, now);
    if (overlap <= 0) continue;
    byTask.set(entry.taskId, (byTask.get(entry.taskId) || 0) + overlap);
  }

  const tree = new Map();
  for (const [taskId, ms] of byTask) {
    const task = taskById(taskId);
    const project = task ? projectById(task.projectId) : null;
    const clientId = project ? (project.clientId || '') : '';
    const projectId = project ? project.id : '';
    if (!tree.has(clientId)) tree.set(clientId, { total: 0, projects: new Map() });
    const clientNode = tree.get(clientId);
    clientNode.total += ms;
    if (!clientNode.projects.has(projectId)) clientNode.projects.set(projectId, { total: 0, tasks: [] });
    const projectNode = clientNode.projects.get(projectId);
    projectNode.total += ms;
    projectNode.tasks.push({ title: task ? task.title : '(削除済みタスク)', ms });
  }
  return tree;
}

// 期間内の作業時間を、タスクごとのキー(カテゴリ/タグなど)で集計する。
// keysOf(task)が返す各キーに同じ時間を計上するため、複数キーを持つタスクの時間は重複する
function sumByKeys(fromStr, toStr, keysOf) {
  const now = Date.now();
  const { start: rangeStart, end: rangeEnd } = reportRangeMs(fromStr, toStr);

  // key → { ms, taskIds }
  const byKey = new Map();
  for (const entry of data.entries) {
    const overlap = overlapMs(entry, rangeStart, rangeEnd, now);
    if (overlap <= 0) continue;
    const task = taskById(entry.taskId);
    for (const key of keysOf(task)) {
      if (!byKey.has(key)) byKey.set(key, { ms: 0, taskIds: new Set() });
      const node = byKey.get(key);
      node.ms += overlap;
      node.taskIds.add(entry.taskId);
    }
  }
  return byKey;
}

// 日別(範囲が62日を超えたら週別)の作業時間バケットを作る
function trendBuckets(fromStr, toStr) {
  const now = Date.now();
  const rangeStart = fromDateStr(fromStr);
  const totalDays = Math.round((fromDateStr(toStr) - rangeStart) / MS_PER_DAY) + 1;
  const bucketDays = totalDays > 62 ? 7 : 1;
  const buckets = [];
  for (let i = 0; i < totalDays; i += bucketDays) {
    const bucketStart = new Date(rangeStart);
    bucketStart.setDate(bucketStart.getDate() + i);
    const bucketEnd = new Date(bucketStart);
    bucketEnd.setDate(bucketEnd.getDate() + Math.min(bucketDays, totalDays - i));
    buckets.push({ day: toDateStr(bucketStart), start: bucketStart.getTime(), end: bucketEnd.getTime(), ms: 0 });
  }
  for (const entry of data.entries) {
    for (const bucket of buckets) {
      const overlap = overlapMs(entry, bucket.start, bucket.end, now);
      if (overlap > 0) bucket.ms += overlap;
    }
  }
  return { buckets, bucketDays };
}

// 日別/週別の推移バーチャート
function renderTrendChart(fromStr, toStr) {
  const { buckets, bucketDays } = trendBuckets(fromStr, toStr);
  if (!buckets.length) return '';
  const maxMs = Math.max(1, ...buckets.map((bucket) => bucket.ms));
  const labelStep = Math.max(1, Math.ceil(buckets.length / 10));
  const cols = buckets.map((bucket, i) => {
    const pct = bucket.ms > 0 ? Math.max((bucket.ms / maxMs) * 100, 3) : 0;
    const rangeEndStr = toDateStr(new Date(bucket.end - MS_PER_DAY));
    const tip = bucketDays === 1
      ? `${fmtDateJa(bucket.day)}\n${fmtDur(bucket.ms)}`
      : `${fmtShortDate(bucket.day)} 〜 ${fmtShortDate(rangeEndStr)}\n${fmtDur(bucket.ms)}`;
    const showLabel = i % labelStep === 0 || i === buckets.length - 1;
    return `<div class="chart-col" title="${esc(tip)}">
      <div class="chart-col-track"><div class="chart-col-bar" style="height:${pct}%"></div></div>
      <div class="chart-col-label">${showLabel ? esc(fmtShortDate(bucket.day)) : ''}</div>
    </div>`;
  }).join('');
  return `
    <div class="chart-block">
      <h3 class="chart-title">📈 ${bucketDays === 1 ? '日別' : '週別'}の推移</h3>
      <div class="chart-trend-wrap"><div class="chart-trend" style="min-width:${Math.max(buckets.length * 22, 100)}px">${cols}</div></div>
    </div>`;
}

// 内訳バーの行。割合は全体(grandTotal)に対するもの、バーの長さは行どうしの最大値に対するもの
function breakdownBarsHtml(rows, grandTotal) {
  const maxMs = Math.max(1, ...rows.map((row) => row.ms));
  return rows.map((row) => {
    const widthPct = Math.max((row.ms / maxMs) * 100, 2);
    return `<div class="chart-bar-row">
      <span class="chart-bar-label" title="${esc(row.label)}">${esc(row.label)}</span>
      <span class="chart-bar-track"><span class="chart-bar-fill" style="width:${widthPct}%;background:${row.color}"></span></span>
      <span class="chart-bar-value">${fmtDur(row.ms)}<small>(${percentOf(row.ms, grandTotal)}%${row.detail})</small></span>
    </div>`;
  }).join('');
}

function breakdownChartBlock(title, barsHtml, noteHtml = '') {
  return `
    <div class="chart-block">
      <h3 class="chart-title">${title}</h3>
      <div class="chart-bars">${barsHtml}</div>${noteHtml}
    </div>`;
}

// プロジェクト別内訳(上位8件 + その他)
function renderProjectBreakdownChart(tree, grandTotal) {
  const list = [];
  for (const [, clientNode] of tree) {
    for (const [projectId, projectNode] of clientNode.projects) list.push({ projectId, ms: projectNode.total });
  }
  list.sort((a, b) => b.ms - a.ms);
  if (!list.length) return '';
  const TOP_N = 8;
  const rows = list.slice(0, TOP_N).map((item) => ({
    label: projectLabel(item.projectId),
    color: projectColor(item.projectId),
    ms: item.ms,
    detail: '',
  }));
  const restMs = list.slice(TOP_N).reduce((sum, item) => sum + item.ms, 0);
  if (restMs > 0) rows.push({ label: 'その他', color: 'var(--text-sub)', ms: restMs, detail: '' });
  return breakdownChartBlock('📁 プロジェクト別の内訳', breakdownBarsHtml(rows, grandTotal));
}

// カテゴリ別内訳。タスクのカテゴリはひとつなので重複計上はない。カテゴリの無い時間は「カテゴリなし」
function renderCategoryBreakdownChart(fromStr, toStr, grandTotal) {
  const byCategory = sumByKeys(fromStr, toStr, (task) => [
    task && categoryById(task.categoryId) ? task.categoryId : '',
  ]);
  // カテゴリ付きの時間がひとつも無ければチャート自体を出さない
  if (![...byCategory.keys()].some((categoryId) => categoryId !== '')) return '';
  const rows = [...byCategory.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([categoryId, node]) => {
      const category = categoryById(categoryId);
      return {
        label: category ? `📂 ${category.name}` : 'カテゴリなし',
        color: category ? 'var(--review)' : 'var(--text-sub)',
        ms: node.ms,
        detail: `・${node.taskIds.size}タスク`,
      };
    });
  return breakdownChartBlock('📂 カテゴリ別の内訳', breakdownBarsHtml(rows, grandTotal));
}

// タグ別内訳。複数タグを持つタスクの時間は各タグに重複計上されるため、割合の合計は100%を超えることがある。
// タグの付いていない時間は「タグなし」に計上する
function renderTagBreakdownChart(fromStr, toStr, grandTotal) {
  const byTag = sumByKeys(fromStr, toStr, (task) => (task && task.tags && task.tags.length ? task.tags : ['']));
  // タグ付きの時間がひとつも無ければチャート自体を出さない
  if (![...byTag.keys()].some((tag) => tag !== '')) return '';
  const rows = [...byTag.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([tag, node]) => ({
      label: tag ? `🏷 ${tag}` : 'タグなし',
      color: tag ? 'var(--accent)' : 'var(--text-sub)',
      ms: node.ms,
      detail: `・${node.taskIds.size}タスク`,
    }));
  return breakdownChartBlock(
    '🏷 タグ別の内訳',
    breakdownBarsHtml(rows, grandTotal),
    '\n      <p class="chart-note">※ 複数のタグが付いたタスクの時間は各タグに重複して計上されます</p>',
  );
}

// 期間ボタン(今日・昨日など)の開始日・終了日(YYYY-MM-DD)。不明な範囲ならnull
function quickRangeDates(range) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let from = new Date(today);
  let to = new Date(today);
  switch (range) {
    case 'today':
      break;
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
    default:
      return null;
  }
  return { from: toDateStr(from), to: toDateStr(to) };
}

function quickRangeButtonsHtml() {
  return [
    ['today', '今日'],
    ['yesterday', '昨日'],
    ['week', '今週'],
    ['lastweek', '先週'],
    ['month', '今月'],
    ['lastmonth', '先月'],
  ].map(([range, label]) => {
    const dates = quickRangeDates(range);
    const active = dates.from === ui.reportFrom && dates.to === ui.reportTo;
    return `<button class="btn${active ? ' active' : ''}" data-action="quick-range" data-range="${range}" aria-pressed="${active}">${label}</button>`;
  }).join('');
}

// 集計テーブルの行(クライアント → プロジェクト → タスク)
function reportTableRows(tree, grandTotal) {
  const rows = [];
  const sortedClients = [...tree.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [clientId, clientNode] of sortedClients) {
    const client = clientById(clientId);
    rows.push(`<tr class="row-client">
      <td>${esc(client ? client.name : 'クライアントなし')}</td>
      <td class="num">${fmtDur(clientNode.total)}</td>
      <td class="num">${percentOf(clientNode.total, grandTotal)}%</td>
    </tr>`);
    const sortedProjects = [...clientNode.projects.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [projectId, projectNode] of sortedProjects) {
      const project = projectById(projectId);
      const dot = project ? `<span class="chip-dot" style="background:${esc(project.color)};display:inline-block;margin-right:6px"></span>` : '';
      rows.push(`<tr class="row-project">
        <td>${dot}${esc(project ? project.name : 'プロジェクトなし')}</td>
        <td class="num">${fmtDur(projectNode.total)}</td>
        <td class="num">${percentOf(projectNode.total, grandTotal)}%</td>
      </tr>`);
      for (const task of [...projectNode.tasks].sort((a, b) => b.ms - a.ms)) {
        rows.push(`<tr class="row-task">
          <td>${esc(task.title)}</td>
          <td class="num">${fmtDur(task.ms)}</td>
          <td class="num"></td>
        </tr>`);
      }
    }
  }
  return rows;
}

// 見積を設定したタスクを、プロジェクト別に「見積」と「実績」で比べる(全期間の累計)
function estimateRowsHtml() {
  const now = Date.now();
  const actualByTask = new Map();
  for (const entry of data.entries) {
    actualByTask.set(entry.taskId, (actualByTask.get(entry.taskId) || 0) + entryDur(entry, now));
  }
  const estimates = new Map();
  for (const task of data.tasks) {
    if (!task.estimateMinutes) continue;
    const projectId = projectById(task.projectId) ? task.projectId : '';
    if (!estimates.has(projectId)) estimates.set(projectId, { estimate: 0, actual: 0, count: 0 });
    const row = estimates.get(projectId);
    row.estimate += task.estimateMinutes * MS_PER_MINUTE;
    row.actual += actualByTask.get(task.id) || 0;
    row.count++;
  }
  return [...estimates].map(([projectId, row]) => {
    const diff = row.actual - row.estimate;
    return `<tr>
    <td>${esc(projectLabel(projectId))}（${row.count}件）</td>
    <td class="num">${fmtDur(row.estimate)}</td>
    <td class="num">${fmtDur(row.actual)}</td>
    <td class="num">${diff > 0 ? '+' : diff < 0 ? '−' : ''}${fmtDur(Math.abs(diff))}</td>
  </tr>`;
  }).join('');
}

function renderReport() {
  const tree = buildReportTree(ui.reportFrom, ui.reportTo);
  const grandTotal = [...tree.values()].reduce((sum, clientNode) => sum + clientNode.total, 0);
  const tableRows = reportTableRows(tree, grandTotal);
  const hours = (grandTotal / MS_PER_HOUR).toFixed(2);
  const estimateRows = estimateRowsHtml();

  return `
    <div class="card">
      <h2>📊 作業時間の集計</h2>
      <div class="report-controls">
        <input type="date" value="${esc(ui.reportFrom)}" data-action-change="agg-from" aria-label="集計開始日">
        〜
        <input type="date" value="${esc(ui.reportTo)}" data-action-change="agg-to" aria-label="集計終了日">
      </div>
      <div class="quick-ranges">
        ${quickRangeButtonsHtml()}
        <span class="export-btns">
          <button class="btn" data-action="export-report-csv" title="集計結果をCSVでダウンロード">⬇ 集計CSV</button>
          <button class="btn" data-action="export-entries-csv" title="作業記録の明細をCSVでダウンロード">⬇ 明細CSV</button>
        </span>
      </div>
      <div class="report-total">${fmtDur(grandTotal)}<small>(${hours}h) ${fmtDateJa(ui.reportFrom)} 〜 ${fmtDateJa(ui.reportTo)}</small></div>
      ${tableRows.length ? `
        ${renderTrendChart(ui.reportFrom, ui.reportTo)}
        ${renderProjectBreakdownChart(tree, grandTotal)}
        ${renderCategoryBreakdownChart(ui.reportFrom, ui.reportTo, grandTotal)}
        ${renderTagBreakdownChart(ui.reportFrom, ui.reportTo, grandTotal)}
        <div class="report-table-wrap">
          <table class="report-table">
            <thead><tr><th>クライアント / プロジェクト / タスク</th><th class="num">時間</th><th class="num">割合</th></tr></thead>
            <tbody>${tableRows.join('')}</tbody>
          </table>
        </div>` : '<p class="empty">この期間の作業記録はありません</p>'}
    </div>
    <div class="card">
      <h2>プロジェクト別 見積と実績</h2>
      <p class="task-meta">見積を設定したタスクのみ、全期間の累計で比較します（上の日付範囲とは独立）。未完了・繰り返しタスクも含むため、差は最終的な見積誤差とは限りません。</p>
      ${estimateRows ? `<div class="report-table-wrap"><table class="report-table">
        <thead><tr><th>プロジェクト</th><th>見積</th><th>実績</th><th>実績 − 見積</th></tr></thead>
        <tbody>${estimateRows}</tbody></table></div>` : '<p class="empty">見積時間を設定したタスクがありません</p>'}
    </div>`;
}
