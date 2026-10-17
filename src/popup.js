/** @license MIT — QuizKing · 答题王 toolbar popup. */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-k]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const k = btn.getAttribute("data-k");
      chrome.runtime.sendMessage({ type: "aqh/trigger", payload: { kind: k } }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          $("status").textContent = res?.error || "当前页面不可用";
          return;
        }
        if (k === "show-fab" && res && typeof res.shown === "boolean") {
          $("status").textContent = res.shown ? "已召唤 王字气泡" : "已收起 王字气泡";
        } else $("status").textContent = k === "visible" ? "已发送。侧栏模式请在截图结果侧栏查看；网页模式请回到网页框选。" : "已发送：" + k;
      });
    });
  });
  $("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());
  // Prepare the window id before the click, retaining its user-gesture context.
  let panelWindowId;
  chrome.windows.getCurrent().then((win) => { panelWindowId = win.id; }).catch(() => {});
  $("openSidepanel").addEventListener("click", () => {
    if (panelWindowId === undefined || !chrome.sidePanel?.open) {
      $("status").textContent = "暂时无法打开侧栏，请使用支持侧栏的 Chrome/Edge 116 或更新版本。";
      return;
    }
    chrome.sidePanel.open({ windowId: panelWindowId })
      .then(() => window.close())
      .catch((error) => { $("status").textContent = "打开侧栏失败：" + error.message; });
  });

  chrome.runtime.sendMessage({ type: "aqh/test" }, (res) => {
    if (!res || !res.ok) {
      $("status").textContent = "插件暂未就绪";
      return;
    }
    const n = res.providerCount || 0;
    $("keyState").textContent = res.hasKey
      ? ("API Key ✓" + (n > 1 ? (" · " + n + " 个服务商") : ""))
      : "未配置 API Key";
  });
});

function $(id) { return document.getElementById(id); }
