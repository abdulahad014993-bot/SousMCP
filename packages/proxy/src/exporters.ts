// SIEM / external log exporters — push log entries async to webhook, file, or syslog.
// Exporters never block the proxy pipeline; failures are silently logged.

import * as fs from "node:fs";
import * as net from "node:net";
import * as https from "node:https";
import * as http from "node:http";
import * as dgram from "node:dgram";
import { log } from "./logger.js";

// ── Config types (stored in ~/.sousmcp/config.json under "exporters") ──────

export interface WebhookExporterConfig {
  type: "webhook";
  url: string;                    // https://hooks.slack.com/... or any POST endpoint
  headers?: Record<string, string>;
  filterMethods?: string[];       // only send these methods (e.g. ["tools/call"])
}

export interface FileExporterConfig {
  type: "file";
  path: string;                   // append JSONL; Splunk/Elastic filebeat can tail this
  filterMethods?: string[];
}

export interface SyslogExporterConfig {
  type: "syslog";
  host?: string;                  // default "127.0.0.1"
  port?: number;                  // default 514 (UDP)
  facility?: number;              // default 1 (user-level)
  filterMethods?: string[];
}

export type ExporterConfig = WebhookExporterConfig | FileExporterConfig | SyslogExporterConfig;

// ── Log entry format ───────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  sessionId: string;
  serverName: string;
  direction: string;
  method: string;
  params: unknown;
  policyAction: string | null;
  hash: string;
}

// ── Exporters ──────────────────────────────────────────────────────────────

function passes(method: string, filter?: string[]): boolean {
  return !filter || filter.includes(method);
}

function postJson(rawUrl: string, body: string, headers: Record<string, string>): void {
  try {
    const url = new URL(rawUrl);
    const mod = url.protocol === "https:" ? https : http;
    const bodyBuf = Buffer.from(body, "utf8");
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(bodyBuf.length),
        "User-Agent": "sousmcp-exporter/1",
        ...headers,
      },
    }, res => {
      // Drain body so the socket is released
      res.resume();
    });
    req.on("error", () => { /* silent */ });
    req.setTimeout(5000, () => req.destroy());
    req.end(bodyBuf);
  } catch (e) {
    log("warn", `Webhook exporter error: ${String(e)}`);
  }
}

function appendJsonl(filePath: string, body: string): void {
  try {
    fs.appendFileSync(filePath, body + "\n", "utf8");
  } catch (e) {
    log("warn", `File exporter error: ${String(e)}`);
  }
}

function sendSyslog(host: string, port: number, facility: number, body: string): void {
  try {
    const severity = 6; // informational
    const pri = facility * 8 + severity;
    const msg = Buffer.from(`<${pri}>${body}`, "utf8");
    const client = dgram.createSocket("udp4");
    client.send(msg, port, host, () => client.close());
  } catch (e) {
    log("warn", `Syslog exporter error: ${String(e)}`);
  }
}

// ── ExporterManager ────────────────────────────────────────────────────────

export class ExporterManager {
  private readonly exporters: ExporterConfig[];

  constructor(exporters: ExporterConfig[]) {
    this.exporters = exporters;
    if (exporters.length > 0) {
      log("info", `Exporters: ${exporters.length} configured (${exporters.map(e => e.type).join(", ")})`);
    }
  }

  push(entry: LogEntry): void {
    if (this.exporters.length === 0) return;
    // Run async, never block the caller
    setImmediate(() => { this._push(entry); });
  }

  private _push(entry: LogEntry): void {
    const body = JSON.stringify(entry);

    for (const cfg of this.exporters) {
      try {
        if (!passes(entry.method, cfg.filterMethods)) continue;

        if (cfg.type === "webhook") {
          // Slack-compatible: wrap in { text: ... } if it looks like a Slack webhook
          const isSlack = cfg.url.includes("hooks.slack.com") || cfg.url.includes("discord.com/api/webhooks");
          const payload = isSlack
            ? JSON.stringify({ text: `\`\`\`${body}\`\`\`` })
            : body;
          postJson(cfg.url, payload, cfg.headers ?? {});

        } else if (cfg.type === "file") {
          appendJsonl(cfg.path, body);

        } else if (cfg.type === "syslog") {
          sendSyslog(cfg.host ?? "127.0.0.1", cfg.port ?? 514, cfg.facility ?? 1, body);
        }
      } catch (e) {
        log("warn", `Exporter (${cfg.type}) failed: ${String(e)}`);
      }
    }
  }

  get count(): number {
    return this.exporters.length;
  }
}

// Connect a net.Socket to a Unix domain socket for daemon IPC (Feature 3).
export function connectUnixSocket(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
    sock.setTimeout(1000, () => { sock.destroy(); reject(new Error("timeout")); });
  });
}
