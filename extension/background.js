// ─── WebSocket Connection Manager ────────────────────────────────────
const CONNECTION = {
  ws: null,
  url: "ws://localhost:3001",
  authenticated: false,
  authContext: null,
  capabilities: [],
  authError: null,
  pairingRequired: false,
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,
  backoffMultiplier: 2,
  reconnectTimer: null,
  isConnecting: false,
  cleanupReady: false,
  cleanupPromise: null,
  limits: {
    maxScreenshotDimension: 4096,
    maxScreenshotPayloadBytes: 24 * 1_048_576,
  },
};

const PAIRING_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1_048_576;

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(byte => Number.parseInt(byte, 16)));
}

async function createPairingProof(token, role, serverNonce, extensionNonce, confirmationNonce) {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const confirmationContext = confirmationNonce ? `:${confirmationNonce}` : "";
  const payload = new TextEncoder().encode(
    `alloy-mcp-v1:${role}:${serverNonce}:${extensionNonce}${confirmationContext}`
  );
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

function proofsMatch(actual, expected) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) {
    difference |= (actual.codePointAt(index) ?? 0) ^ (expected.codePointAt(index) ?? 0);
  }
  return difference === 0;
}

async function getBrowserId() {
  const stored = await chrome.storage.local.get("browserId");
  if (stored.browserId) return stored.browserId;

  const browserId = crypto.randomUUID();
  await chrome.storage.local.set({ browserId });
  return browserId;
}

async function answerAuthChallenge(serverNonce, requestedCapabilities, requestedLimits) {
  if (typeof serverNonce !== "string" || !/^[a-f0-9]{64}$/i.test(serverNonce)) {
    throw new Error("Invalid server authentication challenge");
  }

  const stored = await chrome.storage.local.get("pairingToken");
  const pairingToken = stored.pairingToken?.trim().toLowerCase();
  if (!pairingToken || !PAIRING_TOKEN_PATTERN.test(pairingToken)) {
    CONNECTION.pairingRequired = true;
    CONNECTION.authError = "Pairing token required";
    updateBadge("PAIR", "#B26A00");
    CONNECTION.ws?.close(4005, "Pairing token required");
    return;
  }

  const extensionNonce = randomHex(32);
  CONNECTION.limits = {
    maxScreenshotDimension: Number.isInteger(requestedLimits?.maxScreenshotDimension)
      ? Math.min(4096, Math.max(1, requestedLimits.maxScreenshotDimension))
      : 4096,
    maxScreenshotPayloadBytes: Number.isInteger(requestedLimits?.maxScreenshotPayloadBytes)
      ? Math.min(24 * 1_048_576, Math.max(1, requestedLimits.maxScreenshotPayloadBytes))
      : 24 * 1_048_576,
  };
  const proof = await createPairingProof(
    pairingToken,
    "extension",
    serverNonce,
    extensionNonce
  );
  CONNECTION.authContext = { pairingToken, serverNonce, extensionNonce };
  const capabilities = Array.isArray(requestedCapabilities)
    ? requestedCapabilities.filter(name => typeof toolHandlers[name] === "function")
    : Object.keys(toolHandlers);
  CONNECTION.capabilities = capabilities;
  send({
    type: "handshake",
    version: chrome.runtime.getManifest().version,
    capabilities,
    browserId: await getBrowserId(),
    extensionNonce,
    proof,
  });
}

async function finishAuthentication(proof, confirmationNonce) {
  const context = CONNECTION.authContext;
  if (!context) throw new Error("Unexpected server authentication response");
  if (typeof confirmationNonce !== "string" || !/^[a-f0-9]{64}$/i.test(confirmationNonce)) {
    throw new Error("Invalid authentication confirmation challenge");
  }

  const expectedProof = await createPairingProof(
    context.pairingToken,
    "server",
    context.serverNonce,
    context.extensionNonce,
    confirmationNonce
  );
  if (!proofsMatch(proof, expectedProof)) {
    CONNECTION.pairingRequired = true;
    throw new Error("Server authentication failed");
  }

  const confirmationProof = await createPairingProof(
    context.pairingToken,
    "extension-confirmation",
    context.serverNonce,
    context.extensionNonce,
    confirmationNonce
  );
  context.serverVerified = true;
  send({ type: "handshake_complete", proof: confirmationProof, timestamp: Date.now() });
}

function markAuthenticationReady() {
  if (!CONNECTION.authContext?.serverVerified) {
    throw new Error("Unexpected authentication-ready message");
  }

  CONNECTION.authenticated = true;
  CONNECTION.authContext = null;
  CONNECTION.authError = null;
  CONNECTION.pairingRequired = false;
  CONNECTION.reconnectAttempts = 0;
  updateBadge("ON", "#2E7D32");
  console.log("[MCP] Authenticated with server");
}

function connect() {
  if (!CONNECTION.cleanupReady) return;
  if (CONNECTION.isConnecting || CONNECTION.ws?.readyState === WebSocket.OPEN) {
    return;
  }

  CONNECTION.isConnecting = true;

  try {
    CONNECTION.ws = new WebSocket(CONNECTION.url);

    CONNECTION.ws.onopen = () => {
      console.log("[MCP] WebSocket connected; authenticating");
      CONNECTION.isConnecting = false;
      CONNECTION.authenticated = false;
      CONNECTION.authContext = null;
      updateBadge("...", "#616161");
    };

    CONNECTION.ws.onmessage = async (event) => {
      try {
        await handleMessage(JSON.parse(event.data));
      } catch (error) {
        CONNECTION.authError = error.message;
        console.error("[MCP] Protocol error", error);
        CONNECTION.ws?.close(4004, "Authentication failed");
      }
    };

    CONNECTION.ws.onclose = async (event) => {
      console.log("[MCP] Disconnected");
      CONNECTION.ws = null;
      CONNECTION.isConnecting = false;
      CONNECTION.authenticated = false;
      CONNECTION.authContext = null;
      CONNECTION.capabilities = [];
      CONNECTION.cleanupReady = false;
      clearTimeout(CONNECTION.reconnectTimer);
      CONNECTION.reconnectTimer = null;
      if (event.code === 4004) {
        CONNECTION.pairingRequired = true;
        CONNECTION.authError = "Pairing token does not match";
      }
      updateBadge(CONNECTION.pairingRequired ? "PAIR" : "OFF", CONNECTION.pairingRequired ? "#B26A00" : "#C62828");
      try {
        await ensureCleanSession();
        scheduleReconnect();
      } catch (error) {
        CONNECTION.authError = `Session cleanup failed: ${error.message}`;
        updateBadge("ERR", "#C62828");
        console.error("[MCP] Session cleanup failed", error);
      }
    };

    CONNECTION.ws.onerror = (err) => {
      console.error("[MCP] WebSocket error", err);
      CONNECTION.isConnecting = false;
    };
  } catch (error) {
    CONNECTION.authError = error instanceof Error ? error.message : String(error);
    console.error("[MCP] Could not create WebSocket", error);
    CONNECTION.isConnecting = false;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!CONNECTION.cleanupReady) return;
  if (CONNECTION.pairingRequired) return;
  if (CONNECTION.reconnectAttempts >= CONNECTION.maxReconnectAttempts) {
    console.log("[MCP] Max reconnect attempts reached");
    return;
  }

  const delay = Math.min(
    1000 * Math.pow(CONNECTION.backoffMultiplier, CONNECTION.reconnectAttempts),
    30000
  );
  CONNECTION.reconnectAttempts++;
  console.log(`[MCP] Reconnecting in ${delay}ms (attempt ${CONNECTION.reconnectAttempts})`);

  clearTimeout(CONNECTION.reconnectTimer);
  CONNECTION.reconnectTimer = setTimeout(() => {
    CONNECTION.reconnectTimer = null;
    connect();
  }, delay);
}

function send(data) {
  if (CONNECTION.ws?.readyState === WebSocket.OPEN) {
    const serialized = JSON.stringify(data);
    if (new TextEncoder().encode(serialized).byteLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
      throw new Error("Extension response exceeds the WebSocket payload limit");
    }
    CONNECTION.ws.send(serialized);
  }
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Enhanced Keyboard Event Helper Functions ─────────────────────────
// Key code mapping for virtual key codes
function getKeyCode(key) {
  const keyCodes = {
    // Letters
    'a': 65, 'b': 66, 'c': 67, 'd': 68, 'e': 69, 'f': 70, 'g': 71, 'h': 72,
    'i': 73, 'j': 74, 'k': 75, 'l': 76, 'm': 77, 'n': 78, 'o': 79, 'p': 80,
    'q': 81, 'r': 82, 's': 83, 't': 84, 'u': 85, 'v': 86, 'w': 87, 'x': 88,
    'y': 89, 'z': 90,

    // Numbers
    '0': 48, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53, '6': 54, '7': 55,
    '8': 56, '9': 57,

    // Function keys
    'F1': 112, 'F2': 113, 'F3': 114, 'F4': 115, 'F5': 116, 'F6': 117,
    'F7': 118, 'F8': 119, 'F9': 120, 'F10': 121, 'F11': 122, 'F12': 123,

    // Arrow keys
    'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40,

    // Special keys
    'Enter': 13, 'Return': 13, 'Tab': 9, 'Escape': 27, 'Esc': 27,
    'Backspace': 8, 'Delete': 46, 'Insert': 45, 'Home': 36, 'End': 35,
    'PageUp': 33, 'PageDown': 34, 'Space': 32, ' ': 32,

    // Modifier keys
    'Shift': 16, 'Control': 17, 'Alt': 18, 'Meta': 91, 'Cmd': 91, 'Win': 91,

    // Punctuation
    ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191,
    '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222,
  };

  return keyCodes[key] || keyCodes[key.toLowerCase()] || 0;
}

// Convert modifier flags to Chrome debugger bitmask
function getModifierFlags(modifiers) {
  let flags = 0;
  if (modifiers.alt) flags |= 1;      // Alt
  if (modifiers.ctrl) flags |= 2;     // Ctrl
  if (modifiers.meta) flags |= 4;     // Cmd/Meta
  if (modifiers.shift) flags |= 8;    // Shift
  return flags;
}

// Get the proper key code name for Chrome debugger
function getKeyCodeName(key) {
  const codeNames = {
    // Arrow keys
    'ArrowLeft': 'ArrowLeft', 'ArrowUp': 'ArrowUp',
    'ArrowRight': 'ArrowRight', 'ArrowDown': 'ArrowDown',

    // Function keys
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
    'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',

    // Special keys
    'Enter': 'Enter', 'Tab': 'Tab', 'Escape': 'Escape', 'Backspace': 'Backspace',
    'Delete': 'Delete', 'Insert': 'Insert', 'Home': 'Home', 'End': 'End',
    'PageUp': 'PageUp', 'PageDown': 'PageDown', 'Space': 'Space', ' ': 'Space',

    // Modifier keys
    'Shift': 'ShiftLeft', 'Control': 'ControlLeft', 'Alt': 'AltLeft',
    'Meta': 'MetaLeft', 'Cmd': 'MetaLeft', 'Win': 'MetaLeft'
  };

  // Single characters get Key prefix
  if (key.length === 1 && /[a-zA-Z]/.test(key)) {
    return `Key${key.toUpperCase()}`;
  }

  if (key.length === 1 && /\d/.test(key)) {
    return `Digit${key}`;
  }

  return codeNames[key] || key;
}

// ─── Message Router ──────────────────────────────────────────────────
async function handleMessage(msg) {
  if (msg.type === "auth_challenge") {
    await answerAuthChallenge(msg.serverNonce, msg.requestedCapabilities, msg.limits);
    return;
  }

  if (msg.type === "handshake_ack") {
    await finishAuthentication(msg.proof, msg.confirmationNonce);
    return;
  }

  if (msg.type === "auth_ready") {
    markAuthenticationReady();
    return;
  }

  if (!CONNECTION.authenticated) return;

  if (msg.type === "ping") {
    send({ type: "pong", timestamp: Date.now() });
    return;
  }

  if (msg.requestId && msg.tool) {
    handleToolRequest(msg);
  }

}

const activeToolRequests = new Set();

function handleToolRequest(msg) {
  const request = executeToolRequest(msg);
  activeToolRequests.add(request);
  void request.then(
    () => activeToolRequests.delete(request),
    () => activeToolRequests.delete(request)
  );
  return request;
}

async function executeToolRequest(msg) {
  const { requestId, tool, params } = msg;
  const handler = toolHandlers[tool];

  if (!handler) {
    send({ requestId, error: { code: 1100, message: `Unknown tool: ${tool}` }, timestamp: Date.now() });
    return;
  }

  try {
    const result = await handler(params);
    send({ requestId, result, timestamp: Date.now() });
  } catch (err) {
    send({
      requestId,
      error: { code: 1303, message: err.message, details: err.stack },
      timestamp: Date.now(),
    });
  }
}

// ─── Helper: Get target tab ─────────────────────────────────────────
async function getTabId(params) {
  if (params.tabId) return params.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

// ─── Helper: Execute in content script ──────────────────────────────
async function execInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (results?.[0]) {
    if (results[0].error) throw new Error(results[0].error.message);
    return results[0].result;
  }
  return null;
}

async function execInMainWorld(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  if (results?.[0]) {
    if (results[0].error) throw new Error(results[0].error.message);
    return results[0].result;
  }
  return null;
}

function clearConsoleMonitor(tabId) {
  return execInMainWorld(tabId, () => {
    if (!window.__mcpConsoleMonitor) return [];
    const entries = window.__mcpConsoleMonitor.entries;
    Object.entries(window.__mcpConsoleMonitor.original).forEach(([level, fn]) => {
      console[level] = fn;
    });
    window.removeEventListener('error', window.__mcpConsoleMonitor._errorHandler);
    window.removeEventListener('unhandledrejection', window.__mcpConsoleMonitor._rejectionHandler);
    window.__mcpConsoleMonitor = null;
    return entries;
  });
}

function clearDialogHandler(tabId) {
  return execInMainWorld(tabId, () => {
    if (!window.__mcpDialogHandler) return false;
    window.alert = window.__mcpDialogHandler._origAlert;
    window.confirm = window.__mcpDialogHandler._origConfirm;
    window.prompt = window.__mcpDialogHandler._origPrompt;
    window.__mcpDialogHandler = null;
    return true;
  });
}

const debuggerSessions = new Map();
let debuggerGeneration = 0;

function createDebuggerSession(tabId) {
  const session = {
    generation: ++debuggerGeneration,
    state: "attaching",
    activeLeases: 0,
    persistentOverrides: new Set(),
    detachPromise: null,
    detached: false,
  };
  session.attachPromise = chrome.debugger.attach({ tabId }, "1.3").then(() => {
    if (session.state === "attaching") session.state = "attached";
  });
  return session;
}

async function acquireDebugger(tabId) {
  while (true) {
    let session = debuggerSessions.get(tabId);
    if (session?.detachPromise) {
      await session.detachPromise;
      continue;
    }

    if (!session) {
      session = createDebuggerSession(tabId);
      debuggerSessions.set(tabId, session);
    }

    try {
      await session.attachPromise;
      if (debuggerSessions.get(tabId) !== session || session.state !== "attached") {
        throw new Error("Debugger detached while it was being acquired");
      }
      session.activeLeases++;
      return session;
    } catch (error) {
      if (debuggerSessions.get(tabId) === session) debuggerSessions.delete(tabId);
      throw error;
    }
  }
}

async function detachDebuggerSession(tabId, session) {
  if (session.detachPromise) return session.detachPromise;

  session.state = "detaching";
  const detachPromise = (async () => {
    try {
      await session.attachPromise;
    } catch {
      if (debuggerSessions.get(tabId) === session) debuggerSessions.delete(tabId);
      return;
    }

    if (!session.detached) {
      try {
        await chrome.debugger.detach({ tabId });
        session.detached = true;
      } catch (error) {
        if (!session.detached) throw error;
      }
    }

    session.state = "detached";
    if (debuggerSessions.get(tabId) === session) debuggerSessions.delete(tabId);
  })();
  session.detachPromise = detachPromise;

  try {
    await detachPromise;
  } catch (error) {
    if (session.detachPromise === detachPromise) session.detachPromise = null;
    if (!session.detached) session.state = "attached";
    throw error;
  }
}

async function releaseDebugger(tabId, session) {
  session.activeLeases = Math.max(0, session.activeLeases - 1);
  if (
    debuggerSessions.get(tabId) !== session
    || session.activeLeases > 0
    || session.persistentOverrides.size > 0
  ) return;
  await detachDebuggerSession(tabId, session);
}

async function withDebugger(tabId, callback) {
  const session = await acquireDebugger(tabId);
  try {
    return await callback();
  } finally {
    await releaseDebugger(tabId, session);
  }
}

async function evaluateRuntime(tabId, expression) {
  const response = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || "JavaScript evaluation failed";
    throw new Error(description);
  }
  return response.result;
}

function evaluateWithDebugger(tabId, expression) {
  return withDebugger(tabId, () => evaluateRuntime(tabId, expression));
}

async function setPersistentDebuggerOverride(tabId, name, callback) {
  const session = await acquireDebugger(tabId);
  try {
    const result = await callback();
    session.persistentOverrides.add(name);
    return result;
  } finally {
    await releaseDebugger(tabId, session);
  }
}

async function clearPersistentDebuggerOverride(tabId, name, callback) {
  const session = await acquireDebugger(tabId);
  try {
    const result = await callback();
    session.persistentOverrides.delete(name);
    return result;
  } finally {
    await releaseDebugger(tabId, session);
  }
}

async function getElementCenter(tabId, selector) {
  return execInTab(tabId, (targetSelector) => {
    const element = document.querySelector(targetSelector);
    if (!element) throw new Error(`Element not found: ${targetSelector}`);
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      rect.width <= 0
      || rect.height <= 0
      || style.display === "none"
      || style.visibility === "hidden"
      || style.pointerEvents === "none"
    ) {
      throw new Error(`Element is not interactable: ${targetSelector}`);
    }
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }, [selector]);
}

async function dispatchMouseClick(tabId, selector, button = "left") {
  const point = await getElementCenter(tabId, selector);
  await withDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button,
      clickCount: 1,
    });
  });
  return point;
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  const session = debuggerSessions.get(source.tabId);
  if (!session) return;

  session.detached = true;
  if (session.state !== "detaching" && debuggerSessions.get(source.tabId) === session) {
    session.state = "detached";
    debuggerSessions.delete(source.tabId);
  }
});

// ─── Network Monitoring State ───────────────────────────────────────
const networkLogs = new Map(); // monitoringId -> { tabId, entries[], startTime }

// ─── Console Monitoring State ───────────────────────────────────────
const consoleLogs = new Map(); // tabId -> { entries[], maxEntries, levels, includeStackTraces }
const dialogOverrideTabs = new Set();
let visibleTabCaptureQueue = Promise.resolve();
let lastVisibleTabCapture = 0;
const MAX_SCREENSHOT_TILES = 64;
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 45_000;
const SCREENSHOT_QUEUE_TIMEOUT_MS = 5_000;

function waitForScreenshotOperation(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error("Screenshot capture timed out"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const handleAbort = () => finish(reject, new Error("Screenshot capture timed out"));
    signal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

function decodeBase64(encoded) {
  const separator = encoded.indexOf(",");
  const binary = atob(separator >= 0 ? encoded.slice(separator + 1) : encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}

function encodeBase64(bytes) {
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCodePoint(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

async function getScreenshotPage(tabId) {
  return execInTab(tabId, () => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    contentWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0
    ),
    contentHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0
    ),
  }));
}

async function getScreenshotRegion(tabId, params, page) {
  if (params.selector) {
    return execInTab(tabId, (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Element not found: ${selector}`);
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        throw new Error(`Element is not visible: ${selector}`);
      }
      return {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    }, [params.selector]);
  }

  if (params.fullPage) {
    return {
      x: 0,
      y: 0,
      width: page.contentWidth,
      height: page.contentHeight,
    };
  }

  return {
    x: page.scrollX,
    y: page.scrollY,
    width: page.viewportWidth,
    height: page.viewportHeight,
  };
}

async function scrollScreenshotPage(tabId, x, y, captureContext, allowAfterAbort = false) {
  if (!allowAfterAbort && captureContext?.signal.aborted) {
    throw new Error("Screenshot capture timed out");
  }
  const scrolling = execInTab(tabId, async (left, top) => {
    window.scrollTo({ left, top, behavior: "instant" });
    await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
    await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
    return {
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }, [x, y]);
  const trackedScrolling = captureContext
    ? captureContext.trackMutation(scrolling)
    : scrolling;
  return waitForScreenshotOperation(
    trackedScrolling,
    allowAfterAbort ? undefined : captureContext?.signal
  );
}

async function getActiveTabId(windowId) {
  return (await chrome.tabs.query({ active: true, windowId }))[0]?.id;
}

async function captureScreenshotBitmap(tabId, windowId, captureContext) {
  const { signal } = captureContext;
  if (signal.aborted) throw new Error("Screenshot capture timed out");
  const wait = Math.max(0, 550 - (Date.now() - lastVisibleTabCapture));
  if (wait > 0) {
    await waitForScreenshotOperation(
      new Promise(resolveWait => setTimeout(resolveWait, wait)),
      signal
    );
  }

  if (await waitForScreenshotOperation(getActiveTabId(windowId), signal) !== tabId) {
    await waitForScreenshotOperation(
      captureContext.trackMutation(chrome.tabs.update(tabId, { active: true })),
      signal
    );
  }
  if (await waitForScreenshotOperation(getActiveTabId(windowId), signal) !== tabId) {
    throw new Error("Could not activate the target tab for screenshot capture");
  }

  lastVisibleTabCapture = Date.now();
  const capture = await waitForScreenshotOperation(
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
    signal
  );
  if (await waitForScreenshotOperation(getActiveTabId(windowId), signal) !== tabId) {
    throw new Error("The active tab changed during screenshot capture");
  }
  return waitForScreenshotOperation(
    createImageBitmap(new Blob([decodeBase64(capture)], { type: "image/png" })),
    signal
  );
}

function drawScreenshotTile(context, bitmap, region, dimensions, viewport) {
  const left = Math.max(region.x, viewport.x);
  const top = Math.max(region.y, viewport.y);
  const right = Math.min(region.x + region.width, viewport.x + viewport.width);
  const bottom = Math.min(region.y + region.height, viewport.y + viewport.height);
  if (right <= left || bottom <= top) return;

  const sourceScaleX = bitmap.width / viewport.width;
  const sourceScaleY = bitmap.height / viewport.height;
  const outputScaleX = dimensions.width / region.width;
  const outputScaleY = dimensions.height / region.height;
  context.drawImage(
    bitmap,
    (left - viewport.x) * sourceScaleX,
    (top - viewport.y) * sourceScaleY,
    (right - left) * sourceScaleX,
    (bottom - top) * sourceScaleY,
    (left - region.x) * outputScaleX,
    (top - region.y) * outputScaleY,
    (right - left) * outputScaleX,
    (bottom - top) * outputScaleY
  );
}

async function captureAndDrawScreenshotTile(
  tabId,
  windowId,
  context,
  region,
  dimensions,
  position,
  captureContext
) {
  const viewport = await scrollScreenshotPage(
    tabId,
    position.x,
    position.y,
    captureContext
  );
  const bitmap = await captureScreenshotBitmap(tabId, windowId, captureContext);
  try {
    const sourceScale = bitmap.width / viewport.width;
    if (!Number.isFinite(sourceScale) || sourceScale <= 0) {
      throw new Error("Screenshot returned invalid viewport dimensions");
    }
    const capturedViewport = {
      ...viewport,
      width: bitmap.width / sourceScale,
      height: bitmap.height / sourceScale,
    };
    drawScreenshotTile(context, bitmap, region, dimensions, capturedViewport);
    return capturedViewport;
  } finally {
    bitmap.close();
  }
}

async function stitchScreenshot(tabId, windowId, region, dimensions, page, captureContext) {
  if (captureContext.signal.aborted) throw new Error("Screenshot capture timed out");
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Screenshot canvas is unavailable");

  const right = region.x + region.width;
  const bottom = region.y + region.height;
  const deadline = Date.now() + SCREENSHOT_CAPTURE_TIMEOUT_MS;
  let tileCount = 0;
  let y = region.y;

  try {
    while (y < bottom) {
      if (captureContext.signal.aborted) throw new Error("Screenshot capture timed out");
      let x = region.x;
      let nextY = Infinity;
      while (x < right) {
        tileCount++;
        if (tileCount > MAX_SCREENSHOT_TILES || Date.now() >= deadline) {
          throw new Error(
            `Screenshot requires more than ${MAX_SCREENSHOT_TILES} viewport tiles or exceeded the capture deadline`
          );
        }
        const viewport = await captureAndDrawScreenshotTile(
          tabId,
          windowId,
          context,
          region,
          dimensions,
          { x, y },
          captureContext
        );
        const viewportRight = viewport.x + viewport.width;
        const viewportBottom = viewport.y + viewport.height;
        if (viewportRight <= x || viewportBottom <= y) {
          throw new Error("Screenshot viewport did not advance during capture");
        }
        x = viewportRight;
        nextY = Math.min(nextY, viewportBottom);
      }
      y = nextY;
    }
  } finally {
    await captureContext.drainMutations();
    await captureContext.restorePage?.();
  }

  return canvas;
}

async function withVisibleTab(tabId, callback) {
  const previousCapture = visibleTabCaptureQueue;
  let releaseCapture;
  const captureComplete = new Promise(resolveRelease => {
    releaseCapture = resolveRelease;
  });
  visibleTabCaptureQueue = previousCapture.then(
    () => captureComplete,
    () => captureComplete
  );

  let activeTab;
  let tab;
  let queueTimer;
  const captureController = new AbortController();
  const pendingMutations = new Set();
  const captureContext = {
    signal: captureController.signal,
    pageRestored: false,
    restorePage: null,
    trackMutation(operation) {
      const tracked = Promise.resolve(operation);
      pendingMutations.add(tracked);
      void tracked.then(
        () => pendingMutations.delete(tracked),
        () => pendingMutations.delete(tracked)
      );
      return tracked;
    },
    async drainMutations() {
      while (pendingMutations.size > 0) {
        await Promise.allSettled(Array.from(pendingMutations));
        await Promise.resolve();
      }
    },
  };
  try {
    await Promise.race([
      previousCapture,
      new Promise((_, reject) => {
        queueTimer = setTimeout(
          () => reject(new Error("Screenshot capture queue is busy")),
          SCREENSHOT_QUEUE_TIMEOUT_MS
        );
      }),
    ]);
    clearTimeout(queueTimer);
    let captureTimer;
    const timeoutPromise = new Promise((_, reject) => {
      captureTimer = setTimeout(() => {
        captureController.abort();
        reject(new Error("Screenshot capture timed out"));
      }, SCREENSHOT_CAPTURE_TIMEOUT_MS);
    });
    const capturePromise = Promise.resolve().then(async () => {
      tab = await waitForScreenshotOperation(chrome.tabs.get(tabId), captureController.signal);
      activeTab = await waitForScreenshotOperation(
        chrome.tabs.query({ active: true, windowId: tab.windowId }).then(tabs => tabs[0]),
        captureController.signal
      );
      return callback(tab.windowId, captureContext);
    });
    try {
      return await Promise.race([capturePromise, timeoutPromise]);
    } finally {
      clearTimeout(captureTimer);
    }
  } finally {
    captureController.abort();
    clearTimeout(queueTimer);
    await captureContext.drainMutations();
    if (captureContext.restorePage && !captureContext.pageRestored) {
      try {
        await captureContext.restorePage();
        await captureContext.drainMutations();
      } catch {
        // The target tab may have closed during capture.
      }
    }
    if (tab && activeTab?.id != null) {
      try {
        await chrome.tabs.update(activeTab.id, { active: true });
      } catch {
        // The previously active tab may have closed during capture.
      }
    }
    releaseCapture();
  }
}

async function encodeScreenshot(canvas, format, quality) {
  const blob = await canvas.convertToBlob({
    type: `image/${format}`,
    ...(format === "jpeg" ? { quality: quality / 100 } : {}),
  });
  return encodeBase64(new Uint8Array(await blob.arrayBuffer()));
}

// ─── Tool Handlers ──────────────────────────────────────────────────
const toolHandlers = {
  // ── Navigation ──────────────────────────────────────────────────
  async navigate(params) {
    const tabId = await getTabId(params);
    const start = Date.now();
    if (params.waitForLoad !== false) {
      await runNavigationAndWait(tabId, () => chrome.tabs.update(tabId, { url: params.url }));
    } else {
      await chrome.tabs.update(tabId, { url: params.url });
    }
    const tab = await chrome.tabs.get(tabId);
    return { success: true, finalUrl: tab.url, title: tab.title, loadTime: Date.now() - start };
  },

  async create_tab(params) {
    const tab = await chrome.tabs.create({
      url: params.url || "about:blank",
      active: params.active !== false,
      windowId: params.windowId,
    });
    return { tabId: tab.id, url: tab.url, title: tab.title };
  },

  async close_tab(params) {
    await chrome.tabs.remove(params.tabId);
    return { success: true };
  },

  async list_tabs(params) {
    const query = {};
    if (params.windowId) query.windowId = params.windowId;
    if (params.activeOnly) query.active = true;
    const tabs = await chrome.tabs.query(query);
    return tabs.map((t) => ({
      tabId: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId,
      favIconUrl: t.favIconUrl,
    }));
  },

  async switch_tab(params) {
    await chrome.tabs.update(params.tabId, { active: true });
    const tab = await chrome.tabs.get(params.tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    return { success: true, tabId: params.tabId };
  },

  async go_back(params) {
    const tabId = await getTabId(params);
    await runNavigationAndWait(tabId, () => chrome.tabs.goBack(tabId));
    const tab = await chrome.tabs.get(tabId);
    return { success: true, url: tab.url };
  },

  async go_forward(params) {
    const tabId = await getTabId(params);
    await runNavigationAndWait(tabId, () => chrome.tabs.goForward(tabId));
    const tab = await chrome.tabs.get(tabId);
    return { success: true, url: tab.url };
  },

  async refresh_page(params) {
    const tabId = await getTabId(params);
    await runNavigationAndWait(
      tabId,
      () => chrome.tabs.reload(tabId, { bypassCache: !!params.bypassCache })
    );
    return { success: true };
  },

  // ── DOM Reading ─────────────────────────────────────────────────
  async get_page_content(params) {
    const tabId = await getTabId(params);
    const format = params.format || "text";
    const selector = params.selector || null;
    const maxLength = params.maxLength ?? 1_000_000;

    const pageContent = await execInTab(tabId, (fmt, sel, limit) => {
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return null;
      const content = fmt === "html" ? root.innerHTML : root.innerText;
      return {
        content: content.slice(0, limit),
        length: content.length,
        truncated: content.length > limit,
      };
    }, [format, selector, maxLength]);

    const tab = await chrome.tabs.get(tabId);
    return {
      content: pageContent?.content ?? null,
      format,
      length: pageContent?.length ?? 0,
      truncated: pageContent?.truncated ?? false,
      url: tab.url,
    };
  },

  async query_selector(params) {
    const tabId = await getTabId(params);
    return execInTab(tabId, (selector, attrs) => {
      const els = Array.from(document.querySelectorAll(selector));
      return els.slice(0, 100).map((el) => {
        const rect = el.getBoundingClientRect();
        const attributes = {};
        if (attrs) {
          attrs.forEach((a) => { attributes[a] = el.getAttribute(a); });
        } else {
          Array.from(el.attributes).forEach((a) => { attributes[a.name] = a.value; });
        }
        return {
          text: el.textContent?.trim().substring(0, 500),
          attributes,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          isVisible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden",
        };
      });
    }, [params.selector, params.attributes || null]);
  },

  async get_element_text(params) {
    const tabId = await getTabId(params);
    const text = await execInTab(tabId, (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent?.trim() : null;
    }, [params.selector]);
    return { text, selector: params.selector };
  },

  async extract_links(params) {
    const tabId = await getTabId(params);
    return execInTab(tabId, (includeHidden) => {
      const links = Array.from(document.querySelectorAll("a[href]"));
      return links
        .filter((a) => {
          if (includeHidden) return true;
          const rect = a.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((a) => ({
          href: a.href,
          text: a.textContent?.trim().substring(0, 200),
          title: a.title,
          target: a.target,
        }));
    }, [params.includeHidden || false]);
  },

  async extract_structured_data(params) {
    const tabId = await getTabId(params);
    return execInTab(tabId, () => {
      // JSON-LD
      const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
        .filter(Boolean);

      // Open Graph
      const openGraph = {};
      document.querySelectorAll('meta[property^="og:"]').forEach((m) => {
        openGraph[m.getAttribute("property")] = m.getAttribute("content");
      });

      // Twitter cards
      const twitter = {};
      document.querySelectorAll('meta[name^="twitter:"]').forEach((m) => {
        twitter[m.getAttribute("name")] = m.getAttribute("content");
      });

      return { jsonLd, openGraph, twitter };
    });
  },

  async get_page_metadata(params) {
    const tabId = await getTabId(params);
    return execInTab(tabId, () => {
      const getMeta = (name) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content");
      const ogTags = {};
      document.querySelectorAll('meta[property^="og:"]').forEach((m) => {
        ogTags[m.getAttribute("property")] = m.getAttribute("content");
      });
      return {
        title: document.title,
        description: getMeta("description"),
        keywords: getMeta("keywords"),
        ogTags,
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
        lang: document.documentElement.lang,
      };
    });
  },

  async get_computed_styles(params) {
    const tabId = await getTabId(params);
    return execInTab(tabId, (selector, props) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const computed = getComputedStyle(el);
      const styles = {};
      if (props?.length) {
        props.forEach((p) => { styles[p] = computed.getPropertyValue(p); });
      } else {
        for (const prop of computed) {
          styles[prop] = computed.getPropertyValue(prop);
        }
      }
      return { styles, selector };
    }, [params.selector, params.properties || null]);
  },

  async get_page_structure(params) {
    const tabId = await getTabId(params);
    return execInTab(tabId, (maxDepth) => {
      function buildTree(el, depth) {
        if (depth > maxDepth) return null;
        const children = Array.from(el.children)
          .slice(0, 50)
          .map((c) => buildTree(c, depth + 1))
          .filter(Boolean);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          classes: el.className ? el.className.split(" ").filter(Boolean) : undefined,
          children: children.length ? children : undefined,
        };
      }
      return buildTree(document.body, 0);
    }, [params.maxDepth ?? 5]);
  },

  // ── DOM Interaction ─────────────────────────────────────────────
  async click_element(params) {
    const tabId = await getTabId(params);
    const button = params.button || "left";
    const position = await dispatchMouseClick(tabId, params.selector, button);
    return { success: true, selector: params.selector, button, position };
  },

  async fill_input(params) {
    const tabId = await getTabId(params);
    await execInMainWorld(tabId, (selector, value, clear) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Element not found: ${selector}`);
      element.focus();

      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) throw new Error(`Element does not accept text: ${selector}`);
        setter.call(element, clear ? value : `${element.value}${value}`);
      } else if (element.isContentEditable) {
        element.textContent = clear ? value : `${element.textContent || ""}${value}`;
      } else {
        throw new Error(`Element does not accept text: ${selector}`);
      }

      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value,
      }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, [params.selector, params.value, params.clear !== false]);
    return { success: true, selector: params.selector };
  },

  async select_option(params) {
    const tabId = await getTabId(params);
    const selectedValue = await execInMainWorld(tabId, (selector, value) => {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLSelectElement)) throw new Error(`Select element not found: ${selector}`);
      // Try by value first, then by text
      let option = Array.from(el.options).find((o) => o.value === value);
      if (!option) option = Array.from(el.options).find((o) => o.textContent.trim() === value);
      if (!option) throw new Error(`Option not found: ${value}`);
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return option.value;
    }, [params.selector, params.value]);
    return { success: true, selectedValue };
  },

  async submit_form(params) {
    const tabId = await getTabId(params);
    const info = await execInMainWorld(tabId, (selector) => {
      const form = document.querySelector(selector);
      if (!(form instanceof HTMLFormElement)) throw new Error(`Form not found: ${selector}`);
      const action = form.action;
      const method = form.method;
      form.requestSubmit();
      return { action, method };
    }, [params.selector]);
    return { success: true, ...info };
  },

  async check_checkbox(params) {
    const tabId = await getTabId(params);
    await execInTab(tabId, (selector, checked) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      if (el.checked !== checked) {
        el.checked = checked;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, [params.selector, params.checked]);
    return { success: true, checked: params.checked };
  },

  async hover_element(params) {
    const tabId = await getTabId(params);
    const position = await getElementCenter(tabId, params.selector);
    await withDebugger(tabId, () => chrome.debugger.sendCommand(
      { tabId },
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: position.x, y: position.y }
    ));
    return { success: true, position };
  },

  async scroll_to(params) {
    const tabId = await getTabId(params);
    const pos = await execInTab(tabId, (selector, x, y, behavior) => {
      if (selector) {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Element not found: ${selector}`);
        el.scrollIntoView({ behavior: behavior || "auto", block: "center" });
      } else {
        window.scrollTo({ left: x || 0, top: y || 0, behavior: behavior || "auto" });
      }
      return { scrollX: window.scrollX, scrollY: window.scrollY };
    }, [params.selector || null, params.x || 0, params.y || 0, params.behavior || "auto"]);
    return { success: true, ...pos };
  },

  async focus_element(params) {
    const tabId = await getTabId(params);
    await execInTab(tabId, (selector) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      el.focus();
    }, [params.selector]);
    return { success: true };
  },

  // ── Screenshots ─────────────────────────────────────────────────
  async take_screenshot(params) {
    const tabId = await getTabId(params);
    const format = params.format === "jpeg" ? "jpeg" : "png";
    const quality = params.quality ?? 90;

    const screenshot = await withVisibleTab(tabId, async (windowId, captureContext) => {
      const page = await getScreenshotPage(tabId);
      captureContext.restorePage = async () => {
        await scrollScreenshotPage(
          tabId,
          page.scrollX,
          page.scrollY,
          captureContext,
          true
        );
        captureContext.pageRestored = true;
      };
      const region = await getScreenshotRegion(tabId, params, page);
      const dimensions = {
        width: Math.ceil(region.width),
        height: Math.ceil(region.height),
      };
      if (
        dimensions.width > CONNECTION.limits.maxScreenshotDimension
        || dimensions.height > CONNECTION.limits.maxScreenshotDimension
      ) {
        throw new Error(
          `Screenshot exceeds the ${CONNECTION.limits.maxScreenshotDimension}px safety limit; capture a smaller element or viewport`
        );
      }

      const canvas = await stitchScreenshot(
        tabId,
        windowId,
        region,
        dimensions,
        page,
        captureContext
      );
      const encoded = await encodeScreenshot(canvas, format, quality);
      if (encoded.length > CONNECTION.limits.maxScreenshotPayloadBytes) {
        throw new Error(
          `Screenshot exceeds the ${CONNECTION.limits.maxScreenshotPayloadBytes}-byte encoded payload limit`
        );
      }
      return { dimensions, image: encoded };
    });

    const mimeType = `image/${format}`;
    return {
      image: screenshot.image,
      format,
      dimensions: screenshot.dimensions,
      mimeType,
    };
  },

  async capture_element(params) {
    return toolHandlers.take_screenshot(params);
  },

  // ── Network Monitoring ──────────────────────────────────────────
  async start_network_monitoring(params) {
    const tabId = await getTabId(params);
    const monitoringId = crypto.randomUUID();
    networkLogs.set(monitoringId, { tabId, entries: [], startTime: Date.now(), filters: params.filters });
    return { monitoringId, startTime: Date.now() };
  },

  async stop_network_monitoring(params) {
    const session = networkLogs.get(params.monitoringId);
    if (!session) throw new Error("Monitoring session not found");
    const entries = session.entries;
    networkLogs.delete(params.monitoringId);
    return entries;
  },

  async get_network_log(params) {
    const entries = [];
    for (const [, session] of networkLogs) {
      if (params.tabId && session.tabId !== params.tabId) continue;
      for (const entry of session.entries) {
        if (params.since && entry.timestamp < params.since) continue;
        entries.push(entry);
      }
    }
    entries.sort((left, right) => left.timestamp - right.timestamp);
    return entries.slice(-(params.limit || 100));
  },

  async block_request(params) {
    const tabId = await getTabId(params);
    return serializeNetworkRuleOperation(async () => {
      const ruleId = await getNextSessionRuleId();
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: ruleId,
          priority: 1,
          action: { type: "block" },
          condition: {
            tabIds: [tabId],
            urlFilter: params.urlPattern,
            resourceTypes: params.resourceTypes || [
              "main_frame", "sub_frame", "stylesheet", "script", "image",
              "font", "object", "xmlhttprequest", "ping", "media", "websocket", "other",
            ],
          },
        }],
        removeRuleIds: [],
      });
      return { ruleId, tabId, pattern: params.urlPattern };
    });
  },

  async unblock_request(params) {
    return serializeNetworkRuleOperation(async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      if (!rules.some(rule => rule.id === params.ruleId)) {
        throw new Error(`Network rule not found: ${params.ruleId}`);
      }
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [],
        removeRuleIds: [params.ruleId],
      });
      return { success: true, ruleId: params.ruleId };
    });
  },

  async modify_request_headers(params) {
    const tabId = await getTabId(params);
    const requestHeaders = Object.entries(params.headers).map(([header, value]) => ({
      header,
      operation: "set",
      value,
    }));
    return serializeNetworkRuleOperation(async () => {
      const ruleId = await getNextSessionRuleId();
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: ruleId,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders },
          condition: { tabIds: [tabId], urlFilter: params.urlPattern },
        }],
        removeRuleIds: [],
      });
      return { ruleId, tabId, pattern: params.urlPattern };
    });
  },

  async list_network_rules(params) {
    return serializeNetworkRuleOperation(() => chrome.declarativeNetRequest.getSessionRules());
  },

  async clear_network_rules(params) {
    const removedRuleIds = await clearSessionNetworkRules();
    return { success: true, removedRuleIds };
  },

  // ── Cookies & Storage ───────────────────────────────────────────
  async get_cookies(params) {
    const query = {};
    if (params.domain) query.domain = params.domain;
    if (params.name) query.name = params.name;
    if (!params.domain && !params.name) {
      // Get from active tab's URL
      const tabId = await getTabId(params);
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) query.url = tab.url;
    }
    return chrome.cookies.getAll(query);
  },

  async set_cookie(params) {
    const cookie = await chrome.cookies.set({
      url: params.url,
      name: params.name,
      value: params.value,
      domain: params.domain,
      path: params.path,
      secure: params.secure,
      httpOnly: params.httpOnly,
      expirationDate: params.expirationDate,
    });
    return { success: true, cookie };
  },

  async delete_cookies(params) {
    if (params.name) {
      const removed = await chrome.cookies.remove({ url: params.url, name: params.name });
      return { deletedCount: removed ? 1 : 0 };
    }
    const cookies = await chrome.cookies.getAll({ url: params.url });
    let deletedCount = 0;
    for (const c of cookies) {
      const removed = await chrome.cookies.remove({ url: params.url, name: c.name });
      if (removed) deletedCount++;
    }
    return { deletedCount };
  },

  async get_local_storage(params) {
    return execInTab(params.tabId, (key) => {
      if (key) return { data: localStorage.getItem(key) };
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        data[k] = localStorage.getItem(k);
      }
      return { data };
    }, [params.key || null]);
  },

  async set_local_storage(params) {
    await execInTab(params.tabId, (key, value) => {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    }, [params.key, params.value]);
    return { success: true };
  },

  async get_session_storage(params) {
    return execInTab(params.tabId, (key) => {
      if (key) return { data: sessionStorage.getItem(key) };
      const data = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        data[k] = sessionStorage.getItem(k);
      }
      return { data };
    }, [params.key || null]);
  },

  async clear_storage(params) {
    const cleared = [];
    for (const type of params.types) {
      if (type === "localStorage") {
        await execInTab(params.tabId, () => localStorage.clear());
        cleared.push("localStorage");
      } else if (type === "sessionStorage") {
        await execInTab(params.tabId, () => sessionStorage.clear());
        cleared.push("sessionStorage");
      } else if (type === "cookies") {
        const tab = await chrome.tabs.get(params.tabId);
        if (tab.url) {
          const cookies = await chrome.cookies.getAll({ url: tab.url });
          for (const c of cookies) {
            await chrome.cookies.remove({ url: tab.url, name: c.name });
          }
        }
        cleared.push("cookies");
      } else if (type === "cache") {
        await execInTab(params.tabId, async () => {
          if ("caches" in window) {
            const names = await caches.keys();
            await Promise.all(names.map((n) => caches.delete(n)));
          }
        });
        cleared.push("cache");
      }
    }
    return { cleared };
  },

  // ── Wait & Observe ──────────────────────────────────────────────
  async wait_for_element(params) {
    const tabId = await getTabId(params);
    const timeout = params.timeout || 30000;
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const found = await execInTab(tabId, (sel) => !!document.querySelector(sel), [params.selector]);
          if (found) {
            clearInterval(interval);
            resolve({ found: true, waitTime: Date.now() - start });
          } else if (Date.now() - start > timeout) {
            clearInterval(interval);
            resolve({ found: false, waitTime: Date.now() - start });
          }
        } catch (err) {
          clearInterval(interval);
          reject(err);
        }
      }, 200);
    });
  },

  async wait_for_navigation(params) {
    const tabId = await getTabId(params);
    const timeout = params.timeout || 30000;
    const start = Date.now();
    await waitForTabLoad(tabId, timeout);
    const tab = await chrome.tabs.get(tabId);
    return { loaded: true, url: tab.url, loadTime: Date.now() - start };
  },

  async wait_for_condition(params) {
    const timeout = params.timeout || 30000;
    const start = Date.now();
    return withDebugger(params.tabId, async () => {
      while (Date.now() - start <= timeout) {
        const result = await evaluateRuntime(params.tabId, `(${params.condition})`);
        if (result.value) {
          return { met: true, result: result.value, waitTime: Date.now() - start };
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return { met: false, waitTime: Date.now() - start };
    });
  },

  async observe_dom_changes(params) {
    const { tabId, duration, selector, attributes, childList, subtree } = params;

    return execInTab(tabId, (sel, dur, attrs, cl, st) => {
      return new Promise((resolve) => {
        const target = sel ? document.querySelector(sel) : document.body;
        if (!target) { resolve([]); return; }

        const mutations = [];
        const observer = new MutationObserver((records) => {
          for (const r of records) {
            if (mutations.length < 5000) {
              mutations.push({
                type: r.type,
                target: r.target.nodeName,
                addedNodes: r.addedNodes.length,
                removedNodes: r.removedNodes.length,
                attributeName: r.attributeName,
              });
            }
          }
        });

        observer.observe(target, {
          attributes: attrs !== false,
          childList: cl !== false,
          subtree: st !== false,
        });

        setTimeout(() => {
          observer.disconnect();
          resolve(mutations);
        }, dur);
      });
    }, [selector || null, duration, attributes, childList, subtree]);
  },

  // ── JavaScript Execution ────────────────────────────────────────
  async execute_javascript(params) {
    const tabId = await getTabId(params);
    const args = params.args || [];
    const argumentNames = args.map((_, index) => `arg${index}`).join(",");
    const expression = `(async function(${argumentNames}) {\n${params.code}\n})(...${JSON.stringify(args)})`;
    const result = await evaluateWithDebugger(tabId, expression);
    return { result: result.value, type: result.type, unserializableValue: result.unserializableValue };
  },

  async evaluate_expression(params) {
    const tabId = await getTabId(params);
    const result = await evaluateWithDebugger(tabId, `(${params.expression})`);
    return { value: result.value, type: result.type, unserializableValue: result.unserializableValue };
  },

  // ── Page Analysis ───────────────────────────────────────────────
  async get_performance_metrics(params) {
    const tabId = await getTabId(params);
    return execInTab(tabId, () => {
      const nav = performance.getEntriesByType("navigation")[0];
      return {
        timing: {
          domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
          load: nav?.loadEventEnd ?? null,
          firstByte: nav?.responseStart ?? null,
        },
        navigation: nav ? { type: nav.type, redirectCount: nav.redirectCount } : null,
        memory: performance.memory
          ? {
              usedJSHeapSize: performance.memory.usedJSHeapSize,
              totalJSHeapSize: performance.memory.totalJSHeapSize,
            }
          : null,
        resources: performance.getEntriesByType("resource").length,
      };
    });
  },

  async check_element_visibility(params) {
    return execInTab(params.tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { visible: false, inViewport: false };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      const inViewport =
        rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0;
      return {
        visible,
        inViewport,
        dimensions: { width: rect.width, height: rect.height },
        position: { x: rect.x, y: rect.y },
      };
    }, [params.selector]);
  },

  async get_viewport_info(params) {
    const tabId = await getTabId(params);
    return execInTab(tabId, () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    }));
  },

  async detect_technology(params) {
    const tabId = await getTabId(params);
    return execInMainWorld(tabId, () => {
      const tech = { frameworks: [], analytics: [], libraries: [] };
      if (window.React || document.querySelector("[data-reactroot]")) tech.frameworks.push("React");
      if (window.Vue || document.querySelector("[data-v-]")) tech.frameworks.push("Vue");
      if (window.angular || document.querySelector("[ng-app], [ng-controller]")) tech.frameworks.push("Angular");
      if (window.jQuery || window.$?.fn?.jquery) tech.libraries.push(`jQuery ${window.$?.fn?.jquery || ""}`);
      if (window.ga || window.gtag) tech.analytics.push("Google Analytics");
      if (window._gaq) tech.analytics.push("Google Analytics (legacy)");
      if (window.fbq) tech.analytics.push("Facebook Pixel");
      return tech;
    });
  },

  // ── Downloads ───────────────────────────────────────────────────
  async trigger_download(params) {
    const id = await chrome.downloads.download({
      url: params.url,
      filename: params.filename,
      saveAs: params.saveAs || false,
    });
    return { downloadId: id, filename: params.filename, state: "in_progress" };
  },

  async get_download_status(params) {
    const [item] = await chrome.downloads.search({ id: params.downloadId });
    if (!item) throw new Error("Download not found");
    return {
      state: item.state,
      filename: item.filename,
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes,
      paused: item.paused,
      error: item.error,
    };
  },

  // ── Console Monitoring ──────────────────────────────────────────
  async start_console_monitoring(params) {
    const tabId = params.tabId;
    if (consoleLogs.has(tabId)) throw new Error("Console monitoring already active on this tab");

    const levels = params.levels || ["log", "warn", "error", "info", "debug", "trace"];
    const maxEntries = params.maxEntries || 500;
    const includeStackTraces = params.includeStackTraces || false;

    consoleLogs.set(tabId, { entries: [], maxEntries, levels, includeStackTraces });

    try {
      await execInMainWorld(tabId, (lvls, stacks, entryLimit) => {
        if (window.__mcpConsoleMonitor) return;
        window.__mcpConsoleMonitor = { entries: [], original: {} };
        window.__mcpConsoleMonitor.append = (entry) => {
          window.__mcpConsoleMonitor.entries.push(entry);
          if (window.__mcpConsoleMonitor.entries.length > entryLimit) {
            window.__mcpConsoleMonitor.entries.splice(
              0,
              window.__mcpConsoleMonitor.entries.length - entryLimit
            );
          }
        };

        lvls.forEach(level => {
          window.__mcpConsoleMonitor.original[level] = console[level];
          console[level] = function(...args) {
            const entry = {
              level,
              timestamp: Date.now(),
              args: args.map(a => {
                try {
                  if (a instanceof Error) return { type: 'error', message: a.message, stack: a.stack };
                  if (typeof a === 'object') return JSON.parse(JSON.stringify(a, null, 0));
                  return a;
                } catch { return String(a); }
              }),
            };
            if (stacks && level === 'error') {
              entry.stack = new Error().stack;
            }
            window.__mcpConsoleMonitor.append(entry);
            window.__mcpConsoleMonitor.original[level].apply(console, args);
          };
        });

        window.__mcpConsoleMonitor._errorHandler = (event) => {
          window.__mcpConsoleMonitor.append({
            level: 'error',
            timestamp: Date.now(),
            args: [{ type: 'uncaught', message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno }],
            stack: event.error?.stack,
          });
        };
        window.__mcpConsoleMonitor._rejectionHandler = (event) => {
          window.__mcpConsoleMonitor.append({
            level: 'error',
            timestamp: Date.now(),
            args: [{ type: 'unhandledRejection', reason: String(event.reason) }],
          });
        };
        window.addEventListener('error', window.__mcpConsoleMonitor._errorHandler);
        window.addEventListener('unhandledrejection', window.__mcpConsoleMonitor._rejectionHandler);
      }, [levels, includeStackTraces, maxEntries]);
    } catch (error) {
      consoleLogs.delete(tabId);
      throw error;
    }

    return { monitoring: true, tabId, levels };
  },

  async stop_console_monitoring(params) {
    const tabId = params.tabId;
    const entries = await clearConsoleMonitor(tabId);
    consoleLogs.delete(tabId);
    return { entries, count: entries.length };
  },

  async get_console_log(params) {
    const tabId = params.tabId;
    const entries = await execInMainWorld(tabId, (level, since, limit, clear) => {
      if (!window.__mcpConsoleMonitor) return [];
      let items = window.__mcpConsoleMonitor.entries;
      if (level && level !== 'all') items = items.filter(e => e.level === level);
      if (since) items = items.filter(e => e.timestamp >= since);
      if (clear) window.__mcpConsoleMonitor.entries = [];
      return items.slice(-limit);
    }, [params.level || 'all', params.since || null, params.limit || 100, params.clear || false]);
    return { entries, count: entries.length };
  },

  async clear_console_log(params) {
    await execInMainWorld(params.tabId, () => {
      if (window.__mcpConsoleMonitor) window.__mcpConsoleMonitor.entries = [];
    });
    return { cleared: true };
  },

  // ── Keyboard & Event Simulation ─────────────────────────────────
  // Enhanced press_key using Chrome Debugger API for trusted events
  async press_key(params) {
    const tabId = params.tabId;
    const { key, modifiers, repeat, delay, selector } = params;

    try {
      if (selector) {
        await execInTab(tabId, (targetSelector) => {
          const element = document.querySelector(targetSelector);
          if (!element) throw new Error(`Element not found: ${targetSelector}`);
          element.focus();
        }, [selector]);
      }

      const m = modifiers || {};
      const keyCode = getKeyCode(key);
      const keyCodeName = getKeyCodeName(key);
      const modifierFlags = getModifierFlags(m);

      await withDebugger(tabId, async () => {
        for (let i = 0; i < (repeat || 1); i++) {
          if (i > 0) await new Promise(resolve => setTimeout(resolve, delay ?? 50));

          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code: keyCodeName,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
            modifiers: modifierFlags,
          });

          if (key.length === 1 && !m.ctrl && !m.alt && !m.meta) {
            const text = m.shift ? key.toUpperCase() : key;
            await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "char",
              text,
              modifiers: modifierFlags,
            });
          }

          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code: keyCodeName,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
            modifiers: modifierFlags,
          });
        }
      });
      return { success: true, key, repeat: repeat || 1, method: "debugger" };

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Trusted key input unavailable: ${message}`);
    }
  },

  async type_text(params) {
    const tabId = params.tabId;
    await execInMainWorld(tabId, (selector, clearFirst) => {
      const target = selector ? document.querySelector(selector) : document.activeElement;
      if (!target) throw new Error(`Element not found: ${selector}`);
      target.focus();
      if (!clearFirst) return;

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const prototype = target instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, "");
      } else if (target.isContentEditable) {
        target.textContent = "";
      }
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));
    }, [params.selector || null, params.clearFirst || false]);

    await withDebugger(tabId, async () => {
      for (const character of params.text) {
        await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: character });
        if ((params.delayPerChar ?? 50) > 0) {
          await new Promise(resolve => setTimeout(resolve, params.delayPerChar ?? 50));
        }
      }
    });

    return { success: true, length: params.text.length };
  },

  async dispatch_event(params) {
    const tabId = params.tabId;
    await execInTab(tabId, (sel, eventType, eventName, eventInit) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);

      const init = { bubbles: true, cancelable: true, ...eventInit };
      let event;

      const constructors = {
        MouseEvent, KeyboardEvent, FocusEvent, InputEvent, CustomEvent, WheelEvent, PointerEvent,
      };

      if (eventType === 'TouchEvent' && typeof TouchEvent !== 'undefined') {
        event = new TouchEvent(eventName, init);
      } else if (constructors[eventType]) {
        event = new constructors[eventType](eventName, init);
      } else {
        event = new Event(eventName, init);
      }

      el.dispatchEvent(event);
    }, [params.selector, params.eventType, params.eventName, params.eventInit || null]);

    return { success: true, eventType: params.eventType, eventName: params.eventName };
  },

  async drag_and_drop(params) {
    const tabId = params.tabId;
    await execInTab(tabId, (srcSel, tgtSel, tgtCoords, steps) => {
      const source = document.querySelector(srcSel);
      if (!source) throw new Error(`Source not found: ${srcSel}`);

      let target, targetRect;
      if (tgtSel) {
        target = document.querySelector(tgtSel);
        if (!target) throw new Error(`Target not found: ${tgtSel}`);
        targetRect = target.getBoundingClientRect();
      }
      if (!tgtCoords && !targetRect) throw new Error("Provide a target selector or coordinates");

      const sourceRect = source.getBoundingClientRect();
      const startX = sourceRect.x + sourceRect.width / 2;
      const startY = sourceRect.y + sourceRect.height / 2;
      const endX = tgtCoords ? tgtCoords.x : (targetRect.x + targetRect.width / 2);
      const endY = tgtCoords ? tgtCoords.y : (targetRect.y + targetRect.height / 2);

      // Create DataTransfer
      const dt = new DataTransfer();

      // mousedown on source
      source.dispatchEvent(new MouseEvent('mousedown', { clientX: startX, clientY: startY, bubbles: true }));

      // dragstart
      source.dispatchEvent(new DragEvent('dragstart', { clientX: startX, clientY: startY, dataTransfer: dt, bubbles: true }));

      // Intermediate drag/dragover events
      for (let i = 1; i <= steps; i++) {
        const ratio = i / steps;
        const cx = startX + (endX - startX) * ratio;
        const cy = startY + (endY - startY) * ratio;
        source.dispatchEvent(new DragEvent('drag', { clientX: cx, clientY: cy, dataTransfer: dt, bubbles: true }));
        if (target) {
          target.dispatchEvent(new DragEvent('dragover', { clientX: cx, clientY: cy, dataTransfer: dt, bubbles: true }));
        }
      }

      // dragenter on target
      if (target) {
        target.dispatchEvent(new DragEvent('dragenter', { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true }));
        target.dispatchEvent(new DragEvent('drop', { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true }));
      }

      // dragend on source
      source.dispatchEvent(new DragEvent('dragend', { clientX: endX, clientY: endY, dataTransfer: dt, bubbles: true }));
      source.dispatchEvent(new MouseEvent('mouseup', { clientX: endX, clientY: endY, bubbles: true }));
    }, [params.sourceSelector, params.targetSelector || null, params.targetCoordinates || null, params.steps ?? 10]);

    return { success: true };
  },

  async upload_file(params) {
    const tabId = params.tabId;
    await execInTab(tabId, (sel, filesData) => {
      const input = document.querySelector(sel);
      if (!input) throw new Error(`Element not found: ${sel}`);
      if (input.tagName !== 'INPUT' || input.type !== 'file') {
        throw new Error('Target element is not a file input');
      }

      const dt = new DataTransfer();
      for (const f of filesData) {
        let content;
        if (f.isBase64) {
          const binary = atob(f.content);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0;
          content = bytes;
        } else {
          content = [f.content];
        }
        const file = new File(content, f.name, { type: f.type });
        dt.items.add(file);
      }

      // Set the files on the input
      Object.defineProperty(input, 'files', { value: dt.files, writable: false });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, [params.selector, params.files]);

    return { success: true, fileCount: params.files.length };
  },

  // ── Browser API Controls ────────────────────────────────────────
  async set_geolocation(params) {
    const tabId = params.tabId;
    await setPersistentDebuggerOverride(tabId, "geolocation", () =>
      chrome.debugger.sendCommand({ tabId }, "Emulation.setGeolocationOverride", {
        latitude: params.latitude,
        longitude: params.longitude,
        accuracy: params.accuracy ?? 100,
        ...(params.altitude == null ? {} : { altitude: params.altitude }),
      })
    );

    return { success: true, latitude: params.latitude, longitude: params.longitude };
  },

  async clear_geolocation(params) {
    await clearPersistentDebuggerOverride(params.tabId, "geolocation", () =>
      chrome.debugger.sendCommand({ tabId: params.tabId }, "Emulation.clearGeolocationOverride")
    );
    return { success: true };
  },

  async emulate_media(params) {
    const tabId = params.tabId;
    const features = [];
    if (params.colorScheme) features.push({ name: "prefers-color-scheme", value: params.colorScheme });
    if (params.reducedMotion) features.push({ name: "prefers-reduced-motion", value: params.reducedMotion });
    if (params.forcedColors) features.push({ name: "forced-colors", value: params.forcedColors });
    if (params.prefersContrast) features.push({ name: "prefers-contrast", value: params.prefersContrast });
    const commandParams = {
      ...(features.length ? { features } : {}),
      ...(params.mediaType ? { media: params.mediaType } : {}),
    };
    const hasOverride = features.length > 0 || Boolean(params.mediaType);

    if (hasOverride) {
      await setPersistentDebuggerOverride(tabId, "media", () =>
        chrome.debugger.sendCommand({ tabId }, "Emulation.setEmulatedMedia", commandParams)
      );
    } else {
      await clearPersistentDebuggerOverride(tabId, "media", () =>
        chrome.debugger.sendCommand({ tabId }, "Emulation.setEmulatedMedia", {})
      );
    }
    return { success: true, cleared: !hasOverride, features: commandParams };
  },

  async set_device_metrics(params) {
    const tabId = params.tabId;
    const hasOverride = params.userAgent != null
      || params.width != null
      || params.height != null
      || params.deviceScaleFactor != null
      || params.mobile != null;

    if (!hasOverride) {
      await clearPersistentDebuggerOverride(tabId, "device", async () => {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride");
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setUserAgentOverride", { userAgent: "" });
      });
      return { success: true, cleared: true };
    }

    const viewport = await execInTab(tabId, () => ({ width: innerWidth, height: innerHeight }));
    await setPersistentDebuggerOverride(tabId, "device", async () => {
      if (params.width != null || params.height != null || params.deviceScaleFactor != null || params.mobile != null) {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
          width: params.width ?? viewport.width,
          height: params.height ?? viewport.height,
          deviceScaleFactor: params.deviceScaleFactor ?? 0,
          mobile: params.mobile ?? false,
        });
      }
      if (params.userAgent != null) {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setUserAgentOverride", {
          userAgent: params.userAgent,
        });
      }
    });
    return { success: true, overrides: params };
  },

  async get_accessibility_tree(params) {
    const tabId = params.tabId;
    return execInTab(tabId, (sel, maxDepth, includeHidden, maxNodes) => {
      let nodeCount = 0;

      function isHidden(el) {
        if (includeHidden) return false;
        const style = getComputedStyle(el);
        return style.display === 'none'
          || style.visibility === 'hidden'
          || el.getAttribute('aria-hidden') === 'true';
      }

      function getAccessibleName(el) {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        const ariaLabelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          const labeled = document.getElementById(ariaLabelledBy);
          const labelledText = labeled?.textContent?.trim();
          if (labelledText) return labelledText;
        }
        if (el.tagName === 'INPUT') {
          const inputName = el.getAttribute('placeholder') || el.getAttribute('name');
          if (inputName) return inputName;
        }
        return Array.from(el.childNodes)
          .filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent.trim())
          .filter(Boolean)
          .join(' ')
          .substring(0, 100) || null;
      }

      function buildA11yTree(el, depth) {
        if (depth > maxDepth || isHidden(el)) return null;
        nodeCount++;
        if (nodeCount > maxNodes) {
          throw new Error(`Accessibility tree exceeds the ${maxNodes}-node limit`);
        }

        const node = { role: el.getAttribute('role') || el.tagName.toLowerCase() };
        const name = getAccessibleName(el);
        if (name) node.name = name;
        const stateMappings = [
          ['aria-expanded', 'expanded', value => value === 'true'],
          ['aria-checked', 'checked', value => value],
          ['aria-selected', 'selected', value => value === 'true'],
          ['aria-disabled', 'disabled', value => value === 'true'],
          ['aria-required', 'required', value => value === 'true'],
          ['aria-describedby', 'describedBy', value => value],
        ];
        for (const [attribute, property, convert] of stateMappings) {
          const value = el.getAttribute(attribute);
          if (value !== null) node[property] = convert(value);
        }
        if (el.getAttribute('tabindex') !== null) node.focusable = true;

        const children = Array.from(el.children)
          .map(c => buildA11yTree(c, depth + 1))
          .filter(Boolean);

        if (children.length > 0) node.children = children;
        return node;
      }

      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return null;
      return buildA11yTree(root, 0);
    }, [params.selector || null, params.maxDepth ?? 8, params.includeHidden || false, 5_000]);
  },

  async manage_dialogs(params) {
    const tabId = params.tabId;

    if (params.action === 'setup') {
      await execInMainWorld(tabId, (autoAccept, promptText) => {
        if (window.__mcpDialogHandler) {
          window.__mcpDialogHandler.autoAccept = autoAccept;
          window.__mcpDialogHandler.promptText = promptText;
          return;
        }

        window.__mcpDialogHandler = {
          autoAccept,
          promptText,
          history: [],
          _origAlert: window.alert,
          _origConfirm: window.confirm,
          _origPrompt: window.prompt,
        };

        window.alert = function(msg) {
          window.__mcpDialogHandler.history.push({ type: 'alert', message: String(msg), timestamp: Date.now() });
        };
        window.confirm = function(msg) {
          const handler = window.__mcpDialogHandler;
          handler.history.push({ type: 'confirm', message: String(msg), result: handler.autoAccept, timestamp: Date.now() });
          return handler.autoAccept;
        };
        window.prompt = function(msg, def) {
          const handler = window.__mcpDialogHandler;
          const result = handler.autoAccept ? (handler.promptText || def || '') : null;
          handler.history.push({ type: 'prompt', message: String(msg), result, timestamp: Date.now() });
          return result;
        };
      }, [params.autoAccept !== false, params.promptText || null]);
      dialogOverrideTabs.add(tabId);
      return { success: true, autoAccept: params.autoAccept !== false };
    }

    if (params.action === 'getHistory') {
      const history = await execInMainWorld(tabId, () => {
        return window.__mcpDialogHandler?.history || [];
      });
      return { history };
    }

    if (params.action === 'clear') {
      await clearDialogHandler(tabId);
      dialogOverrideTabs.delete(tabId);
      return { cleared: true };
    }
  },

  async query_iframe(params) {
    const tabId = params.tabId;
    const { frameSelector, action, params: actionParams } = params;

    // Execute in the target frame by finding it
    const result = await execInTab(tabId, (frameSel, act, aParams) => {
      const iframe = document.querySelector(frameSel);
      if (!iframe) throw new Error(`Iframe not found: ${frameSel}`);
      if (!iframe.contentDocument && !iframe.contentWindow) {
        throw new Error('Cannot access iframe content (likely cross-origin). Use chrome.debugger for cross-origin iframes.');
      }

      const doc = iframe.contentDocument;
      const p = aParams || {};

      if (act === 'querySelector') {
        const els = Array.from(doc.querySelectorAll(p.selector || '*'));
        return els.slice(0, 50).map(el => ({
          text: el.textContent?.trim().substring(0, 200),
          tagName: el.tagName,
          id: el.id,
          className: el.className,
        }));
      }
      if (act === 'getContent') {
        const root = p.selector ? doc.querySelector(p.selector) : doc.body;
        return root ? root.innerText : null;
      }
      if (act === 'click') {
        const el = doc.querySelector(p.selector);
        if (!el) throw new Error(`Element not found in iframe: ${p.selector}`);
        el.click();
        return { clicked: true };
      }
      if (act === 'fill') {
        const el = doc.querySelector(p.selector);
        if (!el) throw new Error(`Element not found in iframe: ${p.selector}`);
        el.focus();
        el.value = p.value || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true };
      }
    }, [frameSelector, action, actionParams || null]);

    return result;
  },

  async query_shadow_dom(params) {
    const tabId = params.tabId;
    return execInTab(tabId, (hostSel, innerSel, action, value) => {
      const host = document.querySelector(hostSel);
      if (!host) throw new Error(`Shadow host not found: ${hostSel}`);
      const root = host.shadowRoot;
      if (!root) throw new Error(`No shadow root found on: ${hostSel}. Element may use closed shadow DOM.`);

      const el = root.querySelector(innerSel);
      if (!el) throw new Error(`Element not found in shadow DOM: ${innerSel}`);

      if (action === 'query') {
        const rect = el.getBoundingClientRect();
        return {
          text: el.textContent?.trim().substring(0, 500),
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          isVisible: rect.width > 0 && rect.height > 0,
        };
      }
      if (action === 'click') { el.click(); return { clicked: true }; }
      if (action === 'fill') {
        el.focus();
        el.value = value || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true };
      }
      if (action === 'getText') { return { text: el.textContent?.trim() }; }
      if (action === 'getAttribute') { return { value: el.getAttribute(value) }; }
    }, [params.hostSelector, params.innerSelector, params.action, params.value || null]);
  },

  async get_error_log(params) {
    const tabId = params.tabId;
    return execInMainWorld(tabId, (since, limit) => {
      const errors = (window.__mcpErrorLog || [])
        .filter(entry => !since || entry.timestamp >= since)
        .slice(-limit);
      return { errors, count: errors.length };
    }, [params.since || null, params.limit || 50]);
  },


};

// ─── Helper: Wait for tab to finish loading ─────────────────────────
function runNavigationAndWait(tabId, action, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistoryUpdate);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onHistoryUpdate);
    };
    const finish = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      cleanup();
      resolve();
    };
    const onCompleted = (details) => finish(details);
    const onHistoryUpdate = (details) => finish(details);
    const onError = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      cleanup();
      reject(new Error(`Navigation failed: ${details.error}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Page load timeout"));
    }, timeout);

    chrome.webNavigation.onCompleted.addListener(onCompleted);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryUpdate);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(onHistoryUpdate);

    Promise.resolve()
      .then(action)
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.webNavigation.onCompleted.removeListener(listener);
      reject(new Error("Page load timeout"));
    }, timeout);

    const listener = (details) => {
      if (details.tabId === tabId && details.frameId === 0) {
        clearTimeout(timer);
        chrome.webNavigation.onCompleted.removeListener(listener);
        resolve();
      }
    };

    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === "complete") {
        clearTimeout(timer);
        resolve();
      } else {
        chrome.webNavigation.onCompleted.addListener(listener);
      }
    });
  });
}

let networkRuleQueue = Promise.resolve();

function serializeNetworkRuleOperation(operation) {
  const result = networkRuleQueue.then(operation, operation);
  networkRuleQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function getNextSessionRuleId() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const usedIds = new Set(rules.map(rule => rule.id));
  let ruleId = 1;
  while (usedIds.has(ruleId)) ruleId++;
  return ruleId;
}

function clearSessionNetworkRules() {
  return serializeNetworkRuleOperation(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const removedRuleIds = rules.map(rule => rule.id);
    if (removedRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [],
        removeRuleIds: removedRuleIds,
      });
    }
    return removedRuleIds;
  });
}

async function clearLegacyDynamicRules() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = rules.map(rule => rule.id);
  if (removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [], removeRuleIds });
  }
}

function removeNetworkRulesForTab(tabId) {
  return serializeNetworkRuleOperation(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = rules
      .filter(rule => rule.condition.tabIds?.includes(tabId))
      .map(rule => rule.id);
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [], removeRuleIds });
    }
  });
}

async function cleanupMcpSession() {
  while (activeToolRequests.size > 0) {
    await Promise.allSettled(Array.from(activeToolRequests));
  }
  networkLogs.clear();

  const tabs = await chrome.tabs.query({});
  const liveTabIds = new Set(tabs.flatMap(tab => tab.id == null ? [] : [tab.id]));
  const trackedCleanup = [];
  for (const tabId of consoleLogs.keys()) {
    if (liveTabIds.has(tabId)) trackedCleanup.push(clearConsoleMonitor(tabId));
  }
  for (const tabId of dialogOverrideTabs) {
    if (liveTabIds.has(tabId)) trackedCleanup.push(clearDialogHandler(tabId));
  }
  await Promise.all(trackedCleanup);

  await Promise.allSettled(tabs.flatMap(tab => {
    if (tab.id == null) return [];
    return [clearConsoleMonitor(tab.id), clearDialogHandler(tab.id)];
  }));
  consoleLogs.clear();
  dialogOverrideTabs.clear();

  const debuggerEntries = Array.from(debuggerSessions.entries());
  await Promise.all(
    debuggerEntries.map(([tabId, session]) => detachDebuggerSession(tabId, session))
  );
  await clearSessionNetworkRules();
}

function ensureCleanSession() {
  if (CONNECTION.cleanupPromise) return CONNECTION.cleanupPromise;

  CONNECTION.cleanupReady = false;
  CONNECTION.cleanupPromise = (async () => {
    await clearLegacyDynamicRules();
    await cleanupMcpSession();
    CONNECTION.cleanupReady = true;
  })().finally(() => {
    CONNECTION.cleanupPromise = null;
  });
  return CONNECTION.cleanupPromise;
}

async function prepareConnection() {
  try {
    await ensureCleanSession();
    connect();
  } catch (error) {
    CONNECTION.authError = `Session cleanup failed: ${error.message}`;
    updateBadge("ERR", "#C62828");
    console.error("[MCP] Session cleanup failed", error);
  }
}

function shouldCaptureNetworkRequest(session, details) {
  if (session.tabId && session.tabId !== details.tabId) return false;
  const filters = session.filters;
  if (filters?.urlPatterns && !filters.urlPatterns.some(pattern => details.url.includes(pattern))) {
    return false;
  }
  return !filters?.resourceTypes || filters.resourceTypes.includes(details.type);
}

function appendNetworkEntry(session, details) {
  const contentLength = details.responseHeaders
    ?.find(header => header.name.toLowerCase() === "content-length")?.value;
  session.entries.push({
    url: details.url,
    method: details.method,
    status: details.statusCode,
    type: details.type,
    timestamp: details.timeStamp,
    size: Number(contentLength || 0),
  });
  if (session.entries.length > 1000) {
    session.entries.splice(0, session.entries.length - 500);
  }
}

// ─── Network request logging via webRequest ─────────────────────────
chrome.webRequest.onCompleted.addListener(
  (details) => {
    for (const [, session] of networkLogs) {
      if (shouldCaptureNetworkRequest(session, details)) appendNetworkEntry(session, details);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    consoleLogs.delete(details.tabId);
    dialogOverrideTabs.delete(details.tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  for (const [monitoringId, session] of networkLogs) {
    if (session.tabId === tabId) networkLogs.delete(monitoringId);
  }
  consoleLogs.delete(tabId);
  dialogOverrideTabs.delete(tabId);
  await removeNetworkRulesForTab(tabId);

  const session = debuggerSessions.get(tabId);
  if (session) await detachDebuggerSession(tabId, session);
});

// ─── Popup communication ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getStatus") {
    chrome.storage.local.get("pairingToken").then((stored) => {
      sendResponse({
        connected: CONNECTION.authenticated,
        socketConnected: CONNECTION.ws?.readyState === WebSocket.OPEN,
        paired: PAIRING_TOKEN_PATTERN.test(stored.pairingToken || ""),
        authError: CONNECTION.authError,
        url: CONNECTION.url,
        reconnectAttempts: CONNECTION.reconnectAttempts,
        toolCount: CONNECTION.capabilities.length,
      });
    });
    return true;
  }

  if (message.action === "setPairingToken") {
    const pairingToken = String(message.token || "").trim().toLowerCase();
    if (!PAIRING_TOKEN_PATTERN.test(pairingToken)) {
      sendResponse({ success: false, error: "Token must be 64 hexadecimal characters" });
      return true;
    }

    chrome.storage.local.set({ pairingToken }).then(() => {
      CONNECTION.pairingRequired = false;
      CONNECTION.authError = null;
      CONNECTION.reconnectAttempts = 0;
      if (CONNECTION.ws) {
        CONNECTION.ws.close(1000, "Pairing token updated");
      } else {
        void prepareConnection();
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === "reconnect") {
    CONNECTION.pairingRequired = false;
    CONNECTION.authError = null;
    CONNECTION.reconnectAttempts = 0;
    if (CONNECTION.ws) {
      CONNECTION.ws.close(1000, "Manual reconnect");
    } else {
      void prepareConnection();
    }
    sendResponse({ success: true });
    return true;
  }
});

// ─── Start connection ───────────────────────────────────────────────
async function startConnection() {
  await prepareConnection();
}

startConnection(); // NOSONAR: top-level await can stall MV3 worker cold starts.

// ─── Service Worker Keepalive ───────────────────────────────────────
// Chrome MV3 service workers are terminated after ~30s of inactivity.
// This keepalive prevents that from killing the WebSocket connection.
const KEEPALIVE_INTERVAL = 25_000; // 25 seconds (under the 30s threshold)
setInterval(() => {
  if (CONNECTION.authenticated && CONNECTION.ws?.readyState === WebSocket.OPEN) {
    send({ type: "keepalive", timestamp: Date.now() });
    return;
  }
  // If disconnected, try to reconnect (service worker just woke up)
  if (!CONNECTION.pairingRequired && !CONNECTION.ws && !CONNECTION.isConnecting) {
    CONNECTION.reconnectAttempts = 0;
    if (CONNECTION.cleanupReady) connect();
    else void prepareConnection();
  }
}, KEEPALIVE_INTERVAL);
