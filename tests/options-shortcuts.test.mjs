import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/options.js", import.meta.url), "utf8");

function harness({ shortcut = "Ctrl+Shift+H", readError = "", openError = "" } = {}) {
  const elements = new Map();
  const calls = [];
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { textContent: "", disabled: false, classList: { toggle() {} } });
        return elements.get(id);
      },
    },
    chrome: {
      runtime: { lastError: undefined },
      commands: { getAll(callback) {
        context.chrome.runtime.lastError = readError ? { message: readError } : undefined;
        callback([{ name: "capture-selection", shortcut: "Alt+Q" }, { name: "toggle-bubble", shortcut }]);
        context.chrome.runtime.lastError = undefined;
      } },
      tabs: { create(details, callback) {
        calls.push(details.url);
        context.chrome.runtime.lastError = openError ? { message: openError } : undefined;
        callback();
        context.chrome.runtime.lastError = undefined;
      } },
    },
  });
  vm.runInContext(source, context);
  return { context, elements, calls };
}

test("shortcut settings show the actual assigned toggle command, not the default", () => {
  const { context, elements } = harness({ shortcut: "Alt+Shift+B" });
  context.refreshBubbleShortcut();
  assert.equal(elements.get("bubbleShortcutValue").textContent, "Alt+Shift+B");
  assert.equal(elements.get("bubbleShortcutTableValue").textContent, "Alt+Shift+B");
  assert.equal(elements.get("refreshBubbleShortcut").disabled, false);
  assert.equal(vm.runInContext("dirty", context), false);
});

test("an unassigned shortcut is explicit and suggests assigning a usable key", () => {
  const { context, elements } = harness({ shortcut: "" });
  context.refreshBubbleShortcut();
  assert.equal(elements.get("bubbleShortcutValue").textContent, "未分配快捷键");
  assert.match(elements.get("bubbleShortcutStatus").textContent, /分配可用按键/);
});

test("Chrome shortcut read errors are visible and do not leave refresh disabled", () => {
  const { context, elements } = harness({ readError: "模拟读取失败" });
  context.refreshBubbleShortcut();
  assert.equal(elements.get("bubbleShortcutValue").textContent, "读取失败");
  assert.match(elements.get("bubbleShortcutStatus").textContent, /模拟读取失败/);
  assert.equal(elements.get("refreshBubbleShortcut").disabled, false);
});

test("shortcut settings open the Chrome assignment page and preserve unsaved settings", () => {
  const { context, elements, calls } = harness();
  context.openShortcutSettings();
  assert.deepEqual(calls, ["chrome://extensions/shortcuts"]);
  assert.equal(elements.get("setBubbleShortcut").disabled, false);
  assert.equal(vm.runInContext("dirty", context), false);
});

test("opening failures show a manual URL and re-enable the button", () => {
  const { context, elements } = harness({ openError: "模拟打开失败" });
  context.openShortcutSettings();
  assert.match(elements.get("bubbleShortcutStatus").textContent, /模拟打开失败/);
  assert.match(elements.get("bubbleShortcutStatus").textContent, /chrome:\/\/extensions\/shortcuts/);
  assert.equal(elements.get("setBubbleShortcut").disabled, false);
});
