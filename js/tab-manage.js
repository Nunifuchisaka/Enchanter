'use strict';

// Enchanter: 管理タブの描画

/* ----- 管理タブ ----- */

// クライアント・カテゴリの名前編集フォーム(名前だけを編集する)
function renameItemForm(submitAction, id, name) {
  return `
    <li class="manage-item">
      <form class="edit-form" data-action-submit="${submitAction}" data-id="${esc(id)}">
        <input type="text" name="name" value="${esc(name)}" required>
        <button class="btn btn-primary" type="submit">保存</button>
        <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
      </form>
    </li>`;
}

// 一覧行の編集・削除ボタン。keyは data-action の接尾辞(client など)、kindは表示名(クライアント など)
function manageItemButtons(kind, key, id, name) {
  return `
    <button class="btn-icon" data-action="edit-${key}" data-id="${esc(id)}" title="${kind}を編集" aria-label="${esc(name)}を編集">✎</button>
    <button class="btn-icon danger" data-action="del-${key}" data-id="${esc(id)}" title="${kind}を削除" aria-label="${esc(name)}を削除">🗑</button>`;
}

function manageClientItem(client) {
  if (ui.editingClient === client.id) return renameItemForm('save-client', client.id, client.name);
  const projectCount = data.projects.filter((project) => project.clientId === client.id).length;
  return `
    <li class="manage-item">
      <span class="name">${esc(client.name)}</span>
      <span class="sub">${projectCount} プロジェクト</span>
      ${manageItemButtons('クライアント', 'client', client.id, client.name)}
    </li>`;
}

function manageCategoryItem(category) {
  if (ui.editingCategory === category.id) return renameItemForm('save-category', category.id, category.name);
  const taskCount = data.tasks.filter((task) => task.categoryId === category.id).length;
  return `
    <li class="manage-item">
      <span class="name">${esc(category.name)}</span>
      <span class="sub">${taskCount} タスク</span>
      ${manageItemButtons('カテゴリ', 'category', category.id, category.name)}
    </li>`;
}

function manageProjectItem(project) {
  if (ui.editingProject === project.id) {
    return `
      <li class="manage-item">
        <form class="edit-form" data-action-submit="save-project" data-id="${esc(project.id)}">
          <input type="text" name="name" value="${esc(project.name)}" required>
          <input type="text" name="customId" value="${esc(project.customId || '')}" placeholder="ID(任意)">
          <select name="clientId">${clientOptionsInRegistrationOrder(project.clientId)}</select>
          <input type="color" name="color" value="${esc(project.color)}" title="カラー">
          <button class="btn btn-primary" type="submit">保存</button>
          <button class="btn" type="button" data-action="cancel-edit">キャンセル</button>
        </form>
      </li>`;
  }
  const client = clientById(project.clientId);
  const taskCount = data.tasks.filter((task) => task.projectId === project.id).length;
  return `
    <li class="manage-item">
      <span class="chip-dot" style="background:${esc(project.color)}"></span>
      <span class="name">${esc(project.name)}</span>
      ${project.customId ? `<span class="chip">${esc(project.customId)}</span>` : ''}
      <span class="sub">${client ? esc(client.name) : 'クライアントなし'} ・ ${taskCount} タスク</span>
      ${manageItemButtons('プロジェクト', 'project', project.id, project.name)}
    </li>`;
}

function manageGoogleCard() {
  const status = ui.googleStatus;
  let statusHtml;
  let actionHtml;
  if (!status.configured) {
    statusHtml = '<span class="sub">data/google-credentials.json が未設定です</span>';
    actionHtml = '';
  } else if (!status.connected) {
    statusHtml = '<span class="sub">未連携</span>';
    actionHtml = '<button class="btn btn-primary" data-action="google-connect">連携する</button>';
  } else {
    statusHtml = '<span class="sub">連携済み</span>';
    actionHtml = '<button class="btn" data-action="google-disconnect">連携を解除</button>';
  }
  return `
    <div class="card">
      <h2>🗓️ Googleカレンダー連携</h2>
      <p>${statusHtml}</p>
      ${actionHtml}
    </div>`;
}

function manageBackupCard() {
  return `
    <div class="card">
      <h2>💾 バックアップ</h2>
      <p class="backup-note">全データ(クライアント・プロジェクト・カテゴリ・タスク・作業記録)をJSONで書き出し/読み込みできます。インポートは現在のデータを全て置き換えます。</p>
      <p class="backup-note">自動バックアップ：各日の最初の保存前データをサーバーのデータフォルダー内の backups/enchanter-日付.json に保持します。復元はそのファイルをインポートしてください。自動削除はしません。</p>
      <div class="backup-actions">
        <button class="btn" data-action="export-backup">⬇ エクスポート</button>
        <label class="btn file-btn" role="button" tabindex="0">⬆ インポート<input type="file" accept=".json,application/json" data-action-change="import-backup" hidden></label>
      </div>
    </div>`;
}

function manageShortcutCard() {
  return `
    <div class="card">
      <h2>⌨️ キーボードショートカット</h2>
      <ul class="shortcut-list">
        <li><kbd>1</kbd>〜<kbd>6</kbd> タブ切替(Todo / カンバン / タイムライン / ガント / 集計 / 管理)</li>
        <li><kbd>N</kbd> 新しいタスクを追加(Todoタブのタスク名入力へ)</li>
        <li><kbd>Esc</kbd> 編集をキャンセル</li>
      </ul>
    </div>`;
}

function renderManage() {
  return `
    <div class="manage-grid">
      <div class="card">
        <h2>👤 クライアント</h2>
        <form class="add-form" data-action-submit="add-client" style="margin-bottom:12px">
          <input type="text" name="name" placeholder="クライアント名..." required autocomplete="off">
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <ul class="manage-list">
          ${data.clients.length ? data.clients.map(manageClientItem).join('') : '<li class="empty">クライアントがありません</li>'}
        </ul>
      </div>
      <div class="card">
        <h2>📁 プロジェクト</h2>
        <form class="add-form" data-action-submit="add-project" style="margin-bottom:12px">
          <input type="text" name="name" placeholder="プロジェクト名..." required autocomplete="off">
          <input type="text" name="customId" placeholder="ID(任意)" autocomplete="off">
          <select name="clientId">${clientOptionsInRegistrationOrder('')}</select>
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <ul class="manage-list">
          ${data.projects.length ? data.projects.map(manageProjectItem).join('') : '<li class="empty">プロジェクトがありません</li>'}
        </ul>
      </div>
      <div class="card">
        <h2>📂 カテゴリ</h2>
        <form class="add-form" data-action-submit="add-category" style="margin-bottom:12px">
          <input type="text" name="name" placeholder="カテゴリ名..." required autocomplete="off">
          <button class="btn btn-primary" type="submit">追加</button>
        </form>
        <ul class="manage-list">
          ${data.categories.length ? data.categories.map(manageCategoryItem).join('') : '<li class="empty">カテゴリがありません</li>'}
        </ul>
      </div>
      ${manageGoogleCard()}
      ${manageBackupCard()}
      ${manageShortcutCard()}
    </div>`;
}
