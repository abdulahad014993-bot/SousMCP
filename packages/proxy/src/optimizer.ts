// Token optimization engine: semantic caching, deduplication, response compression.
// Caching is backed by SQLite via LogStore; dedup state is in-memory per session.

import { createHash } from "node:crypto";
import type { LogStore } from "./store.js";
import { log } from "./logger.js";

// ── Configuration ──────────────────────────────────────────────────────────

export interface OptimizerConfig {
  enabled: boolean;
  cacheTtlSeconds: number;        // default TTL for all tools
  toolTtlOverrides: Record<string, number>; // per-tool TTL (0 = no cache)
  dedupWindowSeconds: number;     // deduplicate identical calls within this window
  compressThresholdChars: number; // compress text responses larger than this
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  enabled: true,
  cacheTtlSeconds: 30,
  toolTtlOverrides: {
    // Filesystem reads: 30 s
    read_file: 30,
    read_text_file: 30,
    get_file_info: 30,
    list_directory: 30,
    // External API calls: no cache
    fetch: 0,
    http_get: 0,
    http_post: 0,
    // Search: 60 s
    search: 60,
    web_search: 60,
  },
  dedupWindowSeconds: 60,
  compressThresholdChars: 5000,
};

// ── Metrics ────────────────────────────────────────────────────────────────

export interface OptimizerMetrics {
  cacheHits: number;
  cacheMisses: number;
  deduplications: number;
  compressions: number;
  estimatedTokensSaved: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function cacheKey(toolName: string, args: unknown): string {
  return createHash("sha256")
    .update(`${toolName}::${JSON.stringify(args ?? {})}`)
    .digest("hex");
}

function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 chars
  return Math.ceil(text.length / 4);
}

// Compress a large text response into a summary with a reference ID.
function compressText(text: string, threshold: number): { compressed: string; wasSaved: number } {
  if (text.length <= threshold) return { compressed: text, wasSaved: 0 };
  const head = text.slice(0, 500);
  const tail = text.slice(-300);
  const omitted = text.length - 800;
  const compressed = `${head}\n… (${omitted} chars omitted — full response cached) …\n${tail}`;
  return { compressed, wasSaved: text.length - compressed.length };
}

// Compress a directory listing: keep top-level entries + count.
function compressDirectoryListing(text: string): { compressed: string; wasSaved: number } {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length <= 20) return { compressed: text, wasSaved: 0 };
  const shown = lines.slice(0, 20);
  const rest = lines.length - 20;
  const compressed = [...shown, `… and ${rest} more entries`].join("\n");
  return { compressed, wasSaved: text.length - compressed.length };
}

// ── OptimizerEngine ────────────────────────────────────────────────────────

export class OptimizerEngine {
  private readonly store: LogStore;
  private readonly cfg: OptimizerConfig;
  private readonly metrics: OptimizerMetrics = {
    cacheHits: 0, cacheMisses: 0, deduplications: 0,
    compressions: 0, estimatedTokensSaved: 0,
  };

  // In-memory dedup tracker: sessionId → Map<cacheKey, { result, timestamp }>
  private readonly dedupCache = new Map<string, Map<string, { result: unknown; at: number }>>();

  // Pending call tracking: correlate inbound (id) → cache key for outbound caching
  private readonly pendingCalls = new Map<unknown, { key: string; toolName: string }>();

  constructor(store: LogStore, cfg: Partial<OptimizerConfig> = {}) {
    this.store = store;
    this.cfg = { ...DEFAULT_OPTIMIZER_CONFIG, ...cfg };
  }

  private ttlForTool(toolName: string): number {
    if (toolName in this.cfg.toolTtlOverrides) return this.cfg.toolTtlOverrides[toolName] * 1000;
    return this.cfg.cacheTtlSeconds * 1000;
  }

  private getSessionDedup(sessionId: string): Map<string, { result: unknown; at: number }> {
    let m = this.dedupCache.get(sessionId);
    if (!m) { m = new Map(); this.dedupCache.set(sessionId, m); }
    return m;
  }

  // Called on inbound tools/call. Returns cached JSON-RPC response string, or null to forward.
  checkCache(
    sessionId: string,
    messageId: unknown,
    toolName: string,
    args: unknown
  ): string | null {
    if (!this.cfg.enabled) return null;
    if (this.ttlForTool(toolName) === 0) {
      this.metrics.cacheMisses++;
      return null;
    }

    const key = cacheKey(toolName, args);

    // 1. Dedup check (same session, recent identical call)
    const sessionDedup = this.getSessionDedup(sessionId);
    const dedupEntry = sessionDedup.get(key);
    if (dedupEntry && Date.now() - dedupEntry.at < this.cfg.dedupWindowSeconds * 1000) {
      this.metrics.deduplications++;
      this.metrics.cacheHits++;
      const estimatedSaved = estimateTokens(JSON.stringify(dedupEntry.result ?? {}));
      this.metrics.estimatedTokensSaved += estimatedSaved;
      log("info", `Optimizer: dedup hit for '${toolName}' — saved ~${estimatedSaved} tokens`);
      return JSON.stringify({ jsonrpc: "2.0", id: messageId, result: dedupEntry.result });
    }

    // 2. SQLite cache check
    const cached = this.store.getCachedResult(key);
    if (cached) {
      this.metrics.cacheHits++;
      try {
        const result = JSON.parse(cached);
        const estimatedSaved = estimateTokens(cached);
        this.metrics.estimatedTokensSaved += estimatedSaved;
        log("info", `Optimizer: cache hit for '${toolName}' — saved ~${estimatedSaved} tokens`);
        // Populate dedup too
        sessionDedup.set(key, { result, at: Date.now() });
        return JSON.stringify({ jsonrpc: "2.0", id: messageId, result });
      } catch { /* fall through */ }
    }

    this.metrics.cacheMisses++;
    // Track the pending call so we can cache its response
    this.pendingCalls.set(messageId, { key, toolName });
    return null;
  }

  // Called on outbound tools/call result. Stores in cache and dedup.
  cacheResponse(sessionId: string, messageId: unknown, resultJson: string): void {
    if (!this.cfg.enabled) return;
    const pending = this.pendingCalls.get(messageId);
    if (!pending) return;
    this.pendingCalls.delete(messageId);

    const { key, toolName } = pending;
    const ttl = this.ttlForTool(toolName);
    if (ttl === 0) return;

    try {
      const result = JSON.parse(resultJson);
      const sessionDedup = this.getSessionDedup(sessionId);
      sessionDedup.set(key, { result, at: Date.now() });
      this.store.setCachedResult(key, toolName, resultJson, ttl);
    } catch (e) {
      log("warn", `Optimizer: failed to cache response for '${toolName}': ${String(e)}`);
    }
  }

  // Optionally compress a tools/call result before forwarding to the agent.
  // Returns the (possibly compressed) result JSON, and tracks savings.
  compressResult(toolName: string, resultJson: string): string {
    if (!this.cfg.enabled) return resultJson;
    try {
      const result = JSON.parse(resultJson) as Record<string, unknown>;

      // Handle standard MCP content format: { content: [{ type: "text", text: "..." }] }
      if (!Array.isArray(result["content"])) return resultJson;

      let totalSaved = 0;
      const newContent = (result["content"] as Array<Record<string, unknown>>).map(item => {
        if (item["type"] !== "text" || typeof item["text"] !== "string") return item;
        const text = item["text"] as string;
        if (text.length <= this.cfg.compressThresholdChars) return item;

        // Detect directory listing vs generic text
        const isListing = /^\[(?:FILE|DIR)\]/.test(text);
        const { compressed, wasSaved } = isListing
          ? compressDirectoryListing(text)
          : compressText(text, this.cfg.compressThresholdChars);

        totalSaved += wasSaved;
        return { ...item, text: compressed };
      });

      if (totalSaved === 0) return resultJson;
      this.metrics.compressions++;
      this.metrics.estimatedTokensSaved += estimateTokens(" ".repeat(totalSaved));
      return JSON.stringify({ ...result, content: newContent });
    } catch {
      return resultJson;
    }
  }

  getMetrics(): OptimizerMetrics {
    return { ...this.metrics };
  }

  // Clean up dedup state for a closed session
  evictSession(sessionId: string): void {
    this.dedupCache.delete(sessionId);
    // Clean up any pending calls that may have been left behind
    for (const [id] of this.pendingCalls) {
      this.pendingCalls.delete(id);
    }
  }
}
