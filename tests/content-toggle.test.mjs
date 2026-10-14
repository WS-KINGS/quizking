import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [contentSource, backgroundSource, manifestText, bubbleCss] = await Promise.all([
  readFile(new URL('../src/content.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/background.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/manifest.json', import.meta.url), 'utf8'),
  readFile(new URL('../src/bubble.css', import.meta.url), 'utf8'),
]);
const flush = () => new Promise(setImmediate);
const decodeText = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_match, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);
const escapeText = (text) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// This small DOM supports the tree, classes, selectors and event listeners used
// by the actual content script. It does not replace any application functions.
class TextNode {
  constructor(text) { this.textContent = text; this.parentNode = null; }
  get outerHTML() { return escapeText(this.textContent); }
}

class Element {
  constructor(tagName) {
    this.tagName = tagName.toLowerCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(' '); },
      toggle: (name) => {
        const show = !this.classList.contains(name);
        if (show) this.classList.add(name); else this.classList.remove(name);
        return show;
      },
    };
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get children() { return this.childNodes.filter((node) => node instanceof Element); }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(value) { this.childNodes = []; if (String(value)) this.appendChild(new TextNode(String(value))); }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  get innerHTML() { return this.childNodes.map((node) => node.outerHTML).join(''); }
  set innerHTML(value) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    const stack = [this];
    for (const token of String(value).match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<([\w-]+)/)?.[1];
        if (!tag) continue;
        const element = new Element(tag);
        const attrs = token.slice(tag.length + 1, token.endsWith('/>') ? -2 : -1);
        for (const match of attrs.matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) element.setAttribute(match[1], decodeText(match[2] || ''));
        stack.at(-1).appendChild(element);
        if (!token.endsWith('/>') && !['br', 'hr', 'input', 'img', 'meta', 'link'].includes(tag)) stack.push(element);
      } else stack.at(-1).appendChild(new TextNode(decodeText(token)));
    }
  }
  get outerHTML() {
    const attrs = [...this.attributes].map(([name, value]) => ` ${name}="${escapeText(value)}"`).join('');
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(node) {
    if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter((child) => child !== node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
    this.parentNode = null;
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attribute) return this.attributes.has(attribute[1]) && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
    return this.tagName === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
  emit(type, extra = {}) {
    const event = { stopPropagation() {}, preventDefault() {}, ...extra };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; }
}

function createContentHarness({ deferAck = false, deferCapture = false, captureError = null, imageError = false, cfg = {} } = {}) {
  const documentElement = new Element('html');
  const body = documentElement.appendChild(new Element('body'));
  const draws = [];
  const canvases = [];
  const document = {
    documentElement, body, hidden: false, visibilityState: 'visible',
    hasFocus: () => true,
    createElement(tag) {
      const element = new Element(tag);
      if (tag === 'canvas') {
        element.getContext = () => ({ drawImage: (...args) => draws.push(args) });
        element.toDataURL = () => 'data:image/jpeg;base64,CROPPED';
        canvases.push(element);
      }
      return element;
    },
    getElementById: (id) => documentElement.querySelector(`#${id}`),
  };
  let onMessage;
  let onStorageChanged;
  let selection = '中国的首都是哪里？ A.北京 B.上海';
  const asks = [];
  const captures = [];
  const frames = [];
  const windowEvents = new Element('window');
  const window = {
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 2,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    getSelection: () => ({ toString: () => selection }),
  };
  class FakeImage {
    constructor() { this.width = this.naturalWidth = 2400; this.height = this.naturalHeight = 1600; }
    set src(value) {
      this._src = value;
      Promise.resolve().then(() => imageError ? this.onerror?.(new Error('bad image')) : this.onload?.());
    }
    get src() { return this._src; }
  }
  const captureResult = () => captureError
    ? { ok: false, error: captureError }
    : { ok: true, dataUrl: 'data:image/png;base64,FULL_SCREEN' };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { onMessage = fn; } },
      openOptionsPage() {},
      sendMessage(message, callback) {
        if (message.type === 'aqh/get-config') { callback({ ok: true, cfg: { hasKey: false, providers: [], promptMode: 'reason', ...cfg } }); return; }
        if (message.type === 'aqh/capture-visible-tab') {
          captures.push({
            message, callback,
            rootDisplay: document.getElementById('aqh-root')?.style.display,
            fabDisplay: document.getElementById('aqh-fab')?.style.display,
            hasMask: !!document.getElementById('aqh-mask'),
            hasSelection: !!document.getElementById('aqh-sel'),
          });
          if (!deferCapture) callback(captureResult());
          return;
        }
        if (message.type === 'aqh/ask') {
          const request = { message, callback };
          asks.push(request);
          if (!deferAck) callback({ ok: true, result: { reqId: message.payload.reqId, pending: [], promptMode: 'reason' } });
          return;
        }
        throw new Error(`Unexpected background request: ${message.type}`);
      },
    },
    storage: { onChanged: { addListener(fn) { onStorageChanged = fn; } } },
  };
  vm.runInContext(contentSource, vm.createContext({ window, document, chrome, Image: FakeImage, console: { log() {} }, setTimeout, clearTimeout }), { filename: 'src/content.js' });
  const send = (type, payload) => {
    let response;
    onMessage({ type, payload }, {}, (value) => { response = value; });
    return response;
  };
  return {
    document, asks, captures, draws, canvases, send,
    bubble: () => document.getElementById('aqh-bubble'),
    mask: () => document.getElementById('aqh-mask'),
    trigger: (kind) => send('aqh/capture', { kind }),
    storageChanged: (changes, area = 'sync') => onStorageChanged(changes, area),
    emitWindow: (type, extra) => windowEvents.emit(type, extra),
    listenerCount: (type) => (windowEvents.listeners.get(type) || []).length,
    paint() { const callbacks = frames.splice(0); callbacks.forEach((callback) => callback(0)); },
    captureReply(result = captureResult(), index = captures.length - 1) { captures[index].callback(result); },
    select(text) { selection = text; },
    ack(index = asks.length - 1) {
      const request = asks[index];
      request.callback({ ok: true, result: { reqId: request.message.payload.reqId, pending: [], promptMode: 'reason' } });
    },
    finish(answer = 'A. 北京', index = asks.length - 1) {
      const reqId = asks[index].message.payload.reqId;
      send('aqh/ask-finish', { reqId, promptMode: 'reason', items: [{ id: 'question-bank', ok: true, answer, reasoning: '来自已上传题库', source: '练习题库.txt' }], bankNotice: '已命中本地题库' });
    },
  };
}

test('the manifest shortcut is Ctrl+Shift+H and the background forwards it to the answer bubble route', async () => {
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.commands['toggle-bubble'].suggested_key.default, 'Ctrl+Shift+H');
  assert.equal(manifest.commands['toggle-bubble'].suggested_key.mac, 'Command+Shift+H');
  let command;
  const messages = [];
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { onInstalled: event(), onMessage: event() },
    contextMenus: { onClicked: event() },
    commands: { onCommand: { addListener(fn) { command = fn; } } },
    tabs: {
      query(_query, callback) { callback([{ id: 17 }]); },
      async sendMessage(tabId, message) { messages.push({ tabId, message }); },
    },
  };
  const source = backgroundSource.replace(/^import \{[^\n]+\} from "\.\/question-bank(?:-store)?\.js";$/gm, '');
  vm.runInContext(source, vm.createContext({ chrome, console, setTimeout, clearTimeout }));
  await command('toggle-bubble');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].tabId, 17);
  assert.equal(messages[0].message.type, 'aqh/capture');
  assert.equal(messages[0].message.payload.kind, 'toggle');
  assert.match(bubbleCss, /#aqh-bubble\.aqh-hide\s*\{[^}]*display:\s*none\s*;/);
});

test('toggle hides and shows the same answer bubble without deleting captured text', async () => {
  const h = createContentHarness();
  h.trigger('selection');
  await flush();
  const bubble = h.bubble();
  const captured = bubble.innerHTML;
  assert.match(bubble.textContent, /中国的首都/);
  h.trigger('toggle');
  assert.equal(h.bubble(), bubble);
  assert.ok(bubble.classList.contains('aqh-hide'));
  assert.equal(bubble.innerHTML, captured);
  h.trigger('toggle');
  assert.ok(!bubble.classList.contains('aqh-hide'));
  assert.equal(bubble.innerHTML, captured);
  assert.equal(h.document.getElementById('aqh-fab'), null);
});

test('toggling a completed answer preserves the answer, reasoning and file source', async () => {
  const h = createContentHarness();
  h.trigger('selection');
  await flush();
  h.finish();
  const bubble = h.bubble();
  const answer = bubble.innerHTML;
  assert.match(bubble.textContent, /A\. 北京/);
  assert.match(bubble.textContent, /练习题库.txt/);
  h.trigger('toggle');
  assert.ok(bubble.classList.contains('aqh-hide'));
  h.trigger('toggle');
  assert.ok(!bubble.classList.contains('aqh-hide'));
  assert.equal(bubble.innerHTML, answer);
  assert.equal(h.asks.length, 1, 'Showing an answer must not request the model again');
});

test('when no bubble exists, toggle displays an actionable empty-state message', () => {
  const h = createContentHarness();
  h.trigger('toggle');
  assert.ok(h.bubble());
  assert.ok(!h.bubble().classList.contains('aqh-hide'));
  assert.match(h.bubble().textContent, /暂无/);
  assert.match(h.bubble().textContent, /选中|捕获|截取/);
  assert.equal(h.asks.length, 0);
  assert.equal(h.document.getElementById('aqh-fab'), null);
  h.trigger('toggle');
  assert.ok(h.bubble().classList.contains('aqh-hide'));
});

test('a late answer cannot reveal a bubble hidden while waiting for the result', async () => {
  const h = createContentHarness();
  h.trigger('selection');
  await flush();
  h.trigger('toggle');
  h.finish();
  assert.ok(h.bubble().classList.contains('aqh-hide'));
  assert.match(h.bubble().textContent, /A\. 北京/);
  h.trigger('toggle');
  assert.ok(!h.bubble().classList.contains('aqh-hide'));
  assert.match(h.bubble().textContent, /A\. 北京/);
});

test('even a result delivered before the request acknowledgement keeps the bubble hidden', async () => {
  const h = createContentHarness({ deferAck: true });
  h.trigger('selection');
  h.trigger('toggle');
  h.finish();
  assert.ok(h.bubble().classList.contains('aqh-hide'));
  h.ack();
  await flush();
  assert.ok(h.bubble().classList.contains('aqh-hide'));
  assert.match(h.bubble().textContent, /A\. 北京/);
});

test('rendering a newly captured question preserves the existing hidden state', async () => {
  const h = createContentHarness();
  h.trigger('selection');
  await flush();
  h.finish();
  h.trigger('toggle');
  h.select('第二道题：2+2是多少？');
  h.trigger('selection');
  await flush();
  assert.ok(h.bubble().classList.contains('aqh-hide'));
  assert.match(h.bubble().textContent, /第二道题/);
  h.finish('4');
  assert.ok(h.bubble().classList.contains('aqh-hide'));
  h.trigger('toggle');
  assert.ok(!h.bubble().classList.contains('aqh-hide'));
  assert.match(h.bubble().textContent, /4/);
});

test('the keyboard toggle restores an answer hidden with the header button', async () => {
  const h = createContentHarness();
  h.trigger('selection');
  await flush();
  h.finish();
  h.bubble().querySelector('[data-act="min"]').emit('click');
  assert.ok(h.bubble().classList.contains('aqh-hide'));
  h.trigger('toggle');
  assert.ok(!h.bubble().classList.contains('aqh-hide'));
  assert.match(h.bubble().textContent, /A\. 北京/);
});

test('aqh/show-fab controls only the floating button and leaves answer visibility unchanged', async () => {
  const h = createContentHarness();
  h.trigger('selection');
  await flush();
  h.finish();
  h.trigger('toggle');
  const bubble = h.bubble();
  const before = bubble.outerHTML;
  assert.equal(h.send('aqh/show-fab').shown, true);
  assert.ok(h.document.getElementById('aqh-fab'));
  assert.equal(h.bubble().outerHTML, before);
  assert.equal(h.send('aqh/show-fab').shown, false);
  assert.equal(h.document.getElementById('aqh-fab'), null);
  assert.equal(h.bubble(), bubble);
  assert.equal(bubble.outerHTML, before);
});

test('closing a hidden bubble still invalidates an in-flight result', async () => {
  const h = createContentHarness();
  h.trigger('selection');
  await flush();
  h.trigger('toggle');
  h.send('aqh/close');
  h.finish();
  assert.equal(h.bubble(), null);
  h.trigger('toggle');
  assert.match(h.bubble().textContent, /暂无/);
  assert.doesNotMatch(h.bubble().textContent, /A\. 北京/);
});

function dragCrop(h, from = [340, 280], to = [140, 100]) {
  h.mask().emit('mousedown', { button: 0, clientX: from[0], clientY: from[1] });
  h.emitWindow('mousemove', { clientX: to[0], clientY: to[1] });
  h.emitWindow('mouseup', { button: 0, clientX: to[0], clientY: to[1] });
}

async function paintCropRemoval(h) {
  await flush();
  h.paint();
  h.paint();
  await flush();
}

function assertCropRemoved(h, { pendingCapture = false } = {}) {
  assert.equal(h.mask(), null);
  assert.equal(h.document.getElementById('aqh-sel'), null);
  for (const type of (pendingCapture ? ['keydown'] : ['keydown', 'blur', 'resize', 'scroll'])) {
    assert.equal(h.listenerCount(type), 0, `${type} crop listener must be removed`);
  }
}

for (const cancel of ['Escape', 'small crop']) {
  test(`a screenshot cancelled by ${cancel} sends no screenshot or model request`, async () => {
    const h = createContentHarness();
    h.trigger('visible');
    assert.ok(h.mask());
    assert.equal(h.captures.length, 0, 'Do not capture before the user confirms an area');
    if (cancel === 'Escape') h.emitWindow('keydown', { key: 'Escape' });
    else dragCrop(h, [100, 100], [102, 102]);
    await paintCropRemoval(h);
    assertCropRemoved(h);
    assert.equal(h.captures.length, 0);
    assert.equal(h.asks.length, 0);
    assert.equal(h.bubble(), null, 'Cancelling must not create a result bubble');
    h.trigger('visible');
    assert.ok(h.mask(), 'Cancelling must release the capture lock');
    h.emitWindow('keydown', { key: 'Escape' });
    await flush();
  });
}

test('reverse dragging captures only the selected area after removing crop UI and hiding existing controls', async () => {
  const h = createContentHarness({ deferCapture: true });
  h.trigger('toggle');
  h.trigger('toggle');
  h.send('aqh/show-fab');
  const root = h.document.getElementById('aqh-root');
  const fab = h.document.getElementById('aqh-fab');
  root.style.display = 'block';
  fab.style.display = 'flex';
  h.trigger('visible');
  dragCrop(h);
  assertCropRemoved(h, { pendingCapture: true });
  await flush();
  assert.equal(root.style.display, 'none');
  assert.equal(fab.style.display, 'none');
  assert.equal(h.captures.length, 0, 'Wait for the controls to disappear before capturing');
  h.paint();
  h.paint();
  await flush();
  assert.equal(h.captures.length, 1);
  assert.deepEqual({ ...h.captures[0], message: undefined, callback: undefined }, {
    message: undefined, callback: undefined, rootDisplay: 'none', fabDisplay: 'none', hasMask: false, hasSelection: false,
  });
  assert.equal(root.style.display, 'none', 'Controls remain hidden until the capture callback finishes');
  assert.equal(h.asks.length, 0);
  h.captureReply();
  await flush();
  assertCropRemoved(h);
  assert.equal(root.style.display, 'block');
  assert.equal(fab.style.display, 'flex');
  assert.ok(h.bubble().classList.contains('aqh-hide'), 'Screenshot results must preserve the previous hidden state');
  assert.equal(h.asks.length, 1);
  assert.equal(h.asks[0].message.payload.imageDataUrl, 'data:image/jpeg;base64,CROPPED');
  assert.equal(h.draws.length, 1);
  assert.deepEqual(h.draws[0].slice(1), [280, 200, 400, 360, 0, 0, 400, 360]);
  assert.equal(h.canvases[0].width, 400);
  assert.equal(h.canvases[0].height, 360);
});

test('repeated screenshot triggers during selecting and capturing produce one request', async () => {
  const h = createContentHarness({ deferCapture: true });
  h.trigger('visible');
  const firstMask = h.mask();
  h.trigger('visible');
  assert.equal(h.mask(), firstMask);
  assert.equal(h.document.documentElement.querySelectorAll('#aqh-mask').length, 1);
  dragCrop(h);
  await paintCropRemoval(h);
  h.trigger('visible');
  assert.equal(h.mask(), null, 'An in-flight capture must not create another selector');
  assert.equal(h.captures.length, 1);
  h.captureReply();
  await flush();
  assert.equal(h.asks.length, 1, 'Sharing a capture promise must not cause duplicate model calls');
});

for (const eventName of ['blur', 'resize', 'scroll']) {
  test(`${eventName} while selecting cancels and cleans up without sending an image`, async () => {
    const h = createContentHarness();
    h.trigger('visible');
    h.mask().emit('mousedown', { button: 0, clientX: 50, clientY: 70 });
    h.emitWindow(eventName);
    await paintCropRemoval(h);
    assertCropRemoved(h);
    assert.equal(h.listenerCount('mouseup'), 0);
    assert.equal(h.listenerCount('mousemove'), 0);
    assert.equal(h.captures.length, 0);
    assert.equal(h.asks.length, 0);
  });
}

test('a failed screenshot restores controls and allows the next capture', async () => {
  const h = createContentHarness({ deferCapture: true });
  h.trigger('toggle');
  h.send('aqh/show-fab');
  const root = h.document.getElementById('aqh-root');
  const fab = h.document.getElementById('aqh-fab');
  root.style.display = 'block';
  fab.style.display = 'flex';
  h.trigger('visible');
  dragCrop(h);
  await paintCropRemoval(h);
  h.captureReply({ ok: false, error: 'capture unavailable' });
  await flush();
  assertCropRemoved(h);
  assert.equal(root.style.display, 'block');
  assert.equal(fab.style.display, 'flex');
  assert.equal(h.asks.length, 0);
  assert.match(h.bubble().textContent, /capture unavailable/);
  h.trigger('visible');
  assert.ok(h.mask(), 'The failed attempt must release the lock');
  dragCrop(h);
  await paintCropRemoval(h);
  h.captureReply();
  await flush();
  assert.equal(h.captures.length, 2);
  assert.equal(h.asks.length, 1);
});

test('a crop image decoding failure must never submit the full-screen image', async () => {
  const h = createContentHarness({ imageError: true });
  h.trigger('visible');
  dragCrop(h);
  await paintCropRemoval(h);
  assertCropRemoved(h);
  assert.equal(h.captures.length, 1);
  assert.equal(h.asks.length, 0);
  assert.equal(h.draws.length, 0);
  assert.match(h.bubble().textContent, /失败/);
  h.trigger('visible');
  assert.ok(h.mask());
  h.emitWindow('keydown', { key: 'Escape' });
  await flush();
});

test('switching away before the capture frame does not capture or submit another tab', async () => {
  const h = createContentHarness();
  h.trigger('visible');
  dragCrop(h);
  await flush();
  h.document.hidden = true;
  h.document.visibilityState = 'hidden';
  await paintCropRemoval(h);
  assertCropRemoved(h);
  assert.equal(h.captures.length, 0);
  assert.equal(h.asks.length, 0);
});

test('losing focus during the screenshot callback restores controls without submitting the image', async () => {
  const h = createContentHarness({ deferCapture: true });
  h.trigger('toggle');
  const root = h.document.getElementById('aqh-root');
  root.style.display = 'block';
  h.trigger('visible');
  dragCrop(h);
  await paintCropRemoval(h);
  assert.equal(h.captures.length, 1);
  assert.equal(root.style.display, 'none');
  h.emitWindow('blur');
  h.captureReply();
  await flush();
  assertCropRemoved(h);
  assert.equal(root.style.display, 'block');
  assert.equal(h.asks.length, 0);
  assert.equal(h.draws.length, 0);
});

test('the capture border uses the faint default or saved opacity within the supported range', async () => {
  for (const [saved, expected] of [[undefined, 0.08], [0.35, 0.35], [0, 0.02], [2, 1], ['invalid', 0.08]]) {
    const h = createContentHarness({ cfg: { captureBorderOpacity: saved } });
    await flush();
    h.trigger('visible');
    const border = h.document.getElementById('aqh-sel');
    assert.equal(border.style.borderColor, `rgba(65,75,90,${expected})`, `Saved opacity: ${saved}`);
    assert.doesNotMatch(border.style.cssText, /box-shadow\s*:/, 'A bright shadow must not override the subtle border');
    h.emitWindow('keydown', { key: 'Escape' });
    await flush();
    assert.equal(h.captures.length, 0);
    assert.equal(h.asks.length, 0);
  }
});

test('sync opacity changes update the current and next capture border without refreshing the page', async () => {
  const h = createContentHarness({ cfg: { captureBorderOpacity: 0.2 } });
  await flush();
  h.trigger('visible');
  const border = h.document.getElementById('aqh-sel');
  h.storageChanged({ captureBorderOpacity: { oldValue: 0.2, newValue: 0.65 } }, 'local');
  assert.equal(border.style.borderColor, 'rgba(65,75,90,0.2)', 'Unrelated local data must not change the appearance');
  h.storageChanged({ captureBorderOpacity: { oldValue: 0.2, newValue: 0.04 } });
  assert.equal(border.style.borderColor, 'rgba(65,75,90,0.04)');
  h.emitWindow('keydown', { key: 'Escape' });
  await flush();
  h.trigger('visible');
  assert.equal(h.document.getElementById('aqh-sel').style.borderColor, 'rgba(65,75,90,0.04)');
  h.storageChanged({ captureBorderOpacity: { oldValue: 0.04 } });
  assert.equal(h.document.getElementById('aqh-sel').style.borderColor, 'rgba(65,75,90,0.08)', 'Removing the saved preference restores the default');
  h.emitWindow('keydown', { key: 'Escape' });
  await flush();
});
