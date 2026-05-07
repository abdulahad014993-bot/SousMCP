import chalk from "chalk";
import { startStdioProxy } from "./interceptor.js";
import { LogStore } from "./store.js";
import { PolicyEngine } from "./policy.js";
import { pauseForApproval } from "./notify.js";
import { startApiServer } from "./server.js";
import { printLastMessages } from "./display.js";
import type { InterceptedMessage, InboundResult } from "@sousmcp/shared";

// ── Bootstrap ──────────────────────────────────────────────────────────────

const [targetCommand, ...targetArgs] = process.argv.slice(2);

if (!targetCommand) {
  process.stderr.write("Usage: sousmcp-proxy <command> [args...]\n");
  process.exit(1);
}

const dbPath = process.env["SOUSMCP_DB"] ?? "./sousmcp.db";
const store = new LogStore(dbPath);
const policy = new PolicyEngine();

const serverCommand = [targetCommand, ...targetArgs].join(" ");
const sessionId = store.createSession("host", targetCommand, serverCommand);

process.stderr.write(
  chalk.bold.cyan("SousMCP proxy starting\n") +
  chalk.dim(`  target:  ${serverCommand}\n`) +
  chalk.dim(`  db:      ${dbPath}\n`) +
  chalk.dim(`  session: ${sessionId}\n`) +
  chalk.dim(`  policy:  ${policy.filePath}\n`)
);

startApiServer(store, policy);

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
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message },
  });
}

// ── Inbound handler (host → child) ─────────────────────────────────────────

async function onInbound(msg: InterceptedMessage): Promise<InboundResult> {
  const method = extractMethod(msg.parsed);
  const params = extractParams(msg.parsed);
  const id = extractId(msg.parsed);
  const { action, rule } = policy.evaluate(msg.parsed);

  if (action === "block") {
    const ruleName = rule?.name ?? "default";
    process.stderr.write(chalk.red(`[BLOCK] ${ruleName}: ${method}\n`));
    store.logMessage(sessionId, msg.direction, method, params, null, "block");
    return {
      action: "block",
      errorResponse: jsonRpcError(id, `Blocked by SousMCP policy: ${ruleName}`),
    };
  }

  if (action === "pause") {
    const decision = pauseForApproval(msg, rule!);
    if (decision === "deny") {
      const ruleName = rule?.name ?? "default";
      store.logMessage(sessionId, msg.direction, method, params, null, "pause:denied");
      return {
        action: "block",
        errorResponse: jsonRpcError(id, `Denied by user via SousMCP policy: ${ruleName}`),
      };
    }
    store.logMessage(sessionId, msg.direction, method, params, null, "pause:approved");
    return { action: "forward" };
  }

  // action === "log" — forward transparently, record policyAction only if a rule fired.
  const policyAction = rule ? "log" : null;
  store.logMessage(sessionId, msg.direction, method, params, null, policyAction);
  return { action: "forward" };
}

// ── Outbound handler (child → host) ────────────────────────────────────────

function onOutbound(msg: InterceptedMessage): void {
  const method = extractMethod(msg.parsed);
  const params = extractParams(msg.parsed);
  store.logMessage(sessionId, msg.direction, method, params);
}

// ── Start proxy ────────────────────────────────────────────────────────────

const cleanup = startStdioProxy({ targetCommand, targetArgs, onInbound, onOutbound });

// ── Shutdown ───────────────────────────────────────────────────────────────

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanup();
  printLastMessages(store, sessionId, 10);
  store.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("beforeExit", shutdown);
