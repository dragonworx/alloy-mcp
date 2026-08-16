import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

interface HarnessOptions {
  accessibilityChildCount?: number;
  autoDetach?: boolean;
  captureBitmapHeight?: number;
  captureBitmapHeights?: number[];
  captureGate?: Promise<void>;
  executeScriptGate?: Promise<void>;
  failDynamicCleanup?: boolean;
  immediateCaptureTimeouts?: number;
  immediateTimeouts?: boolean;
  page?: {
    contentHeight: number;
    contentWidth: number;
    scrollX?: number;
    scrollY?: number;
    viewportHeight: number;
    viewportWidth: number;
  };
  sendDebuggerCommand?: (method: string, params?: Record<string, unknown>) => Promise<any>;
  switchToTabIdDuringCapture?: number;
  tabs?: Array<{ active?: boolean; id: number; windowId?: number }>;
  tabUpdateGate?: Promise<void>;
}

function flushTasks(): Promise<void> {
  return new Promise(resolveTask => setImmediate(resolveTask));
}

function createHarness(options: HarnessOptions = {}) {
  const intervals: Array<() => void> = [];
  const detachListeners: Array<(source: { tabId?: number }) => void> = [];
  const detachResolvers: Array<() => void> = [];
  let dynamicCleanupCalls = 0;
  let attachCalls = 0;
  let webSocketCalls = 0;
  let bitmapIndex = 0;
  let remainingCaptureTimeouts = options.immediateCaptureTimeouts ?? 0;
  const drawCalls: any[][] = [];
  const scrollCalls: Array<{ left: number; top: number }> = [];
  const tabUpdates: Array<{ active?: boolean; tabId: number }> = [];
  const timeoutDelays: number[] = [];
  const visibleTabCaptures: Array<{ options: Record<string, unknown>; windowId: number }> = [];
  const tabs = options.tabs ?? [];

  const page = options.page ?? {
    contentHeight: 800,
    contentWidth: 1200,
    viewportHeight: 800,
    viewportWidth: 1200,
  };

  const pageConsole = {
    log() {},
    warn() {},
    error() {},
    info() {},
    debug() {},
    trace() {},
  };
  const pageWindow: Record<string, any> = {
    alert() {},
    confirm() { return true; },
    prompt() { return ""; },
    removeEventListener() {},
    innerHeight: page.viewportHeight,
    innerWidth: page.viewportWidth,
    scrollX: page.scrollX ?? 0,
    scrollY: page.scrollY ?? 0,
    scrollTo({ left, top }: { left: number; top: number }) {
      this.scrollX = Math.min(Math.max(0, left), Math.max(0, page.contentWidth - page.viewportWidth));
      this.scrollY = Math.min(Math.max(0, top), Math.max(0, page.contentHeight - page.viewportHeight));
      scrollCalls.push({ left: this.scrollX, top: this.scrollY });
    },
  };
  const accessibilityChildren = Array.from(
    { length: options.accessibilityChildCount ?? 0 },
    () => ({
      childNodes: [],
      children: [],
      getAttribute: () => null,
      tagName: "DIV",
    })
  );
  const pageDocument = {
    body: {
      childNodes: [],
      children: accessibilityChildren,
      getAttribute: () => null,
      scrollHeight: page.contentHeight,
      scrollWidth: page.contentWidth,
      tagName: "BODY",
    },
    documentElement: { scrollHeight: page.contentHeight, scrollWidth: page.contentWidth },
  };

  class FakeOffscreenCanvas {
    constructor(public width: number, public height: number) {}

    getContext() {
      return {
        drawImage: (...args: any[]) => drawCalls.push(args),
      };
    }

    async convertToBlob() {
      return new Blob(["stitched"], { type: "image/png" });
    }
  }

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    onerror?: (error: Error) => void;

    constructor() {
      webSocketCalls++;
    }

    close() {}
    send() {}
  }

  const chrome = {
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
    debugger: {
      attach: async () => {
        attachCalls++;
      },
      detach: () => new Promise<void>(resolveDetach => {
        if (options.autoDetach) {
          resolveDetach();
          return;
        }
        detachResolvers.push(resolveDetach);
      }),
      sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) =>
        options.sendDebuggerCommand?.(method, params) ?? {},
      onDetach: {
        addListener(listener: (source: { tabId?: number }) => void) {
          detachListeners.push(listener);
        },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => {
        dynamicCleanupCalls++;
        if (options.failDynamicCleanup) throw new Error("dynamic cleanup failed");
        return [];
      },
      updateDynamicRules: async () => undefined,
      getSessionRules: async () => [],
      updateSessionRules: async () => undefined,
    },
    tabs: {
      query: async (query: { active?: boolean; windowId?: number } = {}) => tabs.filter(tab =>
        (query.active == null || tab.active === query.active)
        && (query.windowId == null || (tab.windowId ?? 1) === query.windowId)
      ),
      get: async (tabId: number) => ({
        ...(() => {
          const tab = tabs.find(candidate => candidate.id === tabId);
          if (!tab) throw new Error(`Tab not found: ${tabId}`);
          return { ...tab, status: "complete", windowId: tab.windowId ?? 1 };
        })(),
      }),
      update: async (tabId: number, update: { active?: boolean }) => {
        await options.tabUpdateGate;
        const tab = tabs.find(candidate => candidate.id === tabId);
        if (update.active && tab) {
          for (const candidate of tabs) {
            if ((candidate.windowId ?? 1) === (tab.windowId ?? 1)) candidate.active = false;
          }
          tab.active = true;
        }
        tabUpdates.push({ tabId, ...update });
        return tab;
      },
      captureVisibleTab: async (windowId: number, captureOptions: Record<string, unknown>) => {
        visibleTabCaptures.push({ windowId, options: captureOptions });
        await options.captureGate;
        if (options.switchToTabIdDuringCapture != null) {
          const switchedTab = tabs.find(tab => tab.id === options.switchToTabIdDuringCapture);
          if (switchedTab) {
            for (const tab of tabs) tab.active = tab.id === switchedTab.id;
          }
        }
        return `data:image/png;base64,${btoa("tile")}`;
      },
      onRemoved: { addListener() {} },
    },
    scripting: {
      executeScript: async ({ func, args = [] }: { func: (...values: any[]) => any; args?: any[] }) => {
        await options.executeScriptGate;
        return [{ result: await func(...args) }];
      },
    },
    webRequest: {
      onCompleted: { addListener() {} },
    },
    webNavigation: {
      onCommitted: { addListener() {} },
      onCompleted: { addListener() {}, removeListener() {} },
      onErrorOccurred: { addListener() {}, removeListener() {} },
      onHistoryStateUpdated: { addListener() {}, removeListener() {} },
      onReferenceFragmentUpdated: { addListener() {}, removeListener() {} },
    },
    runtime: {
      getManifest: () => ({ version: "1.0.0-test" }),
      onMessage: { addListener() {} },
    },
    cookies: {},
    downloads: {},
  };

  const context = vm.createContext({
    AbortController,
    atob,
    Blob,
    btoa,
    chrome,
    console: pageConsole,
    createImageBitmap: async () => ({
      close() {},
      height: options.captureBitmapHeights?.[bitmapIndex++]
        ?? options.captureBitmapHeight
        ?? page.viewportHeight * 2,
      width: page.viewportWidth * 2,
    }),
    crypto: globalThis.crypto,
    document: pageDocument,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    Node: { TEXT_NODE: 3 },
    OffscreenCanvas: FakeOffscreenCanvas,
    requestAnimationFrame(callback: () => void) { callback(); },
    TextEncoder,
    Uint8Array,
    WebSocket: FakeWebSocket,
    window: pageWindow,
    setTimeout: options.immediateTimeouts
      ? (callback: () => void, delay = 0) => {
          timeoutDelays.push(delay);
          if (delay < 10_000) callback();
          else if (remainingCaptureTimeouts > 0) {
            remainingCaptureTimeouts--;
            setImmediate(callback);
          }
          return 1;
        }
      : setTimeout,
    clearTimeout,
    setInterval(callback: () => void) {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval() {},
  });

  const backgroundPath = resolve(import.meta.dir, "../../extension/background.js");
  const source = `${readFileSync(backgroundPath, "utf8")}\n;globalThis.__backgroundTest = {\n    CONNECTION, ensureCleanSession, cleanupMcpSession, networkLogs, consoleLogs,\n    activeToolRequests, dialogOverrideTabs, acquireDebugger, releaseDebugger, debuggerSessions,\n    handleToolRequest, send, toolHandlers\n  };`;
  new vm.Script(source, { filename: backgroundPath }).runInContext(context);

  return {
    api: (context as any).__backgroundTest,
    drawCalls,
    intervals,
    pageConsole,
    pageWindow,
    scrollCalls,
    tabs,
    tabUpdates,
    timeoutDelays,
    visibleTabCaptures,
    emitDetach(tabId: number) {
      for (const listener of detachListeners) listener({ tabId });
    },
    resolveNextDetach() {
      const resolveDetach = detachResolvers.shift();
      if (!resolveDetach) throw new Error("No pending debugger detach");
      resolveDetach();
    },
    get attachCalls() { return attachCalls; },
    get dynamicCleanupCalls() { return dynamicCleanupCalls; },
    get webSocketCalls() { return webSocketCalls; },
  };
}

describe("extension lifecycle", () => {
  test("cleanup failure blocks startup and keepalive reconnects", async () => {
    const harness = createHarness({ failDynamicCleanup: true });
    await flushTasks();

    expect(harness.dynamicCleanupCalls).toBe(1);
    expect(harness.webSocketCalls).toBe(0);
    expect(harness.api.CONNECTION.cleanupReady).toBe(false);

    harness.intervals[0]();
    await flushTasks();
    expect(harness.dynamicCleanupCalls).toBe(2);
    expect(harness.webSocketCalls).toBe(0);
  });

  test("cleanup restores tracked page hooks and discards monitor state", async () => {
    const harness = createHarness({ failDynamicCleanup: true, tabs: [{ id: 7 }] });
    await flushTasks();

    const originalLog = () => undefined;
    const originalAlert = () => undefined;
    const originalConfirm = () => true;
    const originalPrompt = () => "original";
    harness.pageWindow.__mcpConsoleMonitor = {
      entries: ["captured"],
      original: { log: originalLog },
      _errorHandler() {},
      _rejectionHandler() {},
    };
    harness.pageWindow.__mcpDialogHandler = {
      _origAlert: originalAlert,
      _origConfirm: originalConfirm,
      _origPrompt: originalPrompt,
    };
    harness.api.consoleLogs.set(7, { entries: [] });
    harness.api.dialogOverrideTabs.add(7);
    harness.api.networkLogs.set("monitor", { tabId: 7, entries: [] });

    await harness.api.cleanupMcpSession();

    expect(harness.api.consoleLogs.size).toBe(0);
    expect(harness.api.dialogOverrideTabs.size).toBe(0);
    expect(harness.api.networkLogs.size).toBe(0);
    expect(harness.pageConsole.log).toBe(originalLog);
    expect(harness.pageWindow.alert).toBe(originalAlert);
    expect(harness.pageWindow.__mcpConsoleMonitor).toBeNull();
    expect(harness.pageWindow.__mcpDialogHandler).toBeNull();
  });

  test("dialog setup can be reconfigured and still restores native functions", async () => {
    const harness = createHarness({ failDynamicCleanup: true, tabs: [{ id: 7 }] });
    await flushTasks();
    const originalAlert = harness.pageWindow.alert;
    const originalConfirm = harness.pageWindow.confirm;
    const originalPrompt = harness.pageWindow.prompt;

    await harness.api.toolHandlers.manage_dialogs({
      action: "setup",
      autoAccept: true,
      promptText: "first",
      tabId: 7,
    });
    await harness.api.toolHandlers.manage_dialogs({
      action: "setup",
      autoAccept: false,
      promptText: "second",
      tabId: 7,
    });
    expect(harness.pageWindow.confirm("continue?")).toBe(false);
    expect(harness.pageWindow.prompt("value?")).toBeNull();

    await harness.api.toolHandlers.manage_dialogs({ action: "clear", tabId: 7 });
    expect(harness.pageWindow.alert).toBe(originalAlert);
    expect(harness.pageWindow.confirm).toBe(originalConfirm);
    expect(harness.pageWindow.prompt).toBe(originalPrompt);
    expect(harness.pageWindow.confirm("native")).toBe(true);
  });

  test("cleanup drains delayed tool handlers before removing page hooks", async () => {
    let releaseScript = () => {};
    const executeScriptGate = new Promise<void>(resolveScript => {
      releaseScript = resolveScript;
    });
    const harness = createHarness({
      executeScriptGate,
      failDynamicCleanup: true,
      tabs: [{ id: 7 }],
    });
    await flushTasks();

    const setupRequest = harness.api.handleToolRequest({
      params: { action: "setup", autoAccept: true, tabId: 7 },
      requestId: "dialog-setup",
      tool: "manage_dialogs",
    });
    await flushTasks();
    let cleanupFinished = false;
    const cleanup = harness.api.cleanupMcpSession().then(() => {
      cleanupFinished = true;
    });
    await flushTasks();
    expect(cleanupFinished).toBe(false);

    releaseScript();
    await setupRequest;
    await cleanup;
    expect(harness.pageWindow.__mcpDialogHandler).toBeNull();
    expect(harness.api.dialogOverrideTabs.size).toBe(0);
    expect(harness.api.activeToolRequests.size).toBe(0);
  });

  test("accessibility traversal rejects more than 5000 nodes", async () => {
    const harness = createHarness({
      accessibilityChildCount: 5_000,
      failDynamicCleanup: true,
      tabs: [{ id: 7 }],
    });
    await flushTasks();

    await expect(harness.api.toolHandlers.get_accessibility_tree({
      includeHidden: false,
      maxDepth: 1,
      tabId: 7,
    })).rejects.toThrow("5000-node limit");
  });

  test("extension responses enforce the WebSocket payload limit", async () => {
    const harness = createHarness({ failDynamicCleanup: true });
    await flushTasks();
    harness.api.CONNECTION.ws = { readyState: 1, send() {} };

    expect(() => harness.api.send({ value: "x".repeat(32 * 1_048_576) }))
      .toThrow("WebSocket payload limit");
  });

  test("a new debugger generation waits for detach completion", async () => {
    const harness = createHarness({ failDynamicCleanup: true });
    await flushTasks();

    const firstSession = await harness.api.acquireDebugger(11);
    const firstGeneration = firstSession.generation;
    const releasing = harness.api.releaseDebugger(11, firstSession);
    await flushTasks();

    const acquiring = harness.api.acquireDebugger(11);
    await flushTasks();
    expect(harness.attachCalls).toBe(1);

    harness.resolveNextDetach();
    await releasing;
    const secondSession = await acquiring;
    expect(harness.attachCalls).toBe(2);
    expect(secondSession.generation).toBeGreaterThan(firstGeneration);

    const finalRelease = harness.api.releaseDebugger(11, secondSession);
    await flushTasks();
    harness.resolveNextDetach();
    await finalRelease;
  });

  test("full-page screenshots stitch CSS-sized viewport tiles and restore scroll", async () => {
    const harness = createHarness({
      autoDetach: true,
      failDynamicCleanup: true,
      immediateTimeouts: true,
      page: {
        contentHeight: 180,
        contentWidth: 100,
        scrollY: 25,
        viewportHeight: 80,
        viewportWidth: 100,
      },
      tabs: [
        { active: true, id: 3, windowId: 1 },
        { active: false, id: 7, windowId: 1 },
      ],
    });
    await flushTasks();

    const result = await harness.api.toolHandlers.take_screenshot({
      format: "png",
      fullPage: true,
      tabId: 7,
    });

    expect(result.dimensions).toEqual({ width: 100, height: 180 });
    expect(result.image).toBe(btoa("stitched"));
    expect(harness.visibleTabCaptures).toEqual([
      { windowId: 1, options: { format: "png" } },
      { windowId: 1, options: { format: "png" } },
      { windowId: 1, options: { format: "png" } },
    ]);
    expect(harness.tabUpdates).toEqual([
      { tabId: 7, active: true },
      { tabId: 3, active: true },
    ]);
    expect(harness.drawCalls).toHaveLength(3);
    expect(harness.scrollCalls).toEqual([
      { left: 0, top: 0 },
      { left: 0, top: 80 },
      { left: 0, top: 100 },
      { left: 0, top: 25 },
    ]);
  });

  test("full-page screenshots adapt when visible capture height changes", async () => {
    const harness = createHarness({
      autoDetach: true,
      captureBitmapHeights: [120, 160, 160],
      failDynamicCleanup: true,
      immediateTimeouts: true,
      page: {
        contentHeight: 180,
        contentWidth: 100,
        scrollY: 25,
        viewportHeight: 80,
        viewportWidth: 100,
      },
      tabs: [{ active: true, id: 7, windowId: 1 }],
    });
    await flushTasks();

    await harness.api.toolHandlers.take_screenshot({
      format: "png",
      fullPage: true,
      tabId: 7,
    });

    expect(harness.drawCalls.map(call => ({
      destinationHeight: call[8],
      destinationY: call[6],
    }))).toEqual([
      { destinationHeight: 60, destinationY: 0 },
      { destinationHeight: 80, destinationY: 60 },
      { destinationHeight: 80, destinationY: 100 },
    ]);
    expect(harness.scrollCalls).toEqual([
      { left: 0, top: 0 },
      { left: 0, top: 60 },
      { left: 0, top: 100 },
      { left: 0, top: 25 },
    ]);
  });

  test("screenshots reject a tab switch during capture and restore the previous tab", async () => {
    const harness = createHarness({
      autoDetach: true,
      failDynamicCleanup: true,
      immediateTimeouts: true,
      switchToTabIdDuringCapture: 3,
      tabs: [
        { active: true, id: 3, windowId: 1 },
        { active: false, id: 7, windowId: 1 },
      ],
    });
    await flushTasks();

    await expect(harness.api.toolHandlers.take_screenshot({
      format: "png",
      tabId: 7,
    })).rejects.toThrow("active tab changed");
    expect(harness.tabs.find(tab => tab.id === 3)?.active).toBe(true);
  });

  test("screenshots restore an initially active target after a tab switch", async () => {
    const harness = createHarness({
      autoDetach: true,
      failDynamicCleanup: true,
      immediateTimeouts: true,
      switchToTabIdDuringCapture: 3,
      tabs: [
        { active: false, id: 3, windowId: 1 },
        { active: true, id: 7, windowId: 1 },
      ],
    });
    await flushTasks();

    await expect(harness.api.toolHandlers.take_screenshot({
      format: "png",
      tabId: 7,
    })).rejects.toThrow("active tab changed");
    expect(harness.tabs.find(tab => tab.id === 7)?.active).toBe(true);
  });

  test("a stale tab does not block the next screenshot", async () => {
    const harness = createHarness({
      autoDetach: true,
      failDynamicCleanup: true,
      immediateTimeouts: true,
      tabs: [{ active: true, id: 7, windowId: 1 }],
    });
    await flushTasks();

    await expect(harness.api.toolHandlers.take_screenshot({
      format: "png",
      tabId: 999,
    })).rejects.toThrow("Tab not found");
    const result = await harness.api.toolHandlers.take_screenshot({ format: "png", tabId: 7 });
    expect(result.dimensions).toEqual({ width: 1200, height: 800 });
  });

  test("a queued screenshot times out without bypassing the active capture", async () => {
    let releaseCapture = () => {};
    const captureGate = new Promise<void>(resolveCapture => {
      releaseCapture = resolveCapture;
    });
    const harness = createHarness({
      autoDetach: true,
      captureGate,
      failDynamicCleanup: true,
      immediateTimeouts: true,
      tabs: [{ active: true, id: 7, windowId: 1 }],
    });
    await flushTasks();

    const firstCapture = harness.api.toolHandlers.take_screenshot({ format: "png", tabId: 7 });
    await flushTasks();
    await expect(harness.api.toolHandlers.take_screenshot({
      format: "png",
      tabId: 7,
    })).rejects.toThrow("queue is busy");
    expect(harness.visibleTabCaptures).toHaveLength(1);

    releaseCapture();
    await firstCapture;
    await harness.api.toolHandlers.take_screenshot({ format: "png", tabId: 7 });
    expect(harness.visibleTabCaptures).toHaveLength(2);
  });

  test("an in-flight screenshot timeout releases the queue", async () => {
    let releaseCapture = () => {};
    const captureGate = new Promise<void>(resolveCapture => {
      releaseCapture = resolveCapture;
    });
    const harness = createHarness({
      autoDetach: true,
      captureGate,
      failDynamicCleanup: true,
      immediateCaptureTimeouts: 1,
      immediateTimeouts: true,
      tabs: [{ active: true, id: 7, windowId: 1 }],
    });
    await flushTasks();

    await expect(harness.api.toolHandlers.take_screenshot({
      format: "png",
      tabId: 7,
    })).rejects.toThrow("capture timed out");
    expect(harness.visibleTabCaptures).toHaveLength(1);

    releaseCapture();
    const result = await harness.api.toolHandlers.take_screenshot({ format: "png", tabId: 7 });
    expect(result.dimensions).toEqual({ width: 1200, height: 800 });
    expect(harness.visibleTabCaptures).toHaveLength(2);
    expect(harness.timeoutDelays.some(delay => delay > 0 && delay <= 550)).toBe(true);
  });

  test("a timed-out tab activation stays fenced until final restoration", async () => {
    let releaseTabUpdate = () => {};
    const tabUpdateGate = new Promise<void>(resolveUpdate => {
      releaseTabUpdate = resolveUpdate;
    });
    const harness = createHarness({
      autoDetach: true,
      failDynamicCleanup: true,
      immediateCaptureTimeouts: 1,
      immediateTimeouts: true,
      tabUpdateGate,
      tabs: [
        { active: true, id: 3, windowId: 1 },
        { active: false, id: 7, windowId: 1 },
      ],
    });
    await flushTasks();

    const timedOutCapture = harness.api.toolHandlers.take_screenshot({ format: "png", tabId: 7 });
    await flushTasks();
    await flushTasks();
    await expect(harness.api.toolHandlers.take_screenshot({
      format: "png",
      tabId: 7,
    })).rejects.toThrow("queue is busy");
    expect(harness.visibleTabCaptures).toHaveLength(0);

    releaseTabUpdate();
    await expect(timedOutCapture).rejects.toThrow("capture timed out");
    expect(harness.tabs.find(tab => tab.id === 3)?.active).toBe(true);

    const result = await harness.api.toolHandlers.take_screenshot({ format: "png", tabId: 7 });
    expect(result.dimensions).toEqual({ width: 1200, height: 800 });
  });

  test("screenshots bound tile work and restore scroll on rejection", async () => {
    const harness = createHarness({
      autoDetach: true,
      captureBitmapHeight: 2,
      failDynamicCleanup: true,
      immediateTimeouts: true,
      page: {
        contentHeight: 180,
        contentWidth: 100,
        scrollY: 25,
        viewportHeight: 80,
        viewportWidth: 100,
      },
      tabs: [{ active: true, id: 7, windowId: 1 }],
    });
    await flushTasks();

    await expect(harness.api.toolHandlers.take_screenshot({
      format: "png",
      fullPage: true,
      tabId: 7,
    })).rejects.toThrow("more than 64 viewport tiles");
    expect(harness.visibleTabCaptures).toHaveLength(64);
    expect(harness.scrollCalls.at(-1)).toEqual({ left: 0, top: 25 });
  });
});
