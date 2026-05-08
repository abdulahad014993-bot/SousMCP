import * as fs from "node:fs";
import notifier from "node-notifier";
import { log } from "./logger.js";
import type { InterceptedMessage } from "@sousmcp/shared";
import type { PolicyRule, PolicyAction } from "./policy.js";

export type ApprovalDecision = "approve" | "deny";

// Write directly to /dev/tty — never stdout or stderr (both reserved for MCP data).
function writeTty(text: string): void {
  try {
    const fd = fs.openSync("/dev/tty", "w");
    fs.writeSync(fd, text);
    fs.closeSync(fd);
  } catch { /* TTY unavailable — silent */ }
}

function readTty(): string {
  try {
    const buf = Buffer.alloc(32);
    const fd = fs.openSync("/dev/tty", fs.constants.O_RDONLY);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString("utf8").trim().toLowerCase();
  } catch {
    return ""; // default to deny when TTY unavailable
  }
}

export function notifyLearningMode(
  msg: InterceptedMessage,
  rule: PolicyRule,
  wouldHave: PolicyAction
): void {
  const parsed = msg.parsed as Record<string, unknown> | null;
  const params = parsed?.["params"] as Record<string, unknown> | undefined;
  const toolName = String(params?.["name"] ?? "tool");
  const action = wouldHave === "block" ? "BLOCK" : "PAUSE";

  try {
    notifier.notify({
      title: `SousMCP · Learning [${action}]`,
      message: `Would have ${action.toLowerCase()}ed: ${toolName} (${rule.name})`,
      sound: false,
      wait: false,
    });
  } catch (err) {
    log("warn", `Notification failed: ${String(err)}`);
  }
}

export function pauseForApproval(
  msg: InterceptedMessage,
  rule: PolicyRule
): ApprovalDecision {
  const parsed = msg.parsed as Record<string, unknown> | null;
  const params = parsed?.["params"] as Record<string, unknown> | undefined;
  const toolName = String(params?.["name"] ?? "(unknown)");
  const paramsStr = JSON.stringify(params ?? {}).slice(0, 100);

  try {
    notifier.notify({
      title: "SousMCP: Approval Required",
      message: `${toolName}: ${paramsStr}`,
      sound: true,
      wait: false,
    });
  } catch (e) {
    log("warn", `Notification failed: ${String(e)}`);
  }

  writeTty(
    `\n┌─ PAUSE ─ ${rule.name} ${"─".repeat(Math.max(0, 38 - rule.name.length))}\n` +
    `│  tool:   ${toolName}\n` +
    `│  params: ${paramsStr}\n` +
    `└${"─".repeat(50)}\n` +
    `  [a] approve  [d] deny  > `
  );

  const answer = readTty();
  const decision: ApprovalDecision = answer.startsWith("a") ? "approve" : "deny";

  writeTty(decision === "approve" ? "  ✓ approved\n\n" : "  ✗ denied\n\n");
  log("info", `Pause: ${decision} — rule: ${rule.name}, tool: ${toolName}`);

  return decision;
}
