import express from "express";
import cors from "cors";
import * as fs from "node:fs";
import * as net from "node:net";
import * as cp from "node:child_process";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";
import { listApprovals, resolveApproval } from "./approvals.js";
import type { LogStore } from "./store.js";
import type { PolicyEngine } from "./policy.js";
import type { QuarantineManager } from "./quarantine.js";
import type { OptimizerEngine } from "./optimizer.js";

function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => { server.close(); resolve(false); });
    server.listen(port, "127.0.0.1");
  });
}

// Shared state injected by index.ts for debug endpoints
interface DebugState {
  serverCommand: string;
  serverArgs: string[];
  toolSchemas: Map<string, unknown[]>; // serverName → tools array from tools/list
}

export let debugState: DebugState | null = null;

export function setDebugState(s: DebugState): void {
  debugState = s;
}

export function startApiServer(
  store: LogStore,
  policy: PolicyEngine,
  port = 8787,
  startTime = Date.now(),
  quarantine?: QuarantineManager,
  optimizer?: OptimizerEngine
): void {
  portInUse(port).then(inUse => {
    if (inUse) {
      log("warn", `API port ${port} already in use — skipping server`);
      return;
    }

    const app = express();
    app.use(cors());
    app.use(express.json());

    // ── Existing endpoints ───────────────────────────────────────────────

    app.get("/api/sessions", (_req, res) => {
      try { res.json(store.getSessions()); }
      catch (err) { res.status(500).json({ error: String(err) }); }
    });

    app.get("/api/messages", (req, res) => {
      try {
        const sessionId = typeof req.query["sessionId"] === "string"
          ? req.query["sessionId"] : undefined;
        res.json(store.getMessages(sessionId));
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    app.get("/api/policies", (_req, res) => {
      res.json({ rules: policy.getRules(), filePath: policy.filePath });
    });

    app.post("/api/policies", (req, res) => {
      const { rules } = req.body as { rules?: unknown };
      if (!Array.isArray(rules)) { res.status(400).json({ error: "rules must be an array" }); return; }
      try {
        policy.setRules(rules as Parameters<PolicyEngine["setRules"]>[0]);
        res.json({ ok: true, count: rules.length });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    app.post("/api/policies/reload", (_req, res) => {
      policy.reload();
      res.json({ ok: true, rules: policy.getRules() });
    });

    app.get("/api/policies/raw", (_req, res) => {
      try {
        res.type("text/plain").send(fs.readFileSync(policy.filePath, "utf8"));
      } catch { res.status(404).json({ error: "policies file not found" }); }
    });

    app.get("/api/stats", (_req, res) => {
      try { res.json(store.getStats()); }
      catch (err) { res.status(500).json({ error: String(err) }); }
    });

    app.get("/api/metrics", (_req, res) => {
      res.json(metrics.snapshot());
    });

    app.get("/api/approvals", (_req, res) => {
      res.json(listApprovals());
    });

    app.post("/api/approvals/:id/approve", (req, res) => {
      const ok = resolveApproval(req.params["id"], "approve");
      if (ok) res.json({ ok: true, decision: "approve" });
      else res.status(404).json({ error: "Approval not found or already resolved" });
    });

    app.post("/api/approvals/:id/deny", (req, res) => {
      const ok = resolveApproval(req.params["id"], "deny");
      if (ok) res.json({ ok: true, decision: "deny" });
      else res.status(404).json({ error: "Approval not found or already resolved" });
    });

    app.get("/api/health", (_req, res) => {
      try {
        const snap = metrics.snapshot();
        const sessions = store.getSessions();
        const stats = store.getStats();
        res.json({
          status: "ok",
          uptime: Math.round((Date.now() - startTime) / 1000),
          messagesTotal: stats.totalMessages,
          servers: sessions.map(s => ({
            name: s.serverName,
            sessionId: s.id,
            startedAt: new Date(s.startedAt).toISOString(),
            messageCount: snap.messages.total,
          })),
        });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    // ── New: multi-server list ────────────────────────────────────────────

    app.get("/api/servers", (_req, res) => {
      try {
        const sessions = store.getSessions();
        const stats = store.getStats();
        res.json({
          servers: sessions.map(s => ({
            sessionId: s.id,
            serverName: s.serverName,
            serverCommand: s.serverCommand,
            startedAt: new Date(s.startedAt).toISOString(),
            messageCount: stats.methodCounts,
          })),
          total: sessions.length,
        });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    // ── New: quarantine endpoints ─────────────────────────────────────────

    if (quarantine) {
      app.get("/api/quarantine", (_req, res) => {
        res.json({ tools: quarantine.listAll(), stats: quarantine.stats() });
      });

      app.post("/api/quarantine/:server/:name/approve", (req, res) => {
        const ok = quarantine.approve(req.params["name"], req.params["server"]);
        if (ok) res.json({ ok: true });
        else res.status(404).json({ error: "Tool not found in quarantine registry" });
      });

      app.post("/api/quarantine/:server/:name/deny", (req, res) => {
        const ok = quarantine.deny(req.params["name"], req.params["server"]);
        res.json({ ok: true, blocked: ok });
      });
    }

    // ── New: activity log (agent observability) ───────────────────────────

    app.get("/api/activity", (req, res) => {
      try {
        const sessionId = typeof req.query["sessionId"] === "string"
          ? req.query["sessionId"] : undefined;
        const activity = store.getActivity(sessionId);
        const messages = store.getMessages(sessionId).slice(-50);
        // Merge and sort by timestamp descending
        const unified = [
          ...messages.map(m => ({
            source: "mcp" as const,
            timestamp: m.timestamp,
            direction: m.direction,
            method: m.method,
            policyAction: m.policyAction,
            hash: m.hash,
          })),
          ...activity.map(a => ({
            source: a.source,
            timestamp: a.timestamp,
            data: JSON.parse(a.dataJson),
          })),
        ].sort((a, b) => b.timestamp - a.timestamp);
        res.json({ activity: unified, total: unified.length });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    // ── New: token optimizer metrics ──────────────────────────────────────

    if (optimizer) {
      app.get("/api/optimizer", (_req, res) => {
        const m = optimizer.getMetrics();
        const cacheStats = store.getCacheStats();
        const totalCalls = m.cacheHits + m.cacheMisses;
        res.json({
          ...m,
          cacheHitRate: totalCalls > 0 ? Math.round((m.cacheHits / totalCalls) * 100) : 0,
          persistedCacheEntries: cacheStats.entries,
          persistedCacheHits: cacheStats.totalHits,
        });
      });
    }

    // ── New: debug endpoints (Feature 6) ──────────────────────────────────

    // GET /api/debug/schema — return tool schemas from most recent tools/list response
    app.get("/api/debug/schema", (_req, res) => {
      if (!debugState || debugState.toolSchemas.size === 0) {
        res.json({ schemas: {}, note: "No tool schemas captured yet — proxy must be running" });
        return;
      }
      const schemas: Record<string, unknown[]> = {};
      for (const [server, tools] of debugState.toolSchemas) {
        schemas[server] = tools;
      }
      res.json({ schemas });
    });

    // POST /api/debug/call — spawn ephemeral MCP session and invoke one tool
    // Body: { command: string, args: string[], message: object }
    app.post("/api/debug/call", (req, res) => {
      const { command, args, message } = req.body as {
        command?: string;
        args?: string[];
        message?: unknown;
      };

      const cmd = command ?? debugState?.serverCommand;
      const cmdArgs = args ?? debugState?.serverArgs ?? [];

      if (!cmd) {
        res.status(400).json({ error: "command is required (or proxy must be running)" });
        return;
      }
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      // Wrap with initialize + the caller's message, collect response
      const init = JSON.stringify({
        jsonrpc: "2.0", id: "__init__", method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sousmcp-debug", version: "1" } },
      });
      const notify = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      const msg = JSON.stringify(message);
      const input = [init, notify, msg].join("\n") + "\n";

      let output = "";
      const proc = cp.spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"] });
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (c: string) => { output += c; });
      proc.stdin?.write(input);
      proc.stdin?.end();

      const timer = setTimeout(() => { proc.kill(); }, 8000);
      proc.on("close", () => {
        clearTimeout(timer);
        const lines = output.split("\n").filter(l => l.trim());
        const responses = lines.map(l => {
          try { return JSON.parse(l) as unknown; } catch { return l; }
        });
        res.json({ responses, rawOutput: output });
      });
      proc.on("error", (e: Error) => {
        clearTimeout(timer);
        res.status(500).json({ error: String(e) });
      });
    });

    // POST /api/debug/replay — look up a logged message and return it with context
    app.post("/api/debug/replay", (req, res) => {
      const { messageId } = req.body as { messageId?: string };
      if (!messageId) { res.status(400).json({ error: "messageId required" }); return; }
      try {
        const all = store.getMessages();
        const msg = all.find(m => m.id === messageId);
        if (!msg) { res.status(404).json({ error: "Message not found" }); return; }
        const idx = all.indexOf(msg);
        res.json({
          message: msg,
          prev: idx > 0 ? all[idx - 1] : null,
          next: idx < all.length - 1 ? all[idx + 1] : null,
          note: "Re-sending is not automatic — copy 'message.paramsJson' and POST to /api/debug/call",
        });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    app.listen(port, "127.0.0.1", () => {
      log("info", `API server listening on http://127.0.0.1:${port}`);
    }).unref().on("error", (err: Error) => {
      log("warn", `API server error: ${err.message}`);
    });
  }).catch((err: unknown) => {
    log("warn", `Could not check port availability: ${String(err)}`);
  });
}
