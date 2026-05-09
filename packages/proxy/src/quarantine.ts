// Tool quarantine registry — tracks every tool name + server ever seen.
// New tools (not in the registry) are auto-quarantined: calls are paused
// until approved or denied. Denied tools are permanently blocked.

import * as fs from "node:fs";
import * as path from "node:path";
import { SOUSMCP_DIR } from "./config.js";
import { log } from "./logger.js";

export type ToolStatus = "trusted" | "blocked" | "pending";

export interface KnownTool {
  name: string;
  server: string;
  firstSeen: string;   // ISO date
  status: ToolStatus;
  inputSchema?: unknown;
}

interface Registry {
  tools: KnownTool[];
}

const REGISTRY_PATH = path.join(SOUSMCP_DIR, "known-tools.json");

export class QuarantineManager {
  private registry = new Map<string, KnownTool>();
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
    this.load();
  }

  private key(name: string, server: string): string {
    return `${server}::${name}`;
  }

  private load(): void {
    try {
      if (fs.existsSync(REGISTRY_PATH)) {
        const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as Registry;
        for (const t of reg.tools ?? []) {
          this.registry.set(this.key(t.name, t.server), t);
        }
        log("info", `Quarantine: loaded ${this.registry.size} known tools`);
      }
    } catch (e) {
      log("warn", `Quarantine: failed to load registry: ${String(e)}`);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(SOUSMCP_DIR, { recursive: true });
      const reg: Registry = { tools: Array.from(this.registry.values()) };
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), "utf8");
    } catch (e) {
      log("warn", `Quarantine: failed to save registry: ${String(e)}`);
    }
  }

  // Returns "trusted" | "blocked" | "new". Fast — reads in-memory only.
  checkTool(name: string, server: string): "trusted" | "blocked" | "new" {
    if (!this.enabled) return "trusted";
    const entry = this.registry.get(this.key(name, server));
    if (!entry) return "new";
    if (entry.status === "blocked") return "blocked";
    if (entry.status === "pending") return "new"; // treat pending as new every time
    return "trusted";
  }

  // Register a brand-new tool as pending. Returns true if it was genuinely new.
  registerNew(name: string, server: string, inputSchema?: unknown): boolean {
    if (!this.enabled) return false;
    const k = this.key(name, server);
    if (this.registry.has(k)) return false;
    this.registry.set(k, { name, server, firstSeen: new Date().toISOString(), status: "pending", inputSchema });
    this.save();
    log("info", `Quarantine: new tool '${name}' from '${server}' — pending approval`);
    return true;
  }

  // Bulk-register known tools (from a tools/list response) as trusted if not already tracked.
  registerToolList(tools: Array<{ name: string; inputSchema?: unknown }>, server: string): string[] {
    const newOnes: string[] = [];
    for (const t of tools) {
      if (this.registerNew(t.name, server, t.inputSchema)) newOnes.push(t.name);
    }
    return newOnes;
  }

  approve(name: string, server: string): boolean {
    const k = this.key(name, server);
    const entry = this.registry.get(k);
    if (!entry) return false;
    entry.status = "trusted";
    this.save();
    log("info", `Quarantine: approved '${name}' from '${server}'`);
    return true;
  }

  deny(name: string, server: string): boolean {
    const k = this.key(name, server);
    const entry = this.registry.get(k) ?? { name, server, firstSeen: new Date().toISOString(), status: "blocked" as const };
    entry.status = "blocked";
    this.registry.set(k, entry);
    this.save();
    log("info", `Quarantine: blocked '${name}' from '${server}'`);
    return true;
  }

  listAll(): KnownTool[] {
    return Array.from(this.registry.values()).sort(
      (a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name)
    );
  }

  listPending(): KnownTool[] {
    return this.listAll().filter(t => t.status === "pending");
  }

  stats(): { trusted: number; blocked: number; pending: number } {
    let trusted = 0, blocked = 0, pending = 0;
    for (const t of this.registry.values()) {
      if (t.status === "trusted") trusted++;
      else if (t.status === "blocked") blocked++;
      else pending++;
    }
    return { trusted, blocked, pending };
  }
}
