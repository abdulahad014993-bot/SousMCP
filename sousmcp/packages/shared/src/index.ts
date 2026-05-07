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
  // JSON-RPC error string written back to the host when action === "block".
  errorResponse?: string;
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
}

export type CleanupFn = () => void;
