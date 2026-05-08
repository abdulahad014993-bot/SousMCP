// Shared in-memory store for pending policy approvals.
// notify.ts writes here; server.ts reads and resolves.

export interface PendingApproval {
  id: string;
  method: string;
  toolName: string;
  params: unknown;
  ruleName: string;
  createdAt: number;
}

type Resolver = (decision: "approve" | "deny") => void;

const store = new Map<string, { approval: PendingApproval; resolve: Resolver }>();

export function registerApproval(
  id: string,
  method: string,
  toolName: string,
  params: unknown,
  ruleName: string,
  resolve: Resolver
): void {
  store.set(id, {
    approval: { id, method, toolName, params, ruleName, createdAt: Date.now() },
    resolve,
  });
}

export function resolveApproval(id: string, decision: "approve" | "deny"): boolean {
  const entry = store.get(id);
  if (!entry) return false;
  store.delete(id);
  entry.resolve(decision);
  return true;
}

export function cancelApproval(id: string): void {
  store.delete(id);
}

export function listApprovals(): PendingApproval[] {
  return Array.from(store.values()).map(e => e.approval);
}
