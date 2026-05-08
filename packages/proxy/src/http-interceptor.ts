// HTTP/SSE reverse proxy for MCP servers that expose a URL instead of stdio.
// Usage: install wraps { url: "http://..." } servers by pointing Claude at the
// local interceptor port, which forwards every request to the real server.

import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import type { InterceptedMessage, InboundResult } from "@sousmcp/shared";
import { log } from "./logger.js";

export interface HttpInterceptorOptions {
  targetUrl: string;
  listenPort: number;
  onInbound: (msg: InterceptedMessage) => Promise<InboundResult>;
  onOutbound: (msg: InterceptedMessage) => void;
}

export interface HttpInterceptorHandle {
  port: number;
  close(): void;
}

export function startHttpInterceptor(opts: HttpInterceptorOptions): HttpInterceptorHandle {
  const target = new URL(opts.targetUrl);
  const isHttps = target.protocol === "https:";
  const targetPort = target.port
    ? parseInt(target.port, 10)
    : isHttps ? 443 : 80;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      const bodyStr = bodyBuf.toString("utf8");

      let parsed: unknown = null;
      try { parsed = JSON.parse(bodyStr); } catch { /* SSE/non-JSON body */ }

      const msg: InterceptedMessage = {
        raw: bodyStr,
        parsed,
        direction: "inbound",
        timestamp: new Date().toISOString(),
      };

      opts.onInbound(msg).then(result => {
        if (result.action === "block") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(result.errorResponse ?? JSON.stringify({ error: "Blocked by SousMCP" }));
          return;
        }
        forward(req, res, bodyBuf);
      }).catch(err => {
        log("error", `HTTP interceptor onInbound: ${String(err)}`);
        forward(req, res, bodyBuf); // fail-open
      });
    });
  });

  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer
  ): void {
    const proxyOpts: http.RequestOptions = {
      hostname: target.hostname,
      port: targetPort,
      path: req.url ?? "/",
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host,
        "content-length": String(body.length),
      },
    };

    const proxyReq = (isHttps ? https : http).request(proxyOpts, proxyRes => {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);

      const respChunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => {
        respChunks.push(chunk);
        res.write(chunk); // stream through immediately (SSE-friendly)
      });

      proxyRes.on("end", () => {
        res.end();
        const respStr = Buffer.concat(respChunks).toString("utf8");
        let respParsed: unknown = null;
        try { respParsed = JSON.parse(respStr); } catch { /* SSE */ }
        opts.onOutbound({
          raw: respStr,
          parsed: respParsed,
          direction: "outbound",
          timestamp: new Date().toISOString(),
        });
      });
    });

    proxyReq.on("error", (err: Error) => {
      log("error", `HTTP proxy upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Upstream unavailable", detail: err.message }));
      }
    });

    proxyReq.end(body);
  }

  server.on("error", (err: Error) => {
    log("error", `HTTP interceptor server error: ${err.message}`);
  });

  server.listen(opts.listenPort, "127.0.0.1", () => {
    log("info", `HTTP interceptor :${opts.listenPort} → ${opts.targetUrl}`);
  });

  return {
    port: opts.listenPort,
    close: () => server.close(),
  };
}

// Pick a free port for the interceptor, starting from base.
export async function findFreePort(base: number): Promise<number> {
  const net = await import("node:net");
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = (addr && typeof addr === "object") ? addr.port : base;
      s.close(() => resolve(port));
    });
    s.on("error", () => resolve(base + Math.floor(Math.random() * 1000)));
  });
}
