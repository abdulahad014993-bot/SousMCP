// ── SousMCP proxy daemon ───────────────────────────────────────────────────
// stdout and stderr are sacred — they carry the MCP data channel.
// All operational output goes to ~/.sousmcp/sousmcp.log.

import { startStdioProxy } from "./interceptor.js";
import { LogStore } from "./store.js";
import { PolicyEngine } from "./policy.js";
import { pauseForApproval, notifyLearningMode } from "./notify.js";
import { startApiServer } from "./server.js";
import { loadConfig, isLearningMode, SOUSMCP_DIR } from "./config.js";
import { log, logError, setLogFile } from "./logger.js";
import { metrics } from "./metrics.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InterceptedMessage, InboundResult } from "@sousmcp/shared";

// ── Bootstrap ──────────────────────────────────────────────────────────────

const [targetCommand, ...targetArgs] = process.argv.slice(2);

if (!targetCommand) {
  process.stderr.write("Usage: sousmcp-proxy <command> [args...]\n");
  process.exit(1);
}

// Ensure the config directory exists so logging works from the start.
try { fs.mkdirSync(SOUSMCP_DIR, { recursive: true }); } catch { /* ignore */ }

const cfg = loadConfig();
setLogFile(cfg.logPath);

const store = new LogStore(cfg.dbPath);
const learningMode = isLearningMode(cfg);
const policy = new PolicyEngine(undefined, learningMode);

const serverCommand = [targetCommand, ...targetArgs].join(" ");
const sessionId = store.createSession("host", targetCommand, serverCommand);

log("info", `Proxy starting — target: ${serverCommand} session: ${sessionId} learning: ${learningMode}`);

const proxyStartTime = Date.now();
try { startApiServer(store, policy, cfg.apiPort, proxyStartTime); } catch (err) {
  log("warn", `API server failed to start: ${String(err)}`);
}

// Hot-reload policies when the file changes on disk.
const policiesPath = path.join(SOUSMCP_DIR, "policies.yaml");
try {
  fs.watch(policiesPath, { persistent: false }, eventType => {
    if (eventType === "change") {
      policy.reload();
      log("info", `Policies reloaded: ${policy.getRules().length} rules`);
    }
  });
} catch (err) {
  log("warn", `Could not watch policies file: ${String(err)}`);
}

// ── JSON-RPC helpers ───────────────────────────────────────────────────────

function extractMethod(parsed: unknown): string {
  if (parsed !== null && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (typeof p["method"] === "string") return p["method"];
    if ("result" in p) return "(response/result)";
    if ("error" in p) return "(response/error)";
  }
  return "(non-json)";
}

function extractParams(parsed: unknown): unknown {
  if (parsed !== null && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    return p["params"] ?? p["result"] ?? p["error"] ?? null;
  }
  return null;
}

function extractId(parsed: unknown): unknown {
  if (parsed !== null && typeof parsed === "object") {
    return (parsed as Record<string, unknown>)["id"] ?? null;
  }
  return null;
}

function jsonRpcError(id: unknown, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

// ── Inbound handler ────────────────────────────────────────────────────────

async function onInbound(msg: InterceptedMessage): Promise<InboundResult> {
  const t0 = Date.now();
  const method = extractMethod(msg.parsed);
  const params = extractParams(msg.parsed);
  const id = extractId(msg.parsed);

  metrics.recordMessage("inbound");

  let evalResult;
  try {
    evalResult = policy.evaluate(msg.parsed);
  } catch (err) {
    logError(err, "Policy evaluation");
    metrics.recordError();
    evalResult = { action: "log" as const, learningModeOverride: false };
  }

  const { action, rule, learningModeOverride } = evalResult;

  // Notify in learning mode when a rule would have fired.
  if (learningModeOverride && rule) {
    try { notifyLearningMode(msg, rule, rule.action); } catch { /* non-fatal */ }
  }

  if (action === "block") {
    const ruleName = rule?.name ?? "policy";
    log("info", `BLOCK ${ruleName}: ${method}`);
    metrics.recordPolicyAction(ruleName, "block", Date.now() - t0);
    try { store.logMessage(sessionId, msg.direction, method, params, null, "block"); } catch (err) {
      logError(err, "DB write (block)");
    }
    return { action: "block", errorResponse: jsonRpcError(id, `Blocked by SousMCP: ${ruleName}`) };
  }

  if (action === "pause") {
    let decision: "approve" | "deny" = "approve";
    try { decision = await pauseForApproval(msg, rule!); } catch (err) {
      logError(err, "Pause approval — defaulting to approve");
    }
    const policyAction = decision === "deny" ? "pause:denied" : "pause:approved";
    metrics.recordPolicyAction(rule?.name, policyAction, Date.now() - t0);
    try { store.logMessage(sessionId, msg.direction, method, params, null, policyAction); } catch (err) {
      logError(err, "DB write (pause)");
    }
    if (decision === "deny") {
      return { action: "block", errorResponse: jsonRpcError(id, `Denied by user: ${rule?.name ?? "policy"}`) };
    }
    return { action: "forward" };
  }

  // log / learning-mode-override — forward and record
  const policyAction = learningModeOverride ? `learning:${rule?.action ?? "log"}` : (rule ? "log" : null);
  metrics.recordPolicyAction(rule?.name, policyAction ?? "log", Date.now() - t0);
  try { store.logMessage(sessionId, msg.direction, method, params, null, policyAction); } catch (err) {
    logError(err, "DB write");
  }
  return { action: "forward" };
}

// ── Outbound handler ───────────────────────────────────────────────────────

function onOutbound(msg: InterceptedMessage): void {
  metrics.recordMessage("outbound");
  const method = extractMethod(msg.parsed);
  const params = extractParams(msg.parsed);
  try { store.logMessage(sessionId, msg.direction, method, params); } catch (err) {
    logError(err, "DB write (outbound)");
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

const cleanup = startStdioProxy({ targetCommand, targetArgs, onInbound, onOutbound });

// ── Shutdown ───────────────────────────────────────────────────────────────

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try { cleanup(); } catch { /* ignore */ }
  log("info", `Session ${sessionId} ended`);
  try { store.close(); } catch { /* ignore */ }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("beforeExit", shutdown);
