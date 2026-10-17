import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/answer-overlay.js', import.meta.url), 'utf8');

class Style {
  values = new Map();
  setProperty(name, value, priority = '') { this.values.set(name, { value: String(value), priority }); }
  getPropertyValue(name) { return this.values.get(name)?.value || ''; }
  getPropertyPriority(name) { return this.values.get(name)?.priority || ''; }
  removeProperty(name) { const value = this.getPropertyValue(name); this.values.delete(name); return value; }
}

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.style = new Style();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.textAssignments = 0;
    this.value = '';
  }
  get isConnected() { return this.tagName === 'HTML' || !!this.parentNode?.isConnected || !!this.host?.isConnected; }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', value); }
  set textContent(value) { this.value = String(value); this.children = []; this.textAssignments += 1; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Overlay must not parse HTML'); }
  appendChild(child) {
    child.remove();
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  attachShadow(options) {
    assert.equal(options.mode, 'open');
    this.shadowRoot = new Element('shadow-root');
    this.shadowRoot.host = this;
    return this.shadowRoot;
  }
  addEventListener() { throw new Error('Overlay must not listen to page/input events'); }
  focus() { throw new Error('Overlay must not move focus'); }
  blur() { throw new Error('Overlay must not move focus'); }
}

function harness({ width = 1024, height = 768 } = {}) {
  const documentElement = new Element('html');
  const body = documentElement.appendChild(new Element('body'));
  const input = body.appendChild(new Element('input'));
  const find = (node, id) => node.id === id ? node : node.children.map((child) => find(child, id)).find(Boolean);
  const document = {
    documentElement, body, activeElement: input,
    createElement: (tag) => new Element(tag),
    getElementById: (id) => find(documentElement, id) || null,
    addEventListener() { throw new Error('Overlay must not listen to document events'); },
  };
  const frames = [];
  const timers = new Map();
  let timerId = 0;
  const messages = [];
  const changes = [];
  const resizeListeners = [];
  const window = {
    innerWidth: width, innerHeight: height,
    requestAnimationFrame(callback) { frames.push(callback); },
    addEventListener(type, listener, options) {
      assert.equal(type, 'resize', 'Overlay may only observe resize for layout');
      assert.equal(options.passive, true);
      resizeListeners.push(listener);
    },
    focus() { throw new Error('Overlay must not focus window'); },
    blur() { throw new Error('Overlay must not blur window'); },
  };
  const chrome = {
    runtime: { onMessage: { addListener: (listener) => messages.push(listener) } },
    storage: { onChanged: { addListener: (listener) => changes.push(listener) } },
  };
  const context = vm.createContext({
    window, document, chrome,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const inject = () => vm.runInContext(source, context, { filename: 'src/answer-overlay.js' });
  inject();
  const send = (type, payload) => {
    let response;
    let resolve;
    const reply = new Promise((done) => { resolve = done; });
    const keepAlive = messages[0]({ type, payload }, {}, (value) => { response = value; resolve(value); });
    return { reply, keepAlive, get response() { return response; } };
  };
  const frame = () => { const callbacks = frames.splice(0); callbacks.forEach((callback) => callback()); };
  const expire = (delay) => {
    const entries = [...timers].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of entries) { timers.delete(id); timer.callback(); }
  };
  const prepare = async (id = 'r1', opacity = 0.4) => {
    const request = send('aqh/overlay-prepare', { reqId: id, opacity });
    frame(); frame();
    assert.equal((await request.reply).ok, true);
    return request;
  };
  const restore = (id = 'r1') => send('aqh/overlay-restore', { reqId: id }).response;
  const result = (items = [{ id: 'one', ok: true, answer: 'A' }], extra = {}) => send('aqh/overlay-result', {
    reqId: 'r1', state: 'finished', items, ...extra,
  }).response;
  const root = () => document.getElementById('aqh-answer-overlay');
  const text = () => root()?.shadowRoot.children.map((node) => node.textContent).filter(Boolean).join('\n') || '';
  const content = () => root()?.shadowRoot.children[1];
  const visible = () => root()?.style.getPropertyValue('display') === 'flex';
  const resize = (width, height) => {
    window.innerWidth = width;
    window.innerHeight = height;
    resizeListeners.forEach((listener) => listener());
  };
  const addLegacy = (id, display = '', priority = '') => {
    const node = documentElement.appendChild(new Element('div'));
    node.id = id;
    if (display) node.style.setProperty('display', display, priority);
    return node;
  };
  return { document, input, messages, changes, inject, send, frame, expire, prepare, restore, result, root, text, content, visible, resize, addLegacy, timers };
}

test('injection registers once and ping creates no page element', () => {
  const h = harness();
  h.inject();
  assert.equal(h.messages.length, 1);
  assert.equal(h.changes.length, 1);
  assert.equal(h.send('aqh/overlay-ping').response.ok, true);
  const toggle = h.send('aqh/overlay-toggle').response;
  assert.equal(toggle.handled, false);
  assert.equal(toggle.hidden, false);
  assert.equal(h.root(), null);
});

test('prepare hides existing UI immediately and replies only after two frames', async () => {
  const h = harness();
  const bubble = h.addLegacy('aqh-root', 'flex', 'important');
  const fab = h.addLegacy('aqh-fab');
  const request = h.send('aqh/overlay-prepare', { reqId: 'r1' });
  assert.equal(request.keepAlive, true);
  assert.equal(bubble.style.getPropertyValue('display'), 'none');
  assert.equal(fab.style.getPropertyValue('display'), 'none');
  assert.equal(request.response, undefined);
  h.frame();
  assert.equal(request.response, undefined);
  h.frame();
  assert.equal((await request.reply).ok, true);
  assert.equal(h.restore().ok, true);
  assert.equal(bubble.style.getPropertyValue('display'), 'flex');
  assert.equal(bubble.style.getPropertyPriority('display'), 'important');
  assert.equal(fab.style.getPropertyValue('display'), '');
  assert.equal(h.visible(), false);
});

test('display is text-only, pointer-passive and does not change activeElement', async () => {
  const h = harness();
  await h.prepare(); h.restore();
  h.result([{ id: 'one', ok: true, answer: '<img src=x onerror="alert(1)"> & A' }]);
  assert.equal(h.text(), '<img src=x onerror="alert(1)"> & A');
  assert.equal(h.visible(), true);
  assert.equal(h.root().shadowRoot.children.length, 3);
  const content = h.content();
  assert.equal(content.children.length, 0);
  assert.equal(h.root().style.getPropertyValue('pointer-events'), 'none');
  assert.equal(content.style.getPropertyValue('pointer-events'), 'none');
  assert.equal(content.style.getPropertyValue('font-size'), '12px');
  assert.equal(h.root().attributes.has('tabindex'), false);
  assert.equal(content.attributes.has('tabindex'), false);
  assert.equal(h.document.activeElement, h.input);
});

test('prepare removes the previous answer and hides new results until restore', async () => {
  const h = harness();
  await h.prepare(); h.restore(); h.result();
  assert.equal(h.text(), 'A');
  await h.prepare('r2');
  assert.equal(h.text(), '');
  assert.equal(h.visible(), false);
  h.result([{ ok: true, answer: 'B' }], { reqId: 'r2' });
  assert.equal(h.visible(), false);
  h.restore('r2');
  assert.equal(h.text(), 'B');
  assert.equal(h.visible(), true);
});

test('late results and restore from an older request cannot replace or reveal a newer capture', async () => {
  const h = harness();
  const bubble = h.addLegacy('aqh-root', 'grid');
  await h.prepare('r1');
  await h.prepare('r2');
  assert.equal(h.result().ok, false);
  assert.equal(h.restore('r1').ok, false);
  assert.equal(bubble.style.getPropertyValue('display'), 'none');
  h.result([{ ok: true, answer: 'new' }], { reqId: 'r2' });
  h.restore('r2');
  assert.equal(h.text(), 'new');
  assert.equal(bubble.style.getPropertyValue('display'), 'grid');
});

test('overlapping prepares reject the old acknowledgement and preserve original UI display', async () => {
  const h = harness();
  const bubble = h.addLegacy('aqh-root', 'inline');
  const first = h.send('aqh/overlay-prepare', { reqId: 'old' });
  const second = h.send('aqh/overlay-prepare', { reqId: 'new' });
  h.frame(); h.frame();
  assert.equal((await first.reply).ok, false);
  assert.equal((await second.reply).ok, true);
  h.restore('new');
  assert.equal(bubble.style.getPropertyValue('display'), 'inline');
});

test('manual hide survives incremental results and a later question, toggle restores preserved answer', async () => {
  const h = harness();
  await h.prepare(); h.restore(); h.result();
  const toggle = h.send('aqh/overlay-toggle').response;
  assert.equal(toggle.handled, true);
  assert.equal(toggle.hidden, true);
  h.result([{ ok: true, answer: 'B' }]);
  assert.equal(h.visible(), false);
  await h.prepare('r2'); h.restore('r2');
  h.result([{ ok: true, answer: 'C' }], { reqId: 'r2' });
  assert.equal(h.visible(), false);
  assert.equal(h.send('aqh/overlay-toggle').response.hidden, false);
  assert.equal(h.text(), 'C');
  assert.equal(h.visible(), true);
});

test('multi-model answers identify their models and retain disagreement warning', async () => {
  const h = harness();
  await h.prepare(); h.restore();
  h.result([
    { id: 'a', label: '模型甲', ok: true, answer: 'A' },
    { id: 'b', label: '模型乙', ok: true, answer: 'B' },
  ]);
  assert.equal(h.text(), '答案不一致，请核对。\n模型甲：A\n模型乙：B');
});

test('errors, empty answers and bank warnings remain visible with successful answers', async () => {
  const h = harness();
  await h.prepare(); h.restore();
  h.result([
    { id: 'a', label: '甲', ok: true, answer: 'A' },
    { id: 'b', label: '乙', ok: false, error: '认证失败' },
    { id: 'c', label: '丙', ok: true, answer: '', reasoning: '只返回分析' },
  ], { bankNotice: '题库存在冲突', error: '部分请求失败' });
  assert.match(h.text(), /甲：A/);
  assert.match(h.text(), /乙：错误：认证失败/);
  assert.match(h.text(), /丙：未返回单独答案/);
  assert.match(h.text(), /题库存在冲突/);
  assert.match(h.text(), /错误：部分请求失败/);
});

test('working snapshots show progress while preserving returned answers without needless DOM rewrites', async () => {
  const h = harness();
  await h.prepare(); h.restore();
  h.result([], { state: 'working', pending: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] });
  assert.equal(h.text(), '处理中…');
  const items = [{ id: 'a', label: '甲', ok: true, answer: 'A' }];
  const extra = { state: 'working', pending: [{ id: 'a' }, { id: 'b' }] };
  h.result(items, extra);
  assert.equal(h.text(), '甲：A\n等待其余 1 个结果…');
  const count = h.content().textAssignments;
  h.result(items, extra);
  assert.equal(h.content().textAssignments, count);
});

test('JSON answers are unwrapped as plain text', async () => {
  const h = harness();
  await h.prepare(); h.restore();
  h.result([{ ok: true, answer: '```json\n{"answer":"A", "reasoning":"reason"}\n```' }]);
  assert.equal(h.text(), 'A');
});

test('opacity is bounded and reacts only to the relevant sync setting', async () => {
  const h = harness();
  await h.prepare('r1', 0.02); h.restore(); h.result();
  assert.equal(h.root().style.getPropertyValue('opacity'), '0.15');
  h.changes[0]({ overlayOpacity: { newValue: 0.7 } }, 'local');
  assert.equal(h.root().style.getPropertyValue('opacity'), '0.15');
  h.changes[0]({ overlayOpacity: { newValue: 0.7 } }, 'sync');
  assert.equal(h.root().style.getPropertyValue('opacity'), '0.7');
  h.changes[0]({ overlayOpacity: { newValue: 7 } }, 'sync');
  assert.equal(h.root().style.getPropertyValue('opacity'), '1');
  h.changes[0]({ overlayOpacity: { newValue: 'invalid' } }, 'sync');
  assert.equal(h.root().style.getPropertyValue('opacity'), '0.4');
});

test('clear restores UI, removes answer and rejects in-flight updates', async () => {
  const h = harness();
  const bubble = h.addLegacy('aqh-root', 'none');
  await h.prepare();
  h.result();
  assert.equal(h.send('aqh/overlay-clear').response.ok, true);
  assert.equal(h.text(), '');
  assert.equal(h.visible(), false);
  assert.equal(bubble.style.getPropertyValue('display'), 'none');
  assert.equal(h.result().ok, false);
  assert.equal(h.restore().ok, false);
  assert.equal(h.send('aqh/overlay-toggle').response.handled, false);
});

test('clearing during prepare rejects its pending acknowledgement', async () => {
  const h = harness();
  const request = h.send('aqh/overlay-prepare', { reqId: 'r1' });
  h.send('aqh/overlay-clear');
  h.frame(); h.frame();
  assert.equal((await request.reply).ok, false);
  assert.equal(h.visible(), false);
});

test('stalled animation frames fail preparation and restore extension UI', async () => {
  const h = harness();
  const bubble = h.addLegacy('aqh-root', 'flex');
  const request = h.send('aqh/overlay-prepare', { reqId: 'r1' });
  h.expire(1500);
  assert.equal((await request.reply).ok, false);
  assert.equal(bubble.style.getPropertyValue('display'), 'flex');
  assert.match(h.text(), /未及时完成绘制/);
  h.frame(); h.frame();
  assert.equal(request.response.ok, false);
  assert.equal(h.timers.size, 0);
});

test('missing restore cannot keep UI hidden forever and late results are rejected', async () => {
  const h = harness();
  const bubble = h.addLegacy('aqh-root', 'flex');
  await h.prepare();
  h.expire(10000);
  assert.equal(bubble.style.getPropertyValue('display'), 'flex');
  assert.match(h.text(), /截图等待超时/);
  assert.equal(h.result().ok, false);
  assert.equal(h.send('aqh/overlay-toggle').response.handled, true);
  assert.equal(h.visible(), false);
});

test('restore cancels recovery timeout and does not erase a completed answer', async () => {
  const h = harness();
  await h.prepare(); h.restore(); h.result();
  h.expire(10000);
  assert.equal(h.text(), 'A');
  assert.equal(h.timers.size, 0);
});

test('unknown messages and results without a prepared request have no visible effect', () => {
  const h = harness();
  assert.equal(h.result().ok, false);
  assert.equal(h.send('aqh/overlay-prepare', {}).response.ok, false);
  assert.equal(h.send('unrelated').response, undefined);
  assert.equal(h.root(), null);
});

test('case-sensitive mathematical answers retain the disagreement warning', async () => {
  const h = harness();
  await h.prepare(); h.restore();
  h.result([{ id: 'a', ok: true, answer: 'X' }, { id: 'b', ok: true, answer: 'x' }]);
  assert.match(h.text(), /答案不一致/);
});

test('long results are bounded with a separate visible truncation notice and warning header', async () => {
  const h = harness();
  await h.prepare(); h.restore();
  const items = [
    { id: 'a', ok: true, answer: 'A'.repeat(1000) },
    { id: 'b', ok: true, answer: 'B'.repeat(1000) },
    ...Array.from({ length: 20 }, (_, i) => ({ id: 'e' + i, ok: false, error: '请求错误'.repeat(100) })),
  ];
  h.result(items);
  assert.ok(h.text().length <= 480);
  const [warning, content, more] = h.root().shadowRoot.children;
  assert.match(warning.textContent, /答案不一致/);
  assert.match(warning.textContent, /存在错误/);
  assert.equal(more.textContent, '内容较长，完整结果请在侧栏查看');
  assert.equal(more.style.getPropertyValue('display'), 'block');
  assert.equal(more.style.getPropertyValue('flex-shrink'), '0');
  assert.ok(Number(content.style.getPropertyValue('-webkit-line-clamp')) <= 8);
  assert.ok(content.textContent.split('\n').every((line) => Array.from(line).length <= 160));
  assert.equal(items[0].answer.length, 1000, 'original results must remain untouched');
});

test('multiline answers signal visual clipping even when their character count is small', async () => {
  const h = harness();
  await h.prepare(); h.restore();
  h.result([{ ok: true, answer: Array.from({ length: 30 }, () => 'A').join('\n') }]);
  assert.match(h.text(), /内容较长，完整结果请在侧栏查看/);
});

test('small viewport preserves warning and truncation hint; resizing restores available answer space', async () => {
  const h = harness({ width: 160, height: 60 });
  await h.prepare(); h.restore();
  h.result([{ id: 'a', ok: true, answer: 'A'.repeat(1000) }, { id: 'b', ok: true, answer: 'B'.repeat(1000) }, { id: 'e', ok: false, error: '失败' }]);
  const [warning, content, more] = h.root().shadowRoot.children;
  assert.match(warning.textContent, /有分歧/);
  assert.match(warning.textContent, /有错误/);
  assert.equal(content.textContent, '');
  assert.equal(more.textContent, '完整结果见侧栏');
  assert.equal(more.style.getPropertyValue('display'), 'block');
  assert.ok(parseFloat(h.root().style.getPropertyValue('max-height')) <= 56);
  assert.ok(parseFloat(h.root().style.getPropertyValue('max-width')) <= 156);
  h.resize(1024, 768);
  assert.ok(content.textContent.length > 0);
  assert.equal(content.style.getPropertyValue('font-size'), '12px');
  assert.equal(h.document.activeElement, h.input);
});
