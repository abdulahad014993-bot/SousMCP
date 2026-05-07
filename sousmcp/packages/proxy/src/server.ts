import express from "express";
import cors from "cors";
import * as fs from "node:fs";
import type { LogStore } from "./store.js";
import type { PolicyEngine } from "./policy.js";

export function startApiServer(
  store: LogStore,
  policy: PolicyEngine,
  port = 8787
): void {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── Sessions ─────────────────────────────────────────────────────────────

  app.get("/api/sessions", (_req, res) => {
    res.json(store.getSessions());
  });

  // ── Messages ──────────────────────────────────────────────────────────────

  app.get("/api/messages", (req, res) => {
    const sessionId =
      typeof req.query["sessionId"] === "string"
        ? req.query["sessionId"]
        : undefined;
    res.json(store.getMessages(sessionId));
  });

  // ── Policies ──────────────────────────────────────────────────────────────

  app.get("/api/policies", (_req, res) => {
    res.json({ rules: policy.getRules(), filePath: policy.filePath });
  });

  app.post("/api/policies", (req, res) => {
    const { rules } = req.body as { rules?: unknown };
    if (!Array.isArray(rules)) {
      res.status(400).json({ error: "rules must be an array" });
      return;
    }
    policy.setRules(rules as Parameters<PolicyEngine["setRules"]>[0]);
    res.json({ ok: true, count: rules.length });
  });

  // Reload policies from disk (e.g. after editing the YAML manually).
  app.post("/api/policies/reload", (_req, res) => {
    policy.reload();
    res.json({ ok: true, rules: policy.getRules() });
  });

  // Return the raw YAML file for in-browser editing.
  app.get("/api/policies/raw", (_req, res) => {
    try {
      const content = fs.readFileSync(policy.filePath, "utf8");
      res.type("text/plain").send(content);
    } catch {
      res.status(404).json({ error: "policies file not found" });
    }
  });

  // ── Stats ─────────────────────────────────────────────────────────────────

  app.get("/api/stats", (_req, res) => {
    res.json(store.getStats());
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  app.listen(port, "127.0.0.1", () => {
    process.stderr.write(`SousMCP API listening on http://127.0.0.1:${port}\n`);
  });
}
