'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function clientScripts() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
}

function client() {
  const listeners = {};
  const context = vm.createContext({
    console, URL, URLSearchParams, structuredClone,
    setInterval() {},
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { addEventListener: (event, fn) => { listeners[event] = fn; } },
    confirm: () => true,
    alert: () => {},
    FormData: function(form) { return new Map(Object.entries(form.values)); },
  });
  // ブラウザと同じく、index.htmlの読み込み順にファイルごと別スクリプトとして実行する(読み込み時の参照順の誤りも検出できる)
  for (const file of clientScripts()) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(file === 'js/main.js' ? source.replace(/init\(\);\s*$/, '') : source, context, { filename: file });
  }
  vm.runInContext('save = () => {}; renderAll = () => {}; syncEntryToGoogle = () => {};', context);
  return { context, listeners, run: (code) => vm.runInContext(code, context) };
}

test('search includes completed tasks, notes and normalized tags; today appears only once', () => {
  const { run } = client();
  run(`data.tasks = [
    {id:'one', title:'Alpha', status:'done', note:'Design', tags:['ＶＲ']},
    {id:'two', title:'Today task', status:'todo', todayDate:toDateStr(new Date()), repeat:'daily'},
    {id:'three', title:'Future task', status:'todo', plannedStart:'2099-01-01', plannedEnd:'2099-01-01'}
  ]; ui.todoSearch = 'design vr';`);
  assert.equal(run('applyTodoFilters(data.tasks)[0].id'), 'one');
  assert.equal(run('applyTodoFilters(data.tasks).length'), 1);
  run("ui.todoSearch = '';");
  const html = run('renderTodo()');
  assert.equal((html.match(/title="タスク名を変更" aria-label="Today task/g) || []).length, 1);
  assert.ok(html.indexOf('Today task') < html.indexOf('data-layout-column="1"'));
  assert.ok(html.includes('Future task'));
});

test('undo restores task and entries without reverting unrelated edits', () => {
  const { run } = client();
  run(`data.tasks = [{id:'a', title:'A'}, {id:'b', title:'B'}];
    data.entries = [{id:'entry', taskId:'a', start:100, end:200}];
    deleteTask('a'); data.tasks[0].title = 'Edited'; undoDeletion();`);
  assert.equal(run("taskById('b').title"), 'Edited');
  assert.equal(run("entryById('entry').taskId"), 'a');
  assert.equal(run('data.tasks.length'), 2);
});

test('stop-at rejects future/before-start times and accepts a past end', () => {
  const { run, listeners } = client();
  run("data.entries = [{id:'r', taskId:'a', start:new Date('2020-01-01T10:00').getTime(), end:null}];");
  function submit(end) {
    const form = { dataset: { actionSubmit:'stop-at', id:'r' }, values: { end } };
    listeners.submit({ target: { closest: () => form }, preventDefault() {} });
  }
  submit('2099-01-01T12:00');
  assert.equal(run('data.entries[0].end'), null);
  submit('2020-01-01T09:00');
  assert.equal(run('data.entries[0].end'), null);
  submit('2020-01-01T11:00');
  assert.equal(run('data.entries[0].end - data.entries[0].start'), 3600000);
});

test('project estimates compare the same estimated tasks across all time', () => {
  const { run } = client();
  run(`data.tasks = [{id:'a', title:'A', estimateMinutes:60}, {id:'b', title:'B'}];
    data.entries = [{id:'x', taskId:'a', start:0, end:7200000}, {id:'y', taskId:'b', start:0, end:3600000}];`);
  const html = run('renderReport()');
  assert.ok(html.includes('プロジェクト別 見積と実績'));
  assert.ok(html.includes('+1時間'));
});

test('daily backups retain original data and sanitize today/search fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-test-'));
  try {
    const context = vm.createContext({ require, console, __dirname:root, process:{env:{DATA_DIR:dir}} });
    const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/server\.listen\(PORT, HOST,[\s\S]*$/, '');
    vm.runInContext(source, context);
    const run = (code) => vm.runInContext(code, context);
    run('writeData({clients:[],projects:[],tasks:[],entries:[]})');
    run('writeData({clients:[],projects:[],tasks:[{id:"a"}],entries:[]})');
    run('writeData({clients:[],projects:[],tasks:[{id:"b"}],entries:[]})');
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'backups', backups[0]))).tasks.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'enchanter-data.json'))).tasks[0].id, 'b');
    const { sanitizeData } = require(path.join(root, 'store.js'));
    assert.equal(sanitizeData({tasks:[{todayDate:'bad'}]}).tasks[0].todayDate, null);
    assert.equal(sanitizeData({tasks:[{todayDate:'2026-09-27'}]}).tasks[0].todayDate, '2026-09-27');
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('enchanter-test-'));
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

function loadServerModule(dir) {
  const context = vm.createContext({ require, console, Buffer, __dirname:root, process:{env:{DATA_DIR:dir}} });
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/server\.listen\(PORT, HOST,[\s\S]*$/, '');
  vm.runInContext(source, context);
  return { context, run: (code) => vm.runInContext(code, context) };
}

test('request body split inside a multibyte character is decoded intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-test-'));
  try {
    const { context, run } = loadServerModule(dir);
    const text = '{"title":"日本語のタスク"}';
    const bytes = Buffer.from(text, 'utf8');
    const cut = bytes.indexOf(Buffer.from('日')) + 1;
    const req = new EventEmitter();
    req.destroy = () => {};
    const res = { writeHead() {}, end() {} };
    let received = null;
    Object.assign(context, { req, res, onEnd: (body) => { received = body; } });
    run('readBody(req, res, onEnd)');
    req.emit('data', bytes.subarray(0, cut));
    req.emit('data', bytes.subarray(cut));
    req.emit('end');
    assert.equal(received, text);
  } finally {
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

test('request body over the byte limit gets 413 and is not passed on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-test-'));
  try {
    const { context, run } = loadServerModule(dir);
    const req = new EventEmitter();
    req.destroy = () => {};
    const res = { status: null, writeHead(status) { this.status = status; }, end() {} };
    let called = false;
    Object.assign(context, { req, res, onEnd: () => { called = true; } });
    run('readBody(req, res, onEnd)');
    req.emit('data', Buffer.alloc(run('MAX_BODY') + 1));
    req.emit('end');
    assert.equal(res.status, 413);
    assert.equal(called, false);
  } finally {
    fs.rmSync(dir, {recursive:true, force:true});
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

function httpRequest(port, { method, path: urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await httpRequest(port, { method: 'GET', path: '/api/google/status' });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('server did not start');
}

test('sync-entry answers non-object JSON bodies with 400 and the server keeps running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir },
    stdio: 'ignore',
  });
  try {
    await waitForServer(port);
    const headers = { 'X-Requested-With': 'enchanter' };
    for (const body of ['null', '[]', '1']) {
      const response = await httpRequest(port, { method: 'POST', path: '/api/calendar/sync-entry', headers, body });
      assert.equal(response.status, 400);
    }
    assert.equal((await httpRequest(port, { method: 'GET', path: '/api/google/status' })).status, 200);
  } finally {
    child.kill();
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

test('todo chips escape planned times instead of inserting them as markup', () => {
  const { run } = client();
  run(`data.tasks = [{id:'p', title:'Planned', status:'todo', plannedStart:'2099-01-01', plannedEnd:'2099-01-01', plannedStartTime:'<img src=x onerror=alert(1)>'}];`);
  const html = run('renderTodo()');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('gantt shows the 4-week view above the 1-day view', () => {
  const { run } = client();
  run(`data.tasks = [{id:'g', title:'Gantt task', status:'todo', plannedStart:'2099-01-10', plannedEnd:'2099-01-12'}];
    ui.ganttStart = '2099-01-05'; ui.ganttDays = 28; ui.ganttDate = '2099-01-10';`);
  const html = run('renderGantt()');
  assert.ok(html.indexOf('gantt-wrap') > -1);
  assert.ok(html.indexOf('gantt-wrap') < html.indexOf('🕐 1日'));
});

test('gantt week view shows the month above the day headings', () => {
  const { run } = client();
  run(`data.tasks = [{id:'g', title:'Gantt task', status:'todo', plannedStart:'2099-01-30', plannedEnd:'2099-02-02'}];
    ui.ganttStart = '2099-01-29'; ui.ganttDays = 7;`);
  const html = run('renderGanttWeek()');
  assert.ok(html.includes('<span>2099年1月</span>'));
  assert.ok(html.includes('<span>2月</span>'));
  assert.ok(html.indexOf('2099年1月') < html.indexOf('gantt-day-v'));
});

test('gantt rows offer the same start and stop timer buttons as the todo tab', () => {
  const { run } = client();
  run(`data.tasks = [
    {id:'idle', title:'Idle task', status:'todo', plannedStart:'2099-01-10', plannedEnd:'2099-01-10'},
    {id:'busy', title:'Busy task', status:'todo', plannedStart:'2099-01-10', plannedEnd:'2099-01-10'},
    {id:'fin', title:'Finished task', status:'done', plannedStart:'2099-01-10', plannedEnd:'2099-01-10'}
  ];
    data.entries = [{id:'e1', taskId:'busy', start: Date.now() - 60000, end: null}];
    ui.ganttStart = '2099-01-05'; ui.ganttDays = 28;`);
  const html = run('renderGanttWeek()');
  assert.ok(html.includes('<button class="timer-btn start" data-action="start-timer" data-id="idle">'));
  assert.ok(html.includes('<button class="timer-btn stop" data-action="stop-timer" data-id="e1">'));
  assert.ok(!html.includes('data-action="start-timer" data-id="fin"'));
  assert.ok(!html.includes('data-action="start-timer" data-id="busy"'));
});

test('an edit made while an external-change check is running is not dropped silently', async () => {
  const alerts = [];
  const context = vm.createContext({
    console, URL, URLSearchParams, structuredClone, setInterval() {},
    window: { addEventListener() {} },
    document: { addEventListener() {}, hidden: false, activeElement: null },
    alert: (message) => alerts.push(message),
  });
  for (const file of clientScripts()) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(file === 'js/main.js' ? source.replace(/init\(\);\s*$/, '') : source, context, { filename: file });
  }
  const json = (status, value, revision) => ({
    status, ok: status < 300, json: async () => value,
    headers: { get: (name) => (name === 'X-Data-Revision' ? revision : null) },
  });
  context.fetch = async (url, options = {}) => {
    if (url === '/api/data/revision') return json(200, { revision: 'cli' });
    if (options.method === 'PUT') return json(options.headers['If-Match'] === 'cli' ? 204 : 409, null, 'cli');
    return json(200, { tasks: [{ id: 'cli-task', title: 'CLI' }] }, 'cli');
  };
  vm.runInContext("renderAll = () => {}; dataRevision = 'browser'; checkExternalChange(); data.tasks.push({id:'local'}); save();", context);
  await vm.runInContext('saveChain', context);
  assert.equal(alerts.length, 1);
  assert.equal(vm.runInContext("data.tasks.map((task) => task.id).join()", context), 'cli-task');
});

test('task links: form input is parsed, unsafe URLs are dropped, chips open in a new tab', () => {
  const { run } = client();
  const links = run(`parseLinks('仕様書 https://example.com/spec?a=1&b=2\\nhttps://docs.example.com/x\\njavascript:alert(1)\\nhttps://example.com/spec?a=1&b=2\\nメモだけ')`);
  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { url: 'https://example.com/spec?a=1&b=2', title: '仕様書' },
    { url: 'https://docs.example.com/x', title: null },
  ]);
  run(`data.tasks = [{id:'t', title:'T', status:'todo', links:${JSON.stringify(links)}}];`);
  assert.equal(run('linksToText(data.tasks[0].links)'), '仕様書 https://example.com/spec?a=1&b=2\nhttps://docs.example.com/x');
  const html = run('renderTodo()');
  assert.ok(html.includes('href="https://example.com/spec?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"'));
  assert.ok(html.includes('🔗 docs.example.com'));
  run("ui.todoSearch = 'docs.example';");
  assert.equal(run('applyTodoFilters(data.tasks).length'), 1);
  const multi = run(`parseLinks('メモ https://a.example.com https://b.example.com')`);
  assert.deepEqual(JSON.parse(JSON.stringify(multi)), [
    { url: 'https://a.example.com/', title: 'メモ' },
    { url: 'https://b.example.com/', title: null },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(run(`parseLinks(linksToText(parseLinks('メモ https://a.example.com https://b.example.com')))`))), JSON.parse(JSON.stringify(multi)));
  run(`data.tasks[0].links.push({url:'javascript:alert(1)', title:'x'});`);
  assert.ok(!run('renderTodo()').includes('javascript:'));
  run("ui.todoSearch = ''; ui.editingTask = 't';");
  assert.ok(run('renderTodo()').includes('name="links"'));
});

test('sanitizeData keeps only http(s) links with normalized titles', () => {
  const { sanitizeData } = require(path.join(root, 'store.js'));
  const task = sanitizeData({ tasks: [{ id: 'a', links: [
    { url: 'https://example.com', title: '  資料 ' },
    { url: 'javascript:alert(1)', title: 'x' },
    { url: 'not a url' },
    { url: 'https://example.com/', title: 'dup' },
    'https://bare.example.com',
    { url: 'http://b.example.com/a"b', title: '' },
  ] }] }).tasks[0];
  assert.deepEqual(task.links, [
    { url: 'https://example.com/', title: '資料' },
    { url: 'http://b.example.com/a%22b', title: null },
  ]);
  assert.deepEqual(sanitizeData({ tasks: [{ id: 'b' }] }).tasks[0].links, []);
});

test('todo group layout can be rearranged by key, saved and reset', () => {
  const { run, listeners } = client();
  const order = (html) => [...html.matchAll(/data-group-key="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order(run('renderTodo()')), ['today', 'limited', 'upcoming', 'recurring']);
  assert.ok(!run('renderTodo()').includes('reset-todo-layout'));

  // 同じ列の中で前へ、別の列の末尾へ、別の列の先頭へ
  assert.equal(run("moveTodoGroup('limited', 0, 'today')"), true);
  assert.equal(run("moveTodoGroup('today', 1, null)"), true);
  assert.equal(run("moveTodoGroup('recurring', 0, 'limited')"), true);
  assert.equal(run('JSON.stringify(data.todoLayout)'), JSON.stringify([['recurring', 'limited'], ['upcoming', 'today']]));
  // 位置が変わらない移動は保存しない
  assert.equal(run("moveTodoGroup('today', 1, null)"), false);
  assert.equal(run("moveTodoGroup('nope', 0, null)"), false);

  // 片方の列を空にすると、ドロップ先の案内を出す
  run("moveTodoGroup('upcoming', 0, null); moveTodoGroup('today', 0, null);");
  const html = run('renderTodo()');
  assert.deepEqual(order(html), ['recurring', 'limited', 'upcoming', 'today']);
  assert.ok(html.includes('todo-column todo-column-empty" data-layout-column="1"'));
  assert.ok(html.includes('reset-todo-layout'));

  const element = { dataset: { action: 'reset-todo-layout' } };
  listeners.click({ target: { closest: () => element } });
  assert.equal(run('data.todoLayout'), null);
  assert.deepEqual(order(run('renderTodo()')), ['today', 'limited', 'upcoming', 'recurring']);
});

test('normalizeTodoLayout and sanitizeData repair broken layouts', () => {
  const { run } = client();
  assert.equal(run("JSON.stringify(normalizeTodoLayout([['recurring', 'bogus', 'recurring'], 'x', ['today']]))"),
    JSON.stringify([['recurring', 'today', 'limited'], ['upcoming']]));
  assert.equal(run('JSON.stringify(normalizeTodoLayout(null))'), JSON.stringify([['today', 'limited'], ['upcoming', 'recurring']]));
  const { sanitizeData } = require(path.join(root, 'store.js'));
  assert.deepEqual(sanitizeData({ todoLayout: [['upcoming', 'evil"<'], ['today', 'upcoming']] }).todoLayout, [['upcoming'], ['today']]);
  assert.equal(sanitizeData({ todoLayout: 'x' }).todoLayout, null);
  assert.equal(sanitizeData({ todoLayout: [[], [], []] }).todoLayout, null);
  assert.equal(sanitizeData({}).todoLayout, null);
});
