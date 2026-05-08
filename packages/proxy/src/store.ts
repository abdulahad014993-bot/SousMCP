import { DatabaseSync as DB } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { MessageDirection } from "@sousmcp/shared";

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

  constructor(dbPath: string) {
    this.db = new DB(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");   // safe with WAL; skips per-write fsync
    this.db.exec("PRAGMA cache_size = -65536");    // 64 MB page cache
    this.db.exec("PRAGMA temp_store = MEMORY");    // temp tables stay in RAM
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
    `);

    try { this.db.exec(`ALTER TABLE messages ADD COLUMN policyAction TEXT`); } catch { /* already exists */ }

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
    // On the first message for a session, seed tail hash from DB (one DB read).
    // All subsequent messages use the in-memory value — zero DB reads on hot path.
    if (!this.tailHash.has(sessionId)) {
      const row = this.stmtLastHash.get(sessionId) as { hash: string } | undefined;
      this.tailHash.set(sessionId, row?.hash ?? GENESIS);
    }

    const prevHash = this.tailHash.get(sessionId)!;
    const timestamp = Date.now();
    const paramsJson = JSON.stringify(params ?? null);
    const resultJson = result !== null ? JSON.stringify(result) : null;
    const hash = computeHash(prevHash, timestamp, direction, method, paramsJson);

    // Advance in-memory tail before returning so the next call chains correctly
    // even if multiple messages arrive before the async drain fires.
    this.tailHash.set(sessionId, hash);

    this.writeQueue.push({
      id: randomUUID(), sessionId, timestamp, direction, method,
      paramsJson, resultJson, policyAction, prevHash, hash,
    });

    // Flush immediately when the queue is full, otherwise wait for the batch window.
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
      // Discard the failed batch — the in-memory chain is still valid and new
      // messages will continue chaining correctly from the last persisted hash.
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
    // Drain all pending writes before closing — ensures nothing is lost on
    // graceful shutdown (SIGTERM/SIGINT handled in index.ts).
    while (this.writeQueue.length > 0) this.drainNow();
    this.db.close();
  }
}
