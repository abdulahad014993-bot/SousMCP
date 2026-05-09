// ── SousMCP proxy daemon ───────────────────────────────────────────────────
// stdout and stderr are sacred — they carry the MCP data channel.
// All operational output goes to ~/.sousmcp/sousmcp.log.

import { startStdioProxy } from "./interceptor.js";
import { LogStore } from "./store.js";
import { PolicyEngine } from "./policy.js";
import { pauseForApproval, notifyLearningMode } from "./notify.js";
import { startApiServer, setDebugState } from "./server.js";
import { loadConfig, isLearningMode, SOUSMCP_DIR } from "./config.js";
import { log, logError, setLogFile } from "./logger.js";
import { metrics } from "./metrics.js";
import { QuarantineManager } from "./quarantine.js";
import { OptimizerEngine } from "./optimizer.js";
import { AgentMonitor } from "./agent-monitor.js";
import { ExporterManager } from "./exporters.js";
import { analyzeToolSet, analyzeArgs } from "./threat-rules.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InterceptedMessage, InboundResult } from "@sousmcp/shared";

// ── Bootstrap ──────────────────────────────────────────────────────────────

const [targetCommand, ...targetArgs] = process.argv.slice(2);

if (!targetCommand) {
  process.stderr.write("Usage: sousmcp-proxy <command> [args...]\n");
  process.exit(1);
}

try { fs.mkdirSync(SOUSMCP_DIR, { recursive: true }); } catch { /* ignore */ }

const cfg = loadConfig();
setLogFile(cfg.logPath);

const store = new LogStore(cfg.dbPath);
const learningMode = isLearningMode(cfg);
const policy = new PolicyEngine(undefined, learningMode);
const quarantine = new QuarantineManager(cfg.quarantineEnabled);
const optimizer = new OptimizerEngine(store, cfg.optimizer);
const exporters = new ExporterManager(cfg.exporters ?? []);

// Per-session tool schema cache for debug endpoint
const toolSchemas = new Map<string, unknown[]>();

const serverCommand = [targetCommand, ...targetArgs].join(" ");
const sessionId = store.createSession("host", targetCommand, serverCommand);
const serverName = targetCommand; // used for per-server policy matching

log("info", `Proxy starting — target: ${serverCommand} session: ${sessionId} learning: ${learningMode}`);

const proxyStartTime = Date.now();

// Wire debug state for /api/debug/* endpoints
setDebugState({ serverCommand: targetCommand, serverArgs: targetArgs, toolSchemas });

try {
  startApiServer(store, policy, cfg.apiPort, proxyStartTime, quarantine, optimizer);
} catch (err) {
  log("warn", `API server failed to start: ${String(err)}`);
}

// Hot-reload policies on file change
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

function extractToolName(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object") {
    const params = (parsed as Record<string, unknown>)["params"];
    if (params !== null && typeof params === "object") {
      const name = (params as Record<string, unknown>)["name"];
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function extractToolArgs(parsed: unknown): unknown {
  if (parsed !== null && typeof parsed === "object") {
    const params = (parsed as Record<string, unknown>)["params"];
    if (params !== null && typeof params === "object") {
      return (params as Record<string, unknown>)["arguments"] ?? null;
    }
  }
  return null;
}

function jsonRpcError(id: unknown, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

// ── Outbound handler (server → host) ──────────────────────────────────────

function onOutbound(msg: InterceptedMessage): void {
  metrics.recordMessage("outbound");
  const parsed = msg.parsed as Record<string, unknown> | null;
  const method = extractMethod(msg.parsed);
  const params = extractParams(msg.parsed);
  const id = extractId(msg.parsed);

  // Cache optimizer: store result for a pending tools/call
  if (parsed && "result" in parsed) {
    optimizer.cacheResponse(sessionId, id, JSON.stringify(parsed["result"]));
  }

  // Capture tool schemas from tools/list response for debug endpoint
  if (parsed && "result" in parsed) {
    const result = parsed["result"] as Record<string, unknown> | null;
    if (Array.isArray(result?.["tools"])) {
      const tools = result["tools"] as Array<{ name: string; inputSchema?: unknown }>;
      toolSchemas.set(serverName, tools);

      // Register all tools; new ones are auto-quarantined
      const newTools = quarantine.registerToolList(tools, serverName);

      // Run threat analysis on the tool set
      const report = analyzeToolSet(tools.map(t => t.name));
      if (report.flags.length > 0) {
        log("warn", `Threat analysis [${serverName}]: trustScore=${report.trustScore} flags=${report.flags.map(f => f.message).join("; ")}`);
      }

      if (newTools.length > 0) {
        log("info", `Quarantine: ${newTools.length} new tool(s) pending approval: ${newTools.join(", ")}`);
      }
    }
  }

  // Push to SIEM exporters
  exporters.push({
    timestamp: new Date().toISOString(),
    sessionId,
    serverName,
    direction: "outbound",
    method,
    params,
    policyAction: null,
    hash: "",
  });

  try { store.logMessage(sessionId, msg.direction, method, params); } catch (err) {
    logError(err, "DB write (outbound)");
  }
}

// ── Inbound handler (host → server) ───────────────────────────────────────

async function onInbound(msg: InterceptedMessage): Promise<InboundResult> {
  const t0 = Date.now();
  const method = extractMethod(msg.parsed);
  const params = extractParams(msg.parsed);
  const id = extractId(msg.parsed);
  const toolName = extractToolName(msg.parsed);
  const toolArgs = extractToolArgs(msg.parsed);

  metrics.recordMessage("inbound");

  // ── Optimizer: check cache before forwarding ──────────────────────────
  if (method === "tools/call" && toolName) {
    const cached = optimizer.checkCache(sessionId, id, toolName, toolArgs);
    if (cached !== null) {
      try { store.logMessage(sessionId, msg.direction, method, params, null, "optimizer:cache-hit"); } catch { /* ignore */ }
      return { action: "block", errorResponse: cached };
    }
  }

  // ── Quarantine: block/pause new/denied tools ──────────────────────────
  if (method === "tools/call" && toolName) {
    const qStatus = quarantine.checkTool(toolName, serverName);

    if (qStatus === "blocked") {
      log("info", `Quarantine BLOCKED: '${toolName}' from '${serverName}'`);
      try { store.logMessage(sessionId, msg.direction, method, params, null, "quarantine:blocked"); } catch { /* ignore */ }
      return { action: "block", errorResponse: jsonRpcError(id, `Tool '${toolName}' is blocked by quarantine`) };
    }

    if (qStatus === "new") {
      // Auto-register and pause for approval
      quarantine.registerNew(toolName, serverName);
      log("info", `Quarantine NEW: '${toolName}' from '${serverName}' — pausing for approval`);

      // Synthesize a fake policy rule for the approval UI
      const fakeRule = {
        name: `quarantine:${toolName}`,
        matchMethod: "tools/call",
        action: "pause" as const,
      };

      let decision: "approve" | "deny" = "approve";
      try { decision = await pauseForApproval(msg, fakeRule); } catch { /* fail-open */ }

      if (decision === "approve") {
        quarantine.approve(toolName, serverName);
        try { store.logMessage(sessionId, msg.direction, method, params, null, "quarantine:approved"); } catch { /* ignore */ }
        return { action: "forward" };
      } else {
        quarantine.deny(toolName, serverName);
        try { store.logMessage(sessionId, msg.direction, method, params, null, "quarantine:denied"); } catch { /* ignore */ }
        return { action: "block", errorResponse: jsonRpcError(id, `Tool '${toolName}' quarantined and denied`) };
      }
    }

    // Check per-arg threat patterns
    if (toolArgs) {
      const argThreat = analyzeArgs(toolName, toolArgs);
      if (argThreat.flagged) {
        log("warn", `Threat arg flag [${argThreat.severity}] '${toolName}': ${argThreat.reason}`);
        store.logActivity(sessionId, "mcp", { type: "threat_flag", toolName, reason: argThreat.reason, severity: argThreat.severity });
      }
    }
  }

  // ── Policy evaluation ─────────────────────────────────────────────────
  let evalResult;
  try {
    evalResult = policy.evaluate(msg.parsed, { serverName, sessionId });
  } catch (err) {
    logError(err, "Policy evaluation");
    metrics.recordError();
    evalResult = { action: "log" as const, learningModeOverride: false };
  }

  const { action, rule, learningModeOverride } = evalResult;

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
    exporters.push({ timestamp: new Date().toISOString(), sessionId, serverName, direction: "inbound", method, params, policyAction: "block", hash: "" });
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
    exporters.push({ timestamp: new Date().toISOString(), sessionId, serverName, direction: "inbound", method, params, policyAction, hash: "" });
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
  exporters.push({ timestamp: new Date().toISOString(), sessionId, serverName, direction: "inbound", method, params, policyAction, hash: "" });
  return { action: "forward" };
}

// ── Agent monitor ──────────────────────────────────────────────────────────

const agentMonitor = cfg.agentMonitorEnabled
  ? new AgentMonitor(store, sessionId, cfg.agentMonitorPollMs)
  : null;

// ── Start ──────────────────────────────────────────────────────────────────

const cleanup = startStdioProxy({
  targetCommand,
  targetArgs,
  onInbound,
  onOutbound,
  onChildSpawn: (pid) => {
    log("info", `Child PID: ${pid}`);
    agentMonitor?.start(pid, process.env as Record<string, string | undefined>);
  },
  onChildStderr: (line) => {
    agentMonitor?.observeStderr(line);
  },
});

// ── Shutdown ───────────────────────────────────────────────────────────────

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  agentMonitor?.stop();
  optimizer.evictSession(sessionId);
  try { cleanup(); } catch { /* ignore */ }
  log("info", `Session ${sessionId} ended`);
  try { store.close(); } catch { /* ignore */ }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("beforeExit", shutdown);
