'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function tempDataDir(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-test-'));
  if (data) fs.writeFileSync(path.join(dir, 'enchanter-data.json'), JSON.stringify(data));
  return dir;
}

function cli(dir, ...args) {
  const result = spawnSync(process.execPath, [path.join(root, 'cli.js'), ...args], {
    env: { ...process.env, DATA_DIR: dir, PORT: '1' },
    encoding: 'utf8',
  });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

const readFile = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'enchanter-data.json'), 'utf8'));

const SAMPLE = {
  clients: [{ id: 'c1', name: '顧客' }],
  categories: [{ id: 'k1', name: '開発' }],
  projects: [{ id: 'p1', name: 'Webサイト', clientId: 'c1', color: '#3987e5' }],
  tasks: [{ id: 'aaa111', title: '既存', status: 'todo', createdAt: 1 }, { id: 'aaa222', title: '既存2', status: 'todo', createdAt: 2 }],
  entries: [],
};

test('add works without a server and stores sanitized fields; ls prints one line per task', () => {
  const dir = tempDataDir(SAMPLE);
  try {
    const added = cli(dir, 'add', '請求書', '送付', '-p', 'web', '-c', '開発', '-i', '3', '-e', '90', '-t', 'a, b,a', '--start', '2099-01-02', '--end', '2099-01-01');
    assert.equal(added.code, 0, added.err);
    const task = readFile(dir).tasks.find((item) => item.title === '請求書 送付');
    assert.equal(task.projectId, 'p1');
    assert.equal(task.categoryId, 'k1');
    assert.deepEqual(task.tags, ['a', 'b']);
    assert.equal(task.estimateMinutes, 90);
    assert.equal(task.plannedStart, '2099-01-01'); // 逆順は画面と同じく入れ替える
    assert.equal(added.out, `added ${task.id} todo !3 請求書 送付 @Webサイト #a #b 2099/1/1〜2099/1/2 0m/1h30m`);
    assert.equal(cli(dir, 'ls').out.split('\n')[0], `${task.id} todo !3 請求書 送付 @Webサイト #a #b 2099/1/1〜2099/1/2 0m/1h30m`);
    assert.equal(fs.existsSync(path.join(dir, 'backups')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('done stops the timer and creates the next repeat like the UI does', () => {
  const dir = tempDataDir(SAMPLE);
  try {
    assert.equal(cli(dir, 'edit', 'aaa111', '-r', 'weekly', '--start', '2099-01-01').code, 0);
    assert.match(cli(dir, 'start', 'aaa111').out, /in_progress .*▶$/);
    const done = cli(dir, 'done', 'aaa111');
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, /\nnext \S+ todo 既存 2099\/1\/8$/);
    const data = readFile(dir);
    assert.equal(data.entries.length, 1);
    assert.notEqual(data.entries[0].end, null);
    assert.equal(data.tasks.find((task) => task.id === 'aaa111').status, 'done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous ids and unknown options fail without writing', () => {
  const dir = tempDataDir(SAMPLE);
  try {
    const before = fs.readFileSync(path.join(dir, 'enchanter-data.json'), 'utf8');
    const ambiguous = cli(dir, 'done', 'aaa');
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.err, /曖昧/);
    assert.equal(cli(dir, 'add', 'x', '--bogus', '1').code, 1);
    assert.equal(cli(dir, 'add', 'x', '-i', '9').code, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'enchanter-data.json'), 'utf8'), before);
    assert.equal(cli(dir, 'done', '222').code, 0); // 後方一致でも一意なら可
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('log records a past entry and sum totals it', () => {
  const dir = tempDataDir(SAMPLE);
  try {
    const logged = cli(dir, 'log', 'aaa111', 'yesterday', '-1T10:00', '-1T11:30');
    assert.equal(logged.code, 1); // 日付だけの開始は不可
    assert.equal(cli(dir, 'log', 'aaa111', '-1T10:00', '-1T11:30').code, 0);
    assert.match(cli(dir, 'sum', '--from', '-1').out, /合計 1h30m\n1h30m 既存$/);
    assert.equal(readFile(dir).tasks.find((task) => task.id === 'aaa111').status, 'in_progress');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(port, { method = 'GET', urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a browser save based on stale data is rejected after the CLI writes', async () => {
  const dir = tempDataDir(SAMPLE);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir },
    stdio: 'ignore',
  });
  try {
    let loaded;
    for (let attempt = 0; attempt < 50 && !loaded; attempt++) {
      try { loaded = await request(port, { urlPath: '/api/data' }); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const revision = loaded.headers['x-data-revision'];
    const headers = { 'X-Requested-With': 'enchanter', 'If-Match': revision };
    const saved = await request(port, { method: 'PUT', urlPath: '/api/data', headers, body: loaded.body });
    assert.equal(saved.status, 204);
    const next = saved.headers['x-data-revision'];
    assert.equal(JSON.parse((await request(port, { urlPath: '/api/data/revision' })).body).revision, next);

    assert.equal(cli(dir, 'add', 'CLIの変更').code, 0);
    const stale = await request(port, { method: 'PUT', urlPath: '/api/data', headers: { ...headers, 'If-Match': next }, body: loaded.body });
    assert.equal(stale.status, 409);
    assert.ok(readFile(dir).tasks.some((task) => task.title === 'CLIの変更'));
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
