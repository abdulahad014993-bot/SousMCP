#!/usr/bin/env node
// SousMCP CLI — install / uninstall / status / log / digest / export / verify

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
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

const CLAUDE_CONFIG = path.join(
  os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"
);
const CLAUDE_BACKUP = CLAUDE_CONFIG + ".sousmcp.bak";

// The proxy daemon lives alongside this CLI in the same dist/ directory.
const PROXY_SCRIPT = path.resolve(path.dirname(process.argv[1] ?? ""), "index.js");
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
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      flags[key] = argv[i + 1] ?? "";
      i++;
    } else {
      positional.push(argv[i]);
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

// ── sousmcp install ────────────────────────────────────────────────────────

async function cmdInstall(): Promise<void> {
  const firstRun = !fs.existsSync(SOUSMCP_DIR);

  // ── First-run onboarding ─────────────────────────────────────────────────
  if (firstRun) {
    process.stdout.write(chalk.bold.cyan("\nWelcome to SousMCP\n") +
      "─".repeat(48) + "\n" +
      "SousMCP sits between Claude and your MCP servers, logging\n" +
      "every tool call to a tamper-evident database. You can review\n" +
      "what your AI did, set policies to block or pause risky actions,\n" +
      "and get weekly digests of AI activity.\n\n"
    );
  }

  // Initialise config directory and database
  fs.mkdirSync(SOUSMCP_DIR, { recursive: true });

  let cfg = loadConfig();
  if (firstRun || !fs.existsSync(CONFIG_FILE)) {
    cfg.learningModeStarted = Date.now();
    cfg.learningMode = true;
    saveConfig(cfg);
  }

  // Initialise database
  const store = new LogStore(cfg.dbPath);
  store.close();

  // Initialise default policies
  new PolicyEngine(); // writes ~/.sousmcp/policies.yaml if absent

  if (firstRun) {
    ok("Created ~/.sousmcp/");
    ok("Initialized database");
    ok("Written default policies");
  }

  // ── Wrap Claude Desktop config ───────────────────────────────────────────
  if (!fs.existsSync(CLAUDE_CONFIG)) {
    warn("Claude Desktop config not found at:");
    info(CLAUDE_CONFIG);
    info("Start Claude Desktop at least once, then re-run 'sousmcp install'.");
    return;
  }

  if (!fs.existsSync(PROXY_SCRIPT)) {
    err(`Proxy binary not found at ${PROXY_SCRIPT}`);
    info("Run 'npm run build' first.");
    return;
  }

  const raw = fs.readFileSync(CLAUDE_CONFIG, "utf8");
  const claudeCfg = JSON.parse(raw) as ClaudeConfig;
  const servers = claudeCfg.mcpServers ?? {};

  // Back up original
  if (!fs.existsSync(CLAUDE_BACKUP)) {
    fs.writeFileSync(CLAUDE_BACKUP, raw, "utf8");
    ok("Backed up original config to " + path.basename(CLAUDE_BACKUP));
  }

  cfg = loadConfig(); // reload after potential firstRun save
  let wrapped = 0;
  const wrappedNames: string[] = [];
  const alreadyWrapped: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    if (isWrapped(server)) {
      alreadyWrapped.push(name);
      continue;
    }
    const originalArgs = server.args ?? [];
    server.args = [PROXY_SCRIPT, server.command, ...originalArgs];
    server.command = NODE_BIN;
    server.env = { ...(server.env ?? {}), SOUSMCP_DB: cfg.dbPath };
    wrapped++;
    wrappedNames.push(name);
  }

  claudeCfg.mcpServers = servers;
  fs.writeFileSync(CLAUDE_CONFIG, JSON.stringify(claudeCfg, null, 2), "utf8");

  if (alreadyWrapped.length > 0) {
    info(`Already wrapped: ${alreadyWrapped.join(", ")}`);
  }
  if (wrapped > 0) {
    ok(`Wrapped ${wrapped} MCP server${wrapped > 1 ? "s" : ""}: ${wrappedNames.join(", ")}`);
  } else {
    info("All servers were already wrapped — nothing changed.");
  }

  // ── Post-install message ─────────────────────────────────────────────────
  process.stdout.write("\n");
  if (firstRun) {
    const days = Math.ceil(cfg.learningModeDays);
    process.stdout.write(
      chalk.bold.yellow(`Learning mode enabled for ${days} days`) +
      " — SousMCP will log and notify\n" +
      "but won't block anything yet, so you can see what your agents\n" +
      "actually do before writing rules.\n\n" +
      `Run ${chalk.cyan("'sousmcp policies --strict'")} to enable blocking immediately.\n\n`
    );
  }
  process.stdout.write(
    `Restart Claude Desktop, then:\n` +
    `  ${chalk.cyan("sousmcp status")}   — check everything is running\n` +
    `  ${chalk.cyan("sousmcp log")}      — see what's been intercepted\n\n`
  );
}

// ── sousmcp uninstall ──────────────────────────────────────────────────────

async function cmdUninstall(): Promise<void> {
  if (!fs.existsSync(CLAUDE_BACKUP)) {
    err("No backup found at " + CLAUDE_BACKUP);
    info("Was SousMCP ever installed?");
    return;
  }

  const backup = fs.readFileSync(CLAUDE_BACKUP, "utf8");
  fs.writeFileSync(CLAUDE_CONFIG, backup, "utf8");
  fs.unlinkSync(CLAUDE_BACKUP);

  ok("Restored original Claude Desktop config");
  info("Restart Claude Desktop to complete uninstall.");
  info("Your log database and policies remain at ~/.sousmcp/ for reference.");
}

// ── sousmcp status ─────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();

  heading("SousMCP Status");

  // Installation
  let installStatus = "not installed";
  if (fs.existsSync(CLAUDE_CONFIG)) {
    try {
      const claudeCfg = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, "utf8")) as ClaudeConfig;
      const servers = Object.entries(claudeCfg.mcpServers ?? {});
      const wrapped = servers.filter(([, s]) => isWrapped(s));
      if (wrapped.length > 0) {
        installStatus = `active (${wrapped.length} server${wrapped.length > 1 ? "s" : ""}: ${wrapped.map(([n]) => n).join(", ")})`;
      } else {
        installStatus = "not installed (run 'sousmcp install')";
      }
    } catch { installStatus = "Claude config unreadable"; }
  }
  process.stdout.write(chalk.bold("Installation:  ") + installStatus + "\n");

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

  if (!flags["from"] || !flags["to"] || !flags["out"]) {
    err("Usage: sousmcp export --from YYYY-MM-DD --to YYYY-MM-DD --out report.json");
    return;
  }

  let from: Date, to: Date;
  try { from = parseDate(flags["from"]); to = parseDate(flags["to"]); }
  catch (e) { err(String(e)); return; }

  to.setHours(23, 59, 59, 999);

  const cfg = loadConfig();
  if (!fs.existsSync(cfg.dbPath)) { err("Database not found."); return; }

  const store = new LogStore(cfg.dbPath);
  const bundle = exportBundle(store, from, to, flags["out"]);
  store.close();

  ok(`Exported ${bundle.messages.length} messages (${bundle.sessions.length} sessions) to ${flags["out"]}`);
  info(`Bundle hash: ${bundle.bundleHash}`);
  info("Use 'sousmcp verify <file>' to verify integrity.");
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

// ── Help ───────────────────────────────────────────────────────────────────

function printHelp(): void {
  process.stdout.write(
    `\n${chalk.bold.cyan("SousMCP")} — a transparency layer for MCP agents\n\n` +
    `${chalk.bold("Commands:")}\n` +
    `  ${chalk.cyan("install")}                      Wrap Claude Desktop MCP servers\n` +
    `  ${chalk.cyan("uninstall")}                    Restore original Claude Desktop config\n` +
    `  ${chalk.cyan("status")}                       Show installation and runtime status\n` +
    `  ${chalk.cyan("log")} [--session <id>] [--n N] Pretty-print recent messages\n` +
    `  ${chalk.cyan("digest")} [--out <file>]        Generate weekly activity digest\n` +
    `  ${chalk.cyan("export")} --from --to --out     Export signed message bundle\n` +
    `  ${chalk.cyan("verify")} <file>                Verify a signed export bundle\n` +
    `  ${chalk.cyan("policies")} [--strict|--learning] View / configure policies\n\n`
  );
}

// ── Entry point ────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);

(async () => {
  try {
    switch (cmd) {
      case "install":   await cmdInstall(); break;
      case "uninstall": await cmdUninstall(); break;
      case "status":    await cmdStatus(); break;
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
