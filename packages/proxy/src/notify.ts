import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import notifier from "node-notifier";
import { log } from "./logger.js";
import type { InterceptedMessage } from "@sousmcp/shared";
import type { PolicyRule, PolicyAction } from "./policy.js";
import { registerApproval, cancelApproval } from "./approvals.js";

export type ApprovalDecision = "approve" | "deny";

// Write directly to /dev/tty — never stdout or stderr (both reserved for MCP data).
function writeTty(text: string): void {
  try {
    const fd = fs.openSync("/dev/tty", "w");
    fs.writeSync(fd, text);
    fs.closeSync(fd);
  } catch { /* TTY unavailable — silent */ }
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

// Path 1: macOS notification with Approve / Block action buttons.
// Path 2: dismissed or ignored for 30 s → auto-forward (fail-open).
// Path 3: pending approval registered in the approvals store so the
//          Express API (/api/approvals) can also resolve it.
export async function pauseForApproval(
  msg: InterceptedMessage,
  rule: PolicyRule
): Promise<ApprovalDecision> {
  const parsed = msg.parsed as Record<string, unknown> | null;
  const params = parsed?.["params"] as Record<string, unknown> | undefined;
  const toolName = String(params?.["name"] ?? "(unknown)");
  const paramsStr = JSON.stringify(params ?? {}).slice(0, 120);
  const method = String((parsed as Record<string, unknown>)?.["method"] ?? "tools/call");

  const approvalId = randomUUID();

  return new Promise<ApprovalDecision>((outerResolve) => {
    let settled = false;

    function settle(decision: ApprovalDecision, source: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelApproval(approvalId);
      log("info", `Pause: ${decision} via ${source} — rule: ${rule.name}, tool: ${toolName}`);
      outerResolve(decision);
    }

    // Register with the API store so dashboard can resolve it.
    registerApproval(approvalId, method, toolName, params, rule.name, (d) => settle(d, "api"));

    // Path 2: 30-second timeout → fail-open (never break the user's workflow).
    const timer = setTimeout(() => settle("approve", "timeout-30s"), 30_000);

    // Path 1: macOS notification with action buttons.
    try {
      notifier.notify(
        {
          title: "SousMCP · Approval Required",
          message: `Rule: ${rule.name}\nTool: ${toolName}\n${paramsStr}`,
          sound: true,
          wait: true,   // keep notification active until user interacts
          timeout: 29,  // slightly under 30s so notification dismisses before auto-approve fires
          actions: ["Approve", "Block"],
          closeLabel: "Dismiss (allow)",
        } as Parameters<typeof notifier.notify>[0],
        (_err: unknown, _response: unknown, metadata: unknown) => {
          if (settled) return;
          const m = metadata as Record<string, unknown> | undefined;
          const clicked = String(m?.["activationValue"] ?? "");
          // Any response other than explicitly "Block" → approve (fail-open).
          if (clicked === "Block") settle("deny", "notification");
          else settle("approve", "notification");
        }
      );
    } catch (e) {
      log("warn", `Notification error: ${String(e)}`);
    }

    // Non-blocking TTY message — no readline, just shows where to respond.
    writeTty(
      `\n┌─ PAUSE ─ ${rule.name} ${"─".repeat(Math.max(0, 38 - rule.name.length))}\n` +
      `│  tool:   ${toolName}\n` +
      `│  params: ${paramsStr}\n` +
      `└${"─".repeat(50)}\n` +
      `  Respond via macOS notification  or API:\n` +
      `  POST /api/approvals/${approvalId}/approve\n` +
      `  POST /api/approvals/${approvalId}/deny\n` +
      `  Auto-forwarding in 30 seconds…\n\n`
    );
  });
}
