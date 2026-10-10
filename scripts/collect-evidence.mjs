#!/usr/bin/env node
// Copies everything the grader needs into ./submission (run: npm run evidence).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const workspace = process.env.WORKSPACE_ROOT;
if (!workspace) { console.error("WORKSPACE_ROOT not set (run through `npm run evidence`)."); process.exit(1); }
const logDir = process.env.LOG_DIR ?? "logs";
const out = "submission";
fs.mkdirSync(path.join(out, "handoff"), { recursive: true });
fs.mkdirSync(path.join(out, "logs"), { recursive: true });

for (const f of ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"]) {
  const src = path.join(workspace, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, "handoff", f)); else console.warn(`missing ${src}`);
}
for (const f of ["tool-calls.jsonl", "auth-failures.jsonl"]) {
  const src = path.join(logDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, "logs", f)); else console.warn(`missing ${src}`);
}
const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
fs.writeFileSync(path.join(out, "workspace-git-log.txt"), git("log", "--stat", "--format=commit %h  %an  %ad%n    %s", "--date=iso"));
fs.writeFileSync(path.join(out, "workspace-tree.txt"), git("ls-files"));
fs.writeFileSync(path.join(out, "log-summary.md"), execFileSync(process.execPath, ["scripts/log-summary.mjs", "--file", path.join(logDir, "tool-calls.jsonl")], { encoding: "utf8" }));
console.log(`Evidence written to ./${out}/ (review auth-failures.jsonl for IP addresses before sharing).`);
