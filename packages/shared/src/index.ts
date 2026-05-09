export type MessageDirection = "inbound" | "outbound";

export interface InterceptedMessage {
  direction: MessageDirection;
  timestamp: string;
  raw: string;
  parsed: unknown;
}

// Returned by the inbound handler to control forwarding.
export interface InboundResult {
  action: "forward" | "block";
  // JSON-RPC response written back to the host when action === "block".
  // May be a cached result (not necessarily an error).
  errorResponse?: string;
  // When set and action === "forward", this is written to child stdin instead of the original raw line.
  // Used to translate virtual tool calls (e.g. sousmcp_execute_tool) into real tool calls.
  modifiedRaw?: string;
}

export interface StartStdioProxyOptions {
  targetCommand: string;
  targetArgs: string[];
  // Called for each complete JSON line from stdin (host → child).
  // Awaited before the line is forwarded, so a pause blocks here.
  onInbound: (msg: InterceptedMessage) => Promise<InboundResult>;
  // Called for each complete JSON line from child stdout (child → host).
  // Always forwarded; callback is for observation / logging only.
  onOutbound: (msg: InterceptedMessage) => void;
  // Optional synchronous transform applied to each outbound line BEFORE forwarding to the host.
  // Return the (possibly modified) line. Enables Layer 1 (dynamic schema stripping) and Layer 3 (compression).
  onOutboundTransform?: (line: string) => string;
  // Called once the child process has been spawned (PID available for monitoring).
  onChildSpawn?: (pid: number) => void;
  // Called for each line on child stderr (for subprocess detection heuristics).
  onChildStderr?: (line: string) => void;
}

export type CleanupFn = () => void;
