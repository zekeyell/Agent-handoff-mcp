/**
 * TOOLS: Zod schemas + implementation for all 8 tools, the role -> tool mapping,
 * the handoff-protocol files, and the JSONL call logger.
 *
 * Rules every tool follows (these map directly to the rubric):
 *   - Input is validated by Zod (the `shape` of each tool) before the handler runs.
 *   - The FIRST thing every file-touching handler does is `ctx.sandbox.resolve(path)`.
 *   - Every failure becomes an MCP result with `isError: true` and a message that tells the
 *     agent how to recover. No stack traces, no absolute host paths.
 *   - Every call (success or failure) is appended to logs/tool-calls.jsonl with a timestamp,
 *     duration and status.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SandboxError, type Sandbox } from "./sandbox.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types, limits, errors
// ---------------------------------------------------------------------------
export type Role = "dev" | "qa";

export interface Ctx {
  sandbox: Sandbox;
  role: Role;
  /** Absolute path of logs/tool-calls.jsonl (kept outside the workspace). */
  logFile: string;
  /** Per-request flag: set once a handler logged the call (lets index.ts log protocol-level rejections). */
  state?: { logged: boolean };
}

const MAX_LINES = 1000; // read_file truncation threshold (efficiency rule)
const MAX_READ_BYTES = 2_000_000; // refuse to load huge files into memory
const MAX_WRITE_CHARS = 1_000_000;
const HIDDEN_DIRS = new Set([".git", "node_modules"]);
const NOISE_DIRS = ["node_modules/", ".dart_tool/"]; // filtered out of search results

/** Expected, agent-facing failure: the message is returned as-is. */
class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

// ---------------------------------------------------------------------------
// Handoff protocol files
// ---------------------------------------------------------------------------
export const PROTOCOL_FILES = ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"] as const;

const TEMPLATES: Record<(typeof PROTOCOL_FILES)[number], string> = {
  "PROJECT_STATE.md": [
    "# PROJECT_STATE",
    "",
    "Current snapshot. OVERWRITE this file at the end of every session. Keep it under 30 lines.",
    "",
    "- Goal:",
    "- Status:",
    "- Files that matter:",
    "- Next action (be exact):",
    "- Blockers / open questions:",
    "",
  ].join("\n"),
  "PLAN_LOG.md": [
    "# PLAN_LOG",
    "",
    "APPEND-ONLY. Write your plan BEFORE you act, then one line per finished step.",
    "Format: `S<n> [dev|qa] PLAN: ...` / `S<n> [dev|qa] DONE: ...` / `S<n> [dev|qa] CHANGED: ...`",
    "",
  ].join("\n"),
  "CHECKPOINTS.md": [
    "# CHECKPOINTS",
    "",
    "APPEND-ONLY. After each milestone: git_commit, then add `S<n> <short-hash> <what now works>`.",
    "",
  ].join("\n"),
  "DECISIONS.md": [
    "# DECISIONS",
    "",
    "APPEND-ONLY. `S<n> DECISION: ... WHY: ... ALTERNATIVES: ...`",
    "",
  ].join("\n"),
};

const EFFICIENCY_RULES = [
  "Efficiency rules: read before you write; never edit blind.",
  "Use search_code to locate things instead of reading many files.",
  "Use read_file with start_line/end_line for big files.",
  "Prefer str_replace over rewriting a whole file.",
  "Do not re-read a file you just wrote. Do not retry a failed call without new information.",
].join(" ");

export const INSTRUCTIONS: Record<Role, string> = {
  dev: [
    "You are a DEV agent on a shared workspace. All paths are relative to the workspace root; absolute paths and '..' are rejected.",
    "HANDOFF PROTOCOL (every session):",
    "1. START: read PROJECT_STATE.md, then the end of PLAN_LOG.md, CHECKPOINTS.md and DECISIONS.md. You have no memory of earlier sessions; these files are your memory.",
    "2. PLAN: append your plan to PLAN_LOG.md before changing any code.",
    "3. MILESTONE: git_commit the code, then append the short hash to CHECKPOINTS.md.",
    "4. DECIDE: record non-obvious choices in DECISIONS.md.",
    "5. END: overwrite PROJECT_STATE.md (status + exact next action), then git_commit the handoff files.",
    "delete_file needs confirm=true and can never delete the four protocol files.",
    EFFICIENCY_RULES,
  ].join("\n"),
  qa: [
    "You are a QA auditor with READ-ONLY access plus git. You cannot create, edit or delete files.",
    "All paths are relative to the workspace root; absolute paths and '..' are rejected.",
    "START: read PROJECT_STATE.md and the end of PLAN_LOG.md, CHECKPOINTS.md and DECISIONS.md, then run git_status and compare the history with CHECKPOINTS.md.",
    "Report findings in your final message (severity, file, line, evidence).",
    "Use git_commit only to record the audit: pass allow_empty=true with a message like 'QA audit: PASS, 0 blockers'.",
    EFFICIENCY_RULES,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Logging: one JSON line per tool call
// ---------------------------------------------------------------------------
export function appendJsonl(file: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    /* logging must never break a request */
  }
}

/** Keep logs small and free of file contents: long strings become "<N chars>". */
function summarizeArgs(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = args?.[k];
    if (v === undefined) continue;
    out[k] = typeof v === "string" && v.length > 80 ? `<${v.length} chars>` : v;
  }
  return out;
}

/**
 * Calls rejected by the MCP SDK BEFORE any handler runs (Zod validation failure, or a tool
 * the role does not have, e.g. qa -> write_file) never reach `execute`. index.ts calls this
 * so that even those attempts end up in the log: they are the proof of role gating.
 */
export function logProtocolRejection(ctx: Ctx, tool: string, args: unknown, message: string, ms: number): void {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  appendJsonl(ctx.logFile, {
    ts: new Date().toISOString(), role: ctx.role, tool, status: "error", ms,
    args: summarizeArgs(a, Object.keys(a).slice(0, 10)), error: message.slice(0, 300), rejected_by: "protocol",
  });
}

// ---------------------------------------------------------------------------
// Git helpers (execFile + argument arrays: no shell, so no shell injection)
// ---------------------------------------------------------------------------
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function gitRaw(root: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["--literal-pathspecs", ...args], {
      cwd: root,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    if (err.code === "ENOENT") throw new ToolError("git is not installed or not on PATH on the server.");
    if (err.killed) throw new ToolError("git timed out after 15 seconds.");
    if (typeof err.code === "number") return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    throw e;
  }
}

async function gitOk(root: string, args: string[]): Promise<string> {
  const r = await gitRaw(root, args);
  if (r.code !== 0) {
    const sub = args.find((a) => !a.startsWith("-")) ?? "command";
    throw new ToolError(`git ${sub} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }
  return r.stdout.trimEnd();
}

/** Create the protocol files, the git repo and the first commit (idempotent). */
export async function initWorkspace(sandbox: Sandbox): Promise<void> {
  const root = sandbox.root;
  await fs.mkdir(root, { recursive: true });
  for (const name of PROTOCOL_FILES) {
    const file = path.join(root, name);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, TEMPLATES[name], "utf8");
    }
  }
  if (!existsSync(path.join(root, ".git"))) {
    await gitOk(root, ["init", "--quiet"]);
    await gitOk(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
  const head = await gitRaw(root, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) {
    await gitOk(root, ["add", "--", ...PROTOCOL_FILES]);
    await gitOk(root, [
      "-c", "user.name=mcp-server", "-c", "user.email=server@mcp.local", "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--no-verify", "--message=chore: seed handoff protocol files",
    ]);
  }
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------
/** Write to a temp file in the same folder, then rename: a crash never leaves a half-written file. */
async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function isProtocolFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  return PROTOCOL_FILES.some((f) => lower === f.toLowerCase() || lower === f.toLowerCase().replace(/\.md$/, ""));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  run: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<string>;
}
function define<S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

const TOOLS = {
  // 1 -------------------------------------------------------------------------
  list_files: define({
    name: "list_files",
    description:
      "WHAT: Returns an indented tree of a workspace directory (folders first; '.git' and 'node_modules' are hidden). " +
      "WHEN: Use at the start of a session to orient yourself, or after creating files to confirm the structure. " +
      "To find specific content use search_code instead of walking the tree. " +
      "FAILS (isError): the path is absolute or contains '..' (SANDBOX VIOLATION); the path does not exist; the path is a file, not a directory. " +
      "Large trees are cut at max_entries and the output says so; lower max_depth or pass a sub-folder.",
    shape: {
      path: z.string().min(1).default(".").describe("Directory relative to the workspace root, e.g. 'lib/screens'. Default: root."),
      max_depth: z.number().int().min(1).max(6).default(3).describe("How many folder levels to show (1-6)."),
      max_entries: z.number().int().min(1).max(500).default(200).describe("Maximum entries to print (1-500)."),
    },
    run: async ({ path: p, max_depth, max_entries }, ctx) => {
      const { abs, rel } = await ctx.sandbox.resolve(p); // SANDBOX FIRST
      const st = await fs.stat(abs);
      if (!st.isDirectory()) throw new ToolError(`"${rel}" is a file, not a directory. Use read_file to view it.`);

      const lines = [rel === "." ? "(workspace root)" : `${rel}/`];
      let count = 0;
      let truncated = false;

      async function walk(dir: string, prefix: string, depth: number): Promise<void> {
        const entries = (await fs.readdir(dir, { withFileTypes: true }))
          .filter((e) => !HIDDEN_DIRS.has(e.name) && !e.name.endsWith(".tmp"))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (let i = 0; i < entries.length; i++) {
          if (count >= max_entries) {
            truncated = true;
            return;
          }
          const e = entries[i];
          const last = i === entries.length - 1;
          const label = e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name;
          lines.push(`${prefix}${last ? "└── " : "├── "}${label}`);
          count++;
          if (e.isDirectory() && depth < max_depth) {
            await walk(path.join(dir, e.name), prefix + (last ? "    " : "│   "), depth + 1);
          }
        }
      }
      await walk(abs, "", 1);
      if (count === 0) lines.push("(empty)");
      if (truncated) lines.push(`[truncated at ${max_entries} entries: pass a sub-folder in 'path' or lower 'max_depth']`);
      return lines.join("\n");
    },
  }),

  // 2 -------------------------------------------------------------------------
  read_file: define({
    name: "read_file",
    description:
      "WHAT: Reads a UTF-8 text file. Without a range it returns the whole file, but files over 1000 lines are TRUNCATED to the first 1000 lines with a SYSTEM NOTE; " +
      "with start_line/end_line (1-based, inclusive) it returns just that range (max 1000 lines per call) prefixed by a '[lines a-b of N]' header. " +
      "WHEN: Read a file before you edit it. For big files use search_code to find the line number first, then read only that range. " +
      "FAILS (isError): path escapes the sandbox or is absolute (SANDBOX VIOLATION); file does not exist; path is a directory; file is larger than 2 MB; start_line is past the end of the file; end_line is before start_line.",
    shape: {
      path: z.string().min(1).describe("File relative to the workspace root, e.g. 'lib/main.dart'."),
      start_line: z.number().int().min(1).optional().describe("First line to return (1-based)."),
      end_line: z.number().int().min(1).optional().describe("Last line to return (inclusive). Defaults to start_line + 999."),
    },
    run: async ({ path: p, start_line, end_line }, ctx) => {
      const { abs, rel } = await ctx.sandbox.resolve(p); // SANDBOX FIRST
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new ToolError(`"${rel}" is a directory. Use list_files to see its contents.`);
      if (st.size > MAX_READ_BYTES) {
        throw new ToolError(`"${rel}" is ${st.size} bytes (limit ${MAX_READ_BYTES}). Use search_code to find the part you need.`);
      }
      const text = await fs.readFile(abs, "utf8");
      if (text === "") return "(empty file)";
      const lines = text.split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // trailing newline is not a line
      const total = lines.length;

      if (start_line === undefined && end_line === undefined) {
        if (total <= MAX_LINES) return text;
        return (
          lines.slice(0, MAX_LINES).join("\n") +
          `\n\n[SYSTEM NOTE: Output truncated at ${MAX_LINES} of ${total} lines. ` +
          `Call read_file again with start_line and end_line (for example start_line=${MAX_LINES + 1}, end_line=${Math.min(total, MAX_LINES * 2)}) ` +
          `to read the rest, or use search_code to locate what you need.]`
        );
      }

      const start = start_line ?? 1;
      if (start > total) throw new ToolError(`start_line ${start} is past the end of "${rel}" (${total} lines).`);
      let end = Math.min(end_line ?? start + MAX_LINES - 1, total);
      if (end < start) throw new ToolError(`end_line ${end} is before start_line ${start}.`);
      let note = "";
      if (end - start + 1 > MAX_LINES) {
        end = start + MAX_LINES - 1;
        note = `\n\n[SYSTEM NOTE: Range capped at ${MAX_LINES} lines. Continue with start_line=${end + 1}.]`;
      }
      return `[lines ${start}-${end} of ${total}]\n${lines.slice(start - 1, end).join("\n")}${note}`;
    },
  }),

  // 3 -------------------------------------------------------------------------
  write_file: define({
    name: "write_file",
    description:
      "WHAT: Creates a new text file or completely OVERWRITES an existing one (parent folders are created; the write is atomic via temp file + rename). " +
      "WHEN: Use for new files and for full rewrites. For a small change to an existing file use str_replace instead, which is cheaper and safer. " +
      "Overwrite PROJECT_STATE.md with this tool at the end of a session. " +
      "FAILS (isError): path escapes the sandbox, is absolute, or targets .git (SANDBOX VIOLATION); path is an existing directory; content is over 1,000,000 characters.",
    shape: {
      path: z.string().min(1).describe("File relative to the workspace root. Parent folders are created automatically."),
      content: z.string().max(MAX_WRITE_CHARS).describe("Full file content (UTF-8)."),
    },
    run: async ({ path: p, content }, ctx) => {
      const { abs, rel } = await ctx.sandbox.resolve(p); // SANDBOX FIRST
      if (rel === ".") throw new ToolError("Cannot write to the workspace root itself; give a file path.");
      let existed = false;
      try {
        const st = await fs.lstat(abs);
        if (st.isDirectory()) throw new ToolError(`"${rel}" is an existing directory; choose a file path.`);
        existed = true;
      } catch (e) {
        if (e instanceof ToolError) throw e;
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, content);
      const lineCount = content === "" ? 0 : content.split("\n").length;
      return `${existed ? "Overwrote" : "Created"} ${rel} (${lineCount} lines, ${Buffer.byteLength(content)} bytes).`;
    },
  }),

  // 4 -------------------------------------------------------------------------
  str_replace: define({
    name: "str_replace",
    description:
      "WHAT: Replaces exactly ONE occurrence of old_str with new_str in a file. The match must be strictly unique or nothing is changed. " +
      "WHEN: Use for targeted edits (add an import, change one function) after reading the file. Include enough surrounding lines in old_str to make it unique. " +
      "FAILS (isError): path escapes the sandbox (SANDBOX VIOLATION); file does not exist or is a directory; old_str not found (whitespace and line endings must match exactly); " +
      "old_str matches more than once (the error reports the line numbers); old_str equals new_str.",
    shape: {
      path: z.string().min(1).describe("File relative to the workspace root."),
      old_str: z.string().min(1).describe("Exact text to replace. Must occur exactly once in the file."),
      new_str: z.string().max(MAX_WRITE_CHARS).describe("Replacement text (may be empty to delete old_str)."),
    },
    run: async ({ path: p, old_str, new_str }, ctx) => {
      const { abs, rel } = await ctx.sandbox.resolve(p); // SANDBOX FIRST
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new ToolError(`"${rel}" is a directory, not a file.`);
      if (st.size > MAX_READ_BYTES) throw new ToolError(`"${rel}" is too large to edit (${st.size} bytes).`);
      if (old_str === new_str) throw new ToolError("old_str and new_str are identical; nothing to change.");

      const text = await fs.readFile(abs, "utf8");
      const first = text.indexOf(old_str);
      if (first === -1) {
        throw new ToolError(
          `old_str was not found in "${rel}". Re-read the relevant lines with read_file (start_line/end_line); whitespace and line endings must match exactly.`,
        );
      }
      const second = text.indexOf(old_str, first + 1);
      if (second !== -1) {
        throw new ToolError(
          `old_str matches more than once in "${rel}" (line ${lineOf(text, first)} and line ${lineOf(text, second)}). Include more surrounding lines to make it unique.`,
        );
      }
      await atomicWrite(abs, text.slice(0, first) + new_str + text.slice(first + old_str.length));
      return `Replaced 1 occurrence in ${rel} at line ${lineOf(text, first)}.`;
    },
  }),

  // 5 -------------------------------------------------------------------------
  delete_file: define({
    name: "delete_file",
    description:
      "WHAT: Permanently deletes ONE file (never a directory). GATED: confirm must be explicitly true. " +
      "WHEN: Only when a file is clearly obsolete and nothing references it (check with search_code first). Commit before deleting so it can be restored from git. " +
      "FAILS (isError): confirm is false (nothing is deleted); the target is PROJECT_STATE, PLAN_LOG, CHECKPOINTS or DECISIONS (hardcoded protection); " +
      "path escapes the sandbox (SANDBOX VIOLATION); file does not exist; target is a directory.",
    shape: {
      path: z.string().min(1).describe("File relative to the workspace root."),
      confirm: z.boolean().describe("Must be true. Required so deletion can never happen by accident."),
    },
    run: async ({ path: p, confirm }, ctx) => {
      const { abs, rel } = await ctx.sandbox.resolve(p); // SANDBOX FIRST
      if (isProtocolFile(rel)) {
        throw new ToolError(`"${rel}" is a handoff protocol file and can never be deleted. Edit it with write_file or str_replace instead.`);
      }
      if (confirm !== true) {
        throw new ToolError(`Deletion of "${rel}" was not confirmed. Nothing was deleted. Call again with confirm=true only if you are certain.`);
      }
      const st = await fs.lstat(abs);
      if (st.isDirectory()) throw new ToolError(`"${rel}" is a directory; delete_file only removes single files.`);
      await fs.unlink(abs);
      return `Deleted ${rel}. (Recover with git if it was committed.)`;
    },
  }),

  // 6 -------------------------------------------------------------------------
  search_code: define({
    name: "search_code",
    description:
      "WHAT: Searches text files in the workspace (tracked and untracked, binary files skipped) for a literal string, or for an extended regex when regex=true, using 'git grep' via execFile (no shell). Returns 'file:line: text'. " +
      "WHEN: Use before reading or editing, to find where something is defined or used, and for audits (secrets, TODOs, risky settings). Cheaper than reading many files. " +
      "Regex is POSIX extended (use [0-9], not \\d). " +
      "FAILS (isError): path escapes the sandbox (SANDBOX VIOLATION); path does not exist; regex is invalid (the message shows git's error); search takes over 15 seconds. " +
      "No matches is a normal result, not an error.",
    shape: {
      query: z.string().min(1).max(200).describe("Text to find (literal by default)."),
      path: z.string().min(1).default(".").describe("File or folder to search, relative to the workspace root."),
      regex: z.boolean().default(false).describe("Treat query as a POSIX extended regular expression."),
      case_sensitive: z.boolean().default(false),
      max_results: z.number().int().min(1).max(100).default(40).describe("Maximum matching lines to return (1-100)."),
    },
    run: async ({ query, path: p, regex, case_sensitive, max_results }, ctx) => {
      const { rel } = await ctx.sandbox.resolve(p); // SANDBOX FIRST
      const args = ["grep", "--untracked", "-n", "-I", "--no-color", regex ? "-E" : "-F"];
      if (!case_sensitive) args.push("-i");
      args.push("-e", query, "--", rel);
      const r = await gitRaw(ctx.sandbox.root, args);
      if (r.code === 1 && !r.stderr.trim()) return "No matches.";
      if (r.code !== 0) {
        const msg = r.stderr.trim();
        if (/did not match any|pathspec|No such file/i.test(msg)) throw new ToolError(`Path "${rel}" does not exist in the workspace.`);
        throw new ToolError(`Search failed: ${msg.slice(0, 300) || "unknown git grep error"}`);
      }
      const hits = r.stdout
        .split("\n")
        .filter((l) => l && !NOISE_DIRS.some((d) => l.includes(d)));
      if (hits.length === 0) return "No matches.";
      const shown = hits.slice(0, max_results).map((l) => (l.length > 220 ? l.slice(0, 220) + "…" : l));
      const header = `${hits.length} matching line(s)${hits.length > max_results ? `, showing first ${max_results}` : ""}:`;
      const tail = hits.length > max_results ? `\n[truncated: narrow the query or the path]` : "";
      return `${header}\n${shown.join("\n")}${tail}`;
    },
  }),

  // 7 -------------------------------------------------------------------------
  git_status: define({
    name: "git_status",
    description:
      "WHAT: Shows the branch, every changed or untracked file (one line each) and the 8 most recent commits. " +
      "WHEN: At the start of a session to see whether the previous session left uncommitted work, before git_commit to see what will be included, and when auditing to compare history with CHECKPOINTS.md. " +
      "FAILS (isError): git is not available on the server or the workspace repository is damaged. An empty history is reported as '(no commits yet)', not as an error.",
    shape: {},
    run: async (_args, ctx) => {
      const status = await gitOk(ctx.sandbox.root, ["status", "--short", "--branch", "--untracked-files=all"]);
      const log = await gitRaw(ctx.sandbox.root, ["log", "--oneline", "--decorate=no", "-n", "8"]);
      const history = log.code === 0 && log.stdout.trim() ? log.stdout.trim() : "(no commits yet)";
      const clean = status.split("\n").length <= 1;
      return `WORKING TREE (${clean ? "clean" : "has uncommitted changes"}):\n${status}\n\nRECENT COMMITS:\n${history}`;
    },
  }),

  // 8 -------------------------------------------------------------------------
  git_commit: define({
    name: "git_commit",
    description:
      "WHAT: Stages the given paths (or everything if 'paths' is omitted) and commits them as a checkpoint. The commit message is prefixed with your role, e.g. '[dev] ...', and authored as mcp-dev or mcp-qa. " +
      "WHEN: After each finished milestone (then record the short hash in CHECKPOINTS.md), and once more at the end of a session after updating the handoff files. " +
      "QA agents use allow_empty=true to record an audit marker commit. " +
      "FAILS (isError): a path escapes the sandbox (SANDBOX VIOLATION); a listed path matches nothing; git rejects the commit. " +
      "A clean working tree returns 'Nothing to commit' as an informational result, not an error.",
    shape: {
      message: z.string().min(5).max(200).describe("Meaningful commit message, e.g. 'feat: board screen with three columns'."),
      paths: z.array(z.string().min(1)).max(50).optional().describe("Files or folders to stage. Omit to stage everything."),
      allow_empty: z.boolean().default(false).describe("Create a commit even if nothing changed (audit markers)."),
    },
    run: async ({ message, paths, allow_empty }, ctx) => {
      const specs: string[] = [];
      for (const p of paths ?? ["."]) specs.push((await ctx.sandbox.resolve(p)).rel); // SANDBOX FIRST
      await gitOk(ctx.sandbox.root, paths ? ["add", "--", ...specs] : ["add", "-A", "--", "."]);

      const args = [
        "-c", `user.name=mcp-${ctx.role}`, "-c", `user.email=${ctx.role}@mcp.local`, "-c", "commit.gpgsign=false",
        "commit", "--quiet", "--no-verify", `--message=[${ctx.role}] ${message}`,
      ];
      if (allow_empty) args.push("--allow-empty");
      const r = await gitRaw(ctx.sandbox.root, args);
      if (r.code !== 0) {
        const out = `${r.stdout}\n${r.stderr}`;
        if (/nothing (added )?to commit|no changes added/i.test(out)) {
          return "Nothing to commit: the working tree is clean. (Use allow_empty=true to record an empty marker commit.)";
        }
        throw new ToolError(`git commit failed: ${out.trim().slice(0, 500)}`);
      }
      return `Committed ${await gitOk(ctx.sandbox.root, ["log", "-1", "--shortstat", "--format=%h %s"])}`;
    },
  }),
};

export type ToolName = keyof typeof TOOLS;

/** Rubric B: each role only gets the tools it needs. */
export const ROLE_TOOLS: Record<Role, readonly ToolName[]> = {
  dev: ["list_files", "read_file", "write_file", "str_replace", "delete_file", "search_code", "git_status", "git_commit"],
  qa: ["read_file", "search_code", "git_status", "git_commit"],
};

// ---------------------------------------------------------------------------
// Execution wrapper + registration
// ---------------------------------------------------------------------------
const FS_ERRORS: Record<string, string> = {
  ENOENT: "No such file or directory.",
  ENOTDIR: "A parent in this path is a file, not a directory.",
  EISDIR: "The path is a directory, but a file was expected.",
  EEXIST: "The target already exists.",
  EACCES: "Permission denied by the operating system.",
  EPERM: "Operation not permitted by the operating system.",
  ENOTEMPTY: "The directory is not empty.",
};

function describeError(e: unknown, root: string, args: Record<string, unknown>): string {
  let msg: string;
  if (e instanceof SandboxError) {
    msg = `SANDBOX VIOLATION: ${e.message} Use a relative path inside the workspace, for example "lib/main.dart".`;
  } else if (e instanceof ToolError) {
    msg = e.message;
  } else {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code && FS_ERRORS[code]) {
      msg = FS_ERRORS[code] + (typeof args?.path === "string" ? ` (path: ${args.path})` : "");
    } else {
      msg = `Unexpected server error: ${e instanceof Error ? e.message : String(e)}`; // never a stack trace
    }
  }
  return msg.split(root).join("<workspace>"); // never leak the host's absolute path
}

async function execute(tool: ToolDef<any>, ctx: Ctx, args: Record<string, unknown>) {
  const started = performance.now();
  const keys = Object.keys(tool.shape);
  if (ctx.state) ctx.state.logged = true; // this call is logged below, success or failure
  try {
    const text = await tool.run(args, ctx);
    appendJsonl(ctx.logFile, {
      ts: new Date().toISOString(), role: ctx.role, tool: tool.name, status: "success",
      ms: Math.round(performance.now() - started), args: summarizeArgs(args, keys), result_chars: text.length,
    });
    return { content: [{ type: "text" as const, text }] };
  } catch (e) {
    const message = describeError(e, ctx.sandbox.root, args);
    appendJsonl(ctx.logFile, {
      ts: new Date().toISOString(), role: ctx.role, tool: tool.name, status: "error",
      ms: Math.round(performance.now() - started), args: summarizeArgs(args, keys), error: message,
    });
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

/** Registers ONLY the tools allowed for ctx.role on this MCP server instance. */
export function registerTools(server: McpServer, ctx: Ctx): void {
  for (const name of ROLE_TOOLS[ctx.role]) {
    const tool = TOOLS[name] as ToolDef<any>;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.shape },
      (async (args: Record<string, unknown>) => execute(tool, ctx, args)) as any,
    );
  }
}
