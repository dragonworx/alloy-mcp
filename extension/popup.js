const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const info = document.getElementById("info");
const pairing = document.getElementById("pairing");
const pairingToken = document.getElementById("pairingToken");
const pairBtn = document.getElementById("pairBtn");
const pairError = document.getElementById("pairError");
const reconnectBtn = document.getElementById("reconnectBtn");

function updateUI(status) {
  if (status.connected) {
    statusDot.className = "dot connected";
    statusText.textContent = "Connected to MCP server";
  } else {
    statusDot.className = "dot disconnected";
    statusText.textContent = status.authError || "Disconnected";
  }

  document.getElementById("serverValue").textContent = status.url;
  document.getElementById("toolsValue").textContent = status.toolCount;
  document.getElementById("attemptsValue").textContent = status.reconnectAttempts;
  pairing.hidden = status.connected;
  reconnectBtn.hidden = status.connected;
}

function fetchStatus() {
  chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
    if (response) updateUI(response);
  });
}

reconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "reconnect" }, () => {
    statusText.textContent = "Reconnecting...";
    setTimeout(fetchStatus, 1500);
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
      statusText.textContent = "Authenticating...";
      setTimeout(fetchStatus, 500);
    }
  );
});

pairingToken.addEventListener("input", () => {
  pairError.textContent = "";
});

fetchStatus();
setInterval(fetchStatus, 3000);
