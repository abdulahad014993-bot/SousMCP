import express from "express";
import cors from "cors";
import * as fs from "node:fs";
import * as net from "node:net";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";
import { listApprovals, resolveApproval } from "./approvals.js";
import type { LogStore } from "./store.js";
import type { PolicyEngine } from "./policy.js";

function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => { server.close(); resolve(false); });
    server.listen(port, "127.0.0.1");
  });
}

export function startApiServer(store: LogStore, policy: PolicyEngine, port = 8787, startTime = Date.now()): void {
  portInUse(port).then(inUse => {
    if (inUse) {
      log("warn", `API port ${port} already in use — skipping server`);
      return;
    }

    const app = express();
    app.use(cors());
    app.use(express.json());

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

    // unref() so the HTTP server doesn't prevent natural process exit when
    // the MCP child closes (stdin EOF → child exits → no other active handles).
    app.listen(port, "127.0.0.1", () => {
      log("info", `API server listening on http://127.0.0.1:${port}`);
    }).unref().on("error", (err: Error) => {
      log("warn", `API server error: ${err.message}`);
    });
  }).catch((err: unknown) => {
    log("warn", `Could not check port availability: ${String(err)}`);
  });
}
