const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statusDetail = document.getElementById("statusDetail");
const info = document.getElementById("info");
const pairing = document.getElementById("pairing");
const pairingToken = document.getElementById("pairingToken");
const pairBtn = document.getElementById("pairBtn");
const pairError = document.getElementById("pairError");
const reconnectBtn = document.getElementById("reconnectBtn");
const repairBtn = document.getElementById("repairBtn");
const lastEventValue = document.getElementById("lastEventValue");

const STATE_LABELS = {
  starting: "Starting up",
  connecting: "Connecting to MCP server",
  handshaking: "Authenticating",
  connected: "Connected to MCP server",
  stale: "Connection stale - no reply from server",
  retrying: "Disconnected - retrying",
  disconnected: "Disconnected",
  pairing_required: "Pairing required",
  error: "Connection error",
};

const DOT_CLASSES = {
  connected: "connected",
  connecting: "pending",
  handshaking: "pending",
  starting: "pending",
  stale: "stale",
  retrying: "disconnected",
  disconnected: "disconnected",
  pairing_required: "pending",
  error: "disconnected",
};

function formatDuration(milliseconds) {
  if (milliseconds == null) return null;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/**
 * Describe the connection below the badge. Everything here comes from the
 * background worker's real state, so a stale or unverified socket says so
 * rather than being rounded up to "connected".
 */
function describeDetail(status) {
  if (status.pairingRequired || (status.paired === false && !status.connected)) {
    return status.paired === false
      ? "Enter the pairing token printed by `bun run pair`."
      : "Pairing token rejected by the server.";
  }
  if (status.connected) {
    const silence = formatDuration(status.millisecondsSinceServerMessage);
    const verified = status.verified ? "verified just now" : "heartbeat healthy";
    return silence ? `${verified}, last server message ${silence} ago` : verified;
  }
  if (status.state === "stale") {
    const silence = formatDuration(status.millisecondsSinceServerMessage);
    return `Socket is open but the server has been silent for ${silence ?? "a while"}. Reconnecting.`;
  }
  if (status.retryInMs != null) {
    return `Next attempt in ${formatDuration(status.retryInMs)} (attempt ${status.reconnectAttempts}).`;
  }
  if (status.authError) return status.authError;
  if (status.lastDisconnectReason) return status.lastDisconnectReason;
  return "";
}

function updateUI(status) {
  const state = status.state || (status.connected ? "connected" : "disconnected");
  statusDot.className = `dot ${DOT_CLASSES[state] || "disconnected"}`;
  statusText.textContent = STATE_LABELS[state] || (status.connected ? "Connected" : "Disconnected");
  statusDetail.textContent = describeDetail(status);

  document.getElementById("serverValue").textContent = status.url;
  document.getElementById("toolsValue").textContent = status.toolCount;
  document.getElementById("attemptsValue").textContent = status.reconnectAttempts;

  const lastEvent = status.connected
    ? `connected ${formatDuration(Date.now() - status.lastConnectedAt) ?? "just now"} ago`
    : status.lastDisconnectReason || "never connected";
  lastEventValue.textContent = lastEvent;

  // Pairing is only in the way when the token itself is the problem.
  pairing.hidden = status.paired !== false && !status.pairingRequired;
  // The reconnect button stays available at all times: a connection that only
  // looks healthy is exactly when the user needs to force a fresh one.
  reconnectBtn.hidden = false;
  reconnectBtn.disabled = false;
  // Offer "Re-pair" whenever the token box is hidden — that is exactly the
  // stuck-with-a-stored-token case where the box is otherwise unreachable.
  repairBtn.hidden = !pairing.hidden;
}

function applyResponse(response) {
  if (response) updateUI(response);
}

function fetchStatus() {
  chrome.runtime.sendMessage({ action: "getStatus" }, applyResponse);
}

/** Ask the worker to prove the connection with a live round trip to the server. */
function verifyStatus() {
  chrome.runtime.sendMessage({ action: "verifyConnection" }, applyResponse);
}

reconnectBtn.addEventListener("click", () => {
  reconnectBtn.disabled = true;
  statusDot.className = "dot pending";
  statusText.textContent = "Reconnecting";
  statusDetail.textContent = "Tearing down the current socket and starting over.";
  chrome.runtime.sendMessage({ action: "reconnect" }, () => {
    setTimeout(verifyStatus, 1200);
  });
});

repairBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "enterPairingMode" }, () => {
    fetchStatus();
    pairingToken.focus();
  });
});

pairBtn.addEventListener("click", () => {
  pairError.textContent = "";
  const token = pairingToken.value.trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    pairError.textContent = `Token must be exactly 64 hexadecimal characters (received ${token.length})`;
    pairingToken.focus();
    return;
  }
  chrome.runtime.sendMessage(
    { action: "setPairingToken", token },
    (response) => {
      if (!response?.success) {
        pairError.textContent = response?.error || "Could not save token";
        return;
      }
      pairingToken.value = "";
      statusText.textContent = "Authenticating";
      setTimeout(verifyStatus, 800);
    }
  );
});

pairingToken.addEventListener("input", () => {
  pairError.textContent = "";
});

// Show the installed extension version, sourced from the manifest.
const versionValue = document.getElementById("versionValue");
const manifest = chrome.runtime.getManifest?.();
if (versionValue && manifest) versionValue.textContent = `v${manifest.version}`;

// Verify on open so the badge reflects the server's view, not just ours.
verifyStatus();
setInterval(fetchStatus, 2000);
