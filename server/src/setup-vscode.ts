import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getPairingTokenPath, loadPairingToken } from "./auth.js";

const repositoryRoot = resolve(import.meta.dir, "../..");
const serverEntry = resolve(repositoryRoot, "server/src/server.ts");
const outputDirectory = resolve(repositoryRoot, "artifacts");
const bunPath = resolveBunPath();

interface Choice {
  scope: "workspace" | "global";
  install: boolean;
  print: boolean;
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const choice = await resolveChoice(flags);

  console.log("Alloy MCP — VS Code and GitHub Copilot setup\n");

  if (choice.install) {
    installServerDependencies();
  }

  const token = loadPairingToken();
  const server = buildServerEntry(choice.scope);

  if (choice.print) {
    printConfig(choice.scope, server);
  } else {
    writeConfig(choice.scope, server);
  }

  printNextSteps(choice.scope, token);
}

async function resolveChoice(flags: Set<string>): Promise<Choice> {
  const install = !flags.has("--skip-install");
  const print = flags.has("--print");

  if (flags.has("--global")) return { scope: "global", install, print };
  if (flags.has("--workspace")) return { scope: "workspace", install, print };

  if (!process.stdin.isTTY) return { scope: "workspace", install, print };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Where should Alloy MCP be registered for VS Code?\n");
    console.log("  1) This workspace only  ->  .vscode/mcp.json");
    console.log("  2) Every workspace      ->  VS Code user configuration\n");
    const answer = (await rl.question("Select 1 or 2 [1]: ")).trim();
    const scope = answer === "2" ? "global" : "workspace";
    return { scope, install, print };
  } finally {
    rl.close();
  }
}

function resolveBunPath(): string {
  if (process.execPath && /bun(\.exe)?$/i.test(process.execPath)) {
    return process.execPath;
  }
  const locator = platform() === "win32" ? "where" : "which";
  const result = spawnSync(locator, ["bun"], { encoding: "utf8" });
  const found = result.stdout?.split(/\r?\n/).find(line => line.trim().length > 0);
  return found?.trim() || "bun";
}

function installServerDependencies(): void {
  console.log("Installing locked server dependencies...\n");
  const result = spawnSync(bunPath, ["install", "--frozen-lockfile"], {
    cwd: resolve(repositoryRoot, "server"),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("bun install --frozen-lockfile failed");
  }
  console.log();
}

function buildServerEntry(scope: Choice["scope"]): Record<string, unknown> {
  if (scope === "workspace") {
    return {
      type: "stdio",
      command: "bun",
      args: ["run", "server/src/server.ts"],
      cwd: "${workspaceFolder}",
      env: { ALLOY_MCP_OUTPUT_DIR: "${workspaceFolder}/artifacts" },
    };
  }
  return {
    type: "stdio",
    command: bunPath,
    args: ["run", serverEntry],
    env: { ALLOY_MCP_OUTPUT_DIR: outputDirectory },
  };
}

function globalConfigPath(): string {
  const home = homedir();
  const candidates =
    platform() === "win32"
      ? [join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User")]
      : platform() === "darwin"
        ? [join(home, "Library", "Application Support", "Code", "User")]
        : [join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Code", "User")];

  for (const directory of candidates) {
    if (existsSync(directory)) return join(directory, "mcp.json");
  }
  return join(candidates[0], "mcp.json");
}

function readConfig(path: string): { data: Record<string, unknown>; mergeable: boolean } {
  if (!existsSync(path)) return { data: {}, mergeable: true };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") return { data: parsed, mergeable: true };
  } catch {
    // Comments or trailing commas make the file JSONC; refuse to rewrite it.
  }
  return { data: {}, mergeable: false };
}

function writeConfig(scope: Choice["scope"], server: Record<string, unknown>): void {
  const path = scope === "workspace" ? resolve(repositoryRoot, ".vscode", "mcp.json") : globalConfigPath();
  const { data, mergeable } = readConfig(path);

  if (!mergeable) {
    console.log(`Existing configuration at ${path} contains comments, so it was left untouched.`);
    console.log("Add the following entry to its \"servers\" object manually:\n");
    console.log(JSON.stringify({ alloy: server }, null, 2));
    console.log();
    return;
  }

  const servers = (data.servers as Record<string, unknown>) ?? {};
  servers.alloy = server;
  data.servers = servers;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote Alloy MCP server entry to ${path}\n`);
}

function printConfig(scope: Choice["scope"], server: Record<string, unknown>): void {
  const path = scope === "workspace" ? resolve(repositoryRoot, ".vscode", "mcp.json") : globalConfigPath();
  console.log(`Add the following to ${path}:\n`);
  console.log(JSON.stringify({ servers: { alloy: server } }, null, 2));
  console.log();
}

function printNextSteps(scope: Choice["scope"], token: string): void {
  const tokenSource = process.env.ALLOY_MCP_TOKEN ? "ALLOY_MCP_TOKEN" : getPairingTokenPath();

  console.log("Pairing token:");
  console.log(`  ${token}`);
  console.log(`  Source: ${tokenSource}\n`);

  console.log("Remaining manual steps:\n");
  console.log("  1. Open chrome://extensions and enable Developer mode.");
  console.log("  2. Select Load unpacked and choose this repository's extension/ directory.");
  console.log("  3. Open the Alloy MCP popup, paste the token above, and select Pair extension.");
  console.log("  4. In VS Code, run \"MCP: List Servers\", select alloy, and start it.");
  if (scope === "global") {
    console.log("     The user configuration applies to every workspace.");
  }
  console.log("  5. In Copilot Agent mode, run the ping, health_check, and list_tabs tools.\n");
  console.log("Only one VS Code window should own the alloy server at a time.");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
