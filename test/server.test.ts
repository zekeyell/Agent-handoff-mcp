/**
 * Integration tests: boots the REAL server (src/index.ts) on a random port with a temp
 * workspace and talks to it over HTTP, exactly like an MCP client would.
 * Covers: fail-to-boot without a token, 401 on every request without a token,
 * role-based tool lists, sandbox rejection through the tools, gated delete,
 * truncation note, unique str_replace, git checkpoints and the JSONL log.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "test-token-0123456789abcdef";

let proc: ChildProcess;
let base = "";
let tmp = "";
let logDir = "";
let nextId = 1;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function spawnServer(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: PROJECT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function rpc(role: string, method: string, params?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp/${role}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const call = async (role: string, name: string, args: unknown) => (await rpc(role, "tools/call", { name, arguments: args })).body;
const textOf = (b: any): string => b?.result?.content?.[0]?.text ?? "";
const isErr = (b: any): boolean => b?.result?.isError === true;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-it-"));
  logDir = path.join(tmp, "logs");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawnServer({ PORT: String(port), WORKSPACE_ROOT: path.join(tmp, "ws"), MCP_AUTH_TOKEN: TOKEN, LOG_DIR: logDir });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in 20s")), 20_000);
    proc.stdout!.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr!.on("data", (d) => process.stderr.write(d));
    proc.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
  });
});

after(async () => {
  proc?.removeAllListeners("exit");
  proc?.kill();
  await fs.rm(tmp, { recursive: true, force: true });
});

test("server refuses to boot without MCP_AUTH_TOKEN", async () => {
  const child = spawnServer({ PORT: "0", WORKSPACE_ROOT: path.join(tmp, "ws2"), MCP_AUTH_TOKEN: "", LOG_DIR: logDir });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /MCP_AUTH_TOKEN/);
});

test("every request without a valid token gets 401", async () => {
  for (const role of ["dev", "qa"]) {
    assert.equal((await rpc(role, "tools/list", {}, null)).status, 401);
    assert.equal((await rpc(role, "tools/list", {}, "wrong-token-wrong-token")).status, 401);
  }
  for (const [method, p] of [["GET", "/mcp/dev"], ["DELETE", "/mcp/qa"], ["GET", "/health"], ["POST", "/anything"]]) {
    assert.equal((await fetch(base + p, { method })).status, 401, `${method} ${p}`);
  }
  const lines = (await fs.readFile(path.join(logDir, "auth-failures.jsonl"), "utf8")).trim().split("\n");
  assert.ok(lines.length >= 8);
  assert.ok(!lines.join("\n").includes(TOKEN));
});

test("dev exposes 8 tools, qa exposes exactly 4", async () => {
  const dev = (await rpc("dev", "tools/list", {})).body.result.tools.map((t: any) => t.name).sort();
  const qa = (await rpc("qa", "tools/list", {})).body.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(dev, ["delete_file", "git_commit", "git_status", "list_files", "read_file", "search_code", "str_replace", "write_file"]);
  assert.deepEqual(qa, ["git_commit", "git_status", "read_file", "search_code"]);
});

test("qa cannot call write or delete tools", async () => {
  for (const name of ["write_file", "str_replace", "delete_file", "list_files"]) {
    const b = await call("qa", name, { path: "x.txt", content: "x", old_str: "a", new_str: "b", confirm: true });
    assert.ok(b.error || isErr(b), `qa should not be able to call ${name}`);
  }
});

test("handoff files are seeded and the repo has a first commit", async () => {
  const tree = textOf(await call("dev", "list_files", {}));
  for (const f of ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"]) assert.match(tree, new RegExp(f));
  const status = textOf(await call("dev", "git_status", {}));
  assert.match(status, /clean/);
  assert.match(status, /seed handoff protocol files/);
});

test("sandbox rejections come back as isError (dev and qa)", async () => {
  for (const role of ["dev", "qa"]) {
    for (const p of ["../.env", "../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini", "..\\..\\package.json", "lib/../../x", ".git/config", "a\0b"]) {
      const b = await call(role, "read_file", { path: p });
      assert.ok(isErr(b), `${role} read_file(${JSON.stringify(p)}) should be an error`);
      assert.match(textOf(b), /SANDBOX VIOLATION/);
      assert.ok(!textOf(b).includes(tmp), "error must not leak the host path");
    }
  }
  assert.ok(isErr(await call("dev", "write_file", { path: "../evil.txt", content: "x" })));
  assert.ok(isErr(await call("dev", "list_files", { path: ".." })));
});

test("write, read, unique str_replace", async () => {
  assert.ok(!isErr(await call("dev", "write_file", { path: "lib/main.dart", content: "void main() {\n  print('a');\n  print('a');\n}\n" })));
  assert.match(textOf(await call("dev", "read_file", { path: "lib/main.dart" })), /void main/);

  const dup = await call("dev", "str_replace", { path: "lib/main.dart", old_str: "print('a');", new_str: "print('b');" });
  assert.ok(isErr(dup));
  assert.match(textOf(dup), /more than once/);

  assert.ok(isErr(await call("dev", "str_replace", { path: "lib/main.dart", old_str: "nope", new_str: "x" })));

  const ok = await call("dev", "str_replace", { path: "lib/main.dart", old_str: "  print('a');\n  print('a');", new_str: "  print('ok');" });
  assert.ok(!isErr(ok), textOf(ok));
  assert.match(textOf(await call("dev", "read_file", { path: "lib/main.dart" })), /print\('ok'\)/);
});

test("read_file truncates over 1000 lines and supports ranges", async () => {
  const big = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  await call("dev", "write_file", { path: "big.txt", content: big });
  const full = textOf(await call("dev", "read_file", { path: "big.txt" }));
  assert.match(full, /SYSTEM NOTE/);
  assert.match(full, /start_line/);
  assert.match(full, /end_line/);
  assert.ok(full.includes("line 1000") && !full.includes("line 1001"));
  const range = textOf(await call("dev", "read_file", { path: "big.txt", start_line: 1100, end_line: 1102 }));
  assert.equal(range, "[lines 1100-1102 of 1200]\nline 1100\nline 1101\nline 1102");
  assert.ok(isErr(await call("dev", "read_file", { path: "big.txt", start_line: 5000 })));
});

test("delete_file is gated and protocol files are protected", async () => {
  await call("dev", "write_file", { path: "tmp/old.txt", content: "bye" });
  const noConfirm = await call("dev", "delete_file", { path: "tmp/old.txt", confirm: false });
  assert.ok(isErr(noConfirm));
  assert.match(textOf(noConfirm), /not confirmed/);
  assert.match(textOf(await call("dev", "read_file", { path: "tmp/old.txt" })), /bye/); // still there

  for (const f of ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md", "decisions.md", "PLAN_LOG"]) {
    const b = await call("dev", "delete_file", { path: f, confirm: true });
    assert.ok(isErr(b), `${f} must be protected`);
    assert.match(textOf(b), /protocol file/);
  }
  assert.ok(isErr(await call("dev", "delete_file", { path: "tmp", confirm: true }))); // directories refused
  assert.ok(!isErr(await call("dev", "delete_file", { path: "tmp/old.txt", confirm: true })));
  assert.ok(isErr(await call("dev", "read_file", { path: "tmp/old.txt" })));
});

test("search_code finds literals and regex, reports no-match, rejects bad regex", async () => {
  await call("dev", "write_file", { path: "lib/api.dart", content: "const apiKey = 'PLACEHOLDER';\n// TODO: wire up\n" });
  const hit = textOf(await call("dev", "search_code", { query: "apikey" }));
  assert.match(hit, /lib\/api\.dart:1:/);
  assert.match(textOf(await call("dev", "search_code", { query: "TO[D]O", regex: true })), /api\.dart:2/);
  assert.equal(textOf(await call("dev", "search_code", { query: "zzz-not-there" })), "No matches.");
  assert.ok(isErr(await call("dev", "search_code", { query: "(", regex: true })));
  assert.ok(isErr(await call("dev", "search_code", { query: "x", path: "../" })));
  assert.match(textOf(await call("qa", "search_code", { query: "-e --help; echo pwned" })), /No matches/); // no option/shell injection
});

test("git: dev checkpoint, qa audit marker, history is attributed", async () => {
  assert.match(textOf(await call("dev", "git_status", {})), /uncommitted/);
  const c = await call("dev", "git_commit", { message: "feat: initial scaffold" });
  assert.ok(!isErr(c), textOf(c));
  assert.match(textOf(await call("dev", "git_status", {})), /clean/);
  assert.match(textOf(await call("dev", "git_commit", { message: "nothing here" })), /Nothing to commit/);

  const q = await call("qa", "git_commit", { message: "QA audit: PASS, 0 blockers", allow_empty: true });
  assert.ok(!isErr(q), textOf(q));
  const status = textOf(await call("qa", "git_status", {}));
  assert.match(status, /\[dev\] feat: initial scaffold/);
  assert.match(status, /\[qa\] QA audit: PASS/);
  assert.ok(isErr(await call("dev", "git_commit", { message: "bad path", paths: ["../x"] })));
});

test("invalid tool input is rejected without crashing the server", async () => {
  const b = await call("dev", "read_file", { path: 123 });
  assert.ok(b.error || isErr(b));
  const c = await call("dev", "delete_file", { path: "x.txt" }); // confirm missing
  assert.ok(c.error || isErr(c));
  assert.equal((await rpc("dev", "tools/list", {})).status, 200); // still alive
});

test("every tool call is logged with timestamp, duration and status", async () => {
  const rows = (await fs.readFile(path.join(logDir, "tool-calls.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rows.length > 20);
  for (const r of rows) {
    assert.ok(!Number.isNaN(Date.parse(r.ts)));
    assert.equal(typeof r.ms, "number");
    assert.ok(["success", "error"].includes(r.status));
    assert.ok(["dev", "qa"].includes(r.role));
    assert.equal(typeof r.tool, "string");
  }
  assert.ok(rows.some((r) => r.status === "error" && /SANDBOX VIOLATION/.test(r.error)));
  // calls rejected by the SDK before any handler ran are logged too
  assert.ok(rows.some((r) => r.role === "qa" && r.tool === "write_file" && r.status === "error" && r.rejected_by === "protocol"));
  assert.ok(rows.some((r) => r.tool === "delete_file" && r.rejected_by === "protocol" && /validation/i.test(r.error)));
  const w = rows.find((r) => r.tool === "write_file" && r.args.path === "big.txt");
  assert.match(w.args.content, /^<\d+ chars>$/); // file contents never land in the log
});
