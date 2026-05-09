import { DatabaseSync as DB } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { MessageDirection } from "@sousmcp/shared";
import type { ActivitySource } from "./agent-monitor.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  startedAt: number;
  clientName: string;
  serverName: string;
  serverCommand: string;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  timestamp: number;
  direction: MessageDirection;
  method: string;
  paramsJson: string;
  resultJson: string | null;
  policyAction: string | null;
  prevHash: string;
  hash: string;
}

export interface ActivityRow {
  id: string;
  timestamp: number;
  source: ActivitySource;
  sessionId: string;
  dataJson: string;
}

export interface CacheRow {
  key: string;
  toolName: string;
  resultJson: string;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
}

export interface Stats {
  totalMessages: number;
  sessionsToday: number;
  policiesTriggered: number;
  methodCounts: Record<string, number>;
}

export interface PolicyEventSummary {
  blocks: number;
  pauseApproved: number;
  pauseDenied: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const GENESIS = "0".repeat(64);
type Stmt = ReturnType<DB["prepare"]>;

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function computeHash(
  prevHash: string,
  timestamp: number,
  direction: string,
  method: string,
  paramsJson: string
): string {
  return sha256(`${prevHash}|${timestamp}|${direction}|${method}|${paramsJson}`);
}

interface PendingRow {
  id: string;
  sessionId: string;
  timestamp: number;
  direction: string;
  method: string;
  paramsJson: string;
  resultJson: string | null;
  policyAction: string | null;
  prevHash: string;
  hash: string;
}

// ── LogStore ───────────────────────────────────────────────────────────────

export class LogStore {
  private readonly db: DB;

  // Async write queue: hashes are computed synchronously (preserving chain
  // order), rows are persisted in batches off the critical path.
  private readonly tailHash = new Map<string, string>();
  private readonly writeQueue: PendingRow[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DRAIN_MS = 10;
  private static readonly BATCH_CAP = 64;

  private readonly stmtInsertSession: Stmt;
  private readonly stmtGetSessions: Stmt;
  private readonly stmtGetLastSession: Stmt;
  private readonly stmtGetSessionsInRange: Stmt;
  private readonly stmtInsertMessage: Stmt;
  private readonly stmtLastHash: Stmt;
  private readonly stmtGetMessages: Stmt;
  private readonly stmtGetMessagesAll: Stmt;
  private readonly stmtGetMessagesInRange: Stmt;
  private readonly stmtTotalMessages: Stmt;
  private readonly stmtSessionsToday: Stmt;
  private readonly stmtPoliciesTriggered: Stmt;
  private readonly stmtMethodCounts: Stmt;
  private readonly stmtPolicyEventsInRange: Stmt;
  private readonly stmtMethodsBeforeDate: Stmt;
  // Cache
  private readonly stmtGetCache: Stmt;
  private readonly stmtSetCache: Stmt;
  private readonly stmtIncrCacheHit: Stmt;
  private readonly stmtEvictCache: Stmt;
  private readonly stmtCacheStats: Stmt;
  // Activity log
  private readonly stmtInsertActivity: Stmt;
  private readonly stmtGetActivity: Stmt;
  private readonly stmtGetActivityAll: Stmt;

  constructor(dbPath: string) {
    this.db = new DB(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA cache_size = -65536");
    this.db.exec("PRAGMA temp_store = MEMORY");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        startedAt     INTEGER NOT NULL,
        clientName    TEXT    NOT NULL,
        serverName    TEXT    NOT NULL,
        serverCommand TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT    PRIMARY KEY,
        sessionId    TEXT    NOT NULL REFERENCES sessions(id),
        timestamp    INTEGER NOT NULL,
        direction    TEXT    NOT NULL,
        method       TEXT    NOT NULL,
        paramsJson   TEXT    NOT NULL,
        resultJson   TEXT,
        policyAction TEXT,
        prevHash     TEXT    NOT NULL,
        hash         TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(sessionId, timestamp);

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp
        ON messages(timestamp);

      CREATE TABLE IF NOT EXISTS tool_cache (
        key        TEXT    PRIMARY KEY,
        toolName   TEXT    NOT NULL,
        resultJson TEXT    NOT NULL,
        createdAt  INTEGER NOT NULL,
        expiresAt  INTEGER NOT NULL,
        hitCount   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_cache_expires
        ON tool_cache(expiresAt);

      CREATE TABLE IF NOT EXISTS activity_log (
        id        TEXT    PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        source    TEXT    NOT NULL,
        sessionId TEXT    NOT NULL,
        dataJson  TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activity_session
        ON activity_log(sessionId, timestamp);
    `);

    try { this.db.exec(`ALTER TABLE messages ADD COLUMN policyAction TEXT`); } catch { /* already exists */ }

    // ── Prepared statements ──────────────────────────────────────────────

    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO sessions (id, startedAt, clientName, serverName, serverCommand)
      VALUES (@id, @startedAt, @clientName, @serverName, @serverCommand)
    `);
    this.stmtGetSessions = this.db.prepare(`SELECT * FROM sessions ORDER BY startedAt DESC`);
    this.stmtGetLastSession = this.db.prepare(`SELECT * FROM sessions ORDER BY startedAt DESC LIMIT 1`);
    this.stmtGetSessionsInRange = this.db.prepare(`
      SELECT * FROM sessions WHERE startedAt >= ? AND startedAt <= ? ORDER BY startedAt ASC
    `);
    this.stmtInsertMessage = this.db.prepare(`
      INSERT INTO messages
        (id, sessionId, timestamp, direction, method, paramsJson, resultJson, policyAction, prevHash, hash)
      VALUES
        (@id, @sessionId, @timestamp, @direction, @method, @paramsJson, @resultJson, @policyAction, @prevHash, @hash)
    `);
    this.stmtLastHash = this.db.prepare(`
      SELECT hash FROM messages WHERE sessionId = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1
    `);
    this.stmtGetMessages = this.db.prepare(`
      SELECT * FROM messages WHERE sessionId = ? ORDER BY timestamp ASC, rowid ASC
    `);
    this.stmtGetMessagesAll = this.db.prepare(`SELECT * FROM messages ORDER BY timestamp ASC, rowid ASC`);
    this.stmtGetMessagesInRange = this.db.prepare(`
      SELECT * FROM messages WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC, rowid ASC
    `);
    this.stmtTotalMessages = this.db.prepare(`SELECT COUNT(*) as count FROM messages`);
    this.stmtSessionsToday = this.db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE startedAt >= ?`);
    this.stmtPoliciesTriggered = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE policyAction IN ('block', 'pause:approved', 'pause:denied')
    `);
    this.stmtMethodCounts = this.db.prepare(`
      SELECT method, COUNT(*) as count FROM messages GROUP BY method ORDER BY count DESC
    `);
    this.stmtPolicyEventsInRange = this.db.prepare(`
      SELECT policyAction, COUNT(*) as count FROM messages
      WHERE timestamp >= ? AND timestamp <= ?
        AND policyAction IN ('block', 'pause:approved', 'pause:denied')
      GROUP BY policyAction
    `);
    this.stmtMethodsBeforeDate = this.db.prepare(`
      SELECT DISTINCT method FROM messages WHERE timestamp < ? AND direction = 'inbound'
    `);

    // Cache
    this.stmtGetCache = this.db.prepare(`
      SELECT resultJson FROM tool_cache WHERE key = ? AND expiresAt > ?
    `);
    this.stmtSetCache = this.db.prepare(`
      INSERT OR REPLACE INTO tool_cache (key, toolName, resultJson, createdAt, expiresAt, hitCount)
      VALUES (@key, @toolName, @resultJson, @createdAt, @expiresAt, 0)
    `);
    this.stmtIncrCacheHit = this.db.prepare(`
      UPDATE tool_cache SET hitCount = hitCount + 1 WHERE key = ?
    `);
    this.stmtEvictCache = this.db.prepare(`
      DELETE FROM tool_cache WHERE expiresAt <= ?
    `);
    this.stmtCacheStats = this.db.prepare(`
      SELECT COUNT(*) as entries, SUM(hitCount) as totalHits FROM tool_cache WHERE expiresAt > ?
    `);

    // Activity log
    this.stmtInsertActivity = this.db.prepare(`
      INSERT INTO activity_log (id, timestamp, source, sessionId, dataJson)
      VALUES (@id, @timestamp, @source, @sessionId, @dataJson)
    `);
    this.stmtGetActivity = this.db.prepare(`
      SELECT * FROM activity_log WHERE sessionId = ? ORDER BY timestamp ASC
    `);
    this.stmtGetActivityAll = this.db.prepare(`
      SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT 200
    `);

    // Evict expired cache entries on startup
    try { this.stmtEvictCache.run(Date.now()); } catch { /* ignore */ }
  }

  // ── Session ops ───────────────────────────────────────────────────────────

  createSession(clientName: string, serverName: string, serverCommand: string): string {
    const id = randomUUID();
    this.stmtInsertSession.run({ id, startedAt: Date.now(), clientName, serverName, serverCommand });
    return id;
  }

  getSessions(): SessionRow[] {
    return this.stmtGetSessions.all() as unknown as SessionRow[];
  }

  getLastSession(): SessionRow | undefined {
    return this.stmtGetLastSession.get() as unknown as SessionRow | undefined;
  }

  getSessionsInRange(from: number, to: number): SessionRow[] {
    return this.stmtGetSessionsInRange.all(from, to) as unknown as SessionRow[];
  }

  // ── Message ops ───────────────────────────────────────────────────────────

  logMessage(
    sessionId: string,
    direction: MessageDirection,
    method: string,
    params: unknown,
    result: unknown = null,
    policyAction: string | null = null
  ): void {
    if (!this.tailHash.has(sessionId)) {
      const row = this.stmtLastHash.get(sessionId) as { hash: string } | undefined;
      this.tailHash.set(sessionId, row?.hash ?? GENESIS);
    }

    const prevHash = this.tailHash.get(sessionId)!;
    const timestamp = Date.now();
    const paramsJson = JSON.stringify(params ?? null);
    const resultJson = result !== null ? JSON.stringify(result) : null;
    const hash = computeHash(prevHash, timestamp, direction, method, paramsJson);

    this.tailHash.set(sessionId, hash);

    this.writeQueue.push({
      id: randomUUID(), sessionId, timestamp, direction, method,
      paramsJson, resultJson, policyAction, prevHash, hash,
    });

    if (this.writeQueue.length >= LogStore.BATCH_CAP) {
      this.drainNow();
    } else {
      this.scheduleDrain();
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainNow();
    }, LogStore.DRAIN_MS);
  }

  private drainNow(): void {
    if (this.drainTimer !== null) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    if (this.writeQueue.length === 0) return;
    const batch = this.writeQueue.splice(0, LogStore.BATCH_CAP);
    try {
      this.db.exec("BEGIN");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of batch) this.stmtInsertMessage.run(row as any);
      this.db.exec("COMMIT");
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
    }
  }

  getMessages(sessionId?: string): MessageRow[] {
    if (sessionId !== undefined) {
      return this.stmtGetMessages.all(sessionId) as unknown as MessageRow[];
    }
    return this.stmtGetMessagesAll.all() as unknown as MessageRow[];
  }

  getMessagesInRange(from: number, to: number): MessageRow[] {
    return this.stmtGetMessagesInRange.all(from, to) as unknown as MessageRow[];
  }

  // ── Cache ops ─────────────────────────────────────────────────────────────

  getCachedResult(key: string): string | null {
    const row = this.stmtGetCache.get(key, Date.now()) as { resultJson: string } | undefined;
    if (!row) return null;
    try { this.stmtIncrCacheHit.run(key); } catch { /* ignore */ }
    return row.resultJson;
  }

  setCachedResult(key: string, toolName: string, resultJson: string, ttlMs: number): void {
    const now = Date.now();
    try {
      this.stmtSetCache.run({ key, toolName, resultJson, createdAt: now, expiresAt: now + ttlMs });
    } catch { /* ignore */ }
  }

  getCacheStats(): { entries: number; totalHits: number } {
    const row = this.stmtCacheStats.get(Date.now()) as { entries: number; totalHits: number | null } | undefined;
    return { entries: row?.entries ?? 0, totalHits: row?.totalHits ?? 0 };
  }

  // ── Activity log ops ──────────────────────────────────────────────────────

  logActivity(sessionId: string, source: ActivitySource, data: unknown): void {
    try {
      this.stmtInsertActivity.run({
        id: randomUUID(),
        timestamp: Date.now(),
        source,
        sessionId,
        dataJson: JSON.stringify(data),
      });
    } catch { /* ignore */ }
  }

  getActivity(sessionId?: string): ActivityRow[] {
    if (sessionId) return this.stmtGetActivity.all(sessionId) as unknown as ActivityRow[];
    return this.stmtGetActivityAll.all() as unknown as ActivityRow[];
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats(): Stats {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const { count: totalMessages } = this.stmtTotalMessages.get() as { count: number };
    const { count: sessionsToday } = this.stmtSessionsToday.get(startOfToday.getTime()) as { count: number };
    const { count: policiesTriggered } = this.stmtPoliciesTriggered.get() as { count: number };
    const rows = this.stmtMethodCounts.all() as Array<{ method: string; count: number }>;
    const methodCounts: Record<string, number> = {};
    for (const row of rows) methodCounts[row.method] = row.count;
    return { totalMessages, sessionsToday, policiesTriggered, methodCounts };
  }

  getPolicyEventsInRange(from: number, to: number): PolicyEventSummary {
    const rows = this.stmtPolicyEventsInRange.all(from, to) as Array<{ policyAction: string; count: number }>;
    const summary: PolicyEventSummary = { blocks: 0, pauseApproved: 0, pauseDenied: 0 };
    for (const r of rows) {
      if (r.policyAction === "block") summary.blocks = r.count;
      else if (r.policyAction === "pause:approved") summary.pauseApproved = r.count;
      else if (r.policyAction === "pause:denied") summary.pauseDenied = r.count;
    }
    return summary;
  }

  getDistinctMethodsBefore(before: number): Set<string> {
    const rows = this.stmtMethodsBeforeDate.all(before) as Array<{ method: string }>;
    return new Set(rows.map(r => r.method));
  }

  // ── Chain verification ────────────────────────────────────────────────────

  verifyChain(): boolean {
    const rows = this.stmtGetMessagesAll.all() as unknown as MessageRow[];
    const lastHash = new Map<string, string>();
    for (const row of rows) {
      const expectedPrev = lastHash.get(row.sessionId) ?? GENESIS;
      if (row.prevHash !== expectedPrev) return false;
      if (row.hash !== computeHash(row.prevHash, row.timestamp, row.direction, row.method, row.paramsJson)) return false;
      lastHash.set(row.sessionId, row.hash);
    }
    return true;
  }

  close(): void {
    while (this.writeQueue.length > 0) this.drainNow();
    this.db.close();
  }
}
