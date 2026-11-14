'use strict';

// Enchanter: 画像候補(「サムネイルを選ぶ」のような、候補の画像を見比べて決めるタスク)のデータ操作。
// 候補は task.images = [{ id, file, url, label, note, mark, addedAt }]、採用した候補は task.pickedImageId。
// file はサーバーの data/images/ に保存した画像のファイル名、url は外部の画像(どちらか一方)。
// 描画は js/view-compare.js、検証は store.js の sanitizeImages。

const IMAGE_MARK_LABELS = { good: '◎ 有力', out: '✕ 外す' };
const IMAGE_FILE_PATTERN = /^[0-9a-f]{32}\.(?:png|jpg|gif|webp|avif)$/;
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif';
// 資料リンクのうち、画像を直接指していそうなURL(候補として取り込める)
const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp|avif)(?:$|[?#])/i;
const COMPARE_FILTERS = ['all', 'good', 'hide-out'];
const COMPARE_BACKGROUNDS = { default: '標準', light: '白', dark: '黒', checker: '市松' };
const COMPARE_SIZE_MIN = 120;
const COMPARE_SIZE_MAX = 720;
const COMPARE_SIZE_DEFAULT = 320;
const COMPARE_PREFS_KEY = 'enchanter.compare';
// 削除ボタンを1回押して「もう一度押すと削除」になっている候補のid
let armedDeleteImageId = null;

function taskImages(task) {
  return task && Array.isArray(task.images) ? task.images : [];
}

// <img src>に入れるURL。保存済みファイルはサーバー経由、外部画像はhttp(s)のときだけ
function imageSrc(image) {
  if (image.file && IMAGE_FILE_PATTERN.test(image.file)) return `/api/images/${image.file}`;
  return image.url ? safeLinkUrl(image.url) : null;
}

// 候補の表示名。名前が無ければ番号(1始まり)
function imageLabel(task, image) {
  return image.label || `候補 ${taskImages(task).indexOf(image) + 1}`;
}

function imageById(task, imageId) {
  return taskImages(task).find((image) => image.id === imageId) || null;
}

function pickedImage(task) {
  return task && task.pickedImageId ? imageById(task, task.pickedImageId) : null;
}

// 比較ボードの絞り込み(有力のみ/外したものを隠す)を適用した候補
function visibleCompareImages(task) {
  const images = taskImages(task);
  if (ui.compareFilter === 'good') return images.filter((image) => image.mark === 'good' || image.id === task.pickedImageId);
  if (ui.compareFilter === 'hide-out') return images.filter((image) => image.mark !== 'out');
  return images;
}

// 資料リンクのうち、まだ候補になっていない画像URL
function linkImageCandidates(task) {
  const existing = new Set(taskImages(task).map((image) => image.url).filter(Boolean));
  return (task.links || []).filter((link) => link && IMAGE_URL_RE.test(link.url) && safeLinkUrl(link.url) && !existing.has(link.url));
}

// 候補を追加する。sourcesは{ file }か{ url, label }。URLの重複は追加しない。追加した候補を返す
function addTaskImages(task, sources) {
  if (!Array.isArray(task.images)) task.images = [];
  const added = [];
  for (const source of sources) {
    const file = source.file && IMAGE_FILE_PATTERN.test(source.file) ? source.file : null;
    const url = file ? null : (source.url ? safeLinkUrl(source.url) : null);
    if (!file && !url) continue;
    if (url && task.images.some((image) => image.url === url)) continue;
    const image = { id: uid(), file, url, label: source.label || null, note: null, mark: null, addedAt: Date.now() };
    task.images.push(image);
    added.push(image);
  }
  return added;
}

// 有力/外すの印を切り替える。外した候補は採用を取り消す
function toggleImageMark(task, imageId, mark) {
  const image = imageById(task, imageId);
  if (!image || !IMAGE_MARK_LABELS[mark]) return false;
  image.mark = image.mark === mark ? null : mark;
  if (image.mark === 'out' && task.pickedImageId === image.id) task.pickedImageId = null;
  return true;
}

// 採用は1件だけ。同じ候補をもう一度選ぶと取り消す。採用した候補の「外す」は外す
function togglePickImage(task, imageId) {
  const image = imageById(task, imageId);
  if (!image) return false;
  task.pickedImageId = task.pickedImageId === image.id ? null : image.id;
  if (task.pickedImageId && image.mark === 'out') image.mark = null;
  return true;
}

function removeTaskImage(task, imageId) {
  const before = taskImages(task).length;
  task.images = taskImages(task).filter((image) => image.id !== imageId);
  if (task.pickedImageId === imageId) task.pickedImageId = null;
  if (ui.compareFocusId === imageId) ui.compareFocusId = null;
  return task.images.length !== before;
}

// 候補の並べ替え(番号の付け直し)。deltaは-1か+1
function moveTaskImage(task, imageId, delta) {
  const images = taskImages(task);
  const index = images.findIndex((image) => image.id === imageId);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= images.length) return false;
  [images[index], images[next]] = [images[next], images[index]];
  return true;
}

/* ----- 比較ボードの開閉と表示設定 ----- */

function openCompare(taskId, focusId = null) {
  if (!taskById(taskId)) return;
  if (ui.compareTaskId !== taskId) ui.compareFilter = 'all';
  ui.compareTaskId = taskId;
  ui.compareFocusId = focusId;
  ui.compareActualSize = false;
  armedDeleteImageId = null;
}

function closeCompare() {
  ui.compareTaskId = null;
  ui.compareFocusId = null;
  armedDeleteImageId = null;
}

// 拡大表示で前後の候補へ移る(絞り込み後の並びで巡回)
function stepCompareFocus(task, delta) {
  const images = visibleCompareImages(task);
  if (!images.length) return;
  const index = images.findIndex((image) => image.id === ui.compareFocusId);
  const next = index < 0 ? 0 : (index + delta + images.length) % images.length;
  ui.compareFocusId = images[next].id;
  ui.compareActualSize = false;
}

// 一覧のカード幅と背景は見る人ごとの好みなので、ブラウザに覚えておく(読めなくても動く)
function loadComparePrefs() {
  const prefs = { size: COMPARE_SIZE_DEFAULT, bg: 'default' };
  try {
    const stored = JSON.parse(localStorage.getItem(COMPARE_PREFS_KEY) || '{}');
    if (Number.isFinite(stored.size)) prefs.size = clampCompareSize(stored.size);
    if (COMPARE_BACKGROUNDS[stored.bg]) prefs.bg = stored.bg;
  } catch { /* 既定値のまま */ }
  return prefs;
}

function storeComparePrefs() {
  try {
    localStorage.setItem(COMPARE_PREFS_KEY, JSON.stringify(comparePrefs));
  } catch { /* 保存できなくても表示は続ける */ }
}

function clampCompareSize(value) {
  return Math.min(COMPARE_SIZE_MAX, Math.max(COMPARE_SIZE_MIN, Math.round(Number(value) / 10) * 10));
}

const comparePrefs = loadComparePrefs();

/* ----- 画像の取り込み(ブラウザのみ) ----- */

// 画像ファイルをサーバーへ送り、保存されたファイル名を返す
async function uploadImageFile(blob) {
  const response = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Requested-With': 'enchanter' },
    body: blob,
  });
  if (response.status === 415) throw new Error('unsupported');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).file;
}

// ファイル(ドロップ・貼り付け・選択)を候補に追加して比較ボードを開く。名前はファイル名(拡張子なし)
async function addImageFilesToTask(taskId, files) {
  const images = [...files].filter((file) => file && /^image\//.test(file.type || ''));
  if (!images.length) {
    if (files.length) alert('画像ファイル(PNG・JPEG・GIF・WebP・AVIF)を選んでください。');
    return;
  }
  openCompare(taskId, ui.compareTaskId === taskId ? ui.compareFocusId : null);
  ui.compareUploading += images.length;
  renderAll();
  const sources = [];
  let failed = 0;
  for (const file of images) {
    try {
      const label = file.name && file.name !== 'image.png' ? file.name.replace(/\.[^.]+$/, '') : null;
      sources.push({ file: await uploadImageFile(file), label });
    } catch (error) {
      failed += 1;
      console.error('画像の追加に失敗しました', error);
    } finally {
      ui.compareUploading -= 1;
    }
  }
  // アップロード中に外部の変更を読み直していても、最新のデータのタスクへ追加する
  const task = taskById(taskId);
  if (task && sources.length) {
    addTaskImages(task, sources);
    save();
  }
  renderAll();
  if (failed) alert(`${failed}件の画像を追加できませんでした。PNG・JPEG・GIF・WebP・AVIFに対応しています(SVGは不可)。`);
}

function addImageUrlToTask(taskId, value) {
  const task = taskById(taskId);
  if (!task) return 0;
  const urls = String(value || '').match(/https?:\/\/\S+/gi) || [];
  const added = addTaskImages(task, urls.map((url) => ({ url })));
  if (added.length) save();
  return added.length;
}
