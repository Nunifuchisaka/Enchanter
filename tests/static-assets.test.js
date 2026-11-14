'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function referencedAssets() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  return [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map((match) => match[1]);
}

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

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] }));
    }).on('error', reject);
  });
}

test('index.html loads every file in js/ and css/ exactly once', () => {
  const assets = referencedAssets();
  const onDisk = ['js', 'css'].flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((name) => `${dir}/${name}`));
  assert.deepEqual([...assets].sort(), onDisk.sort());
  assert.equal(new Set(assets).size, assets.length);
  assert.equal(assets.filter((file) => file.endsWith('.js')).at(-1), 'js/main.js');
  assert.equal(assets.filter((file) => file.endsWith('.css')).at(-1), 'css/responsive.css');
});

test('server serves js/ and css/ assets and nothing outside them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir },
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await get(port, '/'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    for (const asset of referencedAssets()) {
      const response = await get(port, `/${asset}`);
      assert.equal(response.status, 200, asset);
      assert.match(response.type, asset.endsWith('.js') ? /javascript/ : /text\/css/);
    }
    for (const blocked of ['/js/missing.js', '/js/main.css', '/js/..%2fserver.js', '/server.js', '/app.js', '/css/../server.js']) {
      assert.equal((await get(port, blocked)).status, 404, blocked);
    }
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function request(port, { method, urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('image candidates: upload needs the CSRF header, only real images are stored, files are served safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir },
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await get(port, '/'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const csrf = { 'X-Requested-With': 'enchanter', 'Content-Type': 'image/png' };
    assert.equal((await request(port, { method: 'POST', urlPath: '/api/images', headers: { 'Content-Type': 'image/png' }, body: png })).status, 400);
    const svg = await request(port, { method: 'POST', urlPath: '/api/images', headers: { ...csrf, 'Content-Type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
    assert.equal(svg.status, 415);
    const uploaded = await request(port, { method: 'POST', urlPath: '/api/images', headers: csrf, body: png });
    assert.equal(uploaded.status, 201);
    const { file } = JSON.parse(uploaded.body.toString());
    assert.match(file, /^[0-9a-f]{32}\.png$/);
    const served = await request(port, { method: 'GET', urlPath: `/api/images/${file}` });
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.match(served.headers['content-security-policy'], /sandbox/);
    assert.deepEqual(served.body, png);
    for (const blocked of ['/api/images/..%2fenchanter-data.json', '/api/images/abc.png', `/api/images/${file.replace('.png', '.svg')}`, '/api/images/']) {
      assert.equal((await request(port, { method: 'GET', urlPath: blocked })).status, 404, blocked);
    }
    assert.equal((await request(port, { method: 'DELETE', urlPath: `/api/images/${file}` })).status, 405);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
