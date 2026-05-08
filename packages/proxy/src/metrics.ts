// In-memory metrics for the current proxy process. Resets daily.

export interface MetricsSnapshot {
  uptime: number;
  dailyResetAt: string;
  messages: { total: number; inbound: number; outbound: number };
  policy: { blocked: number; pausedApproved: number; pausedDenied: number; errors: number };
  avgLatencyMs: number | null;
  ruleHits: Record<string, { log: number; pause: number; block: number }>;
}

class Metrics {
  private readonly startTime = Date.now();
  private dailyResetAt = this.midnight();

  private total = 0;
  private inbound = 0;
  private outbound = 0;
  private blocked = 0;
  private pausedApproved = 0;
  private pausedDenied = 0;
  private errors = 0;
  private latencies: number[] = [];
  private ruleHits: Record<string, { log: number; pause: number; block: number }> = {};

  private midnight(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  private checkReset(): void {
    if (Date.now() < this.dailyResetAt + 86_400_000) return;
    this.total = 0; this.inbound = 0; this.outbound = 0;
    this.blocked = 0; this.pausedApproved = 0; this.pausedDenied = 0;
    this.errors = 0; this.latencies = []; this.ruleHits = {};
    this.dailyResetAt = this.midnight();
  }

  recordMessage(direction: "inbound" | "outbound"): void {
    this.checkReset();
    this.total++;
    if (direction === "inbound") this.inbound++; else this.outbound++;
  }

  recordPolicyAction(
    ruleName: string | undefined,
    action: string,
    latencyMs?: number
  ): void {
    this.checkReset();
    if (action === "block") this.blocked++;
    else if (action === "pause:approved") this.pausedApproved++;
    else if (action === "pause:denied") this.pausedDenied++;

    if (ruleName) {
      const entry = (this.ruleHits[ruleName] ??= { log: 0, pause: 0, block: 0 });
      if (action === "block") entry.block++;
      else if (action.startsWith("pause")) entry.pause++;
      else entry.log++;
    }

    if (latencyMs !== undefined) this.latencies.push(latencyMs);
  }

  recordError(): void {
    this.checkReset();
    this.errors++;
  }

  snapshot(): MetricsSnapshot {
    this.checkReset();
    const avg = this.latencies.length > 0
      ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
      : null;
    return {
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      dailyResetAt: new Date(this.dailyResetAt).toISOString(),
      messages: { total: this.total, inbound: this.inbound, outbound: this.outbound },
      policy: {
        blocked: this.blocked,
        pausedApproved: this.pausedApproved,
        pausedDenied: this.pausedDenied,
        errors: this.errors,
      },
      avgLatencyMs: avg !== null ? Math.round(avg * 10) / 10 : null,
      ruleHits: { ...this.ruleHits },
    };
  }
}

export const metrics = new Metrics();
