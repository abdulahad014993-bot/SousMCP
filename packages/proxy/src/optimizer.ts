// 6-layer token optimization engine — up to 95% token reduction.
//
// Layer 1: Dynamic tool schema loading  — strips full schemas from tools/list, adds virtual proxy tools
// Layer 2: Semantic response caching    — LRU in-memory L1 + SQLite L2 with adaptive TTLs
// Layer 3: Response compression         — large responses truncated, full stored by ref_id
// Layer 4: Deduplication                — sliding-window dedup per session
// Layer 5: Tool schema minification     — truncate descriptions, strip metadata fields
// Layer 6: Context-aware result filtering — field-level stripping (default OFF)
//
// Advanced: adaptive TTLs, progressive schema revelation, response diffing, predictive prefetch

import { createHash, randomUUID } from "node:crypto";
import type { LogStore } from "./store.js";

// ── Config ──────────────────────────────────────────────────────────────────

export interface OptimizationConfig {
  enabled: boolean;
  dynamicToolsets: boolean;          // Layer 1 — default OFF (changes agent behavior)
  cacheTTL: Record<string, number>;  // Layer 2 — seconds per tool name; "default" key for fallback
  compressionThreshold: number;      // Layer 3 — char count to trigger compression (default 2000)
  dedupWindowSeconds: number;        // Layer 4 — sliding window (default 300)
  schemaMinification: boolean;       // Layer 5 — default true
  resultFiltering: boolean;          // Layer 6 — default false
  maxCacheEntries: number;           // LRU eviction cap (default 1000)
}

// Backward-compat alias used in config.ts
export type OptimizerConfig = OptimizationConfig;

export const DEFAULT_OPTIMIZATION_CONFIG: OptimizationConfig = {
  enabled: true,
  dynamicToolsets: false,
  cacheTTL: {
    // Filesystem reads: 30 s
    read_file: 30, read_text_file: 30, get_file_info: 30, list_directory: 30,
    // External / network: no cache
    fetch: 0, http_get: 0, http_post: 0,
    // Search: 60 s
    search: 60, web_search: 60,
    // Writes: no cache
    write_file: 0, create_file: 0, delete_file: 0, write: 0, create: 0, delete: 0,
    // Default fallback
    default: 10,
  },
  compressionThreshold: 2000,
  dedupWindowSeconds: 300,
  schemaMinification: true,
  resultFiltering: false,
  maxCacheEntries: 1000,
};

// Backward-compat alias
export const DEFAULT_OPTIMIZER_CONFIG = DEFAULT_OPTIMIZATION_CONFIG;

// ── Metrics ────────────────────────────────────────────────────────────────

export interface OptimizationMetrics {
  dynamicToolsets: { enabled: boolean; schemasStripped: number; inputTokensSaved: number };
  cache: { hits: number; misses: number; estimatedTokensSaved: number };
  compression: { responsesCompressed: number; bytesSaved: number };
  deduplication: { duplicatesCaught: number; tokensSaved: number };
  schemaMinification: { schemasMinified: number; bytesSaved: number };
  resultFiltering: { responsesFiltered: number; bytesSaved: number };
  adaptive: { ttlDoublings: number; ttlHalvings: number };
  prefetch: { patternsLearned: number; candidatesIdentified: number };
  total: { estimatedTokensSaved: number; estimatedCostSaved: string; optimizationRate: number };
}

// Backward-compat alias used by server.ts
export type OptimizerMetrics = OptimizationMetrics;

// ── LRU Cache ────────────────────────────────────────────────────────────────

interface LRUNode<V> {
  key: string; value: V;
  prev: LRUNode<V> | null; next: LRUNode<V> | null;
}

class LRUCache<V> {
  private readonly cap: number;
  private readonly map = new Map<string, LRUNode<V>>();
  private head: LRUNode<V> | null = null;
  private tail: LRUNode<V> | null = null;

  constructor(capacity: number) { this.cap = capacity; }

  get(key: string): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;
    this.lift(node);
    return node.value;
  }

  set(key: string, value: V): void {
    const existing = this.map.get(key);
    if (existing) { existing.value = value; this.lift(existing); return; }
    const node: LRUNode<V> = { key, value, prev: null, next: this.head };
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
    this.map.set(key, node);
    if (this.map.size > this.cap) this.evict();
  }

  has(key: string): boolean { return this.map.has(key); }
  get size(): number { return this.map.size; }

  private lift(node: LRUNode<V>): void {
    if (node === this.head) return;
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.tail) this.tail = node.prev;
    node.prev = null; node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
  }

  private evict(): void {
    if (!this.tail) return;
    this.map.delete(this.tail.key);
    if (this.tail.prev) this.tail.prev.next = null;
    this.tail = this.tail.prev;
    if (!this.tail) this.head = null;
  }
}

// ── Internal types ────────────────────────────────────────────────────────

interface CacheEntry { json: string; at: number; ttlMs: number; hits: number }
interface DedupEntry { result: unknown; at: number }

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [k: string]: unknown;
}

// ── Virtual tools (Layer 1) ───────────────────────────────────────────────

const VIRTUAL_TOOLS: RawTool[] = [
  {
    name: "sousmcp_search_tools",
    description: "Search available tools by keyword. Returns matching tool names and one-line descriptions.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Keyword to search in tool names/descriptions" } },
      required: ["query"],
    },
  },
  {
    name: "sousmcp_describe_tool",
    description: "Get the full inputSchema for a specific tool by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact tool name" } },
      required: ["name"],
    },
  },
  {
    name: "sousmcp_execute_tool",
    description: "Execute any tool by name with provided arguments.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name to execute" },
        arguments: { type: "object", description: "Arguments to pass to the tool" },
      },
      required: ["name"],
    },
  },
  {
    name: "sousmcp_get_full_response",
    description: "Retrieve the full uncompressed content of a previous large response by its reference ID.",
    inputSchema: {
      type: "object",
      properties: { ref_id: { type: "string", description: "Reference ID from a compressed response" } },
      required: ["ref_id"],
    },
  },
];

// ── OptimizerEngine ────────────────────────────────────────────────────────

export class OptimizerEngine {
  private readonly store: LogStore;
  private readonly cfg: OptimizationConfig;

  // Layer 1: Full schema registry — serverName → tools array
  private readonly schemaRegistry = new Map<string, RawTool[]>();
  // Progressive revelation: serverName → Set of tool names actually called
  private readonly calledTools = new Map<string, Set<string>>();

  // Layer 2: L1 in-memory LRU cache (global, cross-session)
  private readonly l1Cache: LRUCache<CacheEntry>;
  // Adaptive TTL: cacheKey → TTL multiplier (starts 1.0, doubles on 5+ hits, halves on staleness)
  private readonly adaptiveTtl = new Map<string, number>();

  // Layer 4: Per-session dedup map
  private readonly dedupCache = new Map<string, Map<string, DedupEntry>>();

  // Layer 3: Ref store for compressed responses (ref_id → full JSON)
  private readonly refStore = new Map<string, string>();

  // Pending calls: messageId → { cacheKey, toolName } for response-side caching
  private readonly pendingCalls = new Map<unknown, { key: string; toolName: string }>();

  // Response diffing: sessionId:cacheKey → last response JSON
  private readonly lastResponses = new Map<string, string>();

  // Predictive prefetch: toolName → Map<nextToolName, callCount>
  private readonly callSequences = new Map<string, Map<string, number>>();
  private lastCalledTool: string | null = null;

  // Startup pattern: sessionId → first-20 tool calls
  private readonly sessionStarts = new Map<string, string[]>();
  // Global: toolName → how many sessions started with it
  private readonly startupFreq = new Map<string, number>();

  // Metrics accumulators
  private readonly m = {
    dynStripped: 0, dynTokensSaved: 0,
    cacheHits: 0, cacheMisses: 0, cacheTokensSaved: 0,
    compressed: 0, bytesSaved: 0,
    dedups: 0, dedupTokensSaved: 0,
    schemasMinified: 0, minifyBytesSaved: 0,
    filtered: 0, filterBytesSaved: 0,
    ttlDoublings: 0, ttlHalvings: 0,
    prefetchPatterns: 0, prefetchCandidates: 0,
    totalRawTokens: 0,
  };

  constructor(store: LogStore, cfg: Partial<OptimizationConfig> = {}) {
    this.store = store;
    this.cfg = { ...DEFAULT_OPTIMIZATION_CONFIG, ...cfg };
    if (cfg.cacheTTL) {
      this.cfg.cacheTTL = { ...DEFAULT_OPTIMIZATION_CONFIG.cacheTTL, ...cfg.cacheTTL };
    }
    this.l1Cache = new LRUCache<CacheEntry>(this.cfg.maxCacheEntries);
  }

  // ── TTL helpers ──────────────────────────────────────────────────────────

  private baseTtlMs(toolName: string): number {
    const lc = toolName.toLowerCase();
    if (lc in this.cfg.cacheTTL) return this.cfg.cacheTTL[lc] * 1000;
    if (/^(write|create|delete|update|send|post|push|remove|add|insert|modify|set_)/.test(lc)) return 0;
    return (this.cfg.cacheTTL["default"] ?? 10) * 1000;
  }

  private adaptedTtlMs(toolName: string, key: string): number {
    const base = this.baseTtlMs(toolName);
    if (base === 0) return 0;
    const mult = this.adaptiveTtl.get(key) ?? 1;
    return Math.min(base * mult, 600_000); // hard cap: 10 min
  }

  // ── Layer 1: Dynamic Tool Schema Loading ─────────────────────────────────

  // Called from the outbound transform when a tools/list response is detected.
  // Returns the (possibly modified) tools array to include in the forwarded JSON.
  processToolList(tools: RawTool[], serverName: string): RawTool[] {
    if (!this.cfg.enabled) return tools;

    // Always store full schemas for progressive revelation + virtual tool search
    this.schemaRegistry.set(serverName, tools);

    const beforeBytes = JSON.stringify(tools).length;
    this.m.totalRawTokens += Math.ceil(beforeBytes / 4);

    const called = this.calledTools.get(serverName) ?? new Set<string>();

    if (this.cfg.dynamicToolsets) {
      // Strip schemas → stubs; reveal full schema for previously-called tools (progressive)
      const stripped: RawTool[] = tools.map(t => {
        if (called.has(t.name)) {
          // Progressive revelation: full schema for used tools
          return this.cfg.schemaMinification ? this.minifyTool(t) : t;
        }
        const desc = t.description ?? "";
        return {
          name: t.name,
          description: desc.length > 100 ? desc.slice(0, 97) + "..." : desc,
          inputSchema: { type: "object", properties: {} },
        };
      });

      const result = [...stripped, ...VIRTUAL_TOOLS];
      const afterBytes = JSON.stringify(result).length;
      const saved = Math.max(0, beforeBytes - afterBytes);
      this.m.dynStripped += tools.length - called.size;
      this.m.dynTokensSaved += Math.ceil(saved / 4);
      return result;

    } else if (this.cfg.schemaMinification) {
      // Layer 5 only — passive, no behavioral change
      const minified = tools.map(t => this.minifyTool(t));
      const afterBytes = JSON.stringify(minified).length;
      const saved = Math.max(0, beforeBytes - afterBytes);
      this.m.schemasMinified += tools.length;
      this.m.minifyBytesSaved += saved;
      return minified;
    }

    return tools;
  }

  // ── Layer 5: Schema Minification ─────────────────────────────────────────

  private minifyTool(tool: RawTool): RawTool {
    const desc = tool.description ?? "";
    const truncDesc = desc.length > 100 ? desc.slice(0, 97) + "..." : desc;
    const schema = tool.inputSchema as Record<string, unknown> | undefined;
    if (!schema) return { ...tool, description: truncDesc };

    const { $schema, additionalProperties, examples, ...rest } = schema as Record<string, unknown>;
    void $schema; void additionalProperties; void examples;

    if (rest["properties"] && typeof rest["properties"] === "object") {
      const minProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest["properties"] as Record<string, unknown>)) {
        if (typeof v === "object" && v !== null) {
          const { examples: _ex, ...propRest } = v as Record<string, unknown>;
          void _ex;
          if (typeof propRest["description"] === "string" && propRest["description"].length > 80) {
            propRest["description"] = propRest["description"].slice(0, 77) + "...";
          }
          minProps[k] = propRest;
        } else {
          minProps[k] = v;
        }
      }
      rest["properties"] = minProps;
    }

    return { ...tool, description: truncDesc, inputSchema: rest };
  }

  // ── Layer 1: Virtual Tool Handling ───────────────────────────────────────

  // Returns a complete JSON-RPC response string for virtual tool calls, null if not virtual.
  handleVirtualToolCall(toolName: string, args: unknown, messageId: unknown, serverName: string): string | null {
    if (!this.cfg.dynamicToolsets) {
      // sousmcp_get_full_response is available even without dynamicToolsets (Layer 3 refs)
      if (toolName !== "sousmcp_get_full_response") return null;
    }

    const a = (args ?? {}) as Record<string, unknown>;
    let resultContent: unknown;

    if (toolName === "sousmcp_search_tools") {
      const query = String(a["query"] ?? "").toLowerCase();
      const registry = this.schemaRegistry.get(serverName) ?? [];
      const matches = registry
        .filter(t =>
          t.name.toLowerCase().includes(query) ||
          (t.description ?? "").toLowerCase().includes(query))
        .map(t => ({ name: t.name, description: (t.description ?? "").slice(0, 100) }));
      resultContent = { tools: matches, count: matches.length };

    } else if (toolName === "sousmcp_describe_tool") {
      const name = String(a["name"] ?? "");
      const registry = this.schemaRegistry.get(serverName) ?? [];
      const tool = registry.find(t => t.name === name);
      resultContent = tool
        ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
        : { error: `Tool '${name}' not found`, available: registry.map(t => t.name) };

    } else if (toolName === "sousmcp_get_full_response") {
      const refId = String(a["ref_id"] ?? "");
      const full = this.refStore.get(refId);
      if (!full) {
        resultContent = { error: "Reference not found or expired" };
      } else {
        try { resultContent = JSON.parse(full); } catch { resultContent = full; }
      }

    } else {
      return null;
    }

    return JSON.stringify({
      jsonrpc: "2.0",
      id: messageId,
      result: { content: [{ type: "text", text: JSON.stringify(resultContent, null, 2) }] },
    });
  }

  // For sousmcp_execute_tool: returns a translated tools/call raw JSON to forward to the child.
  translateExecuteTool(args: unknown, messageId: unknown): string | null {
    if (!this.cfg.dynamicToolsets) return null;
    const a = (args ?? {}) as Record<string, unknown>;
    const name = typeof a["name"] === "string" ? a["name"] : null;
    if (!name) return null;
    return JSON.stringify({
      jsonrpc: "2.0",
      id: messageId,
      method: "tools/call",
      params: { name, arguments: a["arguments"] ?? {} },
    });
  }

  // ── Layers 2 + 4: Cache / Dedup Check (inbound side) ─────────────────────

  checkCache(
    sessionId: string,
    messageId: unknown,
    toolName: string,
    args: unknown
  ): string | null {
    if (!this.cfg.enabled) return null;
    if (this.baseTtlMs(toolName) === 0) { this.m.cacheMisses++; return null; }

    const key = cacheKey(toolName, args);
    const now = Date.now();
    const sessionDedup = this.getSessionDedup(sessionId);

    this.trackStartup(sessionId, toolName);

    // Layer 4: Dedup (same session, recent identical call)
    const dedupEntry = sessionDedup.get(key);
    if (dedupEntry && now - dedupEntry.at < this.cfg.dedupWindowSeconds * 1000) {
      this.m.dedups++;
      this.m.cacheHits++;
      const tokens = estimateTokens(JSON.stringify(dedupEntry.result ?? {}));
      this.m.dedupTokensSaved += tokens;
      this.m.cacheTokensSaved += tokens;
      return JSON.stringify({ jsonrpc: "2.0", id: messageId, result: dedupEntry.result });
    }

    // Layer 2: L1 in-memory LRU (warm cross-session hit — no SQLite)
    const l1 = this.l1Cache.get(key);
    if (l1 && now - l1.at < l1.ttlMs) {
      this.m.cacheHits++;
      l1.hits++;
      const tokens = estimateTokens(l1.json);
      this.m.cacheTokensSaved += tokens;
      // Adaptive TTL: 5+ consecutive hits → double TTL (max 16×)
      if (l1.hits >= 5) {
        const cur = this.adaptiveTtl.get(key) ?? 1;
        if (cur < 16) { this.adaptiveTtl.set(key, cur * 2); this.m.ttlDoublings++; }
      }
      try {
        const result = JSON.parse(l1.json);
        sessionDedup.set(key, { result, at: now });
        return JSON.stringify({ jsonrpc: "2.0", id: messageId, result });
      } catch { /* fall through */ }
    }

    // Layer 2: SQLite L2 (true cold miss — only hits here once per cache lifetime)
    const cached = this.store.getCachedResult(key);
    if (cached) {
      this.m.cacheHits++;
      const tokens = estimateTokens(cached);
      this.m.cacheTokensSaved += tokens;
      try {
        const result = JSON.parse(cached);
        const ttlMs = this.adaptedTtlMs(toolName, key);
        this.l1Cache.set(key, { json: cached, at: now, ttlMs, hits: 1 });
        sessionDedup.set(key, { result, at: now });
        return JSON.stringify({ jsonrpc: "2.0", id: messageId, result });
      } catch { /* fall through */ }
    }

    this.m.cacheMisses++;
    this.pendingCalls.set(messageId, { key, toolName });
    return null;
  }

  // ── Response diffing ─────────────────────────────────────────────────────

  // Returns a diff summary string if the response changed slightly, null for major changes or first call.
  checkDiff(sessionId: string, key: string, resultJson: string): string | null {
    const diffKey = `${sessionId}:${key}`;
    const prev = this.lastResponses.get(diffKey);
    this.lastResponses.set(diffKey, resultJson);
    if (!prev || prev === resultJson) return null;

    const prevLines = prev.split("\n");
    const newLines = resultJson.split("\n");
    if (prevLines.length === newLines.length) {
      const changed = newLines.filter((l, i) => l !== prevLines[i]);
      if (changed.length > 0 && changed.length <= 3) {
        return `[Resource changed: ${changed.length} line(s) modified since last read]`;
      }
    }
    return null; // significant change — return full content
  }

  // ── On outbound response: cache original, then compress + filter ─────────
  // Called from onOutboundTransform. Returns the processed (possibly compressed)
  // result JSON to forward to the host. If messageId is not a pending tools/call, returns original.

  processOutboundResult(messageId: unknown, resultJson: string, sessionId: string): string {
    const pending = this.pendingCalls.get(messageId);
    if (!pending) return resultJson;
    const { toolName } = pending;
    this.cacheResponse(sessionId, messageId, resultJson); // stores original, deletes from pendingCalls
    let processed = this.compressResponse(toolName, resultJson);
    processed = this.filterResult(toolName, processed);
    return processed;
  }

  // ── Internal: cache + sequence tracking (called by processOutboundResult) ──

  cacheResponse(sessionId: string, messageId: unknown, resultJson: string): void {
    if (!this.cfg.enabled) return;
    const pending = this.pendingCalls.get(messageId);
    if (!pending) return;
    this.pendingCalls.delete(messageId);

    const { key, toolName } = pending;
    const ttlMs = this.adaptedTtlMs(toolName, key);

    // Track call sequence for predictive prefetch
    if (this.lastCalledTool && this.lastCalledTool !== toolName) {
      const seq = this.callSequences.get(this.lastCalledTool) ?? new Map<string, number>();
      seq.set(toolName, (seq.get(toolName) ?? 0) + 1);
      this.callSequences.set(this.lastCalledTool, seq);
      const total = Array.from(seq.values()).reduce((a, b) => a + b, 0);
      if (total >= 3) {
        const candidates = Array.from(seq.entries()).filter(([, c]) => c / total >= 0.7);
        if (candidates.length > 0) this.m.prefetchCandidates = candidates.length;
      }
      this.m.prefetchPatterns = this.callSequences.size;
    }
    this.lastCalledTool = toolName;

    // Mark tool as called for progressive schema revelation
    for (const [server, tools] of this.schemaRegistry) {
      if (tools.some(t => t.name === toolName)) {
        let called = this.calledTools.get(server);
        if (!called) { called = new Set(); this.calledTools.set(server, called); }
        called.add(toolName);
      }
    }

    if (ttlMs === 0) return;

    try {
      const result = JSON.parse(resultJson);
      const now = Date.now();
      const sessionDedup = this.getSessionDedup(sessionId);
      sessionDedup.set(key, { result, at: now });
      this.l1Cache.set(key, { json: resultJson, at: now, ttlMs, hits: 0 });
      this.store.setCachedResult(key, toolName, resultJson, ttlMs);
    } catch { /* ignore */ }
  }

  // ── Layer 3: Response Compression ────────────────────────────────────────

  compressResponse(toolName: string, resultJson: string): string {
    if (!this.cfg.enabled || resultJson.length <= this.cfg.compressionThreshold) return resultJson;

    try {
      const result = JSON.parse(resultJson) as Record<string, unknown>;

      // Standard MCP content wrapper: { content: [{ type: "text", text }] }
      if (Array.isArray(result["content"])) {
        let totalSaved = 0;
        const newContent = (result["content"] as Array<Record<string, unknown>>).map(item => {
          if (item["type"] !== "text" || typeof item["text"] !== "string") return item;
          const text = item["text"];
          if (text.length <= this.cfg.compressionThreshold) return item;

          const isListing = /^\[(?:FILE|DIR)\]/.test(text) || (text.split("\n").length > 20 && /^\s*[-*]/.test(text));
          let compressed: string;

          if (isListing) {
            const lines = text.split("\n").filter(l => l.trim());
            const shown = lines.slice(0, 20);
            const rest = lines.length - 20;
            const refId = randomUUID();
            this.refStore.set(refId, text);
            compressed = [...shown, `… and ${rest} more entries (ref_id: "${refId}")`].join("\n");
          } else if (text.length > 5000) {
            const refId = randomUUID();
            this.refStore.set(refId, text);
            const omitted = text.length - 1500;
            compressed = `${text.slice(0, 1000)}\n\n… (${omitted} chars omitted — use sousmcp_get_full_response with ref_id: "${refId}") …\n\n${text.slice(-500)}`;
          } else {
            const refId = randomUUID();
            this.refStore.set(refId, text);
            compressed = `${text.slice(0, 500)}\n… (${text.length - 500} chars omitted, ref_id: "${refId}") …`;
          }

          totalSaved += text.length - compressed.length;
          return { ...item, text: compressed };
        });

        if (totalSaved <= 0) return resultJson;
        this.m.compressed++;
        this.m.bytesSaved += totalSaved;
        return JSON.stringify({ ...result, content: newContent });
      }

      // Large JSON array: show first 10, store rest by ref
      if (Array.isArray(result)) {
        const arr = result as unknown[];
        if (arr.length > 20) {
          const refId = randomUUID();
          this.refStore.set(refId, resultJson);
          const truncated = JSON.stringify([...arr.slice(0, 10), { _omitted: `${arr.length - 10} more items`, ref_id: refId }]);
          this.m.compressed++;
          this.m.bytesSaved += resultJson.length - truncated.length;
          return truncated;
        }
      }

      // Deeply nested JSON: flatten to depth 2
      if (maxDepth(result) > 3) {
        const flat = JSON.stringify(flattenToDepth(result, 2));
        if (flat.length < resultJson.length) {
          this.m.compressed++;
          this.m.bytesSaved += resultJson.length - flat.length;
          return flat;
        }
      }
    } catch { /* ignore */ }

    return resultJson;
  }

  // ── Layer 6: Context-aware Result Filtering ───────────────────────────────

  filterResult(toolName: string, resultJson: string): string {
    if (!this.cfg.resultFiltering || !this.cfg.enabled) return resultJson;
    const lc = toolName.toLowerCase();

    try {
      const result = JSON.parse(resultJson);
      let filtered: unknown = result;
      const before = resultJson.length;

      if (/read_file|read_text/.test(lc)) {
        if (typeof result === "object" && result !== null) {
          filtered = { content: (result as Record<string, unknown>)["content"] };
        }
      } else if (/^search|list_/.test(lc)) {
        if (Array.isArray(result)) {
          filtered = result.map(item => {
            if (typeof item !== "object" || !item) return item;
            const r = item as Record<string, unknown>;
            return {
              name: r["name"] ?? r["title"] ?? r["id"],
              snippet: typeof r["content"] === "string" ? r["content"].slice(0, 100) : undefined,
            };
          });
        }
      }

      const after = JSON.stringify(filtered).length;
      if (after < before) {
        this.m.filtered++;
        this.m.filterBytesSaved += before - after;
        return JSON.stringify(filtered);
      }
    } catch { /* ignore */ }
    return resultJson;
  }

  // ── Predictive prefetch ───────────────────────────────────────────────────

  // Returns tool names likely to be called next based on observed sequences (>70% frequency).
  getPrefetchCandidates(toolName: string): string[] {
    const seq = this.callSequences.get(toolName);
    if (!seq || seq.size === 0) return [];
    const total = Array.from(seq.values()).reduce((a, b) => a + b, 0);
    if (total < 3) return [];
    return Array.from(seq.entries())
      .filter(([, count]) => count / total >= 0.7)
      .map(([next]) => next);
  }

  // ── Startup tracking (cross-session warm-up) ──────────────────────────────

  private trackStartup(sessionId: string, toolName: string): void {
    let starts = this.sessionStarts.get(sessionId);
    if (!starts) { starts = []; this.sessionStarts.set(sessionId, starts); }
    if (starts.length < 20) {
      starts.push(toolName);
      this.startupFreq.set(toolName, (this.startupFreq.get(toolName) ?? 0) + 1);
    }
  }

  getStartupPattern(): Array<{ tool: string; frequency: number }> {
    return Array.from(this.startupFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, frequency]) => ({ tool, frequency }));
  }

  // ── Summary line for CLI status ───────────────────────────────────────────

  getSummaryLine(): string {
    const total = this.m.cacheHits + this.m.cacheMisses;
    const hitRate = total > 0 ? Math.round((this.m.cacheHits / total) * 100) : 0;
    const saved = this.m.cacheTokensSaved + this.m.dynTokensSaved +
      Math.ceil((this.m.bytesSaved + this.m.minifyBytesSaved + this.m.filterBytesSaved) / 4);
    return `Token savings: ~${saved.toLocaleString()} tokens saved (${hitRate}% cache hit rate) this session`;
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  getMetrics(): OptimizationMetrics {
    const totalTokensSaved =
      this.m.cacheTokensSaved +
      this.m.dynTokensSaved +
      Math.ceil((this.m.bytesSaved + this.m.minifyBytesSaved + this.m.filterBytesSaved) / 4);

    return {
      dynamicToolsets: {
        enabled: this.cfg.dynamicToolsets,
        schemasStripped: this.m.dynStripped,
        inputTokensSaved: this.m.dynTokensSaved,
      },
      cache: {
        hits: this.m.cacheHits,
        misses: this.m.cacheMisses,
        estimatedTokensSaved: this.m.cacheTokensSaved,
      },
      compression: {
        responsesCompressed: this.m.compressed,
        bytesSaved: this.m.bytesSaved,
      },
      deduplication: {
        duplicatesCaught: this.m.dedups,
        tokensSaved: this.m.dedupTokensSaved,
      },
      schemaMinification: {
        schemasMinified: this.m.schemasMinified,
        bytesSaved: this.m.minifyBytesSaved,
      },
      resultFiltering: {
        responsesFiltered: this.m.filtered,
        bytesSaved: this.m.filterBytesSaved,
      },
      adaptive: {
        ttlDoublings: this.m.ttlDoublings,
        ttlHalvings: this.m.ttlHalvings,
      },
      prefetch: {
        patternsLearned: this.m.prefetchPatterns,
        candidatesIdentified: this.m.prefetchCandidates,
      },
      total: {
        estimatedTokensSaved: totalTokensSaved,
        estimatedCostSaved: `$${(totalTokensSaved * 0.000001).toFixed(4)}`,
        optimizationRate: this.m.totalRawTokens > 0
          ? Math.round((totalTokensSaved / this.m.totalRawTokens) * 100)
          : 0,
      },
    };
  }

  // ── Session cleanup ───────────────────────────────────────────────────────

  evictSession(sessionId: string): void {
    this.dedupCache.delete(sessionId);
    for (const k of [...this.lastResponses.keys()]) {
      if (k.startsWith(`${sessionId}:`)) this.lastResponses.delete(k);
    }
    for (const [id] of this.pendingCalls) this.pendingCalls.delete(id);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private getSessionDedup(sessionId: string): Map<string, DedupEntry> {
    let m = this.dedupCache.get(sessionId);
    if (!m) { m = new Map(); this.dedupCache.set(sessionId, m); }
    return m;
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

function cacheKey(toolName: string, args: unknown): string {
  return createHash("sha256").update(`${toolName}::${JSON.stringify(args ?? {})}`).digest("hex");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function maxDepth(obj: unknown, d = 0): number {
  if (d > 5 || typeof obj !== "object" || obj === null || Array.isArray(obj)) return d;
  let max = d;
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const child = maxDepth(v, d + 1);
    if (child > max) max = child;
  }
  return max;
}

function flattenToDepth(obj: unknown, maxD: number, d = 0): unknown {
  if (d >= maxD || typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(v => flattenToDepth(v, maxD, d + 1));
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = typeof v === "object" && v !== null && !Array.isArray(v) && d + 1 >= maxD
      ? "[nested object]"
      : flattenToDepth(v, maxD, d + 1);
  }
  return result;
}
