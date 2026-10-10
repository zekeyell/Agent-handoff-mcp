import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSandbox, SandboxError } from "../src/sandbox.js";

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-"));
  const root = path.join(base, "ws");
  await fs.mkdir(root);
  return { base, root, sb: createSandbox(root) };
}

test("allows normal relative paths", async () => {
  const { sb, root } = await setup();
  const r = await sb.resolve("lib/screens/board.dart");
  assert.equal(r.rel, "lib/screens/board.dart");
  assert.ok(r.abs.startsWith(root));
  assert.equal((await sb.resolve(".")).rel, ".");
  assert.equal((await sb.resolve("./lib//main.dart")).rel, "lib/main.dart");
});

test("rejects ../ traversal in every form", async () => {
  const { sb } = await setup();
  const attempts = ["../x", "..", "a/../../x", "a/../b", "lib/../../package.json", "..\\..\\x", "a\\..\\..\\x", "...", ".. /x", "%2e%2e/x".replace("%2e%2e", "..")];
  for (const p of attempts) await assert.rejects(sb.resolve(p), SandboxError, `should reject: ${p}`);
});

test("rejects absolute, UNC and drive-letter paths", async () => {
  const { sb } = await setup();
  for (const p of ["/etc/passwd", "\\Windows\\win.ini", "//server/share/x", "\\\\server\\share\\x", "C:\\Windows\\win.ini", "C:/x", "file.txt:stream"]) {
    await assert.rejects(sb.resolve(p), SandboxError, `should reject: ${p}`);
  }
});

test("rejects null bytes, empty and oversized paths", async () => {
  const { sb } = await setup();
  await assert.rejects(sb.resolve("a\0b"), SandboxError);
  await assert.rejects(sb.resolve("lib/main.dart\0.txt"), SandboxError);
  await assert.rejects(sb.resolve(""), SandboxError);
  await assert.rejects(sb.resolve("a".repeat(2000)), SandboxError);
});

test("blocks .git (case-insensitive, Windows trailing-dot trick)", async () => {
  const { sb } = await setup();
  for (const p of [".git", ".git/config", "lib/.git/x", ".GIT/config", ".git./config", ".git /config"]) {
    await assert.rejects(sb.resolve(p), SandboxError, `should reject: ${p}`);
  }
  // names that merely contain "git" are fine
  assert.equal((await sb.resolve(".gitignore")).rel, ".gitignore");
});

test("rejects a symlinked folder that points outside the root", async (t) => {
  const { base, root, sb } = await setup();
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  try {
    await fs.symlink(outside, path.join(root, "link"), "dir");
  } catch {
    return t.skip("symlinks not permitted on this OS");
  }
  await assert.rejects(sb.resolve("link"), SandboxError);
  await assert.rejects(sb.resolve("link/secret.txt"), SandboxError);
  await assert.rejects(sb.resolve("link/new-file.txt"), SandboxError); // write-through-symlink attempt
});

test("rejects a symlinked FILE pointing outside, and dangling symlinks", async (t) => {
  const { base, root, sb } = await setup();
  await fs.writeFile(path.join(base, "outside.txt"), "secret");
  try {
    await fs.symlink(path.join(base, "outside.txt"), path.join(root, "leak.txt"));
    await fs.symlink(path.join(base, "does-not-exist"), path.join(root, "dangling.txt"));
  } catch {
    return t.skip("symlinks not permitted on this OS");
  }
  await assert.rejects(sb.resolve("leak.txt"), SandboxError);
  await assert.rejects(sb.resolve("dangling.txt"), SandboxError);
});

test("allows a symlink that stays inside the root", async (t) => {
  const { root, sb } = await setup();
  await fs.mkdir(path.join(root, "real"));
  try {
    await fs.symlink(path.join(root, "real"), path.join(root, "alias"), "dir");
  } catch {
    return t.skip("symlinks not permitted on this OS");
  }
  assert.equal((await sb.resolve("alias/file.txt")).rel, "alias/file.txt");
});
