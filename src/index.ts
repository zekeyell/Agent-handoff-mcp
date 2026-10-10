/**
 * Entry point: Express + Streamable HTTP, bearer-token auth and role-based MCP endpoints.
 *
 *   POST /mcp/dev  -> 8 tools  (frontend/backend development sessions)
 *   POST /mcp/qa   -> 4 tools  (read_file, search_code, git_status, git_commit)
 *
 * Stateless: every POST builds its own McpServer + transport. Restarts (PM2) and tunnel
 * reconnects never break a session; continuity lives in the handoff files, not in memory.
 */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSandbox } from "./sandbox.js";
import { INSTRUCTIONS, ROLE_TOOLS, appendJsonl, initWorkspace, logProtocolRejection, registerTools, type Ctx, type Role } from "./tools.js";

// ---------------------------------------------------------------------------
// Config (all from environment / .env) and fail-fast checks
// ---------------------------------------------------------------------------
function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

const AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN ?? "").trim();
if (AUTH_TOKEN.length < 16) {
  fatal("MCP_AUTH_TOKEN is missing or shorter than 16 characters. Set it in .env (see .env.example). Refusing to start without authentication.");
}

if (!process.env.WORKSPACE_ROOT) fatal("WORKSPACE_ROOT is not set. Define it in .env (see .env.example).");
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT);
const projectDir = process.cwd();
const rel = (from: string, to: string) => path.relative(from, to);
const inside = (parent: string, child: string) => {
  const r = rel(parent, child);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};
if (WORKSPACE_ROOT === path.parse(WORKSPACE_ROOT).root || WORKSPACE_ROOT === os.homedir()) {
  fatal(`WORKSPACE_ROOT must be a dedicated folder, not "${WORKSPACE_ROOT}".`);
}
if (inside(WORKSPACE_ROOT, projectDir)) {
  fatal("WORKSPACE_ROOT must not contain the project folder (it would expose .env and the logs to agents).");
}
const LOG_DIR = path.resolve(process.env.LOG_DIR ?? "logs");
if (inside(WORKSPACE_ROOT, LOG_DIR)) fatal("LOG_DIR must be outside WORKSPACE_ROOT so agents cannot touch the logs.");

const PORT = Number(process.env.PORT ?? 3000);
const TOOL_LOG = path.join(LOG_DIR, "tool-calls.jsonl");
const AUTH_LOG = path.join(LOG_DIR, "auth-failures.jsonl");
const sandbox = createSandbox(WORKSPACE_ROOT);

// ---------------------------------------------------------------------------
// Authentication: runs on EVERY request, before body parsing and routing
// ---------------------------------------------------------------------------
const digest = (s: string) => crypto.createHash("sha256").update(s).digest();

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const ok = match !== null && crypto.timingSafeEqual(digest(match[1].trim()), digest(AUTH_TOKEN));
  if (ok) return next();

  appendJsonl(AUTH_LOG, {
    ts: new Date().toISOString(), ip: req.ip, method: req.method, path: req.path,
    reason: header ? "invalid_token" : "missing_authorization_header", // the token itself is never logged
  });
  res.set("WWW-Authenticate", 'Bearer realm="mcp-file-server"');
  res.status(401).json({ error: "Unauthorized" });
}

// ---------------------------------------------------------------------------
// App + role-based MCP endpoints
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", "loopback"); // ngrok connects from localhost; use X-Forwarded-For for logs
app.use(authenticate);
app.use(express.json({ limit: "2mb" }));

function mcpEndpoint(role: Role) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = new McpServer({ name: `mcp-file-server-${role}`, version: "2.0.0" }, { instructions: INSTRUCTIONS[role] });
    const ctx: Ctx = { sandbox, role, logFile: TOOL_LOG, state: { logged: false } };
    registerTools(server, ctx);

    // Log tools/call requests the SDK rejects before a handler runs (bad input, tool not in this role).
    const started = performance.now();
    let captured = "";
    // The SDK may write the body with res.write() and/or res.end(), so capture both.
    const originalWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
    const originalEnd = res.end.bind(res) as (...a: unknown[]) => Response;
    const capture = (chunk: unknown) => {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) captured += Buffer.from(chunk).toString();
    };
    res.write = ((chunk?: unknown, ...rest: unknown[]) => {
      capture(chunk);
      return originalWrite(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      capture(chunk);
      return originalEnd(chunk, ...rest);
    }) as typeof res.end;
    res.on("finish", () => {
      const b = req.body;
      if (!b || Array.isArray(b) || b.method !== "tools/call" || ctx.state?.logged) return;
      let message = "Request rejected before the tool handler ran.";
      try {
        const j = JSON.parse(captured);
        message = j?.result?.content?.[0]?.text ?? j?.error?.message ?? message;
      } catch { /* keep default */ }
      logProtocolRejection(ctx, String(b.params?.name ?? "unknown"), b.params?.arguments, message, Math.round(performance.now() - started));
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[${role}] MCP request failed:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.set("Allow", "POST");
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null });
};

for (const role of ["dev", "qa"] as const) {
  app.post(`/mcp/${role}`, mcpEndpoint(role));
  app.all(`/mcp/${role}`, methodNotAllowed); // stateless server: no SSE stream, no sessions to delete
}

app.use((_req, res) => {
  res.status(404).json({ error: "Not found. Endpoints: POST /mcp/dev, POST /mcp/qa" });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
await initWorkspace(sandbox); // protocol files + git repo + first commit
app.listen(PORT, "127.0.0.1", () => {
  // Bound to localhost only: the ngrok tunnel is the single public entrance.
  console.log(
    `MCP server listening on http://127.0.0.1:${PORT}  ` +
      `(/mcp/dev: ${ROLE_TOOLS.dev.length} tools, /mcp/qa: ${ROLE_TOOLS.qa.length} tools)  workspace: ${sandbox.root}`,
  );
});
