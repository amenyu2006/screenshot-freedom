/**
 * Background Service Worker
 * 职责：
 * 1) 接收 popup / content 消息，协调不同截图模式
 * 2) 普通模式：节流调用 captureVisibleTab，避免频率超限
 * 3) CDP 模式：通过 chrome.debugger 调用 DevTools Protocol
 *    - 遍历 frame/iframe，找到真实滚动容器
 *    - 分段滚动 + 截图 + 回传给 content 拼接
 *
 * 关键 Chrome API / CDP：
 * - chrome.tabs.captureVisibleTab: 抓当前可见视口
 * - chrome.debugger.attach/sendCommand/detach: 调用 CDP 能力
 * - Page.getFrameTree / createIsolatedWorld / Runtime.evaluate / Page.captureScreenshot
 */

// captureVisibleTab 的最小调用间隔（毫秒），用于规避 MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
const CAPTURE_MIN_INTERVAL_MS = 420;
let lastCaptureAt = 0;
let captureInFlight = false;
let captureTimer = null;
let pendingTabId = null;

// CDP 分段截图参数：步长比例 / 滚动后等待稳定时长 / 最大帧数保护
const CDP_STEP_RATIO = 0.82;
const CDP_SETTLE_MS = 220;
const CDP_MAX_FRAMES = 180;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// tabId -> { startTop, endTop, frameId }
const customSessions = new Map();

// 通知 content 开始进入 CDP 拼接会话
async function cdpStartStitch(tabId) {
  chrome.tabs.sendMessage(tabId, { action: "cdp_stitch_begin" }, () => {
    void chrome.runtime.lastError;
  });
}

// 回传 CDP 元信息（调试/可视化用）
async function cdpSendMeta(tabId, payload) {
  chrome.tabs.sendMessage(tabId, { action: "cdp_stitch_meta", ...payload }, () => {
    void chrome.runtime.lastError;
  });
}

// 回传单帧截图数据（由 content 负责拼接）
async function cdpSendFrame(tabId, payload) {
  chrome.tabs.sendMessage(tabId, { action: "cdp_stitch_frame", ...payload }, () => {
    void chrome.runtime.lastError;
  });
}

// 通知 content 已完成全部帧发送，可尝试收尾导出
async function cdpEndStitch(tabId, payload) {
  chrome.tabs.sendMessage(tabId, { action: "cdp_stitch_end", ...payload }, () => {
    void chrome.runtime.lastError;
  });
}

// 将 frameTree 扁平化为 frameId 数组，便于逐 frame 探测
function flattenFrameTree(node, out = []) {
  if (!node) return out;
  if (node.frame?.id) out.push(node.frame.id);
  if (node.childFrames?.length) {
    for (const c of node.childFrames) flattenFrameTree(c, out);
  }
  return out;
}

/**
 * CDP 会话执行器：
 * - 统一 attach / enable / detach 生命周期
 * - 业务函数 fn 在 attach 成功后执行
 */
async function withDebugger(target, fn) {
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Page.enable");
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    return await fn();
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      // ignore
    }
  }
}

/**
 * 在所有 frame/iframe 中寻找“最可能是真实正文滚动容器”的执行上下文。
 * 选择策略：可滚动距离 (scrollHeight - clientHeight) 最大者优先。
 */
async function buildBestScrollTarget(target) {
  const frameTree = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
  const frameIds = flattenFrameTree(frameTree?.frameTree || frameTree);
  if (!frameIds.length) throw new Error("No frames found");

  const worldByFrame = new Map();
  for (const frameId of frameIds) {
    try {
      const world = await chrome.debugger.sendCommand(target, "Page.createIsolatedWorld", {
        frameId,
        worldName: "__cdp_capture_world__",
        grantUniveralAccess: true
      });
      if (world?.executionContextId) worldByFrame.set(frameId, world.executionContextId);
    } catch {
      // ignore single frame
    }
  }
  if (!worldByFrame.size) throw new Error("Failed to create isolated worlds");

  const detectExpr = `(() => {
    const centerX = Math.round(window.innerWidth / 2);
    const centerY = Math.round(window.innerHeight / 2);
    const els = document.elementsFromPoint(centerX, centerY) || [];
    const isScrollable = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const oy = (cs.overflowY || "").toLowerCase();
      if (oy === "visible") return false;
      return el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 120;
    };
    let chosen = null;
    for (const e of els) {
      let cur = e;
      while (cur && cur !== document.body) {
        if (isScrollable(cur)) { chosen = cur; break; }
        cur = cur.parentElement;
      }
      if (chosen) break;
    }
    if (!chosen && isScrollable(document.scrollingElement)) chosen = document.scrollingElement;
    if (!chosen) chosen = document.scrollingElement || document.documentElement || document.body;
    window.__cdpCaptureScrollEl = chosen;
    const isPageScroll = (chosen === document.scrollingElement || chosen === document.documentElement || chosen === document.body);
    const st = isPageScroll ? (window.scrollY||0) : (chosen.scrollTop||0);
    const sh = isPageScroll ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) : chosen.scrollHeight;
    const ch = isPageScroll ? window.innerHeight : chosen.clientHeight;
    const tag = chosen && chosen.tagName ? chosen.tagName.toLowerCase() : "unknown";
    return { ok: true, scrollHeight: sh, clientHeight: ch, scrollTop: st, tag, isPageScroll };
  })()`;

  let best = null;
  for (const [frameId, contextId] of worldByFrame.entries()) {
    const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: detectExpr,
      contextId,
      returnByValue: true
    });
    const v = res?.result?.value;
    if (!v?.ok) continue;
    const score = (v.scrollHeight || 0) - (v.clientHeight || 0);
    if (!best || score > best.score) {
      best = { frameId, contextId, ...v, score };
    }
  }
  if (!best) throw new Error("Failed to detect scroll container in any frame");
  return best;
}

// 在选中的 frame 内滚动到指定绝对位置，返回实际 scrollTop
async function cdpScrollTo(target, contextId, top) {
  const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(() => {
      const el = window.__cdpCaptureScrollEl;
      if (!el) return { ok:false };
      const isPage = (el === document.scrollingElement || el === document.documentElement || el === document.body);
      if (isPage) {
        window.scrollTo(0, ${top});
        return { ok:true, scrollTop: window.scrollY||0 };
      }
      el.scrollTop = ${top};
      return { ok:true, scrollTop: el.scrollTop||0 };
    })()`,
    contextId,
    returnByValue: true
  });
  return res?.result?.value?.scrollTop ?? 0;
}

// 在选中的 frame 内滚动相对位移，返回滚动前后与实际 delta
async function cdpScrollBy(target, contextId, dy) {
  const movedEval = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(() => {
      const el = window.__cdpCaptureScrollEl;
      const dy = ${dy};
      if (!el) return { ok:false };
      let before = 0, after = 0;
      const isPage = (el === document.scrollingElement || el === document.documentElement || el === document.body);
      if (isPage) {
        before = window.scrollY||0;
        window.scrollBy(0, dy);
        after = window.scrollY||0;
      } else {
        before = el.scrollTop||0;
        el.scrollBy ? el.scrollBy(0, dy) : (el.scrollTop = before + dy);
        after = el.scrollTop||0;
      }
      const delta = Math.max(0, after - before);
      return { ok:true, before, after, delta };
    })()`,
    contextId,
    returnByValue: true
  });
  const mv = movedEval?.result?.value;
  return {
    before: mv?.before ?? 0,
    after: mv?.after ?? 0,
    delta: Math.max(0, mv?.delta ?? 0)
  };
}

/**
 * CDP 全页截图主流程：
 * 1) 识别滚动容器
 * 2) 从顶部开始抓首帧
 * 3) 循环滚动并抓后续帧
 * 4) 发送结束事件，由 content 汇总导出
 */
async function cdpCaptureFullPage(tabId) {
  const target = { tabId };
  try {
    await withDebugger(target, async () => {
      const best = await buildBestScrollTarget(target);
      await cdpStartStitch(tabId);
      await cdpSendMeta(tabId, {
        frameId: best.frameId,
        tag: best.tag,
        scrollHeight: best.scrollHeight,
        clientHeight: best.clientHeight,
        isPageScroll: best.isPageScroll
      });

      const viewportHeight = best.clientHeight || 0;
      const totalHeight = best.scrollHeight || 0;
      const step = Math.max(120, Math.round(viewportHeight * CDP_STEP_RATIO));
      let lastTop = best.scrollTop || 0;

      let frameCount = 0;
      await cdpScrollTo(target, best.contextId, 0);
      await delay(CDP_SETTLE_MS);

      const shot0 = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true
      });
      if (!shot0?.data) throw new Error("CDP captureScreenshot returned empty data");
      frameCount += 1;
      await cdpSendFrame(tabId, {
        index: frameCount,
        delta: 0,
        dataUrl: `data:image/png;base64,${shot0.data}`,
        isFirst: true
      });

      for (let i = 0; i < CDP_MAX_FRAMES - 1; i += 1) {
        const mv = await cdpScrollBy(target, best.contextId, step);
        const delta = mv.delta;
        lastTop = mv.after ?? lastTop;
        await delay(CDP_SETTLE_MS);

        const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
          format: "png",
          fromSurface: true
        });
        if (!shot?.data) throw new Error("CDP captureScreenshot returned empty data");

        frameCount += 1;
        await cdpSendFrame(tabId, {
          index: frameCount,
          delta,
          dataUrl: `data:image/png;base64,${shot.data}`,
          isFirst: false
        });

        if (delta < 2) break;
        if (lastTop + viewportHeight >= totalHeight - 2) break;
      }

      await cdpEndStitch(tabId, { frameCount });
    });
  } catch (e) {
    chrome.tabs.sendMessage(tabId, { action: "cdp_capture_error", message: String(e?.message || e) }, () => {
      void chrome.runtime.lastError;
    });
  }
}

/**
 * 自定义模式 - 标记开始/结尾位置
 * mark=start|end，实际值由 CDP 在目标滚动容器中读取 scrollTop。
 */
async function cdpCustomMark(tabId, mark) {
  const target = { tabId };
  return await withDebugger(target, async () => {
    const best = await buildBestScrollTarget(target);
    const top = best.scrollTop || 0;
    const existing = customSessions.get(tabId) || {};
    const session = {
      ...existing,
      frameId: best.frameId,
      startTop: existing.startTop ?? null,
      endTop: existing.endTop ?? null
    };
    if (mark === "start") session.startTop = top;
    if (mark === "end") session.endTop = top;
    customSessions.set(tabId, session);
    return { ok: true, frameId: best.frameId, scrollTop: top };
  });
}

/**
 * 自定义模式 - 执行区间截图
 * 从 startTop 滚到 endTop，期间按固定步长抓帧并拼接。
 */
async function cdpCustomRun(tabId) {
  const session = customSessions.get(tabId);
  if (!session?.startTop && session?.startTop !== 0) throw new Error("Custom start not set");
  if (!session?.endTop && session?.endTop !== 0) throw new Error("Custom end not set");
  const startTop = Math.min(session.startTop, session.endTop);
  const endTop = Math.max(session.startTop, session.endTop);

  const target = { tabId };
  await withDebugger(target, async () => {
    const best = await buildBestScrollTarget(target);
    await cdpStartStitch(tabId);
    await cdpSendMeta(tabId, {
      mode: "custom",
      frameId: best.frameId,
      tag: best.tag,
      startTop,
      endTop,
      scrollHeight: best.scrollHeight,
      clientHeight: best.clientHeight
    });

    const viewportHeight = best.clientHeight || 0;
    const step = Math.max(120, Math.round(viewportHeight * CDP_STEP_RATIO));

    let curTop = await cdpScrollTo(target, best.contextId, startTop);
    await delay(CDP_SETTLE_MS);

    let frameCount = 0;
    const shot0 = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true
    });
    if (!shot0?.data) throw new Error("CDP captureScreenshot returned empty data");
    frameCount += 1;
    await cdpSendFrame(tabId, {
      index: frameCount,
      delta: 0,
      dataUrl: `data:image/png;base64,${shot0.data}`,
      isFirst: true
    });

    while (frameCount < CDP_MAX_FRAMES) {
      if (curTop >= endTop) break;
      const nextTop = Math.min(endTop, curTop + step);
      const moved = await cdpScrollTo(target, best.contextId, nextTop);
      const delta = Math.max(0, moved - curTop);
      curTop = moved;
      await delay(CDP_SETTLE_MS);

      const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true
      });
      if (!shot?.data) throw new Error("CDP captureScreenshot returned empty data");
      frameCount += 1;
      await cdpSendFrame(tabId, {
        index: frameCount,
        delta,
        dataUrl: `data:image/png;base64,${shot.data}`,
        isFirst: false
      });

      if (delta < 2) break;
    }

    await cdpEndStitch(tabId, { frameCount });
  });
}

// 将 captureVisibleTab 异常回传给 content（用于重试退避）
function sendSnapshotError(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: "snapshot_error", message }, () => {
    void chrome.runtime.lastError;
  });
}

/**
 * 普通截图队列处理器：
 * - 全局串行
 * - 强制最小时间间隔
 * - 成功/失败后继续处理下一请求
 */
function processCaptureQueue() {
  if (captureInFlight || pendingTabId == null) return;
  const waitMs = Math.max(0, CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureAt));
  if (waitMs > 0) {
    if (captureTimer) return;
    captureTimer = setTimeout(() => {
      captureTimer = null;
      processCaptureQueue();
    }, waitMs);
    return;
  }

  const tabId = pendingTabId;
  pendingTabId = null;
  captureInFlight = true;

  chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
    const captureError = chrome.runtime.lastError;
    lastCaptureAt = Date.now();
    captureInFlight = false;

    if (captureError || !dataUrl) {
      sendSnapshotError(tabId, captureError?.message || "captureVisibleTab failed");
      processCaptureQueue();
      return;
    }

    chrome.tabs.sendMessage(tabId, { action: "snapshot_taken", dataUrl }, () => {
      void chrome.runtime.lastError;
      processCaptureQueue();
    });
  });
}

/**
 * 消息总线：
 * - start_capture: 根据模式分发 auto/cdp/custom
 * - cdp_custom_mark / cdp_custom_run: 自定义模式的 CDP 控制
 * - take_visible_snapshot: 进入普通节流队列
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "start_capture") {
    chrome.scripting.executeScript({
      target: { tabId: request.tabId },
      files: ["content.js"]
    }, () => {
      const mode = request.mode || "auto";
      if (mode === "cdp") {
        cdpCaptureFullPage(request.tabId);
      } else if (mode === "custom") {
        chrome.tabs.sendMessage(request.tabId, { action: "begin_capture", mode: "custom" }, () => {
          void chrome.runtime.lastError;
        });
      } else {
        chrome.tabs.sendMessage(request.tabId, {
          action: "begin_capture",
          mode
        }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
    sendResponse();
  } else if (request.action === "cdp_custom_mark") {
    const tabId = sender?.tab?.id;
    (async () => {
      try {
        const result = await cdpCustomMark(tabId, request.mark);
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, message: String(e?.message || e) });
      }
    })();
    return true;
  } else if (request.action === "cdp_custom_run") {
    const tabId = sender?.tab?.id;
    (async () => {
      try {
        await cdpCustomRun(tabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, message: String(e?.message || e) });
      }
    })();
    return true;
  } else if (request.action === "take_visible_snapshot") {
    const tabId = sender?.tab?.id;
    if (tabId != null) {
      pendingTabId = tabId;
      processCaptureQueue();
    }
    sendResponse();
  }
  return true;
});