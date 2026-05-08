import { spawn } from "node:child_process";
import { log } from "./logger.js";
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
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  return { direction, timestamp: new Date().toISOString(), raw, parsed };
}

// ── Outbound pipe (child → host) ───────────────────────────────────────────

function pipeOutbound(
  source: NodeJS.ReadableStream,
  onOutbound: (msg: InterceptedMessage) => void
): void {
  let buffer = "";
  (source as NodeJS.ReadableStream & { setEncoding(e: string): void }).setEncoding("utf8");

  source.on("data", (chunk: string) => {
    process.stdout.write(chunk); // forward immediately — latency matters
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      try { onOutbound(makeMessage(trimmed, "outbound")); } catch (err) {
        log("error", `onOutbound error: ${String(err)}`);
      }
    }
  });

  source.on("end", () => {
    const trimmed = buffer.trimEnd();
    if (trimmed) {
      try { onOutbound(makeMessage(trimmed, "outbound")); } catch { /* ignore */ }
    }
    buffer = "";
  });
}

// ── Inbound pipe (host → child) ────────────────────────────────────────────
// Serial queue ensures messages are processed in order.
// If the handler throws, the message is forwarded anyway (fail-open).

function pipeInbound(
  source: NodeJS.ReadableStream,
  childStdin: NodeJS.WritableStream,
  onInbound: (msg: InterceptedMessage) => Promise<InboundResult>
): void {
  let buffer = "";
  let queue = Promise.resolve();

  (source as NodeJS.ReadableStream & { setEncoding(e: string): void }).setEncoding("utf8");

  function enqueue(raw: string): void {
    queue = queue.then(async () => {
      let result: InboundResult = { action: "forward" }; // fail-open default
      try {
        result = await onInbound(makeMessage(raw, "inbound"));
      } catch (err) {
        log("error", `onInbound error — forwarding anyway: ${String(err)}`);
      }

      if (result.action === "forward") {
        if (!(childStdin as NodeJS.WritableStream & { destroyed: boolean }).destroyed) {
          childStdin.write(raw + "\n");
        }
      } else if (result.errorResponse) {
        process.stdout.write(result.errorResponse + "\n");
      }
    }).catch((err: unknown) => {
      log("error", `inbound queue error: ${String(err)}`);
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
    // Forward EOF to the MCP server after the queue drains — if the host
    // closes its connection the server should also be told to stop.
    queue.then(() => {
      try { childStdin.end(); } catch { /* ignore */ }
    }).catch(() => { /* ignore */ });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

export function startStdioProxy(options: StartStdioProxyOptions): CleanupFn {
  const { targetCommand, targetArgs, onInbound, onOutbound } = options;

  const child = spawn(targetCommand, targetArgs, {
    stdio: ["pipe", "pipe", "inherit"],
  });

  child.on("error", (err) => {
    log("error", `Child process error: ${String(err)}`);
  });

  pipeInbound(process.stdin, child.stdin, onInbound);
  pipeOutbound(child.stdout!, onOutbound);

  child.on("exit", (code, signal) => {
    log("info", `Child exited: code=${code} signal=${signal}`);
    process.exitCode = code ?? 1;
    if (signal) {
      try { process.kill(process.pid, signal); } catch { /* ignore */ }
    }
  });

  return () => {
    try { if (!child.killed) child.kill(); } catch { /* ignore */ }
  };
}
