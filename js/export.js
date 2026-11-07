'use strict';

// Enchanter: CSVエクスポート・バックアップのインポート

/* ----- エクスポート(CSV・バックアップ) ----- */

function csvEscape(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// 先頭のBOMはExcelでの文字化け対策
function toCsv(rows) {
  return '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// 集計タブの階層集計をフラットなCSVにして保存する
function exportReportCsv() {
  const tree = buildReportTree(ui.reportFrom, ui.reportTo);
  const rows = [['クライアント', 'プロジェクト', 'タスク', '時間(分)', '時間(h)']];
  const sortedClients = [...tree.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [clientId, clientNode] of sortedClients) {
    const client = clientById(clientId);
    const sortedProjects = [...clientNode.projects.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [projectId, projectNode] of sortedProjects) {
      const project = projectById(projectId);
      for (const task of [...projectNode.tasks].sort((a, b) => b.ms - a.ms)) {
        rows.push([
          client ? client.name : 'クライアントなし',
          project ? project.name : 'プロジェクトなし',
          task.title,
          Math.round(task.ms / MS_PER_MINUTE),
          (task.ms / MS_PER_HOUR).toFixed(2),
        ]);
      }
    }
  }
  downloadFile(`enchanter-report_${ui.reportFrom}_${ui.reportTo}.csv`, toCsv(rows), 'text/csv');
}

// 期間内の作業記録の明細CSV(期間でクリップするので集計と合計が一致する)
function exportEntriesCsv() {
  const now = Date.now();
  const { start: rangeStart, end: rangeEnd } = reportRangeMs(ui.reportFrom, ui.reportTo);
  const rows = [['日付', '開始', '終了', '時間(分)', 'タスク', 'プロジェクト', 'クライアント']];
  for (const entry of [...data.entries].sort((a, b) => a.start - b.start)) {
    const clipStart = Math.max(entry.start, rangeStart);
    const clipEnd = Math.min(entryEnd(entry, now), rangeEnd);
    if (clipEnd <= clipStart) continue;
    const task = taskById(entry.taskId);
    const project = task ? projectById(task.projectId) : null;
    const client = project ? clientById(project.clientId) : null;
    rows.push([
      toDateStr(new Date(clipStart)),
      fmtTime(clipStart),
      entry.end === null ? '計測中' : fmtTime(clipEnd),
      Math.round((clipEnd - clipStart) / MS_PER_MINUTE),
      task ? task.title : '(削除済みタスク)',
      project ? project.name : '',
      client ? client.name : '',
    ]);
  }
  downloadFile(`enchanter-entries_${ui.reportFrom}_${ui.reportTo}.csv`, toCsv(rows), 'text/csv');
}

// バックアップJSONを読み込み、確認のうえ全データを置き換える
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid shape');
      for (const key of ['clients', 'categories', 'projects', 'tasks', 'entries', 'filters']) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error('invalid shape');
      }
      const next = normalizeData(parsed);
      const message = '現在のデータをインポート内容で【全て置き換え】ます。\n'
        + `現在: タスク ${data.tasks.length} 件・作業記録 ${data.entries.length} 件\n`
        + `インポート: タスク ${next.tasks.length} 件・作業記録 ${next.entries.length} 件\n`
        + 'よろしいですか?';
      if (!confirm(message)) return;
      data = next;
      deletionHistory.length = 0;
      save();
      renderAll();
    } catch (error) {
      console.error('バックアップの読み込みに失敗しました', error);
      alert('バックアップファイルを読み込めませんでした。エクスポートしたJSONファイルか確認してください。');
    }
  };
  reader.readAsText(file);
}

// 取り込むJSONの中身を、既存データを残したまま追加する。同じidの項目は既存を優先して取り込まない
// (同じファイルを何度取り込んでも重複しない)。参照先のプロジェクト等が無いタスクも取り込み、表示は「なし」になる
const MERGE_KEYS = ['clients', 'categories', 'projects', 'tasks', 'entries', 'filters'];
const MERGE_LABELS = { clients: 'クライアント', categories: 'カテゴリ', projects: 'プロジェクト', tasks: 'タスク', entries: '作業記録', filters: '保存済みフィルター' };

function planMerge(incoming) {
  const plan = {};
  for (const key of MERGE_KEYS) {
    const existingIds = new Set((data[key] || []).map((item) => item.id));
    const items = (incoming[key] || []).filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    const added = [];
    let skipped = 0;
    for (const item of items) {
      if (item.id && existingIds.has(item.id)) { skipped++; continue; }
      const copy = { ...item, id: item.id || uid() };
      existingIds.add(copy.id);
      added.push(copy);
    }
    plan[key] = { added, skipped };
  }
  return plan;
}

function applyMerge(plan) {
  for (const key of MERGE_KEYS) {
    if (!data[key]) data[key] = [];
    data[key].push(...plan[key].added);
  }
}

function mergeImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid shape');
      for (const key of MERGE_KEYS) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error('invalid shape');
      }
      const plan = planMerge(parsed);
      const lines = MERGE_KEYS
        .filter((key) => plan[key].added.length || plan[key].skipped)
        .map((key) => `${MERGE_LABELS[key]}: 追加 ${plan[key].added.length} 件` + (plan[key].skipped ? `(既にあるため ${plan[key].skipped} 件はスキップ)` : ''));
      if (!lines.some((line) => !line.includes('追加 0 件'))) {
        alert('追加できる新しい項目はありませんでした(すべて取り込み済みです)。');
        return;
      }
      if (!confirm(`現在のデータはそのまま残し、次の内容を追加します。\n${lines.join('\n')}\nよろしいですか?`)) return;
      applyMerge(plan);
      save();
      renderAll();
    } catch (error) {
      console.error('追加インポートに失敗しました', error);
      alert('ファイルを読み込めませんでした。Enchanter形式のJSONファイルか確認してください。');
    }
  };
  reader.readAsText(file);
}
