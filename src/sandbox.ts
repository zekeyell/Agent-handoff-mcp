/**
 * SECURITY UTILITY: sandbox path resolution.
 *
 * Every tool calls `sandbox.resolve()` BEFORE it touches the filesystem.
 * Checks, in order (each failure throws SandboxError -> tool returns isError):
 *   1. Input is a non-empty string without null bytes.
 *   2. Backslashes are normalised to "/" so Windows-style input behaves the same everywhere.
 *   3. Absolute paths, UNC paths and drive letters are REJECTED (not silently re-rooted),
 *      so an escape attempt is visible in the logs.
 *   4. Any ".." segment is REJECTED, even if it would net out inside the root.
 *      Segments made only of dots/spaces are rejected too (Windows path quirks).
 *   5. Lexical containment: resolved path must still be inside the root (defence in depth).
 *   6. ".git" is off-limits to file tools (agents use git_status / git_commit instead).
 *   7. Symlink containment: every EXISTING component is lstat-ed; a symlink/junction whose
 *      real target is outside the real root, or that is broken, is rejected.
 *      This also stops "write through a dangling symlink" tricks.
 *
 * Known limit (documented in the report): a tiny time-of-check/time-of-use window remains
 * between resolve() and the actual fs call. Agents have no tool that can create symlinks,
 * so exploiting it would need another process on the host.
 */
import fs from "node:fs/promises";
import path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface ResolvedPath {
  /** Absolute path on disk, safe to pass to fs. */
  abs: string;
  /** POSIX-style path relative to the workspace root ("." for the root itself). */
  rel: string;
}

export interface Sandbox {
  /** Absolute workspace root. */
  root: string;
  resolve(userPath: string): Promise<ResolvedPath>;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function createSandbox(rootInput: string): Sandbox {
  const root = path.resolve(rootInput);
  let realRootCache: string | undefined;

  async function getRealRoot(): Promise<string> {
    if (!realRootCache) {
      await fs.mkdir(root, { recursive: true });
      realRootCache = await fs.realpath(root);
    }
    return realRootCache;
  }

  async function resolve(userPath: string): Promise<ResolvedPath> {
    // (1) basic shape
    if (typeof userPath !== "string" || userPath.length === 0) {
      throw new SandboxError("Path must be a non-empty string.");
    }
    if (userPath.includes("\0")) throw new SandboxError("Path contains a null byte.");
    if (userPath.length > 1024) throw new SandboxError("Path is too long (max 1024 characters).");

    // (2) normalise separators
    const normalized = userPath.replace(/\\/g, "/");

    // (3) absolute / UNC / drive-letter / alternate-data-stream paths
    if (normalized.startsWith("/")) {
      throw new SandboxError(`Absolute paths are not allowed ("${userPath}").`);
    }
    if (normalized.includes(":")) {
      throw new SandboxError(`Drive letters and ":" are not allowed in paths ("${userPath}").`);
    }

    // (4) traversal and dot-only segments
    const segments = normalized.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.some((s) => /^[. ]+$/.test(s))) {
      throw new SandboxError(`Directory traversal ("..") is not allowed ("${userPath}").`);
    }

    // (5) lexical containment (defence in depth; should be unreachable after step 4)
    const abs = path.resolve(root, ...segments);
    if (!isInside(root, abs)) {
      throw new SandboxError(`Path escapes the workspace root ("${userPath}").`);
    }

    // (6) protect git internals (trailing dots/spaces are ignored by Windows)
    if (segments.some((s) => s.replace(/[. ]+$/, "").toLowerCase() === ".git")) {
      throw new SandboxError("Access to .git is not allowed through file tools; use git_status or git_commit.");
    }

    // (7) symlink / junction containment on every existing component
    const realRoot = await getRealRoot();
    let current = root;
    for (const seg of segments) {
      current = path.join(current, seg);
      let st;
      try {
        st = await fs.lstat(current);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") break; // rest of the path does not exist yet
        throw err;
      }
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = await fs.realpath(current);
        } catch {
          throw new SandboxError(`Broken symlink in path ("${userPath}").`);
        }
        if (!isInside(realRoot, real)) {
          throw new SandboxError(`Symlink escapes the workspace root ("${userPath}").`);
        }
      }
    }

    return { abs, rel: segments.join("/") || "." };
  }

  return { root, resolve };
}
