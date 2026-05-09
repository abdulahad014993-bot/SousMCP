// Agent observability beyond MCP stdio: tracks child-process network connections,
// subprocess spawning hints from stderr, and environment variable exposure.
// All events land in the activity_log table alongside MCP messages.

import { exec } from "node:child_process";
import { platform } from "node:os";
import type { LogStore } from "./store.js";
import { log } from "./logger.js";

export type ActivitySource = "mcp" | "network" | "process" | "env";

export interface ActivityEvent {
  id: string;
  timestamp: number;
  source: ActivitySource;
  sessionId: string;
  data: unknown;
}

// ── Network polling (macOS / Linux via lsof) ───────────────────────────────

function lsofNetwork(pid: number): Promise<string[]> {
  return new Promise(resolve => {
    if (platform() !== "darwin" && platform() !== "linux") {
      resolve([]);
      return;
    }
    exec(`lsof -p ${pid} -nP -i TCP 2>/dev/null`, { timeout: 3000 }, (_err, stdout) => {
      const connections: string[] = [];
      for (const line of stdout.split("\n").slice(1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const state = parts[parts.length - 1];
        const addr = parts[8] ?? "";
        connections.push(`${addr} [${state}]`);
      }
      resolve(connections);
    });
  });
}

// ── Sensitive environment variable detection ───────────────────────────────

const SENSITIVE_ENV_RE = /token|secret|key|password|credential|auth|api_key|private/i;

function scanEnvForSecrets(env: Record<string, string | undefined>): string[] {
  const found: string[] = [];
  for (const k of Object.keys(env)) {
    if (SENSITIVE_ENV_RE.test(k) && env[k]) {
      found.push(k);
    }
  }
  return found;
}

// ── AgentMonitor ───────────────────────────────────────────────────────────

export class AgentMonitor {
  private readonly store: LogStore;
  private readonly sessionId: string;
  private pid: number | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastConnections: Set<string> = new Set();
  private readonly pollMs: number;

  constructor(store: LogStore, sessionId: string, pollMs = 5000) {
    this.store = store;
    this.sessionId = sessionId;
    this.pollMs = pollMs;
  }

  // Called once the child PID is known (after spawn)
  start(pid: number, serverEnv: Record<string, string | undefined>): void {
    this.pid = pid;
    log("info", `AgentMonitor: watching pid ${pid}`);

    // Immediately scan env for secret exposure
    const sensitiveKeys = scanEnvForSecrets(serverEnv);
    if (sensitiveKeys.length > 0) {
      this.logActivity("env", {
        type: "sensitive_env",
        pid,
        keys: sensitiveKeys,
        message: `MCP server env contains ${sensitiveKeys.length} sensitive variable(s): ${sensitiveKeys.join(", ")}`,
      });
    }

    // Poll network connections
    this.pollInterval = setInterval(() => { this.pollNetwork(); }, this.pollMs);
    // Don't prevent process exit
    if (this.pollInterval.unref) this.pollInterval.unref();
  }

  private pollNetwork(): void {
    if (!this.pid) return;
    lsofNetwork(this.pid).then(connections => {
      const current = new Set(connections);
      // New connections since last poll
      for (const conn of current) {
        if (!this.lastConnections.has(conn)) {
          this.logActivity("network", {
            type: "new_connection",
            pid: this.pid,
            connection: conn,
          });
        }
      }
      // Closed connections
      for (const conn of this.lastConnections) {
        if (!current.has(conn)) {
          this.logActivity("network", { type: "closed_connection", pid: this.pid, connection: conn });
        }
      }
      this.lastConnections = current;
    }).catch(() => { /* lsof might not be available */ });
  }

  // Called from stderr listener when the child writes something unusual
  observeStderr(line: string): void {
    // Heuristic: look for subprocess-spawn indicators
    const spawnRe = /spawn|exec|fork|child_process|subprocess|popen/i;
    if (spawnRe.test(line)) {
      this.logActivity("process", {
        type: "subprocess_hint",
        pid: this.pid,
        stderr_line: line.slice(0, 200),
      });
    }
  }

  private logActivity(source: ActivitySource, data: unknown): void {
    try {
      this.store.logActivity(this.sessionId, source, data);
    } catch (e) {
      log("warn", `AgentMonitor: failed to log activity: ${String(e)}`);
    }
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
