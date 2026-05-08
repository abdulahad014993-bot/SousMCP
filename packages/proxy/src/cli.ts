#!/usr/bin/env node
// SousMCP CLI — install / uninstall / start / status / log / digest / export / verify

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import * as https from "node:https";
import { spawn } from "node:child_process";
import chalk from "chalk";
import { LogStore } from "./store.js";
import { PolicyEngine } from "./policy.js";
import { printMessages } from "./display.js";
import { buildDigestData, formatDigest } from "./digest.js";
import { exportBundle, verifyBundle } from "./export.js";
import {
  loadConfig, saveConfig, isLearningMode, daysRemainingInLearning,
  SOUSMCP_DIR, CONFIG_FILE,
} from "./config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const HOME = os.homedir();

// All known MCP clients, in detection priority order.
interface KnownClient extends ConfigTarget {
  id: string;
}

const KNOWN_CLIENTS: KnownClient[] = [
  {
    id: "claude-desktop",
    clientName: "Claude Desktop",
    configPath: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    backupPath: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json.sousmcp.bak"),
    restartMsg: "Restart Claude Desktop to apply changes.",
  },
  {
    id: "cursor",
    clientName: "Cursor",
    configPath: path.join(HOME, ".cursor", "mcp.json"),
    backupPath: path.join(HOME, ".cursor", "mcp.json.sousmcp.bak"),
    restartMsg: "Restart Cursor to apply changes.",
  },
  {
    id: "claude-code",
    clientName: "Claude Code",
    configPath: path.join(HOME, ".claude.json"),
    backupPath: path.join(HOME, ".claude.json.sousmcp.bak"),
    restartMsg: "Restart Claude Code to apply changes.",
  },
];

// Keep a reference to the first client for legacy paths that assumed Claude Desktop.
const CLAUDE_CONFIG = KNOWN_CLIENTS[0].configPath;

interface ConfigTarget {
  configPath: string;
  backupPath: string;
  clientName: string;
  restartMsg: string;
}

// Returns explicit target(s) from flags, or empty array for auto-detect mode.
function resolveTargets(flags: Record<string, string>): ConfigTarget[] {
  if (flags["config"]) {
    const p = path.resolve(flags["config"]);
    return [{ configPath: p, backupPath: p + ".sousmcp.bak", clientName: path.basename(p), restartMsg: "" }];
  }
  if (flags["client"]) {
    const c = KNOWN_CLIENTS.find(k => k.id === flags["client"]);
    if (!c) {
      err(`Unknown client: ${flags["client"]}. Known: ${KNOWN_CLIENTS.map(k => k.id).join(", ")}`);
      return [];
    }
    return [c];
  }
  // Legacy flags kept for backwards compatibility.
  if (flags["cursor"] === "true") return [KNOWN_CLIENTS.find(k => k.id === "cursor")!];
  return []; // auto-detect
}

// Scans for installed clients and returns those with a valid config file.
function detectInstalledClients(): Array<{ client: KnownClient; servers: Record<string, MCPServer> }> {
  const found: Array<{ client: KnownClient; servers: Record<string, MCPServer> }> = [];
  for (const client of KNOWN_CLIENTS) {
    if (!fs.existsSync(client.configPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(client.configPath, "utf8")) as ClaudeConfig;
      const servers = parsed.mcpServers ?? {};
      found.push({ client, servers });
    } catch { /* skip invalid configs */ }
  }
  return found;
}

function printDryRunDiff(
  toWrap: string[],
  before: Record<string, MCPServer>,
  after: Record<string, MCPServer>
): void {
  process.stdout.write(chalk.bold.yellow("\nDry run — no changes applied.\n\n"));
  if (toWrap.length === 0) {
    process.stdout.write(chalk.dim("  No changes would be made.\n\n"));
    return;
  }
  process.stdout.write(`Would wrap ${toWrap.length} server${toWrap.length > 1 ? "s" : ""}: ` +
    chalk.cyan(toWrap.join(", ")) + "\n\n");
  for (const name of toWrap) {
    const b = before[name];
    const a = after[name];
    process.stdout.write(chalk.bold(`  ${name}:\n`));
    process.stdout.write(chalk.red(`  - command: ${b.command}\n`));
    if ((b.args ?? []).length) process.stdout.write(chalk.red(`  - args:    ${JSON.stringify(b.args)}\n`));
    process.stdout.write(chalk.green(`  + command: ${a.command}\n`));
    process.stdout.write(chalk.green(`  + args:    ${JSON.stringify(a.args)}\n`));
    process.stdout.write("\n");
  }
}

function printMissingClientMessage(): void {
  process.stdout.write(
    chalk.yellow("\nClaude Desktop not found.") +
    " SousMCP also works with Cursor and any MCP client.\n\n" +
    chalk.bold("Options:\n") +
    `  ${chalk.cyan("sousmcp install --cursor")}           Wrap Cursor MCP servers\n` +
    `  ${chalk.cyan("sousmcp install --config <path>")}    Wrap servers in any JSON config file\n\n` +
    chalk.bold("Manual setup:\n") +
    "  Wrap your MCP server command like this:\n\n" +
    chalk.red(`  before: { "command": "python3", "args": ["server.py"] }\n`) +
    chalk.green(`  after:  { "command": "${NODE_BIN}",\n`) +
    chalk.green(`            "args": ["${PROXY_SCRIPT}", "python3", "server.py"] }\n\n`)
  );

  fs.mkdirSync(SOUSMCP_DIR, { recursive: true });
  const templatePath = path.join(SOUSMCP_DIR, "client-config.json");
  if (!fs.existsSync(templatePath)) {
    const template = {
      _instructions: "Wrap your MCP servers using this pattern, then paste into your MCP client config.",
      mcpServers: {
        "your-server-name": {
          command: NODE_BIN,
          args: [PROXY_SCRIPT, "<your-server-command>", "<args...>"],
          env: { SOUSMCP_DB: path.join(SOUSMCP_DIR, "sousmcp.db") },
        },
      },
    };
    fs.writeFileSync(templatePath, JSON.stringify(template, null, 2), "utf8");
    ok(`Created setup template at ${templatePath}`);
  }
}

// The proxy daemon is always in dist/index.js alongside the compiled CLI.
// __dirname is the dist/ dir in CommonJS output, regardless of how the CLI
// was invoked (directly or through the bin/ wrapper).
const PROXY_SCRIPT = path.resolve(__dirname, "index.js");
const NODE_BIN = process.execPath;

interface MCPServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface ClaudeConfig {
  mcpServers?: Record<string, MCPServer>;
  [k: string]: unknown;
}

function isWrapped(s: MCPServer): boolean {
  return s.args !== undefined && s.args.some(a => a.endsWith("sousmcp") || a.includes("dist/index.js"));
}

function ok(msg: string): void { process.stdout.write(chalk.green("✓ ") + msg + "\n"); }
function warn(msg: string): void { process.stdout.write(chalk.yellow("⚠ ") + msg + "\n"); }
function err(msg: string): void { process.stdout.write(chalk.red("✗ ") + msg + "\n"); }
function info(msg: string): void { process.stdout.write(chalk.dim("  ") + msg + "\n"); }
function heading(msg: string): void { process.stdout.write("\n" + chalk.bold.white(msg) + "\n" + "─".repeat(48) + "\n"); }

function parseDate(s: string): Date {
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true"; // boolean flag
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function checkApiRunning(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.setTimeout(400);
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

function openStore(): LogStore {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.dbPath)) {
    err(`Database not found at ${cfg.dbPath}. Run 'sousmcp install' first.`);
    process.exit(1);
  }
  return new LogStore(cfg.dbPath);
}

// ── sousmcp install helpers ────────────────────────────────────────────────

async function promptYN(question: string, defaultY = true): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultY;
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data: unknown) => {
      process.stdin.pause();
      const s = String(data).trim().toLowerCase();
      resolve(s === "" ? defaultY : s.startsWith("y"));
    });
  });
}

async function wrapOneTarget(target: ConfigTarget, dryRun: boolean): Promise<void> {
  const { configPath, backupPath, clientName, restartMsg } = target;

  if (!fs.existsSync(configPath)) {
    const known = KNOWN_CLIENTS.find(k => k.configPath === configPath);
    if (known?.id === "cursor") {
      warn(`Cursor MCP config not found at ${configPath}`);
      info("Open Cursor → Settings → MCP, add a server, then re-run.");
    } else if (known?.id === "claude-code") {
      warn(`Claude Code MCP config not found at ${configPath}`);
      info("Run 'claude mcp add --global <name> <command>' first.");
    } else {
      err(`Config file not found: ${configPath}`);
    }
    return;
  }

  let raw: string;
  let claudeCfg: ClaudeConfig;
  try {
    raw = fs.readFileSync(configPath, "utf8");
    claudeCfg = JSON.parse(raw) as ClaudeConfig;
  } catch (e) { err(`Cannot read ${configPath}: ${String(e)}`); return; }

  const cfg = loadConfig();
  const servers = claudeCfg.mcpServers ?? {};
  const toWrap: string[] = [];
  const alreadyWrapped: string[] = [];
  const afterServers: Record<string, MCPServer> = JSON.parse(JSON.stringify(servers));

  for (const [name, server] of Object.entries(afterServers)) {
    if (isWrapped(server)) { alreadyWrapped.push(name); continue; }
    server.args = [PROXY_SCRIPT, server.command, ...(server.args ?? [])];
    server.command = NODE_BIN;
    server.env = { ...(server.env ?? {}), SOUSMCP_DB: cfg.dbPath };
    toWrap.push(name);
  }

  if (dryRun) {
    process.stdout.write(chalk.bold(`\n${clientName}:\n`));
    printDryRunDiff(toWrap, servers, afterServers);
    return;
  }

  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, raw, "utf8");
    ok(`Backed up original ${clientName} config`);
  }

  claudeCfg.mcpServers = afterServers;
  fs.writeFileSync(configPath, JSON.stringify(claudeCfg, null, 2), "utf8");

  if (alreadyWrapped.length > 0) info(`Already wrapped: ${alreadyWrapped.join(", ")}`);
  if (toWrap.length > 0) {
    ok(`Wrapped ${toWrap.length} MCP server${toWrap.length > 1 ? "s" : ""}: ${toWrap.join(", ")}`);
  } else {
    info("All servers were already wrapped — nothing changed.");
  }
  if (restartMsg) process.stdout.write(`\n${restartMsg}\n`);
}

// ── sousmcp install ────────────────────────────────────────────────────────

async function cmdInstall(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const dryRun = flags["dry-run"] === "true";

  // One-time first-run initialisation regardless of how many clients we wrap.
  const firstRun = !fs.existsSync(SOUSMCP_DIR);
  if (!dryRun) {
    if (firstRun) {
      process.stdout.write(chalk.bold.cyan("\nWelcome to SousMCP\n") +
        "─".repeat(48) + "\n" +
        "SousMCP sits between Claude and your MCP servers, logging\n" +
        "every tool call to a tamper-evident database.\n\n"
      );
    }
    fs.mkdirSync(SOUSMCP_DIR, { recursive: true });
    let cfg = loadConfig();
    if (firstRun || !fs.existsSync(CONFIG_FILE)) {
      cfg.learningModeStarted = Date.now();
      cfg.learningMode = true;
      saveConfig(cfg);
    }
    const store = new LogStore(cfg.dbPath);
    store.close();
    new PolicyEngine();
    if (firstRun) {
      ok("Created ~/.sousmcp/"); ok("Initialized database"); ok("Written default policies");
    }
  }

  if (!fs.existsSync(PROXY_SCRIPT)) {
    err(`Proxy binary not found at ${PROXY_SCRIPT}`);
    info("Run 'npm run build' first.");
    return;
  }

  // Determine targets: explicit flag(s) or auto-detect.
  const explicit = resolveTargets(flags);
  let targets: ConfigTarget[];

  if (explicit.length > 0) {
    targets = explicit;
  } else {
    const detected = detectInstalledClients();
    if (detected.length === 0) { printMissingClientMessage(); return; }

    process.stdout.write(chalk.bold("\nFound MCP clients:\n"));
    for (const { client, servers } of detected) {
      const wrappedCount = Object.values(servers).filter(isWrapped).length;
      const total = Object.keys(servers).length;
      process.stdout.write(
        `  ${chalk.cyan(client.clientName.padEnd(16))}  ${total} server${total !== 1 ? "s" : ""}` +
        (wrappedCount > 0 ? chalk.dim(` (${wrappedCount} already wrapped)`) : "") + "\n"
      );
    }
    process.stdout.write("\n");

    if (!dryRun && !(await promptYN("Wrap all? [Y/n] "))) return;
    targets = detected.map(d => d.client);
  }

  for (const target of targets) {
    await wrapOneTarget(target, dryRun);
  }

  if (!dryRun && firstRun) {
    const cfg = loadConfig();
    process.stdout.write(
      "\n" + chalk.bold.yellow(`Learning mode enabled for ${cfg.learningModeDays} days`) +
      " — will log and notify but won't block yet.\n" +
      `Run ${chalk.cyan("'sousmcp policies --strict'")} to enforce immediately.\n\n` +
      `  ${chalk.cyan("sousmcp status")}   — check everything is running\n` +
      `  ${chalk.cyan("sousmcp log")}      — see what's been intercepted\n\n`
    );
  }
}

// ── sousmcp uninstall ──────────────────────────────────────────────────────

async function cmdUninstall(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  // Default to Claude Desktop when no explicit target given.
  const { configPath, backupPath, clientName, restartMsg } = resolveTargets(flags)[0] ?? KNOWN_CLIENTS[0];

  if (fs.existsSync(backupPath)) {
    // Happy path: restore from backup created at install time.
    const backup = fs.readFileSync(backupPath, "utf8");
    fs.writeFileSync(configPath, backup, "utf8");
    fs.unlinkSync(backupPath);
    ok(`Restored original ${clientName} config from backup`);
  } else if (fs.existsSync(configPath)) {
    // No backup — unwrap wrapped servers in place.
    try {
      const claudeCfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as ClaudeConfig;
      const servers = claudeCfg.mcpServers ?? {};
      let unwrapped = 0;
      for (const [, server] of Object.entries(servers)) {
        if (!isWrapped(server)) continue;
        const idx = server.args!.findIndex(a => a.includes("dist/index.js"));
        if (idx === -1) continue;
        const origCmd = server.args![idx + 1];
        const origArgs = server.args!.slice(idx + 2);
        server.command = origCmd;
        server.args = origArgs.length > 0 ? origArgs : undefined;
        if (server.env) {
          delete server.env["SOUSMCP_DB"];
          if (Object.keys(server.env).length === 0) delete server.env;
        }
        unwrapped++;
      }
      fs.writeFileSync(configPath, JSON.stringify(claudeCfg, null, 2), "utf8");
      ok(`Unwrapped ${unwrapped} server${unwrapped !== 1 ? "s" : ""} from ${clientName} config`);
    } catch (e) {
      err(`Could not unwrap config: ${String(e)}`); return;
    }
  } else {
    err(`Config not found: ${configPath}`);
    info("Was SousMCP ever installed?");
    return;
  }

  if (restartMsg) info(restartMsg);
  info("Your log database and policies remain at ~/.sousmcp/ for reference.");
}

// ── sousmcp status ─────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();

  heading("SousMCP Status");

  // Clients
  process.stdout.write(chalk.bold("MCP Clients:\n"));
  const detected = detectInstalledClients();
  if (detected.length === 0) {
    process.stdout.write(chalk.dim("  No known MCP clients found — run 'sousmcp install'\n"));
  } else {
    for (const { client, servers } of detected) {
      const entries = Object.entries(servers);
      const wrapped = entries.filter(([, s]) => isWrapped(s));
      let status: string;
      if (entries.length === 0) {
        status = chalk.dim("no servers configured");
      } else if (wrapped.length === entries.length) {
        status = chalk.green(`active`) + ` — ${wrapped.length}/${entries.length} server${entries.length !== 1 ? "s" : ""} wrapped`;
      } else if (wrapped.length > 0) {
        status = chalk.yellow(`partial`) + ` — ${wrapped.length}/${entries.length} wrapped`;
      } else {
        status = chalk.dim("not wrapped") + " — run 'sousmcp install'";
      }
      process.stdout.write(`  ${chalk.cyan(client.clientName.padEnd(16))}  ${status}\n`);
      if (wrapped.length > 0) info(wrapped.map(([n]) => n).join(", "));
    }
  }
  for (const client of KNOWN_CLIENTS) {
    if (!detected.find(d => d.client.id === client.id)) {
      process.stdout.write(`  ${chalk.dim(client.clientName.padEnd(16))}  ${chalk.dim("not installed")}\n`);
    }
  }
  process.stdout.write("\n");

  // Database
  process.stdout.write(chalk.bold("Database:      ") + cfg.dbPath + "\n");
  if (fs.existsSync(cfg.dbPath)) {
    try {
      const store = new LogStore(cfg.dbPath);
      const stats = store.getStats();
      const last = store.getLastSession();
      store.close();
      info(`${stats.totalMessages.toLocaleString()} total messages · ${stats.sessionsToday} session${stats.sessionsToday !== 1 ? "s" : ""} today`);
      if (last) {
        const ago = Math.round((Date.now() - last.startedAt) / 60_000);
        info(`Last active: ${ago < 60 ? `${ago} min ago` : `${Math.round(ago / 60)} hr ago`} (${last.serverName})`);
      }
    } catch (e) { warn(`Could not read database: ${String(e)}`); }
  } else {
    warn("Database not found — run 'sousmcp install'");
  }

  // Policies
  process.stdout.write(chalk.bold("Policies:      ") + cfg.dbPath.replace("sousmcp.db", "policies.yaml") + "\n");
  try {
    const policy = new PolicyEngine();
    const rules = policy.getRules();
    const blocks = rules.filter(r => r.action === "block").length;
    const pauses = rules.filter(r => r.action === "pause").length;
    const logs = rules.filter(r => r.action === "log").length;
    info(`${rules.length} rules: ${blocks} block, ${pauses} pause, ${logs} log`);
  } catch { warn("Could not load policies"); }

  // Learning mode
  if (isLearningMode(cfg)) {
    const days = daysRemainingInLearning(cfg);
    process.stdout.write(chalk.bold("Learning mode: ") + chalk.yellow(`active (${days.toFixed(1)} days remaining)`) + "\n");
  } else {
    process.stdout.write(chalk.bold("Learning mode: ") + chalk.dim("disabled — policies enforced strictly") + "\n");
  }

  // API
  const apiRunning = await checkApiRunning(cfg.apiPort);
  const apiStatus = apiRunning
    ? chalk.green(`running at http://127.0.0.1:${cfg.apiPort}`)
    : chalk.dim(`not running (starts automatically with proxy)`);
  process.stdout.write(chalk.bold("API server:    ") + apiStatus + "\n\n");

  // Update check (non-blocking — skip if offline)
  const newer = await checkForUpdate();
  if (newer) {
    process.stdout.write(
      chalk.yellow(`Update available: v${newer}\n`) +
      `  Run: ${chalk.cyan("npm install -g @sousmcp/proxy")}\n\n`
    );
  }
}

// ── sousmcp log ────────────────────────────────────────────────────────────

async function cmdLog(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const sessionId = flags["session"];
  const count = parseInt(flags["n"] ?? "30", 10);

  const store = openStore();
  let rows = store.getMessages(sessionId);
  const chainValid = store.verifyChain();
  store.close();

  rows = rows.slice(-count);
  const title = sessionId ? `session ${sessionId.slice(0, 8)}…` : "recent messages";
  printMessages(rows, chainValid, title);
}

// ── sousmcp digest ─────────────────────────────────────────────────────────

async function cmdDigest(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);

  const cfg = loadConfig();
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);

  if (!fs.existsSync(cfg.dbPath)) {
    err("Database not found. Run 'sousmcp install' first.");
    return;
  }

  const store = new LogStore(cfg.dbPath);
  const data = buildDigestData(store, from, to);
  store.close();

  const text = formatDigest(data);

  if (flags["out"]) {
    fs.writeFileSync(flags["out"], text, "utf8");
    ok(`Digest written to ${flags["out"]}`);
  } else {
    process.stdout.write(text);
  }

  // Update lastDigest timestamp
  cfg.lastDigest = Date.now();
  saveConfig(cfg);
}

// ── sousmcp export ─────────────────────────────────────────────────────────

async function cmdExport(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);

  if (!flags["from"] || !flags["to"]) {
    err("Usage: sousmcp export --from YYYY-MM-DD --to YYYY-MM-DD [--out report.json]");
    return;
  }

  let from: Date, to: Date;
  try { from = parseDate(flags["from"]); to = parseDate(flags["to"]); }
  catch (e) { err(String(e)); return; }

  to.setUTCHours(23, 59, 59, 999);

  const outFile = flags["out"] || "report.json";

  const cfg = loadConfig();
  if (!fs.existsSync(cfg.dbPath)) { err("Database not found. Run 'sousmcp install' first."); return; }

  const store = new LogStore(cfg.dbPath);
  const bundle = exportBundle(store, from, to, outFile);
  store.close();

  ok(`Exported ${bundle.messages.length} messages (${bundle.sessions.length} sessions) to ${outFile}`);
  info(`Bundle hash: ${bundle.bundleHash}`);
  info(`Use 'sousmcp verify ${outFile}' to verify integrity.`);
}

// ── sousmcp verify ─────────────────────────────────────────────────────────

async function cmdVerify(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const file = positional[0];

  if (!file) { err("Usage: sousmcp verify <file>"); return; }
  if (!fs.existsSync(file)) { err(`File not found: ${file}`); return; }

  const result = verifyBundle(file);

  if (result.ok) {
    ok(`Bundle is intact — ${result.stats.messages} messages, ${result.stats.sessions} sessions`);
    info("SHA-256 hash verified · Merkle chain intact · No tampering detected");
  } else {
    err(`Verification FAILED — ${result.errors.length} error${result.errors.length > 1 ? "s" : ""}`);
    for (const e of result.errors) info(e);
  }
}

// ── sousmcp policies ───────────────────────────────────────────────────────

async function cmdPolicies(args: string[]): Promise<void> {
  if (args.includes("--strict")) {
    const cfg = loadConfig();
    cfg.learningMode = false;
    saveConfig(cfg);
    ok("Learning mode disabled — policies are now enforced strictly");
    info("Restart the proxy for changes to take effect.");
    return;
  }

  if (args.includes("--learning")) {
    const cfg = loadConfig();
    cfg.learningMode = true;
    cfg.learningModeStarted = Date.now();
    saveConfig(cfg);
    ok("Learning mode enabled — block/pause rules will log-and-notify only");
    return;
  }

  // Default: show current policies
  try {
    const policy = new PolicyEngine();
    const rules = policy.getRules();
    heading("Active Policies");
    for (const rule of rules) {
      const actionColor = rule.action === "block"
        ? chalk.red(rule.action)
        : rule.action === "pause" ? chalk.yellow(rule.action) : chalk.dim(rule.action);
      process.stdout.write(`  ${chalk.cyan(rule.name)}\n`);
      info(`method: ${rule.matchMethod}  action: ${actionColor}`);
      if (rule.matchToolName) info(`tool: ${rule.matchToolName}`);
      if (rule.matchArgPattern) info(`pattern: ${rule.matchArgPattern}`);
      process.stdout.write("\n");
    }
    process.stdout.write(chalk.dim(`File: ${policy.filePath}\n`));
    process.stdout.write(chalk.dim("Options: --strict  --learning\n\n"));
  } catch (e) { err(`Could not load policies: ${String(e)}`); }
}

// ── sousmcp start ──────────────────────────────────────────────────────────

async function cmdStart(): Promise<void> {
  if (!fs.existsSync(CLAUDE_CONFIG)) {
    err("Claude Desktop config not found. Run 'sousmcp install' first.");
    return;
  }

  const cfg = loadConfig();
  fs.mkdirSync(SOUSMCP_DIR, { recursive: true });

  const claudeCfg = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, "utf8")) as ClaudeConfig;
  const servers = Object.entries(claudeCfg.mcpServers ?? {});

  if (servers.length === 0) {
    warn("No MCP servers configured. Run 'sousmcp install' first.");
    return;
  }

  heading("SousMCP Multi-Server Start");

  const children: ReturnType<typeof spawn>[] = [];

  for (const [name, server] of servers) {
    // Extract original command — unwrap if already wrapped by SousMCP.
    let origCmd: string;
    let origArgs: string[];
    if (isWrapped(server)) {
      const idx = server.args!.findIndex(a => a.includes("dist/index.js"));
      const tail = server.args!.slice(idx + 1);
      origCmd = tail[0] ?? server.command;
      origArgs = tail.slice(1);
    } else {
      origCmd = server.command;
      origArgs = server.args ?? [];
    }

    const child = spawn(
      NODE_BIN,
      [PROXY_SCRIPT, origCmd, ...origArgs],
      {
        env: { ...process.env, SOUSMCP_DB: cfg.dbPath },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    child.on("exit", code => {
      warn(`${name} exited (code ${code ?? "?"})`);
    });

    children.push(child);
    ok(`${name}: ${origCmd} ${origArgs.join(" ")}`);
  }

  ok(`${children.length} server(s) started. API → http://127.0.0.1:${cfg.apiPort}`);
  info("Press Ctrl+C to stop all.");

  const stopAll = () => {
    for (const c of children) { try { c.kill("SIGTERM"); } catch { /* ignore */ } }
    process.exit(0);
  };
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);

  await new Promise<never>(() => { /* block until signal */ });
}

// ── sousmcp doctor ─────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  heading("SousMCP Doctor");

  let allOk = true;

  function check(label: string, passed: boolean, fix?: string): void {
    if (passed) {
      process.stdout.write(chalk.green("✓ ") + label + "\n");
    } else {
      allOk = false;
      process.stdout.write(chalk.red("✗ ") + label + "\n");
      if (fix) info(`Fix: ${fix}`);
    }
  }

  // 1. Node version
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  check(
    `Node.js ${process.versions.node} (requires ≥ 22)`,
    nodeMajor >= 22,
    "Install Node.js 22+ from https://nodejs.org"
  );

  // 2. Claude Desktop app directory
  const claudeDir = path.dirname(CLAUDE_CONFIG);
  check(
    "Claude Desktop app directory found",
    fs.existsSync(claudeDir),
    "Install Claude Desktop from https://claude.ai/download"
  );

  // 3. Claude Desktop config exists and is valid JSON
  let configParsed: ClaudeConfig | null = null;
  if (fs.existsSync(CLAUDE_CONFIG)) {
    try { configParsed = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, "utf8")) as ClaudeConfig; }
    catch { /* invalid JSON */ }
  }
  check(
    "Claude Desktop config exists and is valid JSON",
    configParsed !== null,
    `Open Claude Desktop once if config is missing (${CLAUDE_CONFIG})`
  );

  // 4. At least one server is wrapped
  if (configParsed) {
    const servers = Object.entries(configParsed.mcpServers ?? {});
    const wrapped = servers.filter(([, s]) => isWrapped(s));
    check(
      `SousMCP is wrapping ${wrapped.length} of ${servers.length} MCP server(s)`,
      wrapped.length > 0 || servers.length === 0,
      servers.length > 0 ? "Run 'sousmcp install' to wrap your servers" : "Add MCP servers to Claude Desktop, then run 'sousmcp install'"
    );
  }

  // 5. SousMCP config directory
  check(
    "~/.sousmcp/ config directory exists",
    fs.existsSync(SOUSMCP_DIR),
    "Run 'sousmcp install' to initialise"
  );

  // 6. Database accessible + chain valid
  const cfg = loadConfig();
  let dbAccessible = false;
  let chainOk = false;
  if (fs.existsSync(cfg.dbPath)) {
    try {
      const store = new LogStore(cfg.dbPath);
      chainOk = store.verifyChain();
      store.close();
      dbAccessible = true;
    } catch { /* db inaccessible */ }
  }
  check(
    "Database accessible",
    dbAccessible,
    "Run 'sousmcp install' to initialise the database"
  );
  if (dbAccessible) {
    check(
      "Merkle chain intact (no tampering detected)",
      chainOk,
      "Chain is broken — log may have been modified outside SousMCP"
    );
  }

  // 7. Port available (or SousMCP already listening)
  const apiRunning = await checkApiRunning(cfg.apiPort);
  if (!apiRunning) {
    const portFree = await new Promise<boolean>(resolve => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => { s.close(); resolve(true); });
      s.listen(cfg.apiPort, "127.0.0.1");
    });
    check(
      `Port ${cfg.apiPort} available for API server`,
      portFree,
      `Another process owns :${cfg.apiPort} — set "apiPort" in ~/.sousmcp/config.json`
    );
  } else {
    check(`API server already running on port ${cfg.apiPort}`, true);
  }

  process.stdout.write("\n");
  if (allOk) {
    ok("All checks passed — SousMCP is ready.");
  } else {
    warn("Some checks failed — follow the Fix suggestions above.");
  }
  process.stdout.write("\n");
}

// ── Auto-update check ──────────────────────────────────────────────────────

function checkForUpdate(): Promise<string | null> {
  return new Promise(resolve => {
    const req = https.get(
      "https://registry.npmjs.org/@sousmcp/proxy/latest",
      { headers: { "User-Agent": "sousmcp-cli" }, timeout: 3000 },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { version?: string };
            const latest = json.version ?? null;
            // Read current version from own package.json
            const pkgPath = path.resolve(path.dirname(process.argv[1] ?? ""), "..", "package.json");
            const current = fs.existsSync(pkgPath)
              ? (JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? null
              : null;
            resolve(latest && current && latest !== current ? latest : null);
          } catch { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ── Help ───────────────────────────────────────────────────────────────────

function printHelp(): void {
  process.stdout.write(
    `\n${chalk.bold.cyan("SousMCP")} — a transparency layer for MCP agents\n\n` +
    `${chalk.bold("Commands:")}\n` +
    `  ${chalk.cyan("install")} [--client <id>] [--config <path>] [--dry-run]  Wrap MCP servers\n` +
    `  ${chalk.cyan("uninstall")} [--client <id>] [--config <path>]            Restore config\n` +
    `  ${chalk.cyan("start")}                         Start all configured MCP servers under proxy\n` +
    `  ${chalk.cyan("status")}                         Show all clients and runtime status\n` +
    `  ${chalk.cyan("doctor")}                         Run health checks and suggest fixes\n` +
    `  ${chalk.cyan("log")} [--session <id>] [--n N]   Pretty-print recent messages\n` +
    `  ${chalk.cyan("digest")} [--out <file>]           Generate weekly activity digest\n` +
    `  ${chalk.cyan("export")} --from --to [--out]      Export signed message bundle\n` +
    `  ${chalk.cyan("verify")} <file>                   Verify a signed export bundle\n` +
    `  ${chalk.cyan("policies")} [--strict|--learning]  View / configure policies\n\n` +
    `${chalk.bold("Clients (--client):")}  claude-desktop  cursor  claude-code\n\n`
  );
}

// ── Entry point ────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);

(async () => {
  try {
    switch (cmd) {
      case "install":   await cmdInstall(rest); break;
      case "uninstall": await cmdUninstall(rest); break;
      case "start":     await cmdStart(); break;
      case "status":    await cmdStatus(); break;
      case "doctor":    await cmdDoctor(); break;
      case "log":       await cmdLog(rest); break;
      case "digest":    await cmdDigest(rest); break;
      case "export":    await cmdExport(rest); break;
      case "verify":    await cmdVerify(rest); break;
      case "policies":  await cmdPolicies(rest); break;
      default:          printHelp(); if (cmd) process.exit(1);
    }
  } catch (e) {
    err(`Unexpected error: ${String(e)}`);
    process.exit(1);
  }
})();
