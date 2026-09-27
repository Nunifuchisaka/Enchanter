'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function client() {
  const listeners = {};
  const context = vm.createContext({
    console, URLSearchParams, structuredClone,
    setInterval() {},
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { addEventListener: (event, fn) => { listeners[event] = fn; } },
    confirm: () => true,
    alert: () => {},
    FormData: function(form) { return new Map(Object.entries(form.values)); },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
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
    assert.equal(run('sanitizeData({tasks:[{todayDate:"bad"}]}).tasks[0].todayDate'), null);
    assert.equal(run('sanitizeData({tasks:[{todayDate:"2026-09-27"}]}).tasks[0].todayDate'), '2026-09-27');
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('enchanter-test-'));
    fs.rmSync(dir, {recursive:true, force:true});
  }
});
