import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

class FakeElement {
  className = "";
  hidden = false;
  textContent = "";
  value = "";
  private listeners = new Map<string, () => void>();

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  dispatch(event: string): void {
    this.listeners.get(event)?.();
  }

  focus(): void {}
}

test("pairing validation survives connection status refreshes", () => {
  const elements = new Map(
    [
      "statusDot",
      "statusText",
      "info",
      "pairing",
      "pairingToken",
      "pairBtn",
      "pairError",
      "reconnectBtn",
      "serverValue",
      "toolsValue",
      "attemptsValue",
    ].map(id => [id, new FakeElement()])
  );
  const intervalCallbacks: Array<() => void> = [];
  const messages: string[] = [];
  const popupSource = readFileSync(resolve(import.meta.dir, "../../extension/popup.js"), "utf8");

  runInNewContext(popupSource, {
    chrome: {
      runtime: {
        sendMessage(message: { action: string }, callback: (response: unknown) => void) {
          messages.push(message.action);
          if (message.action === "getStatus") {
            callback({
              connected: false,
              authError: "Pairing token required",
              url: "ws://localhost:3001",
              reconnectAttempts: 1,
              toolCount: 0,
            });
          }
        },
      },
    },
    document: {
      getElementById(id: string) {
        return elements.get(id);
      },
    },
    setInterval(callback: () => void) {
      intervalCallbacks.push(callback);
      return 1;
    },
    setTimeout() {
      return 1;
    },
  });

  const pairingToken = elements.get("pairingToken")!;
  const pairError = elements.get("pairError")!;
  pairingToken.value = "a".repeat(54);
  elements.get("pairBtn")!.dispatch("click");

  expect(pairError.textContent).toBe(
    "Token must be exactly 64 hexadecimal characters (received 54)"
  );
  expect(messages).not.toContain("setPairingToken");

  intervalCallbacks[0]();
  expect(pairError.textContent).toBe(
    "Token must be exactly 64 hexadecimal characters (received 54)"
  );
});
