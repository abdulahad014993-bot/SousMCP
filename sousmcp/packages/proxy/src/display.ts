import chalk from "chalk";
import type { LogStore, MessageRow } from "./store.js";

const TRUNCATE = 80;

function fmt(row: MessageRow): void {
  const time = new Date(row.timestamp).toISOString();

  const dir =
    row.direction === "inbound"
      ? chalk.cyan("→ in ")
      : chalk.green("← out");

  let params: unknown = null;
  try {
    params = JSON.parse(row.paramsJson);
  } catch {
    /* keep null */
  }

  const paramsStr = params !== null
    ? JSON.stringify(params).slice(0, TRUNCATE)
    : "null";
  const truncated = paramsStr.length === TRUNCATE ? paramsStr + "…" : paramsStr;

  process.stderr.write(
    `${chalk.dim(time)}  ${dir}  ${chalk.yellow(row.method.padEnd(28))}  ${chalk.dim(truncated)}\n`
  );
  process.stderr.write(
    chalk.dim(`           hash: ${row.hash.slice(0, 16)}…  prev: ${row.prevHash.slice(0, 16)}…\n`)
  );
}

export function printLastMessages(
  store: LogStore,
  sessionId: string,
  count = 10
): void {
  const rows = store.getMessages(sessionId).slice(-count);

  process.stderr.write(
    chalk.bold.white(`\n── SousMCP · last ${rows.length} message(s) ────────────────────\n`)
  );

  if (rows.length === 0) {
    process.stderr.write(chalk.dim("  (nothing logged)\n"));
  } else {
    for (const row of rows) fmt(row);
  }

  const ok = store.verifyChain();
  const chainLine = ok
    ? chalk.bold.green("  chain OK")
    : chalk.bold.red("  chain BROKEN");

  process.stderr.write(chainLine + "\n");
  process.stderr.write(chalk.bold.white("────────────────────────────────────────────────\n\n"));
}
