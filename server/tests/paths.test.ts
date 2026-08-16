import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareOutputFile, writeOutputFile } from "../src/paths.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("output path confinement", () => {
  test("allows nested paths inside the output directory", () => {
    const root = mkdtempSync(join(tmpdir(), "alloy-mcp-paths-"));
    roots.push(root);
    expect(prepareOutputFile(root, "screenshots/page.png")).toBe(
      join(realpathSync(root), "screenshots/page.png")
    );
  });

  test("rejects traversal and symlink escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "alloy-mcp-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "alloy-mcp-outside-"));
    roots.push(root, outside);
    writeFileSync(join(outside, "secret.json"), "{}");
    symlinkSync(join(outside, "secret.json"), join(root, "link.json"));

    expect(() => prepareOutputFile(root, "../escape.txt")).toThrow();
    expect(() => prepareOutputFile(root, "link.json")).toThrow();
  });

  test("rejects a parent symlink before creating outside directories", () => {
    const root = mkdtempSync(join(tmpdir(), "alloy-mcp-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "alloy-mcp-outside-"));
    roots.push(root, outside);
    symlinkSync(outside, join(root, "linked"));

    expect(() => prepareOutputFile(root, "linked/created/page.png")).toThrow();
    expect(existsSync(join(outside, "created"))).toBe(false);
  });

  test("does not overwrite the target of a final symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "alloy-mcp-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "alloy-mcp-outside-"));
    roots.push(root, outside);
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "unchanged");
    symlinkSync(outsideFile, join(root, "result.txt"));

    expect(() => writeOutputFile(root, "result.txt", "replaced")).toThrow();
    expect(readFileSync(outsideFile, "utf8")).toBe("unchanged");
  });

  test("does not overwrite a file through a hard link", () => {
    const root = mkdtempSync(join(tmpdir(), "alloy-mcp-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "alloy-mcp-outside-"));
    roots.push(root, outside);
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "unchanged");
    linkSync(outsideFile, join(root, "result.txt"));

    expect(() => writeOutputFile(root, "result.txt", "replaced")).toThrow("multiple hard links");
    expect(readFileSync(outsideFile, "utf8")).toBe("unchanged");
  });

  test("rejects an output root writable by other users", () => {
    const root = mkdtempSync(join(tmpdir(), "alloy-mcp-paths-"));
    roots.push(root);
    chmodSync(root, 0o777);

    expect(() => writeOutputFile(root, "result.txt", "data")).toThrow("writable by group or others");
  });
});