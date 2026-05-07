import { spawn } from "node:child_process";
import type {
  CleanupFn,
  InboundResult,
  InterceptedMessage,
  MessageDirection,
  StartStdioProxyOptions,
} from "@sousmcp/shared";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMessage(raw: string, direction: MessageDirection): InterceptedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { direction, timestamp: new Date().toISOString(), raw, parsed };
}

// ── Outbound pipe (child → host) ───────────────────────────────────────────
// Forwards raw bytes immediately and calls onOutbound for each complete line.

function pipeOutbound(
  source: NodeJS.ReadableStream,
  onOutbound: (msg: InterceptedMessage) => void
): void {
  let buffer = "";

  (source as NodeJS.ReadableStream & { setEncoding(enc: string): void }).setEncoding("utf8");

  source.on("data", (chunk: string) => {
    // Forward raw bytes before parsing so latency is minimal.
    process.stdout.write(chunk);

    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) onOutbound(makeMessage(trimmed, "outbound"));
    }
  });

  source.on("end", () => {
    const trimmed = buffer.trimEnd();
    if (trimmed) onOutbound(makeMessage(trimmed, "outbound"));
    buffer = "";
  });
}

// ── Inbound pipe (host → child) ────────────────────────────────────────────
// Parses each complete line, awaits onInbound, then either forwards to the
// child or writes an error response back to the host.  Messages are processed
// strictly in order via a serial promise queue so a pause in onInbound
// naturally stalls later messages without losing them.

function pipeInbound(
  source: NodeJS.ReadableStream,
  childStdin: NodeJS.WritableStream,
  onInbound: (msg: InterceptedMessage) => Promise<InboundResult>
): void {
  let buffer = "";
  let queue = Promise.resolve();

  (source as NodeJS.ReadableStream & { setEncoding(enc: string): void }).setEncoding("utf8");

  function enqueue(raw: string): void {
    queue = queue.then(async () => {
      const msg = makeMessage(raw, "inbound");
      const result = await onInbound(msg);

      if (result.action === "forward") {
        if (!(childStdin as NodeJS.WritableStream & { destroyed: boolean }).destroyed) {
          childStdin.write(raw + "\n");
        }
      } else if (result.errorResponse) {
        process.stdout.write(result.errorResponse + "\n");
      }
    }).catch((err: unknown) => {
      process.stderr.write(`[sousmcp] inbound handler error: ${String(err)}\n`);
    });
  }

  source.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) enqueue(trimmed);
    }
  });

  source.on("end", () => {
    const trimmed = buffer.trimEnd();
    if (trimmed) enqueue(trimmed);
    buffer = "";
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

export function startStdioProxy(options: StartStdioProxyOptions): CleanupFn {
  const { targetCommand, targetArgs, onInbound, onOutbound } = options;

  const child = spawn(targetCommand, targetArgs, {
    stdio: ["pipe", "pipe", "inherit"],
  });

  pipeInbound(process.stdin, child.stdin, onInbound);
  pipeOutbound(child.stdout!, onOutbound);

  child.on("exit", (code, signal) => {
    process.exitCode = code ?? 1;
    if (signal) process.kill(process.pid, signal);
  });

  return () => {
    if (!child.killed) child.kill();
  };
}
