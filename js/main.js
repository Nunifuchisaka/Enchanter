'use strict';

// Enchanter: 経過時間の更新(ticker)と起動処理(init)

/* ---------- ticker ---------- */

// 計測中の経過時間と、止め忘れ警告の表示を1秒ごとに更新する
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-warning-since]').forEach((element) => {
    element.hidden = now - Number(element.dataset.warningSince) < LONG_TIMER_WARNING_MS;
  });
  document.querySelectorAll('[data-live-since]').forEach((element) => {
    element.textContent = fmtClock(now - Number(element.dataset.liveSince));
  });
}, 1000);

// CLIなど他の場所での変更を定期的に取り込む
setInterval(checkExternalChange, EXTERNAL_CHANGE_CHECK_MS);

/* ---------- init ---------- */

async function init() {
  const view = document.getElementById('view');
  if (location.protocol === 'file:') {
    view.innerHTML = `
      <div class="card">
        <h2>⚠ サーバー経由で開いてください</h2>
        <p>このバージョンはデータをローカルファイルに保存するため、サーバーの起動が必要です。</p>
        <p style="margin-top:8px">
          <code>start.cmd</code> をダブルクリック(または <code>node server.js</code> を実行)して、
          <a href="http://localhost:8787">http://localhost:8787</a> を開いてください。<br>
          Dockerの場合は <code>docker compose up -d</code> で起動できます。
        </p>
      </div>`;
    return;
  }
  try {
    data = await loadFromServer();
  } catch (error) {
    console.error('データの読み込みに失敗しました', error);
    view.innerHTML = `
      <div class="card">
        <h2>⚠ データを読み込めませんでした</h2>
        <p>サーバー(server.js)との通信に失敗しました。ページを再読み込みしてください。</p>
      </div>`;
    return;
  }
  migrateFromLocalStorage();
  if (promoteStartedTasks()) save();
  try {
    ui.googleStatus = await fetchGoogleStatus();
  } catch (error) {
    console.error('Google連携状態の取得に失敗しました', error);
  }
  applyHash();
  const params = new URLSearchParams(location.search);
  if (params.has('google')) {
    ui.tab = 'manage';
    history.replaceState(null, '', location.pathname);
  }
  renderAll();
  // データの読み込みに成功した後だけ確認する(読み込み前に足すと空データで上書きしてしまう)
  checkInbox();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkInbox();
  });
}

init();
