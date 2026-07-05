'use strict';

/* ============================================================
 * Enchanter - ローカルサーバー
 * 静的ファイルの配信と、データのJSONファイル保存を行う。
 * 依存パッケージなし。`node server.js` で起動。
 * ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'enchanter-data.json');
const MAX_BODY = 20 * 1024 * 1024;

const EMPTY_DATA = { clients: [], projects: [], tasks: [], entries: [] };

const STATIC_ROUTES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function readData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      clients: d.clients || [],
      projects: d.projects || [],
      tasks: d.tasks || [],
      entries: d.entries || [],
    };
  } catch (e) {
    return EMPTY_DATA;
  }
}

// 一時ファイルに書いてからリネームすることで、書き込み中のクラッシュでも
// 既存データが壊れないようにする
function writeData(obj) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, DATA_FILE);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- API ----
  if (url.pathname === '/api/data') {
    if (req.method === 'GET') {
      sendJson(res, 200, readData());
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) {
          aborted = true;
          sendJson(res, 413, { error: 'データが大きすぎます' });
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const d = JSON.parse(body);
          if (typeof d !== 'object' || d === null || Array.isArray(d)) {
            throw new Error('invalid shape');
          }
          writeData({
            clients: d.clients || [],
            projects: d.projects || [],
            tasks: d.tasks || [],
            entries: d.entries || [],
          });
          res.writeHead(204);
          res.end();
        } catch (e) {
          sendJson(res, 400, { error: '不正なJSONです' });
        }
      });
      return;
    }
    res.writeHead(405, { Allow: 'GET, PUT' });
    res.end();
    return;
  }

  // ---- 静的ファイル ----
  const route = STATIC_ROUTES[url.pathname];
  if (req.method === 'GET' && route) {
    const [file, type] = route;
    fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': type });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Enchanter が起動しました: http://localhost:${PORT}`);
  console.log(`データ保存先: ${DATA_FILE}`);
});
