import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { allTools, serverOnlyToolNames } from "../src/tools.js";

describe("MCP tool parity", () => {
  test("every exposed browser tool has an extension handler", () => {
    const backgroundSource = readFileSync(
      resolve(import.meta.dir, "../../extension/background.js"),
      "utf8"
    );
    const handlerNames = new Set(
      Array.from(backgroundSource.matchAll(/^  async ([a-z_]+)\(params\) \{/gm), match => match[1])
    );
    const serverOnly = new Set<string>(serverOnlyToolNames);
    const missing = Object.keys(allTools).filter(
      toolName => !serverOnly.has(toolName) && !handlerNames.has(toolName)
    );

    expect(missing).toEqual([]);
  });

  test("does not expose unverified workflow and synthetic tools", () => {
    const toolNames = new Set(Object.keys(allTools));
    expect(toolNames.has("start_journey_recording")).toBe(false);
    expect(toolNames.has("replay_journey")).toBe(false);
    expect(toolNames.has("clipboard_action")).toBe(false);
    expect(toolNames.has("touch_event")).toBe(false);
  });

  test("does not expose non-MCP screenshot encodings", () => {
    expect("encoding" in allTools.take_screenshot.schema.shape).toBe(false);
  });

  test("requires a complete drag destination", () => {
    const base = { sourceSelector: "#source", tabId: 1 };
    expect(allTools.drag_and_drop.schema.safeParse(base).success).toBe(false);
    expect(allTools.drag_and_drop.schema.safeParse({ ...base, targetSelector: "#target" }).success).toBe(true);
    expect(allTools.drag_and_drop.schema.safeParse({
      ...base,
      targetCoordinates: { x: 10, y: 20 },
    }).success).toBe(true);
  });

  test("bounds accessibility traversal depth", () => {
    const schema = allTools.get_accessibility_tree.schema;
    expect(schema.safeParse({ maxDepth: 32, tabId: 1 }).success).toBe(true);
    expect(schema.safeParse({ maxDepth: 33, tabId: 1 }).success).toBe(false);
    expect(schema.safeParse({ maxDepth: 1.5, tabId: 1 }).success).toBe(false);
  });
});