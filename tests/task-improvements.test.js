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
  vm.runInContext('globalThis.realSave = save; save = () => {}; renderAll = () => {}; syncEntryToGoogle = () => {}; celebrate = () => {};', context);
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
  assert.ok(html.indexOf('Today task') < html.indexOf('todo-column">', html.indexOf('Today task')));
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
  const context = vm.createContext({ require, console, Buffer, URL, __dirname:root, process:{env:{DATA_DIR:dir}} });
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

function celebrationClient() {
  const harness = client();
  harness.run(`globalThis.celebrated = [];
    celebrate = (kind, origin, detail) => { celebrated.push({ kind, detail }); };
    document.querySelectorAll = () => [];`);
  harness.kinds = () => JSON.parse(harness.run('JSON.stringify(celebrated.map((item) => item.kind))'));
  harness.details = () => JSON.parse(harness.run('JSON.stringify(celebrated.map((item) => item.detail))'));
  return harness;
}

function elementFor(action, id) {
  return { dataset: { action, id }, getBoundingClientRect: () => ({ left: 10, top: 20, width: 30, height: 40 }) };
}

function clickOn(listeners, action, id) {
  const element = elementFor(action, id);
  listeners.click({ target: { closest: () => element } });
}

test('start-timer celebrates once and stays silent when the task is already running', () => {
  const { run, listeners, kinds } = celebrationClient();
  run(`data.tasks = [{id:'t', title:'T', status:'todo'}]; data.entries = [];`);
  clickOn(listeners, 'start-timer', 't');
  assert.deepEqual(kinds(), ['start']);
  clickOn(listeners, 'start-timer', 't');
  assert.deepEqual(kinds(), ['start']);
});

test('stop-timer celebrates with the elapsed time, and stop-all celebrates once for many timers', () => {
  const { run, listeners, kinds, details } = celebrationClient();
  run(`data.tasks = [{id:'a', title:'A', status:'in_progress'}, {id:'b', title:'B', status:'in_progress'}, {id:'c', title:'C', status:'in_progress'}];
    data.entries = [
      {id:'e1', taskId:'a', start: Date.now() - 60000, end: null},
      {id:'e2', taskId:'b', start: Date.now() - 60000, end: null},
      {id:'e3', taskId:'c', start: Date.now() - 60000, end: null}
    ];`);
  clickOn(listeners, 'stop-timer', 'e1');
  assert.deepEqual(kinds(), ['stop']);
  assert.match(details()[0], /^0:01:/);
  clickOn(listeners, 'stop-timer', 'e1');
  assert.deepEqual(kinds(), ['stop']);
  clickOn(listeners, 'stop-all-timers', null);
  assert.deepEqual(kinds(), ['stop', 'stop']);
  assert.equal(details()[1], '2件');
});

test('completion outranks stop: cycling into done stops the timer with a complete celebration only', () => {
  const { run, listeners, kinds } = celebrationClient();
  run(`data.tasks = [{id:'a', title:'A', status:'waiting_review'}];
    data.entries = [{id:'e', taskId:'a', start: Date.now() - 5000, end: null}];`);
  clickOn(listeners, 'cycle-status', 'a');
  assert.equal(run("taskById('a').status"), 'done');
  assert.notEqual(run("data.entries[0].end"), null);
  assert.deepEqual(kinds(), ['complete']);
});

test('cycling through non-done states and leaving done celebrate nothing', () => {
  const { run, listeners, kinds } = celebrationClient();
  run(`data.tasks = [{id:'a', title:'A', status:'todo'}]; data.entries = [];`);
  clickOn(listeners, 'cycle-status', 'a');
  clickOn(listeners, 'cycle-status', 'a');
  assert.deepEqual(kinds(), []);
  clickOn(listeners, 'cycle-status', 'a');
  assert.deepEqual(kinds(), ['complete']);
  clickOn(listeners, 'cycle-status', 'a');
  assert.equal(run("taskById('a').status"), 'todo');
  assert.deepEqual(kinds(), ['complete']);
});

test('kanban arrow keys celebrate only when moving into done', () => {
  const { run, listeners, kinds } = celebrationClient();
  run(`data.tasks = [{id:'k', title:'K', status:'waiting_review'}]; data.entries = [];`);
  const card = { dataset: { id: 'k' }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) };
  const press = (key) => listeners.keydown({
    key, preventDefault() {},
    target: { matches: () => false, isContentEditable: false, closest: (selector) => (selector === '.kanban-card' ? card : null) },
  });
  press('ArrowRight');
  assert.deepEqual(kinds(), ['complete']);
  press('ArrowLeft');
  assert.equal(run("taskById('k').status"), 'waiting_review');
  assert.deepEqual(kinds(), ['complete']);
});

test('kanban drop into done celebrates once and dropping within done does not repeat it', () => {
  const { run, kinds } = celebrationClient();
  run(`data.tasks = [{id:'d', title:'D', status:'waiting_review'}]; data.entries = [];`);
  run(`globalThis.doneColumn = { dataset: { status: 'done' }, querySelectorAll: () => [] };
    document.elementFromPoint = () => ({ closest: (selector) => (selector === '.kanban-column' ? doneColumn : null) });`);
  const drag = () => run(`kanbanDrag = { pointerId: 1, taskId: 'd', started: true, overColumn: null,
    element: { classList: { remove() {} }, style: {}, hasPointerCapture: () => false, releasePointerCapture() {} } };`);
  drag();
  run('finishKanbanDrag({ pointerId: 1, clientX: 5, clientY: 6 }, true)');
  assert.equal(run("taskById('d').status"), 'done');
  assert.deepEqual(kinds(), ['complete']);
  drag();
  run('finishKanbanDrag({ pointerId: 1, clientX: 5, clientY: 6 }, true)');
  assert.deepEqual(kinds(), ['complete']);
});

test('stop-at form celebrates stop only when the end time is accepted', () => {
  const { run, listeners, kinds } = celebrationClient();
  run("data.entries = [{id:'r', taskId:'a', start:new Date('2020-01-01T10:00').getTime(), end:null}];");
  const form = (end) => ({ dataset: { actionSubmit: 'stop-at', id: 'r' }, values: { end },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) });
  listeners.submit({ target: { closest: () => form('2099-01-01T12:00') }, preventDefault() {} });
  assert.deepEqual(kinds(), []);
  listeners.submit({ target: { closest: () => form('2020-01-01T11:00') }, preventDefault() {} });
  assert.deepEqual(kinds(), ['stop']);
});

test('merge import adds only new ids and keeps existing data', () => {
  const { run } = client();
  run(`data.clients = [{id:'c1', name:'既存'}]; data.tasks = [{id:'t1', title:'既存タスク'}];
    applyMerge(planMerge({clients:[{id:'c1', name:'上書きしない'}, {id:'c2', name:'新規'}], tasks:[{id:'t1', title:'X'}, {id:'t2', title:'新規タスク'}]}));`);
  assert.equal(run("data.clients.find(c => c.id === 'c1').name"), '既存');
  assert.equal(run('data.clients.length'), 2);
  assert.equal(run('data.tasks.length'), 2);
  run(`applyMerge(planMerge({tasks:[{id:'t2', title:'again'}]}));`);
  assert.equal(run('data.tasks.length'), 2);
});

test('pasted checklist lines become separate subtasks', () => {
  const { run } = client();
  const lines = run(`parseChecklistLines('- [ ] 一つ目\\n- [x] 二つ目\\n\\n・三つ目\\n1. 四つ目')`);
  assert.deepEqual([...lines], ['一つ目', '二つ目', '三つ目', '四つ目']);
  run(`data.tasks = [{id:'t', title:'T'}]; addSubtasks('t', ['a', 'b']);`);
  assert.equal(run("taskById('t').subtasks.length"), 2);
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

test('inbox endpoints list sanitized files and move them only with the CSRF header', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-inbox-'));
  const inbox = path.join(dir, 'imports');
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'a.json'), JSON.stringify({ tasks: [{ id: 'x', title: 'X', status: 'bogus' }] }));
  fs.writeFileSync(path.join(inbox, 'broken.json'), '{');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'data'), INBOX_DIR: inbox, BROWSER: 'none', NO_OPEN: '1' },
    stdio: 'ignore',
  });
  try {
    let list;
    for (let i = 0; i < 50 && !list; i++) {
      try { list = await (await fetch(`http://127.0.0.1:${port}/api/inbox`)).json(); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.equal(list.files.length, 2);
    assert.equal(list.files[0].content.tasks[0].status, 'todo');
    assert.equal(list.files[1].error, 'invalid');
    const noHeader = await fetch(`http://127.0.0.1:${port}/api/inbox/done`, { method: 'POST', body: '{"name":"a.json"}' });
    assert.equal(noHeader.status, 400);
    const bad = await fetch(`http://127.0.0.1:${port}/api/inbox/done`, { method: 'POST', headers: { 'X-Requested-With': 'enchanter' }, body: '{"name":"../a.json"}' });
    assert.equal(bad.status, 400);
    const ok = await fetch(`http://127.0.0.1:${port}/api/inbox/done`, { method: 'POST', headers: { 'X-Requested-With': 'enchanter' }, body: '{"name":"a.json"}' });
    assert.equal((await ok.json()).moved, true);
    assert.ok(fs.existsSync(path.join(inbox, '取り込み済み', 'a.json')));
  } finally {
    child.kill();
  }
});

test('a failed inbox move answers 500 and leaves the server running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-inbox-'));
  const inbox = path.join(dir, 'imports');
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'a.json'), '{}');
  fs.writeFileSync(path.join(inbox, '取り込み済み'), 'フォルダーを作れなくする');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'data'), INBOX_DIR: inbox },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/api/inbox`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const moved = await fetch(`http://127.0.0.1:${port}/api/inbox/done`, { method: 'POST', headers: { 'X-Requested-With': 'enchanter' }, body: '{"name":"a.json"}' });
    assert.equal(moved.status, 500);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/inbox`)).status, 200);
  } finally {
    child.kill();
  }
});

// checkInboxを本物のsave()で動かす。putは1回ごとのPUTの応答ステータス
function inboxClient(putStatuses) {
  const harness = client();
  const log = { puts: 0, moved: [] };
  const respond = (status, value, revision) => ({
    status, ok: status < 300, json: async () => value,
    headers: { get: (name) => (name === 'X-Data-Revision' ? revision : null) },
  });
  harness.context.fetch = async (url, options = {}) => {
    if (url === '/api/inbox') {
      return respond(200, { files: [{ name: 'a.json', content: { tasks: [{ id: 'inbox-task', title: 'X', status: 'todo' }] } }] });
    }
    if (url === '/api/inbox/done') {
      log.moved.push(JSON.parse(options.body).name);
      return respond(200, { moved: true });
    }
    if (options.method === 'PUT') return respond(putStatuses[log.puts++] ?? 204, null, 'next');
    return respond(200, { tasks: [] }, 'next');
  };
  harness.run("save = realSave; dataRevision = 'old';");
  harness.hasTask = () => harness.run("data.tasks.some((task) => task.id === 'inbox-task')");
  return { ...harness, log };
}

test('checkInbox moves the file only after the import has been saved', async () => {
  const { run, log, hasTask } = inboxClient([]);
  await run('checkInbox()');
  assert.equal(log.puts, 1);
  assert.deepEqual(log.moved, ['a.json']);
  assert.ok(hasTask());
  assert.match(run('ui.inboxNotice'), /タスク 1 件/);
});

test('checkInbox keeps the file when a 409 throws the import away, then imports it next time', async () => {
  const { run, log, hasTask } = inboxClient([409]);
  await run('checkInbox()');
  assert.equal(log.puts, 1);
  assert.deepEqual(log.moved, []);
  assert.equal(hasTask(), false);
  await run('checkInbox()');
  assert.deepEqual(log.moved, ['a.json']);
  assert.ok(hasTask());
});

test('checkInbox keeps the file when saving fails and saves again before moving it', async () => {
  const { run, log } = inboxClient([500]);
  await run('checkInbox()');
  assert.deepEqual(log.moved, []);
  await run('checkInbox()');
  assert.equal(log.puts, 2);
  assert.deepEqual(log.moved, ['a.json']);
  assert.equal(run("data.tasks.filter((task) => task.id === 'inbox-task').length"), 1);
});

test('checkInbox waits while the user is editing', async () => {
  const { run, log, hasTask } = inboxClient([]);
  run("ui.editingTask = 'other';");
  await run('checkInbox()');
  assert.equal(log.puts, 0);
  assert.deepEqual(log.moved, []);
  assert.equal(hasTask(), false);
});

test('clicking a tag chip toggles the tag filter', () => {
  const { run, listeners } = client();
  run(`data.tasks = [{id:'t', title:'T', status:'todo', tags:['2人']}];`);
  const el = { dataset: { action: 'filter-by-tag', tag: '2人' } };
  const event = { target: { closest: () => el } };
  listeners.click(event);
  assert.equal(run('ui.todoFilterTag'), '2人');
  listeners.click(event);
  assert.equal(run('ui.todoFilterTag'), '');
  assert.ok(run('tagChips(data.tasks[0])').includes('data-action="filter-by-tag"'));
});

test('checklist progress board lists unfinished checklists first', () => {
  const { run } = client();
  const html = run(`checklistProgressBoard([
    {id:'a', title:'Half', status:'todo', subtasks:[{id:'1', title:'x', done:true}, {id:'2', title:'y', done:false}]},
    {id:'b', title:'None', status:'todo', subtasks:[{id:'3', title:'z', done:false}]},
    {id:'c', title:'NoList', status:'todo'}
  ])`);
  assert.ok(html.indexOf('None') < html.indexOf('Half'));
  assert.ok(!html.includes('NoList'));
  assert.ok(html.includes('1/3'));
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

const LOCAL_LINK_SAMPLES = [
  'D:\\YouTube\\zundamon-video\\kaihen\\talk-intro\\talk-intro.mp4',
  'D:/a b/日本語 #1?&+,=%.mp4',
  'd:\\x\\..\\y.png',
  'file:///D:/a%20b/c.mp4',
  'file:///D:/a b/日本.mp4',
  'file://localhost/D:/a.mp4',
  'https://example.com/a b',
];

test('sanitizeData accepts Windows paths and file URLs as normalized file URLs and rejects the rest', () => {
  const { sanitizeData, safeLinkUrl } = require(path.join(root, 'store.js'));
  const { pathToFileURL } = require('node:url');
  const task = sanitizeData({ tasks: [{ id: 'a', links: [
    { url: 'D:\\YouTube\\zundamon-video\\kaihen\\talk-intro\\talk-intro.mp4', title: '動画' },
    { url: 'D:/YouTube/zundamon-video/kaihen/talk-intro/talk-intro.mp4', title: '重複' },
    { url: 'file:///D:/%E5%8B%95%E7%94%BB/a%20b.mp4' },
    { url: 'file://server/share/a.mp4' },
    { url: 'file:///D:/a%2Fb.mp4' },
    { url: 'file:///D:/a.mp4#x' },
    { url: 'D:relative.mp4' },
    { url: 'javascript:alert(1)' },
    { url: 'D:\\a\u0000b.mp4' },
    { url: 'e:\\小文字\\x.mp4' },
    { url: 'file:///e:/%E5%B0%8F%E6%96%87%E5%AD%97/x.mp4' },
  ] }] }).tasks[0];
  // ドライブ名はブラウザのURLと同じく大文字にそろえる
  assert.deepEqual(task.links, [
    { url: 'file:///D:/YouTube/zundamon-video/kaihen/talk-intro/talk-intro.mp4', title: '動画' },
    { url: 'file:///D:/%E5%8B%95%E7%94%BB/a%20b.mp4', title: null },
    { url: 'file:///E:/%E5%B0%8F%E6%96%87%E5%AD%97/x.mp4', title: null },
  ]);
  // 空白・日本語・#・?・%などはurl.pathToFileURLと同じ形になる([ ] ^ ~ はNodeだけがエンコードするので対象外)
  for (const sample of ['D:\\a b\\日本語 #1?&+,=%.mp4', 'D:\\YouTube\\talk-intro.mp4', 'C:\\Users\\x\\(1){3}.png']) {
    assert.equal(safeLinkUrl(sample), pathToFileURL(sample, { windows: true }).href, sample);
  }
  const { run } = client();
  for (const sample of LOCAL_LINK_SAMPLES) {
    const once = safeLinkUrl(sample);
    assert.equal(safeLinkUrl(once), once, sample);
    // 画面(js/domain.js)とサーバー(store.js)で結果が一致する
    assert.equal(run(`safeLinkUrl(${JSON.stringify(sample)})`), once, sample);
  }
});

test('local file links: parsed from the form, shown as Windows paths, opened through the server', async () => {
  const { context, listeners, run } = client();
  const links = run(`parseLinks(${JSON.stringify('イントロ D:\\YouTube\\talk intro\\talk-intro.mp4\nD:/動画/a.mp4 https://example.com/x\n"E:\\引用 符\\b.srt"')})`);
  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { url: 'file:///D:/YouTube/talk%20intro/talk-intro.mp4', title: 'イントロ' },
    { url: 'https://example.com/x', title: null },
    { url: 'file:///D:/%E5%8B%95%E7%94%BB/a.mp4', title: null },
    { url: 'file:///E:/%E5%BC%95%E7%94%A8%20%E7%AC%A6/b.srt', title: null },
  ]);
  run(`data.tasks = [{id:'t', title:'T', status:'todo', links:${JSON.stringify(links)}}];`);
  const text = run('linksToText(data.tasks[0].links)');
  assert.ok(text.startsWith('イントロ D:\\YouTube\\talk intro\\talk-intro.mp4\n'));
  assert.deepEqual(JSON.parse(JSON.stringify(run(`parseLinks(${JSON.stringify(text)})`))), JSON.parse(JSON.stringify(links)));
  const html = run('renderTodo()');
  assert.ok(html.includes('href="file:///D:/YouTube/talk%20intro/talk-intro.mp4" data-action="open-local-file" title="D:\\YouTube\\talk intro\\talk-intro.mp4">🔗 イントロ</a>'));
  assert.ok(html.includes('title="D:\\動画\\a.mp4">🔗 a.mp4</a>'));
  assert.ok(html.includes('href="https://example.com/x" target="_blank" rel="noopener noreferrer"'));

  const requests = [];
  context.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true }; };
  let prevented = false;
  const element = { dataset: { action: 'open-local-file' }, getAttribute: (name) => (name === 'href' ? links[0].url : null) };
  listeners.click({ target: { closest: () => element }, preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(prevented);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/open-local');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['X-Requested-With'], 'enchanter');
  assert.deepEqual(JSON.parse(requests[0].options.body), { url: links[0].url });

  const alerts = [];
  context.alert = (message) => alerts.push(message);
  context.fetch = async () => ({ ok: false, json: async () => ({ error: 'この種類のファイルは開けません: a.exe' }) });
  listeners.click({ target: { closest: () => element }, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(alerts, ['この種類のファイルは開けません: a.exe']);
});

test('POST /api/open-local opens only registered files with allowed extensions that exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enchanter-test-'));
  const { pathToFileURL } = require('node:url');
  const { run } = loadServerModule(dir);
  const server = run('server');
  try {
    const video = path.join(dir, '動画 1.mp4');
    const program = path.join(dir, 'tool.exe');
    const folder = path.join(dir, 'folder.mp4');
    fs.writeFileSync(video, '');
    fs.writeFileSync(program, '');
    fs.mkdirSync(folder);
    const unregistered = path.join(dir, 'other.mp4');
    fs.writeFileSync(unregistered, '');
    const linkOf = (file) => ({ url: pathToFileURL(file).href });
    run(`writeData(${JSON.stringify({ tasks: [{ id: 't', links: [linkOf(video), linkOf(program), linkOf(folder), linkOf(path.join(dir, 'missing.mp4'))] }] })})`);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'enchanter-data.json'), 'utf8')).tasks[0].links.map((link) => link.url);
    assert.equal(stored.length, 4);
    run('globalThis.opened = []; openWithDefaultApp = (file) => opened.push(file);');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const headers = { 'X-Requested-With': 'enchanter', 'Content-Type': 'application/json' };
    const open = (url, extra = {}) => httpRequest(port, { method: 'POST', path: '/api/open-local', headers: { ...headers, ...extra }, body: JSON.stringify({ url }) });

    assert.equal((await httpRequest(port, { method: 'POST', path: '/api/open-local', body: JSON.stringify({ url: stored[0] }) })).status, 400);
    assert.equal((await httpRequest(port, { method: 'GET', path: '/api/open-local' })).status, 405);
    assert.equal((await open(pathToFileURL(unregistered).href)).status, 403);
    assert.equal((await open('https://example.com/')).status, 400);
    assert.equal((await open(stored[1])).status, 403);
    assert.equal((await open(stored[2])).status, 404);
    assert.equal((await open(stored[3])).status, 404);
    // 上限を超えた本文は413を返して接続を切る(応答より先に切断が届くこともある)
    const oversized = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/open-local', headers, agent: false }, (res) => {
        res.on('error', () => {});
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', (error) => resolve(error.code));
      req.end('x'.repeat(run('MAX_OPEN_LOCAL_BODY') + 1));
    });
    assert.ok(oversized === 413 || oversized === 'ECONNRESET' || oversized === 'EPIPE', String(oversized));
    assert.deepEqual(JSON.parse(JSON.stringify(run('opened'))), []);

    assert.equal((await open(stored[0])).status, 204);
    assert.deepEqual(JSON.parse(JSON.stringify(run('opened'))), [fs.realpathSync(video)]);
    // 表記の違うURL(エンコードなし・ドライブ名が小文字)でも、正規化して登録済みのリンクと照合する
    const otherSpelling = decodeURI(stored[0]).replace(/^file:\/\/\/([A-Z]):/, (_, drive) => `file:///${drive.toLowerCase()}:`);
    assert.notEqual(otherSpelling, stored[0]);
    assert.equal((await open(otherSpelling)).status, 204);
    assert.equal(run('opened.length'), 2);
    assert.equal(run("isOpenableLocalFile('C:\\\\a.exe:x.mp4')"), false);
    assert.equal(run("isOpenableLocalFile('C:\\\\a\\\\b.MP4')"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
