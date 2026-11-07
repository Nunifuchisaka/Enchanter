'use strict';

// Enchanter: 描画の共通部品(esc・選択肢・チップ・絞り込みUI)

/* ---------- rendering ---------- */

// HTMLの本文・属性へ埋め込む前の値をエスケープする(ユーザー入力は必ずこれを通す)
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 割合(%)。合計が0の場合は0
function percentOf(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

/* ----- 共通の選択肢・チップ ----- */

// 名前順のselect用option。先頭は空値の選択肢(emptyOptionのHTML)
function namedOptions(items, selectedId, emptyOption) {
  let html = emptyOption;
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  for (const item of sorted) {
    html += `<option value="${esc(item.id)}"${item.id === selectedId ? ' selected' : ''}>${esc(item.name)}</option>`;
  }
  return html;
}

function clientOptions(selectedId, emptyLabel) {
  return namedOptions(data.clients, selectedId, `<option value="">${emptyLabel || 'クライアントなし'}</option>`);
}

function categoryOptions(selectedId, emptyLabel) {
  return namedOptions(data.categories, selectedId, `<option value="">${emptyLabel || 'カテゴリなし'}</option>`);
}

// 管理タブのクライアント選択。並べ替えず登録順のまま出す
function clientOptionsInRegistrationOrder(selectedId) {
  let html = '<option value="">クライアントなし</option>';
  for (const client of data.clients) {
    html += `<option value="${esc(client.id)}"${client.id === selectedId ? ' selected' : ''}>${esc(client.name)}</option>`;
  }
  return html;
}

// プロジェクト名は「クライアント / プロジェクト」の表示名で並べる。clientIdを指定するとそのクライアントのものだけ
function projectOptions(selectedId, emptyLabel, clientId = '') {
  let html = `<option value="">${emptyLabel || 'プロジェクトなし'}</option>`;
  const projects = clientId ? data.projects.filter((project) => project.clientId === clientId) : data.projects;
  const sorted = [...projects].sort((a, b) => projectLabel(a.id).localeCompare(projectLabel(b.id), 'ja'));
  for (const project of sorted) {
    html += `<option value="${esc(project.id)}"${project.id === selectedId ? ' selected' : ''}>${esc(projectLabel(project.id))}</option>`;
  }
  return html;
}

// 保存済みフィルターのselect用option(先頭は「フィルターなし」固定)
function savedFilterOptions() {
  const emptyOption = `<option value=""${ui.activeFilterId ? '' : ' selected'}>-- フィルターなし --</option>`;
  return namedOptions(data.filters, ui.activeFilterId, emptyOption);
}

function tagFilterOptions(selected) {
  const tags = allTags();
  // 保存済みフィルター等で、どのタスクにも残っていないタグが選択中でも選択肢に含める
  if (selected && !tags.includes(selected)) tags.push(selected);
  let html = `<option value=""${selected ? '' : ' selected'}>すべて</option>`;
  for (const tag of tags) {
    html += `<option value="${esc(tag)}"${tag === selected ? ' selected' : ''}>${esc(tag)}</option>`;
  }
  return html;
}

function repeatOptions(selected) {
  let html = '<option value="">限定的（繰り返しなし）</option>';
  for (const [value, label] of Object.entries(REPEAT_LABELS)) {
    html += `<option value="${value}"${value === selected ? ' selected' : ''}>恒常的（${label}）</option>`;
  }
  return html;
}

// 段階値(重要度・重さ)のフォーム用option。値は0〜3
function levelOptions(kind, selected) {
  const { labels, formLabel } = LEVEL_FIELDS[kind];
  const current = parseLevel(selected);
  return labels.map((label, value) =>
    `<option value="${value}"${value === current ? ' selected' : ''}>${formLabel}: ${label}</option>`).join('');
}

// 段階値の絞り込み用option(先頭の「すべて」は空値)
function levelFilterOptions(kind, selected) {
  const { labels } = LEVEL_FIELDS[kind];
  const allOption = `<option value=""${selected === '' ? ' selected' : ''}>すべて</option>`;
  return allOption + labels.map((label, value) => {
    const stringValue = String(value);
    return `<option value="${stringValue}"${stringValue === selected ? ' selected' : ''}>${label}</option>`;
  }).join('');
}

// 5分刻みの時刻<option>
function timeOptions(selected) {
  let html = '';
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute += 5) {
      const value = `${pad2(hour)}:${pad2(minute)}`;
      html += `<option value="${value}"${value === selected ? ' selected' : ''}>${value}</option>`;
    }
  }
  return html;
}

const TIME_SELECT_LABELS = {
  plannedStartTime: '予定開始時刻',
  plannedEndTime: '予定終了時刻',
  start: '開始時刻',
  end: '終了時刻',
};

function timeSelect(name, value, { required = false, disabled = false, label = '' } = {}) {
  const placeholder = value
    ? ''
    : `<option value="" selected${required ? ' disabled' : ''}>--:--</option>`;
  const ariaLabel = label || TIME_SELECT_LABELS[name] || '時刻';
  return `<select name="${name}" aria-label="${esc(ariaLabel)}"${required ? ' required' : ''}${disabled ? ' disabled' : ''}>${placeholder}${timeOptions(value)}</select>`;
}

function statusRowClass(task) {
  if (task.status === 'done') return 'done';
  if (task.status === 'in_progress') return 'in-progress';
  if (task.status === 'waiting_review') return 'waiting-review';
  return '';
}

function projectChip(projectId) {
  if (!projectId) return '';
  return `<span class="chip"><span class="chip-dot" style="background:${projectColor(projectId)}"></span>${esc(projectLabel(projectId))}</span>`;
}

function categoryChip(task) {
  const category = categoryById(task.categoryId);
  if (!category) return '';
  return `<span class="chip category-chip">📂 ${esc(category.name)}</span>`;
}

// 重要度・重さのチップ。指定なし(0)は表示しない
function levelChip(kind, task) {
  const level = parseLevel(task[kind]);
  if (!level) return '';
  const { labels, chipLabel } = LEVEL_FIELDS[kind];
  return `<span class="chip ${kind}-${level}">${chipLabel} ${labels[level]}</span>`;
}

function planChip(task) {
  if (!task.plannedStart) return '';
  const today = todayStr();
  let extraClass = '';
  let note = '';
  if (task.status === 'todo') {
    if (isOverdue(task, today)) {
      extraClass = ' plan-overdue';
      note = ' 超過';
    } else if (task.plannedEnd === today) {
      extraClass = ' plan-due-today';
      note = ' 本日締め切り';
    } else if (task.plannedStart <= today) {
      extraClass = ' plan-today';
    }
  }
  return `<span class="chip${extraClass}">📅 ${esc(planLabel(task))}${note}</span>`;
}

function repeatChip(task) {
  if (!task.repeat) return '';
  return `<span class="chip">🔁 ${REPEAT_LABELS[task.repeat] || esc(task.repeat)}</span>`;
}

function tagChips(task) {
  return (task.tags || []).map((tag) => `<span class="chip tag-chip">🏷 ${esc(tag)}</span>`).join('');
}

// 資料リンク。新しいタブで開き、遷移先に元ページを渡さない
function linkChips(task) {
  // インポート直後など未検証のデータでもjavascript:等のURLを描画しない
  const links = Array.isArray(task.links) ? task.links : [];
  return links.filter((link) => link && safeLinkUrl(link.url)).map((link) => `<a class="chip link-chip" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" title="${esc(link.url)}">🔗 ${esc(linkLabel(link))}</a>`).join('');
}

// 累計時間の表示(見積があれば「累計/見積」+進捗バー、超過時は警告色)
function totalChip(task, totalMs) {
  if (!task.estimateMinutes) {
    return totalMs > 0 ? `<span>累計 ${fmtDur(totalMs)}</span>` : '';
  }
  const estMs = task.estimateMinutes * MS_PER_MINUTE;
  const pct = (totalMs / estMs) * 100;
  return `
    <span class="estimate${pct > 100 ? ' over' : ''}">
      累計 ${fmtDur(totalMs)} / 見積 ${fmtDur(estMs)}
      <span class="progress"><span class="progress-fill" style="width:${Math.min(100, pct).toFixed(1)}%"></span></span>
      ${pct > 100 ? `<span class="over-note">+${fmtDur(totalMs - estMs)} 超過</span>` : ''}
    </span>`;
}

// タスク一覧とカンバンで共通のチップ(プロジェクト・カテゴリ・重要度・重さ・予定)
function commonTaskChips(task) {
  return [
    projectChip(task.projectId),
    categoryChip(task),
    levelChip('importance', task),
    levelChip('weight', task),
    planChip(task),
  ].join('');
}

/* ----- Todo/カンバン共通の絞り込みUI ----- */

// <label>の入力欄(ラベル文字とコントロールをまとめる)
function filterField(label, control, className = 'field') {
  return `<label class="${className}"><span class="field-label">${label}</span>${control}</label>`;
}

// Todo/カンバン両タブで共有するフィルタUI(クライアント/プロジェクト/重要度/重さ/年月/タグ+保存済みフィルター)
function todoFilterRow() {
  const hasTags = allTags().length > 0 || ui.todoFilterTag;
  const hasCategories = data.categories.length > 0 || ui.todoFilterCategory;
  const filterCount = [
    ui.todoSearch,
    ui.todoFilterClient,
    ui.todoFilterProject,
    ui.todoFilterCategory,
    ui.todoFilterImportance,
    ui.todoFilterWeight,
    ui.todoFilterMonth,
    ui.todoFilterTag,
  ].filter(Boolean).length;
  // 絞り込み中・保存済みフィルター適用中は開いたままにする。スマホ幅では初期状態を閉じておく
  const filtersOpen = filterCount > 0 || ui.activeFilterId ||
    (ui.tab === 'todo' && !window.matchMedia('(max-width: 720px)').matches);
  const fields = [
    filterField('検索（完了済みも対象）', `<input type="search" value="${esc(ui.todoSearch)}" data-action-change="todo-search" placeholder="タスク名・メモ・タグ">`),
    filterField('保存済み', `<select data-action-change="apply-saved-filter">${savedFilterOptions()}</select>`),
    filterField('クライアント', `<select data-action-change="todo-client-filter">${clientOptions(ui.todoFilterClient, 'すべて')}</select>`),
    filterField('プロジェクト', `<select data-action-change="todo-filter">${projectOptions(ui.todoFilterProject, 'すべて', ui.todoFilterClient)}</select>`, 'field field-project'),
    hasCategories ? filterField('カテゴリ', `<select data-action-change="todo-category-filter">${categoryOptions(ui.todoFilterCategory, 'すべて')}</select>`) : '',
    filterField('重要度', `<select data-action-change="todo-importance-filter">${levelFilterOptions('importance', ui.todoFilterImportance)}</select>`),
    filterField('重さ', `<select data-action-change="todo-weight-filter">${levelFilterOptions('weight', ui.todoFilterWeight)}</select>`),
    filterField('年月', `<input type="month" data-action-change="todo-month-filter" value="${esc(ui.todoFilterMonth)}">`),
    hasTags ? filterField('タグ', `<select data-action-change="todo-tag-filter">${tagFilterOptions(ui.todoFilterTag)}</select>`) : '',
  ].join('');
  return `
    <details class="filter-panel" data-details-key="${ui.tab}-filters"${filtersOpen ? ' open' : ''}>
      <summary class="filter-panel-heading">
        <div>
          <span class="section-eyebrow">表示条件</span>
          <strong>タスクを絞り込む</strong>
          <span class="filter-status">${filterCount ? `${filterCount}項目を指定中` : 'すべて表示中'}</span>
        </div>
      </summary>
      <div class="filter-panel-content">
        <div class="filter-grid">${fields}</div>
        <div class="filter-save-row">
          <form class="save-filter-form" data-action-submit="save-filter">
            <input type="text" name="name" placeholder="現在の条件を名前で保存..." maxlength="40" required>
            <button class="btn" type="submit" title="現在の絞り込み条件を保存">保存</button>
          </form>
          ${filterCount || ui.activeFilterId ? '<button class="btn btn-quiet" type="button" data-action="clear-todo-filters">条件をクリア</button>' : ''}
          ${ui.activeFilterId ? `<button class="btn-icon danger" data-action="delete-filter" data-id="${esc(ui.activeFilterId)}" title="この保存済みフィルターを削除" aria-label="この保存済みフィルターを削除">🗑</button>` : ''}
        </div>
      </div>
    </details>`;
}
