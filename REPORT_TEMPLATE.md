# Midterms Pt 1 Report: MCP File-Server Connector

**Name / section:** Ezekiel Jairus Solitario, BSCS 3A  **Repo:** <link>  **Public URL:** <ngrok domain>

## 1. Overview
Two or three sentences: what the connector does, the Flutter/Firebase Sprint demo, and the three sessions.

## 2. Stack and justification
| Layer | Choice | Alternative considered | Why |
|---|---|---|---|
| Runtime / SDK | Node.js + official TypeScript SDK | Python + FastMCP | |
| Transport | Streamable HTTP, stateless | stdio | |
| Validation | Zod on every tool input | | |
| Exposure | ngrok static domain | Cloudflare Tunnel | |
| Process manager | pm2 (server + tunnel) | systemd / Docker | |
| Version control | git inside the workspace | | |
| Testing | Node test runner, MCP Inspector, real client | | |

Why stateless, and how the handoff files replace session memory.

## 3. Tool design choices
- Why exactly these 8 tools; what each description says (WHAT / WHEN / FAILS) and why.
- `str_replace` strict uniqueness; `read_file` 1000-line truncation with a SYSTEM NOTE; `search_code` via `git grep` + `execFile`.
- `delete_file` gate (`confirm: true`) and the protected protocol files.
- Error design: `isError: true`, recovery hints, no stack traces or host paths.
- Role design: why `/mcp/qa` has only 4 tools; why QA can still `git_commit` (audit marker with `allow_empty`).

## 4. Security and tradeoffs
- Sandbox checks in order (null bytes, absolute paths, `..`, `.git`, symlinks) and what each stops.
- Authentication: bearer token, constant-time compare, fail-to-boot, 401s logged without the token.
- Threats considered: path traversal, symlink escape, shell injection, token theft, runaway deletes, agent overreach.
- Limits: app-level sandbox and TOCTOU, single shared token, no rate limit or locking (see README "Known limits").
- Tests: list the `npm test` cases and the live probes from Session 3.

## 5. Multi-session evidence
| Session | Role | What it did | Calls | Errors | Evidence |
|---|---|---|---|---|---|
| 1 | dev | Flutter scaffold | | | |
| 2 | dev | Firebase integration | | | |
| 3 | qa | Audit + sandbox probe | | | |

Quote lines from `PLAN_LOG` / `CHECKPOINTS` showing session 2 and 3 resuming from the notebook. Add `npm run logs:summary` numbers (calls, error rate, output size).

## 6. Efficiency analysis
Reads before writes, `search_code` instead of full reads, repeated or failed calls and why, how the truncation note helped.

## 7. Problems and lessons learned

## 8. Stretch goals
Token auth (done). `if_version` locking, repo map (not done / planned).
