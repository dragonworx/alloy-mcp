import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const documentationFiles = [
  "README.md",
  "SECURITY.md",
  ...readdirSync(resolve(repositoryRoot, "doc"))
    .filter(file => file.endsWith(".md"))
    .map(file => `doc/${file}`),
];

describe("documentation", () => {
  test("local Markdown links resolve", () => {
    for (const relativePath of documentationFiles) {
      const absolutePath = resolve(repositoryRoot, relativePath);
      const source = readFileSync(absolutePath, "utf8");
      const links = source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);

      for (const [, rawTarget] of links) {
        if (/^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
        const target = decodeURIComponent(rawTarget.split("#", 1)[0]);
        expect(existsSync(resolve(dirname(absolutePath), target))).toBe(true);
      }
    }
  });

  test("copyable JSON examples parse", () => {
    for (const relativePath of ["README.md", "doc/SETUP.md", "doc/VSCODE-COPILOT.md"]) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), "utf8");
      const examples = source.matchAll(/```json\n([\s\S]*?)\n```/g);

      for (const [, json] of examples) {
        expect(() => JSON.parse(json)).not.toThrow();
      }
    }
  });

  test("setup uses the lockfile and provisions pairing", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    expect(packageJson.scripts.setup).toContain("bun install --frozen-lockfile");
    expect(packageJson.scripts.setup).toContain("bun run pair");
    expect(packageJson.scripts["add-to-claude"]).toContain('"$(pwd)/server/src/server.ts"');
  });

  test("local agent permissions cannot be committed", () => {
    const gitignore = readFileSync(resolve(repositoryRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain("**/.claude/settings.local.json");
  });
});