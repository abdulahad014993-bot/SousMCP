import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_LOG_FILE = path.join(os.homedir(), ".sousmcp", "sousmcp.log");
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

let _logFile: string = DEFAULT_LOG_FILE;

export function setLogFile(p: string): void {
  _logFile = p;
}

function rotate(): void {
  try {
    const st = fs.statSync(_logFile);
    if (st.size >= MAX_BYTES) {
      fs.renameSync(_logFile, _logFile + ".1");
    }
  } catch {
    // not yet created — fine
  }
}

export function log(level: "info" | "warn" | "error", message: string): void {
  try {
    fs.mkdirSync(path.dirname(_logFile), { recursive: true });
    rotate();
    fs.appendFileSync(
      _logFile,
      `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`,
      "utf8"
    );
  } catch {
    // logging must never crash the proxy
  }
}

export function logError(err: unknown, context: string): void {
  log("error", `${context}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
}
