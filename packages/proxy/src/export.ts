import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { LogStore, MessageRow, SessionRow } from "./store.js";

// ── Bundle format ──────────────────────────────────────────────────────────

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  from: string;
  to: string;
  sessions: SessionRow[];
  messages: MessageRow[];
  merkleRoots: Record<string, string>; // sessionId → last hash in session
  bundleHash: string;                  // SHA-256 of everything above (excl. bundleHash)
}

type BundleBody = Omit<ExportBundle, "bundleHash">;

function sign(body: BundleBody): ExportBundle {
  const hash = createHash("sha256")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return { ...body, bundleHash: hash };
}

// ── Export ─────────────────────────────────────────────────────────────────

export function exportBundle(
  store: LogStore,
  from: Date,
  to: Date,
  outPath: string
): ExportBundle {
  const fromMs = from.getTime();
  const toMs = to.getTime();

  const sessions = store.getSessionsInRange(fromMs, toMs);
  const messages = store.getMessagesInRange(fromMs, toMs);

  // Compute the last Merkle hash for each session in the export range.
  const merkleRoots: Record<string, string> = {};
  for (const msg of messages) {
    merkleRoots[msg.sessionId] = msg.hash; // last write wins — messages are ASC ordered
  }

  const body: BundleBody = {
    version: 1,
    exportedAt: new Date().toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    sessions,
    messages,
    merkleRoots,
  };

  const bundle = sign(body);
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2), "utf8");
  return bundle;
}

// ── Verify ─────────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  stats: { sessions: number; messages: number };
}

export function verifyBundle(filePath: string): VerifyResult {
  const errors: string[] = [];
  let bundle: ExportBundle;

  try {
    bundle = JSON.parse(fs.readFileSync(filePath, "utf8")) as ExportBundle;
  } catch (err) {
    return { ok: false, errors: [`Cannot read file: ${String(err)}`], stats: { sessions: 0, messages: 0 } };
  }

  // 1. Verify bundle hash
  const { bundleHash, ...body } = bundle;
  const computed = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
  if (computed !== bundleHash) {
    errors.push(`Bundle hash mismatch — file may have been tampered with`);
  }

  // 2. Verify Merkle chain for each session
  const GENESIS = "0".repeat(64);

  function sha256(data: string): string {
    return createHash("sha256").update(data, "utf8").digest("hex");
  }

  const lastHash = new Map<string, string>();
  for (const msg of bundle.messages) {
    const expectedPrev = lastHash.get(msg.sessionId) ?? GENESIS;
    if (msg.prevHash !== expectedPrev) {
      errors.push(`Chain break at message ${msg.id}: prevHash mismatch`);
    }
    const expectedHash = sha256(
      `${msg.prevHash}|${msg.timestamp}|${msg.direction}|${msg.method}|${msg.paramsJson}`
    );
    if (msg.hash !== expectedHash) {
      errors.push(`Hash mismatch at message ${msg.id}`);
    }
    lastHash.set(msg.sessionId, msg.hash);
  }

  // 3. Verify merkleRoots match last hashes
  for (const [sessionId, root] of Object.entries(bundle.merkleRoots)) {
    const actual = lastHash.get(sessionId);
    if (actual !== root) {
      errors.push(`Merkle root mismatch for session ${sessionId}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: { sessions: bundle.sessions.length, messages: bundle.messages.length },
  };
}
