#!/usr/bin/env node
// Summarises logs/tool-calls.jsonl as Markdown (calls, errors, speed, output volume).
// Usage: node scripts/log-summary.mjs [--file logs/tool-calls.jsonl] [--since ISO] [--until ISO] [--role dev|qa]
import fs from "node:fs";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const file = opt("--file") ?? "logs/tool-calls.jsonl";
const since = opt("--since") ? Date.parse(opt("--since")) : 0;
const until = opt("--until") ? Date.parse(opt("--until")) : Infinity;
const role = opt("--role");

if (!fs.existsSync(file)) { console.error(`No log file at ${file}`); process.exit(1); }
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => { const t = Date.parse(r.ts); return t >= since && t <= until && (!role || r.role === role); });
if (rows.length === 0) { console.log("No tool calls in the selected range."); process.exit(0); }

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "0%");
const errors = rows.filter((r) => r.status === "error");
const sandbox = errors.filter((r) => /SANDBOX VIOLATION/.test(r.error ?? ""));
console.log(`# Tool-call summary\n`);
console.log(`- Range: ${rows[0].ts} -> ${rows.at(-1).ts}`);
console.log(`- Total calls: **${rows.length}** (errors: ${errors.length}, ${pct(errors.length, rows.length)}; of which sandbox rejections: ${sandbox.length})`);
console.log(`- Average duration: ${Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length)} ms`);
console.log(`- Total output returned to agents: ${rows.reduce((s, r) => s + (r.result_chars ?? 0), 0)} characters\n`);

const group = (keyFn) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); (m.get(k) ?? m.set(k, []).get(k)).push(r); }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
};
const table = (title, keyFn) => {
  console.log(`## ${title}\n\n| Key | Calls | Errors | Avg ms | Output chars |\n|---|---:|---:|---:|---:|`);
  for (const [k, rs] of group(keyFn)) {
    console.log(`| ${k} | ${rs.length} | ${rs.filter((r) => r.status === "error").length} | ${Math.round(rs.reduce((s, r) => s + r.ms, 0) / rs.length)} | ${rs.reduce((s, r) => s + (r.result_chars ?? 0), 0)} |`);
  }
  console.log();
};
table("By role", (r) => r.role);
table("By tool", (r) => `${r.role}/${r.tool}`);

if (errors.length) {
  console.log(`## Errors\n`);
  for (const r of errors) console.log(`- ${r.ts} [${r.role}] ${r.tool} ${JSON.stringify(r.args)} -> ${r.error}`);
}
