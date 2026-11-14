'use strict';

// Enchanter: 画像候補の描画。タスク行のサムネイル列・カンバンの表紙・比較ボード(全画面)。
// データ操作は js/image-compare.js、イベントは js/events.js(compare-* / image-*)

const TASK_STRIP_MAX = 6;

function imageAlt(task, image) {
  return `${task.title}の${imageLabel(task, image)}`;
}

function imageTag(task, image, className, lazy = true) {
  const src = imageSrc(image);
  if (!src) return '';
  // 外部画像には遷移元を送らない
  return `<img class="${className}" src="${esc(src)}" alt="${esc(imageAlt(task, image))}"${lazy ? ' loading="lazy"' : ''} decoding="async"${image.url ? ' referrerpolicy="no-referrer"' : ''} draggable="false">`;
}

// Todoの行に出す候補のサムネイル列。採用済みなら採用した画像を先頭に大きめに出す
function taskImageStrip(task) {
  const images = taskImages(task);
  if (!images.length) return '';
  const picked = pickedImage(task);
  const ordered = picked ? [picked, ...images.filter((image) => image !== picked)] : images;
  const shown = ordered.slice(0, TASK_STRIP_MAX);
  const rest = images.length - shown.length;
  const marks = images.filter((image) => image.mark === 'good').length;
  const summary = picked
    ? `🏆 採用: ${esc(imageLabel(task, picked))}`
    : `🖼 候補 ${images.length}${marks ? ` · ◎ ${marks}` : ''}`;
  return `
    <button type="button" class="task-image-strip${picked ? ' has-pick' : ''}" data-action="compare-open" data-id="${esc(task.id)}"
      title="画像候補を並べて比較" aria-label="${esc(task.title)}の画像候補(${images.length}件)を比較">
      <span class="task-image-thumbs">
        ${shown.map((image) => `<span class="task-image-thumb${image === picked ? ' is-picked' : ''}${image.mark === 'out' ? ' is-out' : ''}">${imageTag(task, image, 'task-image')}</span>`).join('')}
        ${rest > 0 ? `<span class="task-image-more">+${rest}</span>` : ''}
      </span>
      <span class="task-image-summary">${summary}<span class="task-image-open">比較する →</span></span>
    </button>`;
}

// タスク行の操作ボタン。候補が無いタスクでは控えめに出す(画像のドロップでも追加できる)
function compareOpenButton(task) {
  const count = taskImages(task).length;
  return `<button class="btn-icon compare-open-btn${count ? '' : ' is-empty'}" data-action="compare-open" data-id="${esc(task.id)}"
    title="${count ? `画像候補を比較(${count}件)` : '画像候補を追加して比較(画像をこの行にドロップしても追加できます)'}"
    aria-label="${esc(task.title)}の画像候補を${count ? '比較' : '追加'}">🖼</button>`;
}

// カンバンのカードの表紙(採用した候補、なければ最初の候補)
function kanbanImageCover(task) {
  const images = taskImages(task);
  if (!images.length) return '';
  const cover = pickedImage(task) || images[0];
  // ボタンなのでカンバンのドラッグは始まらず、クリックで比較ボードを開ける
  return `<button type="button" class="kanban-cover${pickedImage(task) ? ' is-picked' : ''}" data-action="compare-open" data-id="${esc(task.id)}"
    title="画像候補を比較(${images.length}件)" aria-label="${esc(task.title)}の画像候補を比較">${imageTag(task, cover, 'kanban-cover-img')}</button>`;
}

function kanbanImageChip(task) {
  const count = taskImages(task).length;
  if (!count) return '';
  return `<span class="chip" title="画像候補">${pickedImage(task) ? '🏆' : '🖼'} ${count}</span>`;
}

/* ----- 比較ボード ----- */

function compareSegmented(name, options, current, label) {
  return `
    <div class="segmented" role="group" aria-label="${label}">
      ${options.map(([value, text]) => `<button type="button" class="segmented-btn" data-action="${name}" data-value="${value}" aria-pressed="${value === current}">${text}</button>`).join('')}
    </div>`;
}

function compareMarkButtons(task, image, compact = false) {
  const picked = task.pickedImageId === image.id;
  const id = esc(image.id);
  return `
    <div class="compare-marks" role="group" aria-label="${esc(imageLabel(task, image))}の評価">
      <button type="button" class="mark-btn mark-good" data-action="image-mark" data-mark="good" data-id="${id}" aria-pressed="${image.mark === 'good'}" title="有力候補に残す (G)">◎${compact ? '' : ' 有力'}</button>
      <button type="button" class="mark-btn mark-out" data-action="image-mark" data-mark="out" data-id="${id}" aria-pressed="${image.mark === 'out'}" title="候補から外す (X)">✕${compact ? '' : ' 外す'}</button>
      <button type="button" class="mark-btn mark-pick" data-action="image-pick" data-id="${id}" aria-pressed="${picked}" title="これに決める (P)">🏆 ${picked ? '採用中' : '採用'}</button>
    </div>`;
}

function imageSourceLabel(image) {
  if (image.file) return 'アップロード画像';
  try {
    return new URL(image.url).host;
  } catch {
    return '外部画像';
  }
}

function compareCard(task, image) {
  const images = taskImages(task);
  const number = images.indexOf(image) + 1;
  const picked = task.pickedImageId === image.id;
  const armed = armedDeleteImageId === image.id;
  const classes = ['compare-card', picked ? 'is-picked' : '', image.mark ? `is-${image.mark}` : ''].filter(Boolean).join(' ');
  const src = imageSrc(image);
  return `
    <li class="${classes}">
      <button type="button" class="compare-thumb" data-action="compare-focus" data-id="${esc(image.id)}" title="大きく表示 (${number <= 9 ? number : 'クリック'})">
        ${imageTag(task, image, 'compare-img')}
        <span class="compare-no" aria-hidden="true">${number}</span>
        ${picked ? '<span class="compare-badge badge-pick">🏆 採用</span>' : image.mark === 'good' ? '<span class="compare-badge badge-good">◎ 有力</span>' : image.mark === 'out' ? '<span class="compare-badge badge-out">✕ 外した</span>' : ''}
      </button>
      <div class="compare-card-body">
        <input class="compare-label" type="text" value="${esc(image.label || '')}" placeholder="候補 ${number}(名前を付ける)" maxlength="200"
          data-action-change="image-label" data-id="${esc(image.id)}" aria-label="候補${number}の名前">
        ${compareMarkButtons(task, image)}
        <textarea class="compare-note" rows="2" placeholder="メモ(良い点・気になる点)" maxlength="2000"
          data-action-change="image-note" data-id="${esc(image.id)}" aria-label="候補${number}のメモ">${esc(image.note || '')}</textarea>
        <div class="compare-card-foot">
          <span class="compare-source" title="${esc(image.url || image.file || '')}">${esc(imageSourceLabel(image))}</span>
          <span class="compare-card-tools">
            <button type="button" class="btn-icon" data-action="image-move" data-delta="-1" data-id="${esc(image.id)}" title="前へ移動" aria-label="候補${number}を前へ移動"${number === 1 ? ' disabled' : ''}>←</button>
            <button type="button" class="btn-icon" data-action="image-move" data-delta="1" data-id="${esc(image.id)}" title="後ろへ移動" aria-label="候補${number}を後ろへ移動"${number === images.length ? ' disabled' : ''}>→</button>
            ${src ? `<a class="btn-icon" href="${esc(src)}" target="_blank" rel="noopener noreferrer" title="原寸を新しいタブで開く" aria-label="候補${number}を新しいタブで開く">↗</a>` : ''}
            <button type="button" class="btn-icon danger${armed ? ' delete-armed' : ''}" data-action="image-delete" data-id="${esc(image.id)}"
              title="${armed ? 'もう一度クリックで削除' : '候補を削除'}" aria-label="${armed ? `もう一度クリックで候補${number}を削除` : `候補${number}を削除`}">${armed ? '削除?' : '🗑'}</button>
          </span>
        </div>
      </div>
    </li>`;
}

function compareAddCard(task, empty) {
  const uploading = ui.compareUploading > 0;
  return `
    <li class="compare-add${empty ? ' is-empty' : ''}">
      <label class="compare-dropzone file-btn" role="button" tabindex="0">
        <span class="compare-dropzone-icon" aria-hidden="true">${uploading ? '⏳' : '＋'}</span>
        <span class="compare-dropzone-title">${uploading ? `画像を追加しています…(${ui.compareUploading}件)` : '画像を追加'}</span>
        <span class="compare-dropzone-hint">ここへドロップ / Ctrl+Vで貼り付け / クリックして選択(複数可)</span>
        <input type="file" accept="${IMAGE_ACCEPT}" multiple hidden data-action-change="image-files" data-id="${esc(task.id)}">
      </label>
      <form class="compare-url-form" data-action-submit="image-url" data-id="${esc(task.id)}">
        <input type="url" name="url" placeholder="画像のURLで追加(https://…)" aria-label="画像のURL">
        <button class="btn" type="submit">追加</button>
      </form>
    </li>`;
}

function compareSummary(task) {
  const images = taskImages(task);
  const good = images.filter((image) => image.mark === 'good').length;
  const out = images.filter((image) => image.mark === 'out').length;
  const picked = pickedImage(task);
  const remaining = images.length - out;
  return `
    <div class="compare-summary">
      <span>候補 <strong>${images.length}</strong></span>
      <span class="summary-good">◎ 有力 <strong>${good}</strong></span>
      <span class="summary-out">✕ 外した <strong>${out}</strong></span>
      <span>残り <strong>${remaining}</strong></span>
      ${picked ? `<span class="summary-pick">🏆 採用: ${images.indexOf(picked) + 1}. ${esc(imageLabel(task, picked))}</span>` : ''}
    </div>`;
}

function compareToolbar(task) {
  const images = taskImages(task);
  const good = images.filter((image) => image.mark === 'good' || image.id === task.pickedImageId).length;
  const notOut = images.filter((image) => image.mark !== 'out').length;
  return `
    <div class="compare-toolbar">
      ${compareSegmented('compare-filter', [['all', `すべて ${images.length}`], ['good', `有力のみ ${good}`], ['hide-out', `外したものを隠す ${notOut}`]], ui.compareFilter, '表示する候補')}
      <label class="compare-size">
        <span>大きさ</span>
        <input type="range" min="${COMPARE_SIZE_MIN}" max="${COMPARE_SIZE_MAX}" step="10" value="${comparePrefs.size}" data-action-input="compare-size" aria-label="候補の表示幅">
        <output class="compare-size-value">${comparePrefs.size}px</output>
      </label>
      ${compareSegmented('compare-bg', Object.entries(COMPARE_BACKGROUNDS), comparePrefs.bg, '画像の背景')}
    </div>`;
}

function compareLinkImport(task) {
  const candidates = linkImageCandidates(task);
  if (!candidates.length) return '';
  return `<button type="button" class="btn compare-link-import" data-action="image-from-links" data-id="${esc(task.id)}">🔗 資料リンクの画像 ${candidates.length}件を候補に追加</button>`;
}

function compareGridHtml(task) {
  const images = taskImages(task);
  const shown = visibleCompareImages(task);
  if (images.length && !shown.length) {
    return `<p class="compare-empty">${ui.compareFilter === 'good' ? '◎ 有力の印を付けた候補はまだありません。' : '表示できる候補がありません。'}
      <button type="button" class="btn btn-quiet" data-action="compare-filter" data-value="all">すべて表示</button></p>`;
  }
  return `
    <ol class="compare-grid bg-${comparePrefs.bg}" style="--compare-size:${comparePrefs.size}px">
      ${shown.map((image) => compareCard(task, image)).join('')}
      ${ui.compareFilter === 'all' || !images.length ? compareAddCard(task, !images.length) : ''}
    </ol>`;
}

// 拡大表示。左右キーで切り替え、下の帯で他の候補へ飛べる
function compareFocusHtml(task) {
  const image = imageById(task, ui.compareFocusId);
  if (!image) return '';
  const images = taskImages(task);
  const shown = visibleCompareImages(task);
  const number = images.indexOf(image) + 1;
  const position = shown.indexOf(image);
  return `
    <div class="compare-focus bg-${comparePrefs.bg}" role="group" aria-label="候補${number}の拡大表示">
      <div class="compare-focus-bar">
        <button type="button" class="btn" data-action="compare-unfocus" title="一覧に戻る (Esc)">← 一覧</button>
        <span class="compare-focus-title"><span class="compare-no">${number}</span><span class="compare-focus-label">${esc(imageLabel(task, image))}</span><span class="compare-focus-count">${position >= 0 ? `${position + 1} / ${shown.length}` : ''}</span></span>
        ${compareMarkButtons(task, image)}
        <button type="button" class="btn" data-action="compare-actual" aria-pressed="${ui.compareActualSize}" title="原寸と画面に合わせるを切り替え (Z)">${ui.compareActualSize ? '画面に合わせる' : '原寸で見る'}</button>
      </div>
      <div class="compare-stage${ui.compareActualSize ? ' is-actual' : ''}">
        <button type="button" class="compare-nav prev" data-action="compare-step" data-delta="-1" aria-label="前の候補 (←)"${shown.length < 2 ? ' disabled' : ''}>‹</button>
        <div class="compare-stage-inner" data-action="compare-actual">${imageTag(task, image, 'compare-focus-img', false)}</div>
        <button type="button" class="compare-nav next" data-action="compare-step" data-delta="1" aria-label="次の候補 (→)"${shown.length < 2 ? ' disabled' : ''}>›</button>
      </div>
      ${image.note ? `<p class="compare-focus-note">${esc(image.note)}</p>` : ''}
      <div class="compare-filmstrip" role="list">
        ${shown.map((item) => `
          <button type="button" role="listitem" class="compare-film${item === image ? ' is-current' : ''}${item.id === task.pickedImageId ? ' is-picked' : ''}${item.mark ? ` is-${item.mark}` : ''}"
            data-action="compare-focus" data-id="${esc(item.id)}" aria-label="候補${images.indexOf(item) + 1}を表示"${item === image ? ' aria-current="true"' : ''}>
            ${imageTag(task, item, 'compare-film-img')}<span class="compare-no">${images.indexOf(item) + 1}</span>
          </button>`).join('')}
      </div>
      <p class="compare-keys">← → 切り替え · 1〜9 番号で移動 · G 有力 · X 外す · P 採用 · Z 原寸 · Esc 一覧へ</p>
    </div>`;
}

function renderCompareOverlay() {
  const task = taskById(ui.compareTaskId);
  if (!task) {
    ui.compareTaskId = null;
    ui.compareFocusId = null;
    return '';
  }
  if (ui.compareFocusId && !imageById(task, ui.compareFocusId)) ui.compareFocusId = null;
  const picked = pickedImage(task);
  return `
    <div class="compare-overlay" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="compare-title" data-image-drop data-id="${esc(task.id)}">
      <div class="compare-shell">
        <header class="compare-header">
          <div class="compare-heading">
            <span class="section-eyebrow">画像候補を比較</span>
            <h2 id="compare-title">${esc(task.title)}</h2>
            ${compareSummary(task)}
          </div>
          <div class="compare-header-actions">
            ${compareLinkImport(task)}
            ${picked && task.status !== 'done' ? `<button type="button" class="btn btn-primary" data-action="compare-complete" data-id="${esc(task.id)}">✓ 「${esc(imageLabel(task, picked))}」に決めて完了</button>` : ''}
            <button type="button" class="btn-icon compare-close" data-action="compare-close" title="閉じる (Esc)" aria-label="比較を閉じる">✕</button>
          </div>
        </header>
        ${taskImages(task).length ? compareToolbar(task) : ''}
        <div class="compare-body">
          ${compareGridHtml(task)}
        </div>
      </div>
      ${compareFocusHtml(task)}
      <div class="compare-drop-hint" aria-hidden="true">ドロップして候補に追加</div>
    </div>`;
}
