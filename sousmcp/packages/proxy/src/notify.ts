import * as fs from "node:fs";
import notifier from "node-notifier";
import chalk from "chalk";
import type { InterceptedMessage } from "@sousmcp/shared";
import type { PolicyRule } from "./policy.js";

export type ApprovalDecision = "approve" | "deny";

export function pauseForApproval(
  msg: InterceptedMessage,
  rule: PolicyRule
): ApprovalDecision {
  const parsed = msg.parsed as Record<string, unknown> | null;
  const params = parsed?.["params"] as Record<string, unknown> | undefined;
  const toolName = String(params?.["name"] ?? "(unknown)");
  const paramsStr = JSON.stringify(params ?? {}).slice(0, 100);

  // Fire a macOS notification (best-effort; non-blocking).
  notifier.notify({
    title: "SousMCP: Approval Required",
    message: `${toolName}: ${paramsStr}`,
    sound: true,
    wait: false,
  });

  process.stderr.write(
    chalk.bold.yellow(`\n┌─ PAUSE ─ ${rule.name} ${"─".repeat(Math.max(0, 44 - rule.name.length))}\n`) +
    chalk.yellow(`│  tool:   ${toolName}\n`) +
    chalk.yellow(`│  params: ${paramsStr}\n`) +
    chalk.bold.yellow(`└${"─".repeat(50)}\n`) +
    chalk.bold(`  [a] approve  [d] deny  > `)
  );

  // Read from /dev/tty so we don't consume bytes from stdin (the MCP channel).
  let answer = "d";
  try {
    const buf = Buffer.alloc(32);
    const fd = fs.openSync("/dev/tty", fs.constants.O_RDONLY);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    fs.closeSync(fd);
    answer = buf.slice(0, n).toString("utf8").trim().toLowerCase();
  } catch {
    process.stderr.write("\n(TTY unavailable — defaulting to deny)\n");
  }

  process.stderr.write("\n");
  const decision: ApprovalDecision = answer.startsWith("a") ? "approve" : "deny";
  process.stderr.write(
    decision === "approve"
      ? chalk.green(`  ✓ approved\n`)
      : chalk.red(`  ✗ denied\n`)
  );
  return decision;
}
