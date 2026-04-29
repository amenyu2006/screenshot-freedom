/**
 * Popup 入口脚本
 * 功能：
 * 1) 读取当前激活标签页 tabId
 * 2) 向 background 发送 start_capture 消息并指定模式
 * 3) 更新按钮文案给用户即时反馈，然后关闭 popup
 *
 * 关键 Chrome API：
 * - chrome.tabs.query: 获取当前窗口激活 tab
 * - chrome.runtime.sendMessage: 触发后台执行具体截图流程
 */

/**
 * 统一的启动函数，避免多个按钮重复写同样逻辑。
 * @param {"auto"|"cdp"|"custom"} mode 截图模式
 * @param {string} buttonId 按钮 DOM id
 * @param {string} busyText 点击后的忙碌态文案
 */
const startCapture = async (mode, buttonId, busyText) => {
  // 读取当前活动页；插件只对当前可见页面生效
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // 设置忙碌文案，提示用户指令已被接收
  document.getElementById(buttonId).innerText = busyText;

  // 发送启动命令给后台；后台负责注入 content / 调用 CDP / 截图拼接
  chrome.runtime.sendMessage({ action: "start_capture", tabId: tab.id, mode }, () => {
    // popup 完成使命后关闭，避免遮挡页面
    window.close();
  });
};

// 自动滚屏拼接（历史能力，兼容普通页面）
document.getElementById('captureBtn').addEventListener('click', async () => {
  await startCapture("auto", "captureBtn", "滚屏截取中...");
});

// CDP 整页截图（优先推荐，复杂页面更稳）
document.getElementById('cdpCaptureBtn').addEventListener('click', async () => {
  await startCapture("cdp", "cdpCaptureBtn", "CDP整页截取中...");
});

// 自定义起止区间（先标记开始，再标记结尾并执行拼接）
document.getElementById('customCaptureBtn').addEventListener('click', async () => {
  await startCapture("custom", "customCaptureBtn", "自定义模式中...");
});