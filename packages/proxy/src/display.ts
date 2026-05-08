import chalk from "chalk";
import type { LogStore, MessageRow } from "./store.js";

const TRUNCATE = 80;

export function formatRow(row: MessageRow): string {
  const time = new Date(row.timestamp).toISOString();
  const dir = row.direction === "inbound"
    ? chalk.cyan("→")
    : chalk.green("←");

  let params: unknown = null;
  try { params = JSON.parse(row.paramsJson); } catch { /* keep null */ }

  const paramsStr = params !== null ? JSON.stringify(params).slice(0, TRUNCATE) : "null";
  const truncated = paramsStr.length === TRUNCATE ? paramsStr + "…" : paramsStr;

  const policy = row.policyAction
    ? ` ${chalk.magenta(`[${row.policyAction}]`)}`
    : "";

  return (
    `${chalk.dim(time)}  ${dir}  ${chalk.yellow(row.method.padEnd(28))}  ${chalk.dim(truncated)}${policy}\n` +
    chalk.dim(`  hash: ${row.hash.slice(0, 16)}…  prev: ${row.prevHash.slice(0, 16)}…\n`)
  );
}

export function printMessages(
  rows: MessageRow[],
  chainValid: boolean,
  title = "SousMCP log"
): void {
  process.stdout.write(
    chalk.bold.white(`\n── ${title} (${rows.length} messages) ─────────────────────\n`)
  );

  if (rows.length === 0) {
    process.stdout.write(chalk.dim("  (nothing logged)\n"));
  } else {
    for (const row of rows) process.stdout.write(formatRow(row));
  }

  const chainLine = chainValid
    ? chalk.bold.green("  ✓ chain intact")
    : chalk.bold.red("  ✗ chain BROKEN — log may have been tampered with");

  process.stdout.write(chainLine + "\n");
  process.stdout.write(chalk.bold.white("─".repeat(54) + "\n\n"));
}

export function printLastMessages(store: LogStore, sessionId: string, count = 10): void {
  const rows = store.getMessages(sessionId).slice(-count);
  printMessages(rows, store.verifyChain());
}
