(() => {
  /**
   * Content Script 主文件
   * 作用：
   * 1) 接收 background 消息，驱动页面内截图拼接会话
   * 2) 管理 UI 控件（提示条、控制面板、自检窗）及交互
   * 3) 处理 CDP 分帧拼接、普通滚屏拼接、自定义区间拼接
   *
   * 关键 API 说明：
   * - chrome.runtime.onMessage: 接收后台推送帧数据/状态事件
   * - chrome.runtime.sendMessage: 向后台请求截图、执行自定义标记/运行
   * - Canvas 2D API: drawImage/toDataURL，负责逐帧拼接和导出
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MANUAL_SAMPLE_MS = 450;
  const MANUAL_MIN_APPEND_PX = 8;
  const MANUAL_FORCE_BOTTOM_CUT_PX = 42;
  const HYBRID_SCROLL_RATIO = 0.82;
  const HYBRID_MAX_IDLE_ROUNDS = 3;
  const HYBRID_SEED_TIMEOUT_MS = 1600;
  const SNAPSHOT_RETRY_MS = 700;
  const TOP_FORCE_CUT_PX = 76;
  const SETTLE_WAIT_MS = 220;
  const DIAG_HISTORY = 12;

  if (!window.captureControllerInstalled) {
    window.captureControllerInstalled = true;

    /**
     * 消息入口：
     * - begin_capture / snapshot_taken / snapshot_error：普通链路
     * - cdp_stitch_*：CDP 分帧拼接链路
     */
    chrome.runtime.onMessage.addListener((request) => {
      if (request.action === "begin_capture") {
        startCapture(request.mode || "auto");
      } else if (request.action === "snapshot_taken" && window.captureSession) {
        handleSnapshot(request.dataUrl);
      } else if (request.action === "snapshot_error" && window.captureSession) {
        handleSnapshotError(request.message || "snapshot error");
      } else if (request.action === "cdp_capture_done") {
        downloadDataUrl(request.dataUrl, `FullPage_CDP_${Date.now()}.png`);
      } else if (request.action === "cdp_capture_error") {
        alert(`CDP整页截图失败：${request.message || "未知错误"}\n\n你可以先用“混合式/手动拼接”作为兜底。`);
      } else if (request.action === "cdp_stitch_begin") {
        startCdpStitch();
      } else if (request.action === "cdp_stitch_meta") {
        if (window.captureSession?.mode === "cdp_stitch") {
          window.captureSession.cdpMeta = request;
        }
      } else if (request.action === "cdp_stitch_frame") {
        handleCdpStitchFrame(request);
      } else if (request.action === "cdp_stitch_end") {
        finishCdpStitch(request);
      }
    });
  }

  function downloadDataUrl(dataUrl, filename) {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    a.click();
  }

  /**
   * 控制插件浮层显隐，避免操作面板被截入最终图。
   * 注意：CDP 拼接期间统一隐藏，收尾再恢复。
   */
  function setPluginUiHidden(hidden) {
    const ids = [
      "__capture_manual_hint__",
      "__capture_manual_control_panel__",
      "__capture_debug_panel__",
      "__capture_diag_panel__"
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.style.display = hidden ? "none" : "";
    }
  }

  function startCdpStitch() {
    // custom 模式下会先创建 captureSession（用于控制面板/提示），这里需要“接管”并切换到 cdp_stitch
    const existing = window.captureSession;
    if (existing?.isCapturing && existing.mode !== "custom") return;

    // 进入 CDP 拼接时隐藏插件浮层，避免被截图
    setPluginUiHidden(true);

    const viewportHeight = existing?.viewportHeight ?? window.innerHeight;
    const viewportWidth = existing?.viewportWidth ?? window.innerWidth;
    const dpr = existing?.dpr ?? (window.devicePixelRatio || 1);

    const canvas = document.createElement("canvas");
    canvas.width = viewportWidth * dpr;
    canvas.height = Math.max(1, viewportHeight * dpr);
    const ctx = canvas.getContext("2d");

    window.captureSession = {
      ...(existing || {}),
      isCapturing: true,
      mode: "cdp_stitch",
      originalScrollY: existing?.originalScrollY ?? window.scrollY,
      originalOverflow: existing?.originalOverflow ?? document.documentElement.style.overflow,
      viewportHeight,
      viewportWidth,
      dpr,
      canvas,
      ctx,
      manualWriteY: 0,
      cdpPrevAnalysis: null,
      cdpTrimLeftPx: null,
      cdpTrimRightPx: null,
      cdpContentWidthCssPx: null,
      expectedFrames: null,
      receivedFrames: 0,
      pendingDraws: 0,
      endRequested: false,
      cdpMeta: null
    };
  }

  /**
   * 处理后台回传的一帧 CDP 图像：
   * - 裁掉顶部/底部固定区域
   * - 自动检测正文左右边界并锁定（首帧）
   * - 计算重叠后写入总画布
   */
  async function handleCdpStitchFrame(frame) {
    const session = window.captureSession;
    if (!session || !session.isCapturing || session.mode !== "cdp_stitch") return;
    const dataUrl = frame.dataUrl;
    if (!dataUrl) return;

    session.receivedFrames += 1;
    session.pendingDraws += 1;

    const img = new Image();
    img.onload = async () => {
      const current = window.captureSession;
      if (!current || !current.isCapturing || current.mode !== "cdp_stitch") return;

      const frameCanvas = buildFrameCanvas(
        img,
        current.viewportWidth * current.dpr,
        current.viewportHeight * current.dpr
      );

      const detectedBottomIgnorePx = detectBottomFixedOverlayHeight();
      const bottomIgnorePx = Math.max(detectedBottomIgnorePx, MANUAL_FORCE_BOTTOM_CUT_PX);
      // 先裁掉顶部/底部固定区域，再裁左右正文区域
      const tbCropped = cropFrameCanvas(
        frameCanvas,
        current.viewportWidth * current.dpr,
        current.viewportHeight * current.dpr,
        current.dpr,
        TOP_FORCE_CUT_PX,
        bottomIgnorePx
      );
      const usableHeightCssPx = Math.max(1, current.viewportHeight - bottomIgnorePx - TOP_FORCE_CUT_PX);

      if (current.cdpTrimLeftPx == null || current.cdpTrimRightPx == null) {
        const crop = detectHorizontalContentCrop(tbCropped, current.viewportWidth, usableHeightCssPx);
        current.cdpTrimLeftPx = crop.trimLeftPx;
        current.cdpTrimRightPx = crop.trimRightPx;
        current.cdpContentWidthCssPx = Math.max(1, current.viewportWidth - crop.trimLeftPx - crop.trimRightPx);
        current.canvas.width = current.cdpContentWidthCssPx * current.dpr;
      }

      const contentWidthCssPx =
        current.cdpContentWidthCssPx ||
        Math.max(1, current.viewportWidth - (current.cdpTrimLeftPx || 0) - (current.cdpTrimRightPx || 0));

      const usableFrameCanvas = cropFrameCanvasLTRB(
        frameCanvas,
        current.viewportWidth * current.dpr,
        current.viewportHeight * current.dpr,
        current.dpr,
        TOP_FORCE_CUT_PX,
        bottomIgnorePx,
        current.cdpTrimLeftPx || 0,
        current.cdpTrimRightPx || 0
      );

      // 优先用“图像重叠匹配”算 overlap，避免 scrollTop 与画面位移不一致导致重复拼接
      const currAnalysis = toAnalysisImageData(usableFrameCanvas, contentWidthCssPx, usableHeightCssPx);
      const delta = Math.max(0, Math.min(usableHeightCssPx, Math.round(frame.delta || 0)));
      const expectedOverlap = frame.isFirst ? 0 : Math.max(0, usableHeightCssPx - delta);
      let overlapPx = frame.isFirst ? 0 : computeOverlapPx(current.cdpPrevAnalysis, currAnalysis, usableHeightCssPx);
      // 如果匹配结果离 delta 推算差太大，说明动态内容干扰，回退到 delta 推算
      if (!frame.isFirst && Math.abs(overlapPx - expectedOverlap) > 140) {
        overlapPx = expectedOverlap;
      }
      const appendHeightPx = usableHeightCssPx - overlapPx;
      if (!frame.isFirst && appendHeightPx <= 1) return;

      const drawTopPx = current.manualWriteY * current.dpr;
      const requiredHeight = drawTopPx + appendHeightPx * current.dpr;
      current.canvas = ensureCanvasSize(
        current.canvas,
        contentWidthCssPx * current.dpr,
        requiredHeight
      );
      current.ctx = current.canvas.getContext("2d");

      current.ctx.drawImage(
        usableFrameCanvas,
        0,
        overlapPx * current.dpr,
        contentWidthCssPx * current.dpr,
        appendHeightPx * current.dpr,
        0,
        drawTopPx,
        contentWidthCssPx * current.dpr,
        appendHeightPx * current.dpr
      );

      current.manualWriteY += appendHeightPx;
      current.cdpPrevAnalysis = currAnalysis;
      current.pendingDraws = Math.max(0, current.pendingDraws - 1);
      maybeFinalizeCdpStitch();
    };
    img.onerror = () => {
      const current = window.captureSession;
      if (!current || current.mode !== "cdp_stitch") return;
      current.pendingDraws = Math.max(0, current.pendingDraws - 1);
      maybeFinalizeCdpStitch();
    };
    img.src = dataUrl;
  }

  function finishCdpStitch(endMsg) {
    const session = window.captureSession;
    if (!session || !session.isCapturing || session.mode !== "cdp_stitch") return;
    session.expectedFrames = Number(endMsg?.frameCount ?? session.expectedFrames);
    session.endRequested = true;
    maybeFinalizeCdpStitch();
  }

  // 当“收到结束信号 + 全部帧绘制完成”时再最终导出，避免只保存首帧
  function maybeFinalizeCdpStitch() {
    const session = window.captureSession;
    if (!session || !session.isCapturing || session.mode !== "cdp_stitch") return;
    if (!session.endRequested) return;
    if (session.expectedFrames != null && session.receivedFrames < session.expectedFrames) return;
    if (session.pendingDraws > 0) return;

    session.isCapturing = false;
    const finalDataUrl = session.canvas.toDataURL("image/png");
    downloadDataUrl(finalDataUrl, `FullPage_CDP_Stitch_${Date.now()}.png`);
    removeManualHint();
    removeDiagnosticsPanel();
    setPluginUiHidden(false);
    window.captureSession = null;
  }

  function ensureCanvasSize(canvas, requiredWidth, requiredHeight) {
    if (canvas.height >= requiredHeight && canvas.width >= requiredWidth) return canvas;
    const resized = document.createElement("canvas");
    resized.width = Math.max(requiredWidth, canvas.width);
    resized.height = Math.max(requiredHeight, canvas.height);
    const resizedCtx = resized.getContext("2d");
    resizedCtx.drawImage(canvas, 0, 0);
    return resized;
  }

  // 手动/混合/自定义模式顶部提示条
  function showManualHint(mode) {
    const oldHint = document.getElementById("__capture_manual_hint__");
    if (oldHint) oldHint.remove();
    const hint = document.createElement("div");
    hint.id = "__capture_manual_hint__";
    if (mode === "hybrid") {
      hint.textContent = "混合式：先滚一下或点“立即接管”，随后插件自动滚到文末；按 X / Esc 可结束";
    } else if (mode === "custom") {
      hint.textContent = "自定义：滚到开始处点“设为开始”，再滚到结束处点“设为结束并开始拼接”";
    } else {
      hint.textContent = "手动拼接中：向下滚动页面，按 X / Esc 或点右上角结束并保存";
    }
    hint.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:14px",
      "transform:translateX(-50%)",
      "background:rgba(0,0,0,.75)",
      "color:#fff",
      "padding:8px 12px",
      "font-size:12px",
      "border-radius:6px",
      "z-index:2147483647",
      "pointer-events:none"
    ].join(";");
    document.body.appendChild(hint);
  }

  function enablePanelDrag(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let panelStartLeft = 0;
    let panelStartTop = 0;
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const nextLeft = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, panelStartLeft + dx));
      const nextTop = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, panelStartTop + dy));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.transform = "none";
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      panelStartLeft = rect.left;
      panelStartTop = rect.top;
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  function showManualControlPanel(mode) {
    const oldPanel = document.getElementById("__capture_manual_control_panel__");
    if (oldPanel) oldPanel.remove();
    const panel = document.createElement("div");
    panel.id = "__capture_manual_control_panel__";
    panel.style.cssText = [
      "position:fixed",
      "right:16px",
      "top:14px",
      "z-index:2147483647",
      "background:rgba(0,0,0,.82)",
      "color:#fff",
      "border-radius:6px",
      "padding:8px",
      "font-size:12px",
      "min-width:220px",
      "box-shadow:0 2px 8px rgba(0,0,0,.25)"
    ].join(";");

    const header = document.createElement("div");
    header.textContent = `${mode === "hybrid" ? "混合式" : "手动拼接"}控制（可拖动）`;
    header.style.cssText = "cursor:move;font-weight:600;margin-bottom:8px;user-select:none;";
    panel.appendChild(header);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;";

    const stopBtn = document.createElement("button");
    stopBtn.textContent = mode === "custom" ? "取消" : "结束并保存";
    stopBtn.style.cssText = "flex:1;background:#e53935;color:#fff;border:none;border-radius:4px;padding:7px 8px;cursor:pointer;";
    stopBtn.addEventListener("click", () => {
      if (mode === "custom") {
        cancelCustom();
      } else {
        requestStopCapture();
      }
    });
    row.appendChild(stopBtn);

    if (mode !== "custom") {
      const shotBtn = document.createElement("button");
      shotBtn.textContent = "补抓一张";
      shotBtn.style.cssText = "flex:1;background:#3b82f6;color:#fff;border:none;border-radius:4px;padding:7px 8px;cursor:pointer;";
      shotBtn.addEventListener("click", () => {
        const session = window.captureSession;
        if (!session || !session.isCapturing || (session.mode !== "manual" && session.mode !== "hybrid")) return;
        session.extraSnapshots += 1;
        requestSnapshot();
      });
      row.appendChild(shotBtn);
    }

    if (mode === "hybrid") {
      const takeoverBtn = document.createElement("button");
      takeoverBtn.textContent = "立即接管";
      takeoverBtn.style.cssText = "margin-top:8px;width:100%;background:#16a34a;color:#fff;border:none;border-radius:4px;padding:7px 8px;cursor:pointer;";
      takeoverBtn.addEventListener("click", () => {
        const session = window.captureSession;
        if (!session || !session.isCapturing || session.mode !== "hybrid") return;
        triggerHybridTakeover(session);
      });
      panel.appendChild(takeoverBtn);
    }

    if (mode === "custom") {
      const startBtn = document.createElement("button");
      startBtn.textContent = "设为开始";
      startBtn.id = "__custom_start_btn__";
      startBtn.style.cssText = "margin-top:8px;width:100%;background:transparent;color:#3b82f6;border:1px solid rgba(59,130,246,.7);border-radius:4px;padding:7px 8px;cursor:pointer;font-weight:600;";
      startBtn.addEventListener("click", () => {
        const session = window.captureSession;
        if (!session || !session.isCapturing || session.mode !== "custom") return;
        setCustomStart(session);
      });
      panel.appendChild(startBtn);

      const endBtn = document.createElement("button");
      endBtn.id = "__custom_end_btn__";
      endBtn.textContent = "设为结尾并开始";
      endBtn.style.cssText = "margin-top:8px;width:100%;background:transparent;color:#16a34a;border:1px solid rgba(22,163,74,.7);border-radius:4px;padding:7px 8px;cursor:pointer;font-weight:600;";
      endBtn.addEventListener("click", () => {
        const session = window.captureSession;
        if (!session || !session.isCapturing || session.mode !== "custom") return;
        setCustomEndAndRun(session);
      });
      panel.appendChild(endBtn);
    }
    panel.appendChild(row);

    const diagRow = document.createElement("div");
    diagRow.style.cssText = "display:flex;gap:8px;margin-top:8px;";
    const diagBtn = document.createElement("button");
    diagBtn.textContent = "自检";
    diagBtn.style.cssText = "flex:1;background:#111827;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:4px;padding:7px 8px;cursor:pointer;";
    diagBtn.addEventListener("click", () => {
      const session = window.captureSession;
      if (!session || !session.isCapturing) return;
      session.diagnostics.enabled = !session.diagnostics.enabled;
      if (session.diagnostics.enabled) {
        showDiagnosticsPanel();
      } else {
        removeDiagnosticsPanel();
      }
      updateDiagnosticsPanel();
    });
    diagRow.appendChild(diagBtn);

    const quietBtn = document.createElement("button");
    quietBtn.textContent = "低抖";
    quietBtn.style.cssText = "flex:1;background:#0f172a;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:4px;padding:7px 8px;cursor:pointer;";
    quietBtn.addEventListener("click", () => {
      const session = window.captureSession;
      if (!session || !session.isCapturing) return;
      session.diagnostics.quietMode = !session.diagnostics.quietMode;
      updateDiagnosticsPanel();
    });
    diagRow.appendChild(quietBtn);
    panel.appendChild(diagRow);

    document.body.appendChild(panel);
    enablePanelDrag(panel, header);
  }

  function showDebugPanel() {
    const oldPanel = document.getElementById("__capture_debug_panel__");
    if (oldPanel) oldPanel.remove();
    const panel = document.createElement("div");
    panel.id = "__capture_debug_panel__";
    panel.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "background:rgba(0,0,0,.78)",
      "color:#d7f7d7",
      "font-size:12px",
      "line-height:1.4",
      "padding:8px 10px",
      "border-radius:6px",
      "min-width:220px",
      "font-family:ui-monospace,SFMono-Regular,Menlo,monospace"
    ].join(";");
    panel.textContent = "DEBUG 初始化中...";
    document.body.appendChild(panel);
  }

  function removeDebugPanel() {
    const panel = document.getElementById("__capture_debug_panel__");
    if (panel) panel.remove();
  }

  function updateDebugPanel() {
    const session = window.captureSession;
    const panel = document.getElementById("__capture_debug_panel__");
    if (!panel || !session || (session.mode !== "manual" && session.mode !== "hybrid")) return;
    panel.textContent =
      `DEBUG ${session.mode === "hybrid" ? "混合式" : "手动拼接"}\n` +
      `req=${session.debug.requestCount} resp=${session.debug.responseCount}\n` +
      `append=${session.debug.appendCount} skip=${session.debug.sameFrameCount}\n` +
      `y=${Math.round(session.manualVirtualY)} ov=${Math.round(session.debug.lastOverlapPx)} bottomCut=${Math.round(session.debug.lastBottomIgnorePx)} pending=${session.pendingShot}`;
  }

  function setOverlayVisibility(hidden) {
    const ids = [
      "__capture_manual_hint__",
      "__capture_manual_control_panel__",
      "__capture_debug_panel__"
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        el.style.visibility = hidden ? "hidden" : "visible";
        el.style.opacity = hidden ? "0" : "1";
      }
    }
  }

  function showDiagnosticsPanel() {
    const old = document.getElementById("__capture_diag_panel__");
    if (old) old.remove();
    const panel = document.createElement("div");
    panel.id = "__capture_diag_panel__";
    panel.style.cssText = [
      "position:fixed",
      "left:16px",
      "bottom:16px",
      "z-index:2147483647",
      "background:rgba(17,24,39,.86)",
      "color:#e5e7eb",
      "font-size:12px",
      "line-height:1.35",
      "padding:10px",
      "border-radius:8px",
      "min-width:260px",
      "max-width:360px",
      "box-shadow:0 6px 18px rgba(0,0,0,.28)",
      "font-family:ui-monospace,SFMono-Regular,Menlo,monospace"
    ].join(";");

    const header = document.createElement("div");
    header.textContent = "自检窗口（可拖动）";
    header.style.cssText = "cursor:move;font-weight:700;margin-bottom:8px;user-select:none;color:#fff;";
    panel.appendChild(header);

    const body = document.createElement("div");
    body.id = "__capture_diag_body__";
    body.textContent = "等待首帧...";
    panel.appendChild(body);

    document.body.appendChild(panel);
    enablePanelDrag(panel, header);
  }

  function removeDiagnosticsPanel() {
    const panel = document.getElementById("__capture_diag_panel__");
    if (panel) panel.remove();
  }

  function updateDiagnosticsPanel() {
    const session = window.captureSession;
    const body = document.getElementById("__capture_diag_body__");
    if (!session || !body) return;
    const h = session.diagnostics.history;
    const last = h.length ? h[h.length - 1] : null;
    const avg = h.length ? Math.round(h.reduce((a, b) => a + b, 0) / h.length) : 0;
    body.textContent =
      `mode=${session.mode} quiet=${session.diagnostics.quietMode ? "on" : "off"}\n` +
      `req=${session.debug.requestCount} resp=${session.debug.responseCount} pending=${session.pendingShot}\n` +
      `delta=${Math.round(session.hybridLastDelta ?? 0)} ov=${Math.round(session.debug.lastOverlapPx)}\n` +
      `diff(last)=${last ?? "-"} diff(avg)=${avg} topCut=${TOP_FORCE_CUT_PX} bottomCut=${Math.round(session.debug.lastBottomIgnorePx)}`;
  }

  function detectBestScrollSource() {
    const centerX = Math.round(window.innerWidth / 2);
    const centerY = Math.round(window.innerHeight / 2);
    const candidates = document.elementsFromPoint(centerX, centerY) || [];
    for (const el of candidates) {
      let cur = el;
      while (cur && cur !== document.body) {
        if (cur.scrollHeight > cur.clientHeight + 80 && cur.clientHeight > 120) {
          return cur;
        }
        cur = cur.parentElement;
      }
    }
    return window;
  }

  function detectBottomFixedOverlayHeight() {
    const xs = [Math.round(window.innerWidth * 0.25), Math.round(window.innerWidth * 0.5), Math.round(window.innerWidth * 0.75)];
    const y = Math.max(0, window.innerHeight - 2);
    let maxHeight = 0;
    for (const x of xs) {
      const elements = document.elementsFromPoint(x, y);
      for (const el of elements) {
        if (!el || el.id === "__capture_manual_hint__" || el.id === "__capture_manual_control_panel__" || el.id === "__capture_debug_panel__") {
          continue;
        }
        const style = window.getComputedStyle(el);
        if (style.position !== "fixed" && style.position !== "sticky") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < window.innerWidth * 0.2) continue;
        if (rect.height < 16 || rect.height > window.innerHeight * 0.4) continue;
        const bottomDist = Math.abs(window.innerHeight - rect.bottom);
        if (bottomDist > 6) continue;
        maxHeight = Math.max(maxHeight, rect.height);
      }
    }
    return Math.min(180, Math.max(0, Math.round(maxHeight)));
  }

  function buildFrameCanvas(img, widthPx, heightPx) {
    const frame = document.createElement("canvas");
    frame.width = widthPx;
    frame.height = heightPx;
    const frameCtx = frame.getContext("2d");
    frameCtx.drawImage(img, 0, 0, widthPx, heightPx);
    return frame;
  }

  function toAnalysisImageData(frameCanvas, cssViewportWidth, cssViewportHeight) {
    const analysisWidth = 220;
    const analysisHeight = Math.max(80, Math.round(cssViewportHeight * (analysisWidth / Math.max(1, cssViewportWidth))));
    const analysisCanvas = document.createElement("canvas");
    analysisCanvas.width = analysisWidth;
    analysisCanvas.height = analysisHeight;
    const aCtx = analysisCanvas.getContext("2d");
    aCtx.drawImage(frameCanvas, 0, 0, analysisWidth, analysisHeight);
    const data = aCtx.getImageData(0, 0, analysisWidth, analysisHeight).data;
    return { data, width: analysisWidth, height: analysisHeight };
  }

  function cropFrameCanvas(frameCanvas, widthPx, heightPx, dpr, trimTopPx, trimBottomPx) {
    const topPx = Math.max(0, Math.round(trimTopPx * dpr));
    const bottomPx = Math.max(0, Math.round(trimBottomPx * dpr));
    const cropHeight = Math.max(1, heightPx - topPx - bottomPx);
    const cropped = document.createElement("canvas");
    cropped.width = widthPx;
    cropped.height = cropHeight;
    const cctx = cropped.getContext("2d");
    cctx.drawImage(
      frameCanvas,
      0,
      topPx,
      widthPx,
      cropHeight,
      0,
      0,
      widthPx,
      cropHeight
    );
    return cropped;
  }

  function cropFrameCanvasLTRB(frameCanvas, widthPx, heightPx, dpr, trimTopPx, trimBottomPx, trimLeftPx, trimRightPx) {
    const topPx = Math.max(0, Math.round(trimTopPx * dpr));
    const bottomPx = Math.max(0, Math.round(trimBottomPx * dpr));
    const leftPx = Math.max(0, Math.round(trimLeftPx * dpr));
    const rightPx = Math.max(0, Math.round(trimRightPx * dpr));
    const cropWidth = Math.max(1, widthPx - leftPx - rightPx);
    const cropHeight = Math.max(1, heightPx - topPx - bottomPx);
    const cropped = document.createElement("canvas");
    cropped.width = cropWidth;
    cropped.height = cropHeight;
    const cctx = cropped.getContext("2d");
    cctx.drawImage(
      frameCanvas,
      leftPx,
      topPx,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight
    );
    return cropped;
  }

  function detectHorizontalContentCrop(frameCanvas, cssWidth, cssHeight) {
    // 在缩小图上找“非背景”区域的左右边界，返回要裁掉的 left/right（CSS px）
    const analysisWidth = 260;
    const analysisHeight = Math.max(120, Math.round(cssHeight * (analysisWidth / Math.max(1, cssWidth))));
    const c = document.createElement("canvas");
    c.width = analysisWidth;
    c.height = analysisHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(frameCanvas, 0, 0, analysisWidth, analysisHeight);
    const { data, width: w, height: h } = ctx.getImageData(0, 0, analysisWidth, analysisHeight);

    // 估计背景色：取左右边缘多点采样的中位灰度
    const samples = [];
    const sampleYs = [Math.round(h * 0.2), Math.round(h * 0.5), Math.round(h * 0.8)];
    for (const y of sampleYs) {
      for (const x of [0, 1, 2, w - 3, w - 2, w - 1]) {
        const i = (y * w + x) * 4;
        const g = (data[i] + data[i + 1] + data[i + 2]) / 3;
        samples.push(g);
      }
    }
    samples.sort((a, b) => a - b);
    const bg = samples[Math.floor(samples.length / 2)] ?? 255;

    const yStart = Math.round(h * 0.18);
    const yEnd = Math.round(h * 0.88);
    const xStep = 2;
    const yStep = 6;
    const colScore = new Array(w).fill(0);

    for (let x = 0; x < w; x += xStep) {
      let sum = 0;
      let count = 0;
      for (let y = yStart; y < yEnd; y += yStep) {
        const i = (y * w + x) * 4;
        const g = (data[i] + data[i + 1] + data[i + 2]) / 3;
        sum += Math.abs(g - bg);
        count += 1;
      }
      colScore[x] = sum / Math.max(1, count);
    }

    const threshold = 10;
    let left = 0;
    while (left < w && colScore[left] < threshold) left += xStep;
    let right = w - 1;
    while (right >= 0 && colScore[right] < threshold) right -= xStep;

    const minWidth = Math.round(w * 0.5);
    if (right - left < minWidth) {
      left = Math.round(w * 0.12);
      right = Math.round(w * 0.88);
    }

    const pad = Math.round(w * 0.01);
    left = Math.max(0, left - pad);
    right = Math.min(w - 1, right + pad);

    const leftCss = (left / w) * cssWidth;
    const rightCss = cssWidth - ((right + 1) / w) * cssWidth;
    return {
      trimLeftPx: Math.max(0, Math.round(leftCss)),
      trimRightPx: Math.max(0, Math.round(rightCss))
    };
  }

  function computeFrameDiffScore(prevAnalysis, currAnalysis) {
    if (!prevAnalysis || !currAnalysis) return null;
    if (prevAnalysis.width !== currAnalysis.width || prevAnalysis.height !== currAnalysis.height) return null;
    const { data: p, width: w, height: h } = prevAnalysis;
    const { data: c } = currAnalysis;
    let sum = 0;
    let count = 0;
    const xStep = 14;
    const yStep = 6;
    for (let y = 0; y < h; y += yStep) {
      for (let x = 0; x < w; x += xStep) {
        const i = (y * w + x) * 4;
        sum += Math.abs(p[i] - c[i]) + Math.abs(p[i + 1] - c[i + 1]) + Math.abs(p[i + 2] - c[i + 2]);
        count += 3;
      }
    }
    return Math.round(sum / Math.max(1, count));
  }

  function computeOverlapPx(prevAnalysis, currAnalysis, viewportHeight) {
    if (!prevAnalysis || !currAnalysis) return 0;
    if (prevAnalysis.width !== currAnalysis.width || prevAnalysis.height !== currAnalysis.height) return 0;

    const { data: p, width: w, height: h } = prevAnalysis;
    const { data: c } = currAnalysis;
    const xStep = 10;
    const yStep = 2;
    const minOverlap = 12;
    const maxOverlap = Math.max(minOverlap, Math.floor(h * 0.82));
    let bestOverlap = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let overlap = minOverlap; overlap <= maxOverlap; overlap += 2) {
      const prevStartY = h - overlap;
      const rows = Math.min(overlap, 36);
      let score = 0;
      let count = 0;
      for (let y = 0; y < rows; y += yStep) {
        const py = prevStartY + y;
        const cy = y;
        for (let x = 0; x < w; x += xStep) {
          const pi = (py * w + x) * 4;
          const ci = (cy * w + x) * 4;
          const pr = p[pi], pg = p[pi + 1], pb = p[pi + 2];
          const cr = c[ci], cg = c[ci + 1], cb = c[ci + 2];
          score += Math.abs(pr - cr) + Math.abs(pg - cg) + Math.abs(pb - cb);
          count += 3;
        }
      }
      const avg = score / Math.max(1, count);
      if (avg < bestScore) {
        bestScore = avg;
        bestOverlap = overlap;
      }
    }

    // 分数越低越接近，阈值防止误匹配导致乱拼接
    if (bestScore > 24) return 0;
    const overlapPx = (bestOverlap / h) * viewportHeight;
    return Math.max(0, Math.min(viewportHeight - 1, overlapPx));
  }

  function removeManualHint() {
    const hint = document.getElementById("__capture_manual_hint__");
    if (hint) hint.remove();
    const panel = document.getElementById("__capture_manual_control_panel__");
    if (panel) panel.remove();
    removeDebugPanel();
  }

  async function startCapture(mode) {
    if (window.captureSession?.isCapturing) return;

    const originalScrollY = window.scrollY;
    const originalOverflow = document.documentElement.style.overflow;
    if (mode === "auto") {
      document.documentElement.style.overflow = "hidden";
    }

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const dpr = window.devicePixelRatio || 1;

    const canvas = document.createElement("canvas");
    canvas.width = viewportWidth * dpr;
    canvas.height = Math.max(viewportHeight * dpr, 1);
    const ctx = canvas.getContext("2d");

    window.captureSession = {
      isCapturing: true,
      mode,
      originalScrollY,
      originalOverflow,
      viewportHeight,
      viewportWidth,
      dpr,
      canvas,
      ctx,
      maxCapturedBottom: 0,
      pendingShot: false,
      queuedShot: false,
      stopRequested: false,
      manualVirtualY: 0,
      sourceLastPos: new Map(),
      manualSignature: null,
      manualFrameIndex: 0,
      manualTicker: null,
      manualPrevAnalysis: null,
      manualWriteY: 0,
      extraSnapshots: 0,
      hybridStartedAuto: false,
      hybridScrollSource: null,
      hybridIdleRounds: 0,
      hybridTakeoverTimer: null,
      hybridLastDelta: null,
      customRunning: false,
      customScrollSource: null,
      customStartTop: null,
      customEndTop: null,
      customLastTop: null,
      customLastDelta: null,
      customStartSet: false,
      customEndSet: false,
      retryTimer: null,
      diagnostics: {
        enabled: false,
        quietMode: true,
        prevAnalysisForDiff: null,
        history: []
      },
      debug: {
        requestCount: 0,
        responseCount: 0,
        appendCount: 0,
        sameFrameCount: 0,
        lastOverlapPx: 0,
        lastBottomIgnorePx: 0
      }
    };

    if (mode === "manual" || mode === "hybrid" || mode === "custom") {
      showManualHint(mode);
      showManualControlPanel(mode);
      showDebugPanel();
      document.addEventListener("scroll", onManualScroll, true);
      document.addEventListener("wheel", onManualWheel, { passive: true, capture: true });
      window.addEventListener("keydown", onManualKeydown, true);
      document.addEventListener("keydown", onManualKeydown, true);
      await sleep(350);
      // custom 模式走 CDP，不在页面内触发 captureVisibleTab
      if (mode !== "custom") {
        requestSnapshot();
      }
      if (mode === "hybrid") {
        window.captureSession.hybridTakeoverTimer = window.setTimeout(() => {
          const current = window.captureSession;
          if (!current || !current.isCapturing || current.mode !== "hybrid" || current.hybridStartedAuto) return;
          triggerHybridTakeover(current);
        }, HYBRID_SEED_TIMEOUT_MS);
      }
      window.captureSession.manualTicker = window.setInterval(() => {
        const session = window.captureSession;
        if (!session || !session.isCapturing || (session.mode !== "manual" && session.mode !== "hybrid" && session.mode !== "custom")) return;
        // 混合式接管后改为“滚动一步抓一张”，避免定时抓导致重复拼接
        if (session.mode === "hybrid" && session.hybridStartedAuto) return;
        // custom 模式走 CDP
        if (session.mode === "custom") return;
        requestSnapshot();
      }, MANUAL_SAMPLE_MS);
      updateDebugPanel();
      return;
    }

    window.scrollTo(0, 0);
    await sleep(400);
    requestSnapshot();
  }

  function getScrollSource(event) {
    if (event.target === document || event.target === document.documentElement || event.target === document.body) {
      return window;
    }
    return event.target;
  }

  function getSourceScrollPos(source) {
    if (source === window) return window.scrollY || document.documentElement.scrollTop || 0;
    return source.scrollTop || 0;
  }

  function onManualScroll(event) {
    const session = window.captureSession;
    if (!session || !session.isCapturing || (session.mode !== "manual" && session.mode !== "hybrid" && session.mode !== "custom")) return;
    const source = getScrollSource(event);
    const currentPos = getSourceScrollPos(source);
    const prevPos = session.sourceLastPos.get(source);
    session.sourceLastPos.set(source, currentPos);
    if (prevPos === undefined) return;

    const delta = currentPos - prevPos;
    if (delta > 10) {
      if (session.mode === "hybrid" && !session.hybridScrollSource) {
        session.hybridScrollSource = source;
      }
      if (session.mode === "hybrid" && !session.hybridStartedAuto) {
        triggerHybridTakeover(session);
      }
      if (session.mode === "manual") {
        session.manualVirtualY += Math.max(10, delta);
      }
      requestSnapshot();
      updateDebugPanel();
    }
  }

  function onManualWheel(event) {
    const session = window.captureSession;
    if (!session || !session.isCapturing || (session.mode !== "manual" && session.mode !== "hybrid" && session.mode !== "custom")) return;
    if (event.deltaY > 8) {
      if (session.mode === "hybrid" && !session.hybridScrollSource) {
        session.hybridScrollSource = getScrollSource(event);
      }
      if (session.mode === "hybrid" && !session.hybridStartedAuto) {
        triggerHybridTakeover(session);
      }
      if (session.mode === "manual") {
        session.manualVirtualY += Math.max(10, Math.round(event.deltaY));
      }
      if (event.deltaY > 240) {
        session.extraSnapshots += Math.min(3, Math.floor(event.deltaY / 240));
      }
      requestSnapshot();
      updateDebugPanel();
    }
  }

  function onManualKeydown(event) {
    const session = window.captureSession;
    if (!session || !session.isCapturing || (session.mode !== "manual" && session.mode !== "hybrid" && session.mode !== "custom")) return;
    if (event.isComposing) return;
    const isStopKey =
      event.code === "KeyX" ||
      event.key === "x" ||
      event.key === "X" ||
      event.key === "Escape";
    if (isStopKey) {
      event.preventDefault();
      event.stopPropagation();
      if (session.mode === "custom") {
        cancelCustom();
      } else {
        requestStopCapture();
      }
    }
  }

  function getScrollTopForCustom(source) {
    if (source === window) return window.scrollY || document.documentElement.scrollTop || 0;
    return source.scrollTop || 0;
  }

  function setScrollTopForCustom(source, top) {
    if (source === window) {
      window.scrollTo(0, top);
      return window.scrollY || document.documentElement.scrollTop || 0;
    }
    source.scrollTop = top;
    return source.scrollTop || 0;
  }

  function setCustomStart(session) {
    chrome.runtime.sendMessage({ action: "cdp_custom_mark", mark: "start" }, (resp) => {
      if (!resp?.ok) {
        alert(`设为开始失败：${resp?.message || "未知错误"}`);
        return;
      }
      session.customStartTop = resp.scrollTop;
      session.customStartSet = true;
      const btn = document.getElementById("__custom_start_btn__");
      if (btn) {
        btn.style.background = "#3b82f6";
        btn.style.color = "#fff";
        btn.style.border = "none";
        btn.textContent = "已设为开始";
        btn.disabled = true;
        btn.style.cursor = "default";
      }
      showManualHint("custom");
    });
  }

  function setCustomEndAndRun(session) {
    chrome.runtime.sendMessage({ action: "cdp_custom_mark", mark: "end" }, (resp) => {
      if (!resp?.ok) {
        alert(`设为结尾失败：${resp?.message || "未知错误"}`);
        return;
      }
      session.customEndTop = resp.scrollTop;
      session.customEndSet = true;
      const btn = document.getElementById("__custom_end_btn__");
      if (btn) {
        btn.style.background = "#16a34a";
        btn.style.color = "#fff";
        btn.style.border = "none";
        btn.textContent = "已设为结尾，开始截取...";
        btn.disabled = true;
        btn.style.cursor = "default";
      }
      chrome.runtime.sendMessage({ action: "cdp_custom_run" }, (runResp) => {
        if (!runResp?.ok) {
          alert(`自定义截取失败：${runResp?.message || "未知错误"}`);
          // 失败时允许用户重新点结尾
          const eb = document.getElementById("__custom_end_btn__");
          if (eb) {
            eb.disabled = false;
            eb.style.cursor = "pointer";
            eb.textContent = "设为结尾并开始";
            eb.style.background = "transparent";
            eb.style.color = "#16a34a";
            eb.style.border = "1px solid rgba(22,163,74,.7)";
          }
        }
      });
    });
  }

  function cancelCustom() {
    const session = window.captureSession;
    if (!session || !session.isCapturing || session.mode !== "custom") return;
    finishCapture();
  }

  function scrollSourceBy(source, delta) {
    if (source === window) {
      const before = window.scrollY || document.documentElement.scrollTop || 0;
      window.scrollBy(0, delta);
      const after = window.scrollY || document.documentElement.scrollTop || 0;
      return after - before;
    }
    const before = source.scrollTop || 0;
    source.scrollTop = before + delta;
    const after = source.scrollTop || 0;
    return after - before;
  }

  async function runHybridAutoStep(session) {
    if (!session.hybridStartedAuto || session.stopRequested) return;
    const source = session.hybridScrollSource || window;
    const step = Math.max(80, Math.round(session.viewportHeight * HYBRID_SCROLL_RATIO));
    const moved = scrollSourceBy(source, step);
    session.hybridLastDelta = Math.max(0, moved);
    await sleep(session.diagnostics.quietMode ? SETTLE_WAIT_MS : 320);
    if (moved < 4) {
      session.hybridIdleRounds += 1;
      if (session.hybridIdleRounds >= HYBRID_MAX_IDLE_ROUNDS) {
        requestStopCapture();
      }
    } else {
      session.hybridIdleRounds = 0;
    }
    requestSnapshot();
  }

  async function runCustomAutoStep(session) {
    if (!session.customRunning || session.stopRequested) return;
    const source = session.customScrollSource || window;
    const step = Math.max(80, Math.round(session.viewportHeight * HYBRID_SCROLL_RATIO));

    const before = getScrollTopForCustom(source);
    const maxTop = Math.max(0, Number(session.customEndTop ?? before));
    if (before >= maxTop) {
      session.stopRequested = true;
      finishCapture();
      return;
    }

    const desired = Math.min(maxTop, before + step);
    const after = setScrollTopForCustom(source, desired);
    const moved = Math.max(0, after - before);
    session.customLastDelta = moved;
    session.customLastTop = after;

    await sleep(session.diagnostics?.quietMode ? SETTLE_WAIT_MS : 320);
    requestSnapshot();
  }

  function triggerHybridTakeover(session) {
    if (!session || session.mode !== "hybrid") return;
    if (!session.hybridScrollSource) {
      session.hybridScrollSource = detectBestScrollSource();
    }
    session.hybridStartedAuto = true;
    session.hybridIdleRounds = 0;
    if (session.hybridTakeoverTimer) {
      window.clearTimeout(session.hybridTakeoverTimer);
      session.hybridTakeoverTimer = null;
    }
    updateDebugPanel();
  }

  function requestStopCapture() {
    const session = window.captureSession;
    if (!session || !session.isCapturing) return;
    session.stopRequested = true;
    if (!session.pendingShot) {
      finishCapture();
    }
  }

  function requestSnapshot() {
    const session = window.captureSession;
    if (!session || !session.isCapturing) return;
    if (session.pendingShot) {
      session.queuedShot = true;
      return;
    }
    session.pendingShot = true;
    if (session.mode === "manual" || session.mode === "hybrid") {
      session.debug.requestCount += 1;
      updateDebugPanel();
      // 不再每帧显隐，避免屏幕抖动；我们通过顶部裁剪去掉浮层区域
    }
    chrome.runtime.sendMessage({ action: "take_visible_snapshot" });
  }

  function handleSnapshotError() {
    const session = window.captureSession;
    if (!session || !session.isCapturing) return;

    session.pendingShot = false;
    // 不做显隐，避免抖动
    if (session.stopRequested) {
      finishCapture();
      return;
    }
    if (session.retryTimer) return;

    session.retryTimer = window.setTimeout(() => {
      const current = window.captureSession;
      if (!current || !current.isCapturing) return;
      current.retryTimer = null;
      requestSnapshot();
    }, SNAPSHOT_RETRY_MS);
  }

  async function handleSnapshot(dataUrl) {
    const session = window.captureSession;
    if (!session || !session.isCapturing) return;

    const img = new Image();
    img.onload = async () => {
      const currentSession = window.captureSession;
      if (!currentSession || !currentSession.isCapturing) return;
      if (currentSession.mode === "manual" || currentSession.mode === "hybrid" || currentSession.mode === "custom") {
        currentSession.debug.responseCount += 1;
        // 不做显隐，避免抖动
      }

      if (currentSession.mode === "manual" || currentSession.mode === "hybrid" || currentSession.mode === "custom") {
        const signature = dataUrl.slice(0, 300) + dataUrl.slice(-300);
        const isSameFrame = currentSession.manualSignature === signature;
        currentSession.pendingShot = false;

        if (isSameFrame) {
          currentSession.debug.sameFrameCount += 1;
          if (currentSession.queuedShot) {
            currentSession.queuedShot = false;
            requestSnapshot();
          } else if (currentSession.extraSnapshots > 0) {
            currentSession.extraSnapshots -= 1;
            requestSnapshot();
          } else if (currentSession.mode === "hybrid" && currentSession.hybridStartedAuto) {
            await runHybridAutoStep(currentSession);
          } else if (currentSession.mode === "custom" && currentSession.customRunning) {
            await runCustomAutoStep(currentSession);
          } else if (currentSession.stopRequested) {
            finishCapture();
          }
          updateDebugPanel();
          return;
        }

        currentSession.manualSignature = signature;
        currentSession.manualFrameIndex += 1;
        const frameCanvas = buildFrameCanvas(
          img,
          currentSession.viewportWidth * currentSession.dpr,
          currentSession.viewportHeight * currentSession.dpr
        );
        const detectedBottomIgnorePx = detectBottomFixedOverlayHeight();
        const bottomIgnorePx = Math.max(detectedBottomIgnorePx, MANUAL_FORCE_BOTTOM_CUT_PX);
        currentSession.debug.lastBottomIgnorePx = bottomIgnorePx;
        const usableFrameCanvas = cropFrameCanvas(
          frameCanvas,
          currentSession.viewportWidth * currentSession.dpr,
          currentSession.viewportHeight * currentSession.dpr,
          currentSession.dpr,
          TOP_FORCE_CUT_PX,
          bottomIgnorePx
        );
        const usableHeightCssPx = Math.max(1, currentSession.viewportHeight - bottomIgnorePx - TOP_FORCE_CUT_PX);
        const currAnalysis = toAnalysisImageData(usableFrameCanvas, currentSession.viewportWidth, usableHeightCssPx);

        if (currentSession.diagnostics.enabled) {
          const diff = computeFrameDiffScore(currentSession.diagnostics.prevAnalysisForDiff, currAnalysis);
          if (diff !== null) {
            currentSession.diagnostics.history.push(diff);
            if (currentSession.diagnostics.history.length > DIAG_HISTORY) {
              currentSession.diagnostics.history.shift();
            }
          }
          currentSession.diagnostics.prevAnalysisForDiff = currAnalysis;
          updateDiagnosticsPanel();
        }

        let overlapPx = 0;
        if (
          currentSession.mode === "hybrid" &&
          currentSession.hybridStartedAuto &&
          currentSession.hybridLastDelta !== null &&
          currentSession.manualFrameIndex > 1
        ) {
          const delta = Math.max(0, Math.min(usableHeightCssPx, Math.round(currentSession.hybridLastDelta)));
          overlapPx = Math.max(0, usableHeightCssPx - delta);
        } else if (
          currentSession.mode === "custom" &&
          currentSession.customRunning &&
          currentSession.customLastDelta != null &&
          currentSession.manualFrameIndex > 1
        ) {
          const delta = Math.max(0, Math.min(usableHeightCssPx, Math.round(currentSession.customLastDelta)));
          overlapPx = Math.max(0, usableHeightCssPx - delta);
        } else if (currentSession.manualFrameIndex > 1) {
          overlapPx = computeOverlapPx(
            currentSession.manualPrevAnalysis,
            currAnalysis,
            usableHeightCssPx
          );
        }
        currentSession.debug.lastOverlapPx = overlapPx;

        const appendHeightPx = usableHeightCssPx - overlapPx;
        if (currentSession.manualFrameIndex > 1 && appendHeightPx < MANUAL_MIN_APPEND_PX) {
          currentSession.debug.sameFrameCount += 1;
          currentSession.manualPrevAnalysis = currAnalysis;
          if (currentSession.queuedShot) {
            currentSession.queuedShot = false;
            requestSnapshot();
          } else if (currentSession.extraSnapshots > 0) {
            currentSession.extraSnapshots -= 1;
            requestSnapshot();
          } else if (currentSession.mode === "hybrid" && currentSession.hybridStartedAuto) {
            await runHybridAutoStep(currentSession);
          } else if (currentSession.mode === "custom" && currentSession.customRunning) {
            await runCustomAutoStep(currentSession);
          } else if (currentSession.stopRequested) {
            finishCapture();
          }
          updateDebugPanel();
          return;
        }

        const drawTopPx = currentSession.manualWriteY * currentSession.dpr;
        const requiredHeight = drawTopPx + appendHeightPx * currentSession.dpr;
        currentSession.canvas = ensureCanvasSize(
          currentSession.canvas,
          currentSession.viewportWidth * currentSession.dpr,
          requiredHeight
        );
        currentSession.ctx = currentSession.canvas.getContext("2d");
        currentSession.ctx.drawImage(
          usableFrameCanvas,
          0,
          overlapPx * currentSession.dpr,
          currentSession.viewportWidth * currentSession.dpr,
          appendHeightPx * currentSession.dpr,
          0,
          drawTopPx,
          currentSession.viewportWidth * currentSession.dpr,
          appendHeightPx * currentSession.dpr
        );

        currentSession.manualWriteY += appendHeightPx;
        currentSession.manualVirtualY = currentSession.manualWriteY;
        currentSession.manualPrevAnalysis = currAnalysis;
        currentSession.maxCapturedBottom = Math.max(
          currentSession.maxCapturedBottom,
          currentSession.manualWriteY
        );
        currentSession.debug.appendCount += 1;
        updateDebugPanel();
        if (currentSession.diagnostics.enabled) {
          updateDiagnosticsPanel();
        }

        if (currentSession.queuedShot) {
          currentSession.queuedShot = false;
          requestSnapshot();
          return;
        }
        if (currentSession.extraSnapshots > 0) {
          currentSession.extraSnapshots -= 1;
          requestSnapshot();
          return;
        }
        if (currentSession.mode === "hybrid" && currentSession.hybridStartedAuto) {
          await runHybridAutoStep(currentSession);
          return;
        }
        if (currentSession.mode === "custom" && currentSession.customRunning) {
          await runCustomAutoStep(currentSession);
          return;
        }
        if (currentSession.stopRequested) {
          finishCapture();
        }
        currentSession.hybridLastDelta = null;
        return;
      }

      const drawY = currentSession.mode === "manual" ? currentSession.manualVirtualY : window.scrollY;
      const drawTop = drawY * currentSession.dpr;
      const requiredHeight = drawTop + currentSession.viewportHeight * currentSession.dpr;

      currentSession.canvas = ensureCanvasSize(
        currentSession.canvas,
        currentSession.viewportWidth * currentSession.dpr,
        requiredHeight
      );
      currentSession.ctx = currentSession.canvas.getContext("2d");

      currentSession.ctx.drawImage(
        img,
        0,
        drawTop,
        currentSession.viewportWidth * currentSession.dpr,
        currentSession.viewportHeight * currentSession.dpr
      );

      currentSession.maxCapturedBottom = Math.max(
        currentSession.maxCapturedBottom,
        drawY + currentSession.viewportHeight
      );
      currentSession.pendingShot = false;

      if (currentSession.queuedShot) {
        currentSession.queuedShot = false;
        requestSnapshot();
        return;
      }

      if (currentSession.mode === "manual") {
        if (currentSession.stopRequested) {
          finishCapture();
        }
        return;
      }

      const totalHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const actualScrollY = window.scrollY;
      const nextTop = actualScrollY + currentSession.viewportHeight;

      if (nextTop < totalHeight && actualScrollY + currentSession.viewportHeight < totalHeight) {
        window.scrollTo(0, nextTop);
        await sleep(400);
        requestSnapshot();
      } else {
        finishCapture();
      }
    };
    img.src = dataUrl;
  }

  function finishCapture() {
    const session = window.captureSession;
    if (!session || !session.isCapturing) return;

    session.isCapturing = false;
    if (session.manualTicker) {
      window.clearInterval(session.manualTicker);
    }
    if (session.hybridTakeoverTimer) {
      window.clearTimeout(session.hybridTakeoverTimer);
    }
    if (session.retryTimer) {
      window.clearTimeout(session.retryTimer);
    }
    document.removeEventListener("scroll", onManualScroll, true);
    document.removeEventListener("wheel", onManualWheel, true);
    window.removeEventListener("keydown", onManualKeydown, true);
    document.removeEventListener("keydown", onManualKeydown, true);
    removeManualHint();
    removeDiagnosticsPanel();

    document.documentElement.style.overflow = session.originalOverflow;
    window.scrollTo(0, session.originalScrollY);

    const finalDataUrl = session.canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = finalDataUrl;
    a.download = `FullPage_ScrollCapture_${Date.now()}.png`;
    a.click();

    window.captureSession = null;
  }
})();