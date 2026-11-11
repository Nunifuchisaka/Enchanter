'use strict';

// Enchanter: ドメインヘルパー(絞り込み・並び順・繰り返しなど)

/* ---------- domain helpers ---------- */

// フォームの段階値(重要度・重さ)入力を0〜3の整数へ正規化
function parseLevel(value) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 && num <= 3 ? num : 0;
}

// フォームの見積(分)入力を正の整数またはnullに正規化
function parseEstimate(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : null;
}

// 複数行のテキスト(箇条書き・Markdownのチェックリストなど)を1行1件のサブタスクにする
function parseChecklistLines(text) {
  return String(text).split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+・•]\s*)?(?:\[[ xX]\]\s*)?(?:\d+[.)．]\s*)?/, '').trim())
    .filter(Boolean);
}

// フォームのタグ入力(カンマ/読点区切り)を、トリム済み・空要素なし・重複なしの配列へ正規化
function parseTags(value) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(value || '').split(/[,、]/)) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

// 資料リンクの入力(1行に1件。「タイトル URL」またはURLだけ)を[{ url, title }]へ正規化する。
// http/https・file:のURLとWindowsの絶対パス(D:\a\b.mp4)を受け付け、それ以外(javascript:など)は
// href属性に入れると危険なので捨てる。同じURLは1件にまとめる
const LINK_URL_TOKEN_RE = /(?:https?:\/\/|file:)\S+/gi;
// Windowsのパスは空白を含みうるので、行末までをパスとみなす(引用符で囲んでもよい)
const LINK_WINDOWS_PATH_TAIL_RE = /(?:^|\s)(["']?)([A-Za-z]:[\\/].*?)\1\s*$/;

function parseLinks(value) {
  const seen = new Set();
  const links = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    // 1行に複数のURLがあれば別々のリンクにし、URL以外の文字列を最初のリンクのタイトルにする
    const raws = line.match(LINK_URL_TOKEN_RE) || [];
    let rest = line.replace(LINK_URL_TOKEN_RE, ' ');
    const pathMatch = LINK_WINDOWS_PATH_TAIL_RE.exec(rest);
    if (pathMatch) {
      raws.push(pathMatch[2]);
      rest = rest.slice(0, pathMatch.index);
    }
    if (!raws.length) continue;
    const title = rest.replace(/^[\s|:：-]+|[\s|:：-]+$/g, '').replace(/\s+/g, ' ');
    raws.forEach((raw, index) => {
      const url = safeLinkUrl(raw);
      if (!url || seen.has(url)) return;
      seen.add(url);
      links.push({ url, title: index === 0 && title ? title : null });
    });
  }
  return links;
}

// 資料リンクのURLを正規化して返す。使えないものはnull(store.jsのsafeLinkUrlと同じ規則・同じ結果にすること)。
// http/httpsはそのまま、Windowsの絶対パスとfile:のURLはfile:///D:/a/b.mp4の形(url.pathToFileURL相当。[ ] ^ ~ はエンコードしない)にそろえる
function safeLinkUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;
  if (/^[A-Za-z]:[\\/]/.test(text)) return localPathToFileUrl(text.replace(/\\/g, '/'));
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  // ホスト付き(UNC)・クエリ・フラグメント付き・区切り文字をエンコードしたものは受け付けない
  if (url.protocol !== 'file:' || url.host || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(pathname)) return null;
  return localPathToFileUrl(/^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname);
}

// 区切りが/のローカルパス(D:/a/b.mp4 または /home/a.mp4)をfile URLにする
function localPathToFileUrl(slashPath) {
  const escaped = slashPath.replace(/^\/+/, '').replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
  try {
    const url = new URL(`file:///${escaped}`);
    return url.host || url.search || url.hash ? null : url.href;
  } catch {
    return null;
  }
}

function isFileLinkUrl(url) {
  return typeof url === 'string' && /^file:/i.test(url);
}

// file URLを人が読めるパスにする(Windowsのドライブ付きならD:\a\b.mp4)。読めなければそのまま返す
function fileUrlToDisplayPath(fileUrl) {
  try {
    const pathname = decodeURIComponent(new URL(fileUrl).pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1).replace(/\//g, '\\') : pathname;
  } catch {
    return fileUrl;
  }
}

// 編集フォームに戻すときの文字列(parseLinksの逆)。Windowsのファイルは読めるパスで出す
function linksToText(links) {
  return (links || []).map((link) => {
    const display = isFileLinkUrl(link.url) ? fileUrlToDisplayPath(link.url) : link.url;
    const shown = /^[A-Za-z]:\\/.test(display) ? display : link.url;
    return link.title ? `${link.title} ${shown}` : shown;
  }).join('\n');
}

// リンクの表示名。タイトルが無ければホスト名(ファイルならファイル名)
function linkLabel(link) {
  if (link.title) return link.title;
  if (isFileLinkUrl(link.url)) return fileUrlToDisplayPath(link.url).split(/[\\/]/).pop() || link.url;
  try {
    return new URL(link.url).host;
  } catch {
    return link.url;
  }
}

// 全タスクで使われているタグの一覧(五十音順)。タグはタスク側にのみ持ち、マスタは持たない
function allTags() {
  const tags = new Set();
  for (const task of data.tasks) {
    for (const tag of task.tags || []) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'ja'));
}

// フォームの予定入力を正規化してタスクの予定フィールドを返す。
// 片方だけなら同日扱いにし、終了が開始より前なら入れ替える
function planFromForm(formData) {
  let start = { date: formData.get('plannedStart') || null, time: formData.get('plannedStartTime') || null };
  let end = { date: formData.get('plannedEnd') || null, time: formData.get('plannedEndTime') || null };
  if (!start.date && end.date) start = { ...end };
  if (start.date && !end.date) end = { ...start };
  const reversed = start.date && end.date && (
    end.date < start.date ||
    (end.date === start.date && start.time && end.time && end.time < start.time)
  );
  if (reversed) [start, end] = [end, start];
  return { plannedStart: start.date, plannedEnd: end.date, plannedStartTime: start.time, plannedEndTime: end.time };
}

// 予定日時のラベル("7/5" / "7/5 14:00" / "7/5〜7/6" / "7/5 14:00〜15:00")
function planLabel(task) {
  const startDate = fmtShortDate(task.plannedStart);
  const endDate = fmtShortDate(task.plannedEnd);
  const startTime = task.plannedStartTime ? ` ${task.plannedStartTime}` : '';
  const endTime = task.plannedEndTime ? ` ${task.plannedEndTime}` : '';
  if (task.plannedStart === task.plannedEnd) {
    return task.plannedStartTime && task.plannedEndTime
      ? `${startDate}${startTime}〜${task.plannedEndTime}`
      : `${startDate}${startTime}`;
  }
  return `${startDate}${startTime}〜${endDate}${endTime}`;
}

// 指定日において、タスクの開始/終了のうちその日にあたる側に時刻指定があるか
function hasTimeOnDay(task, day) {
  return (task.plannedStart === day && !!task.plannedStartTime) || (task.plannedEnd === day && !!task.plannedEndTime);
}

// 予定の期限を過ぎた未完了タスク(todayは比較用の "YYYY-MM-DD")
function isOverdue(task, today) {
  return task.status === 'todo' && task.plannedEnd < today;
}

function isDueToday(task) {
  return task.status === 'todo' && task.plannedEnd === todayStr();
}

// 重要度が高い順。同じ重要度なら予定日が近い順(予定なしは後ろ)、同条件なら新しい順
function compareActiveTasks(a, b) {
  const levelA = parseLevel(a.importance);
  const levelB = parseLevel(b.importance);
  if (levelA !== levelB) return levelB - levelA;
  const planA = a.plannedStart || '9999-99-99';
  const planB = b.plannedStart || '9999-99-99';
  if (planA !== planB) return planA < planB ? -1 : 1;
  return b.createdAt - a.createdAt;
}

// ui.todoFilter* のうち、クライアントとプロジェクトの組み合わせが矛盾する場合を整える
function reconcileTodoProjectFilter() {
  const project = projectById(ui.todoFilterProject);
  if (project && ui.todoFilterClient && project.clientId !== ui.todoFilterClient) {
    ui.todoFilterProject = '';
  } else if (project && !ui.todoFilterClient) {
    ui.todoFilterClient = project.clientId || '';
  }
}

// 一覧の絞り込み(検索語・クライアント・プロジェクト・重要度・重さ・年月・タグ・カテゴリ)。Todo/カンバン両タブで共有
function applyTodoFilters(tasks) {
  let result = tasks;
  const words = ui.todoSearch.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length) {
    result = result.filter((task) => {
      const text = [task.title, task.note, ...(task.tags || []), ...(task.links || []).map((link) => `${link.title || ''} ${link.url}`)].join(' ').normalize('NFKC').toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    });
  }
  if (ui.todoFilterClient) {
    result = result.filter((task) => {
      const project = projectById(task.projectId);
      return project && project.clientId === ui.todoFilterClient;
    });
  }
  if (ui.todoFilterProject) {
    result = result.filter((task) => task.projectId === ui.todoFilterProject);
  }
  if (ui.todoFilterImportance !== '') {
    const importance = Number(ui.todoFilterImportance);
    result = result.filter((task) => parseLevel(task.importance) === importance);
  }
  if (ui.todoFilterWeight !== '') {
    const weight = Number(ui.todoFilterWeight);
    result = result.filter((task) => parseLevel(task.weight) === weight);
  }
  if (ui.todoFilterMonth) {
    const monthStart = `${ui.todoFilterMonth}-01`;
    const monthEnd = endOfMonthStr(ui.todoFilterMonth);
    result = result.filter((task) => task.plannedStart && task.plannedEnd && task.plannedStart <= monthEnd && task.plannedEnd >= monthStart);
  }
  if (ui.todoFilterTag) {
    result = result.filter((task) => (task.tags || []).includes(ui.todoFilterTag));
  }
  if (ui.todoFilterCategory) {
    result = result.filter((task) => task.categoryId === ui.todoFilterCategory);
  }
  return result;
}

// 状態切替ボタンの次の状態(最後の状態の次は最初へ戻る)
function nextTaskStatus(status) {
  const index = TASK_STATUS_ORDER.indexOf(status);
  return TASK_STATUS_ORDER[(index + 1) % TASK_STATUS_ORDER.length];
}

// 繰り返しの単位ぶん予定日を先送りする(毎月は月の繰り上がりをDateに任せる)
function shiftDateByRepeat(dateStr, repeat) {
  const date = fromDateStr(dateStr);
  if (repeat === 'daily') date.setDate(date.getDate() + 1);
  else if (repeat === 'weekly') date.setDate(date.getDate() + 7);
  else if (repeat === 'monthly') date.setMonth(date.getMonth() + 1);
  return toDateStr(date);
}

// 繰り返しタスクの完了時に、次回分のタスクを生成する
function createNextOccurrence(task) {
  const plannedStart = task.plannedStart ? shiftDateByRepeat(task.plannedStart, task.repeat) : null;
  const plannedEnd = task.plannedEnd ? shiftDateByRepeat(task.plannedEnd, task.repeat) : plannedStart;
  return {
    id: uid(),
    title: task.title,
    projectId: task.projectId,
    categoryId: task.categoryId || null,
    status: 'todo',
    createdAt: Date.now(),
    completedAt: null,
    plannedStart,
    plannedEnd,
    plannedStartTime: task.plannedStartTime || null,
    plannedEndTime: task.plannedEndTime || null,
    repeat: task.repeat,
    estimateMinutes: task.estimateMinutes || null,
    importance: parseLevel(task.importance),
    weight: parseLevel(task.weight),
    note: task.note || null,
    tags: [...(task.tags || [])],
    links: (task.links || []).map((link) => ({ ...link })),
  };
}
