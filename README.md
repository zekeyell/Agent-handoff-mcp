# MCP File Server: role-based, sandboxed, Streamable HTTP

A custom MCP connector that lets AI agents work on **one sandboxed folder** (the *workspace*) and
hand work to each other through four shared notebook files. Built for the Midterms Pt 1 project
and demonstrated with a three-session **Flutter/Firebase Sprint**.

| Endpoint | Role | Tools |
|---|---|---|
| `POST /mcp/dev` | Frontend/backend development sessions | `list_files`, `read_file`, `write_file`, `str_replace`, `delete_file`, `search_code`, `git_status`, `git_commit` (all 8) |
| `POST /mcp/qa` | Auditing session (read-only plus git) | `read_file`, `search_code`, `git_status`, `git_commit` |

Everything requires `Authorization: Bearer <MCP_AUTH_TOKEN>`. The server will not start without a token.

## How it maps to the rubric

| Rubric | Where to look |
|---|---|
| A. Agent efficiency | `logs/tool-calls.jsonl` + `npm run logs:summary`; `read_file` truncates at 1000 lines and tells the agent to use `start_line`/`end_line`; `search_code` instead of reading many files; tool descriptions teach the loop |
| B. Agent and tool management | Role endpoints (`src/index.ts`, `ROLE_TOOLS` in `src/tools.ts`); `delete_file` needs `confirm: true` and can never touch the 4 protocol files; handoff files; every call logged |
| C. Tool design | `src/tools.ts`: strict Zod schemas, every description states WHAT / WHEN / FAILS, all failures return `isError: true` with a recovery hint, no stack traces or host paths |
| D. Stack and architecture | Node.js + TypeScript SDK, Express, Streamable HTTP (stateless), pm2, ngrok; config only from `.env`; `src/index.ts` (server), `src/sandbox.ts` (security), `src/tools.ts` (tools) |
| E. Security | `src/sandbox.ts` + `npm test` (path-traversal, symlink and auth tests), bearer token on every request, 401s logged to `logs/auth-failures.jsonl`, destructive calls gated and logged |
| F. Documentation | This README, `REPORT_TEMPLATE.md`, meaningful git history in the workspace (`[dev]` / `[qa]` commit prefixes) |

## 1. Prerequisites

- Node.js 20.6 or newer (`node -v`), Git (`git --version`)
- `npm install -g pm2`
- An [ngrok](https://ngrok.com) account with the CLI installed and authenticated
  (`ngrok config add-authtoken <token>`) and one **static domain** (dashboard > Domains)

## 2. Install and configure `.env`

```bash
npm install
cp .env.example .env        # Windows PowerShell: copy .env.example .env
```

Edit `.env`:

| Variable | Meaning |
|---|---|
| `PORT` | Local port (default 3000). The server binds to `127.0.0.1` only; ngrok is the public door. |
| `WORKSPACE_ROOT` | The only folder agents can touch, e.g. `./workspace` or `D:/sprint-workspace`. Created on first start. Must not contain this project folder. |
| `MCP_AUTH_TOKEN` | Required, 16+ characters. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NGROK_DOMAIN` | Your static domain, e.g. `your-name.ngrok-free.app`. Read by `ecosystem.config.cjs`. |
| `LOG_DIR` | Where logs go (default `./logs`). Must be outside `WORKSPACE_ROOT`, so agents cannot edit their own evidence. |

On first start the server creates `PROJECT_STATE.md`, `PLAN_LOG.md`, `CHECKPOINTS.md` and `DECISIONS.md` in the
workspace, runs `git init`, and makes a first commit.

## 3. Test locally (do this before deploying)

```bash
npm run typecheck
npm test            # sandbox unit tests + integration tests against the real server
npm run dev         # starts the server (tsx), Ctrl+C to stop
```

In a second terminal, open the MCP Inspector:

```bash
npm run inspector
```

Choose **Streamable HTTP**, URL `http://127.0.0.1:3000/mcp/dev`, and add the header
`Authorization: Bearer <your token>`. Check that:

1. `/mcp/dev` lists 8 tools and `/mcp/qa` lists 4.
2. `list_files` shows the four protocol files.
3. `read_file` with `../.env` returns a red `SANDBOX VIOLATION` error.
4. Without the header, the server answers `401`:
   ```bash
   curl -i -X POST http://127.0.0.1:3000/mcp/dev
   ```

Take screenshots of 1, 3 and 4: they are evidence for criteria C and E.

## 4. Deploy with PM2 and ngrok

```bash
npm run build
pm2 start ecosystem.config.cjs     # starts mcp-file-server AND mcp-ngrok
pm2 status                         # both should say "online"
pm2 logs                           # live logs
pm2 save                           # remember the process list
```

Reboot persistence: on Linux/macOS run `pm2 startup` and follow the printed command; on Windows use
`pm2-windows-startup` or Task Scheduler. If PM2 cannot launch `ngrok` on your OS, run the tunnel in its own terminal:
`ngrok http --url=<NGROK_DOMAIN> 3000` (older CLI: `--domain=`), and keep only the server under PM2.

After changing code: `npm run build && pm2 restart mcp-file-server`.

Public endpoints:

```
https://<NGROK_DOMAIN>/mcp/dev
https://<NGROK_DOMAIN>/mcp/qa
```

Prove it from outside (screenshot both):

```bash
curl -i -X POST https://<NGROK_DOMAIN>/mcp/dev                      # expect 401
curl -s -X POST https://<NGROK_DOMAIN>/mcp/dev \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                # expect 8 tools
```

Survives a restart (criterion D): run `pm2 restart mcp-file-server`, then call a tool again. It works because the
server is stateless and the notebook lives in the workspace files.

## 5. Connect your AI client

You need a client that can send a custom `Authorization` header. Add **two** servers, one per role.
Exact flags depend on your client version, so check its docs; common options:

- **Claude Code** (CLI):
  ```bash
  claude mcp add --transport http sprint-dev https://<NGROK_DOMAIN>/mcp/dev --header "Authorization: Bearer <token>"
  claude mcp add --transport http sprint-qa  https://<NGROK_DOMAIN>/mcp/qa  --header "Authorization: Bearer <token>"
  ```
- **VS Code / Cursor** (`mcp.json`): an entry with `"type": "http"`, the URL, and `"headers": { "Authorization": "Bearer <token>" }`.
- **Claude Desktop** (config file): bridge with `mcp-remote`, e.g.
  `npx mcp-remote https://<NGROK_DOMAIN>/mcp/dev --header "Authorization: Bearer <token>"`.
- Claude.ai's built-in custom connector form may not let you set a bearer header. If so, use one of the clients above.

Keep the token out of screenshots and the repo. Run `/mcp` (or your client's equivalent) and confirm the tools appear.

**Important for QA:** the QA session must be connected to `/mcp/qa` **only** (disable the dev server in that chat), otherwise it
will have write tools and the role separation is not demonstrated.

## 6. Generate the submission artifacts: the Flutter/Firebase Sprint

You do not need the Flutter SDK. The agents write the project files; they cannot run `flutter`.
Start each session in a **new chat** so nothing is remembered except what is in the workspace files, and note the
clock time when each session starts and ends (for `npm run logs:summary -- --since ...`).
Export or copy each full transcript including the tool calls.

### Session 1: Flutter UI scaffold (connect `sprint-dev`)

```text
You are the FRONTEND agent in a three-session "Flutter/Firebase Sprint". You only have the MCP file-server connector.
You cannot run Flutter, so write the project as files.

Follow the handoff protocol in the server instructions:
1. Read PROJECT_STATE.md first. Then append your plan for this session to PLAN_LOG.md BEFORE writing any code.
2. Goal: scaffold a Flutter app called "Sprint Board" (Material 3, no Firebase yet):
   - pubspec.yaml
   - lib/main.dart
   - lib/models/task.dart (id, title, status: todo/doing/done)
   - lib/data/task_repository.dart: an abstract TaskRepository with
     Stream<List<Task>> watchTasks(), Future<void> upsert(Task t), Future<void> delete(String id),
     plus InMemoryTaskRepository
   - lib/screens/board_screen.dart (three columns or tabs by status, add-task dialog, move a task between statuses)
   - lib/widgets/task_card.dart
3. Be efficient: read before you write, use str_replace for small edits, do not re-read files you just wrote.
4. When the scaffold is complete: git_commit it, append the short hash to CHECKPOINTS.md, record the decision
   "UI depends only on the TaskRepository interface so Firebase can be swapped in" in DECISIONS.md,
   overwrite PROJECT_STATE.md with status and the exact next action, then git_commit the handoff files.
Finish with a 5-line summary.
```

### Session 2: Firebase integration (new chat, `sprint-dev`; a different account or client makes the handoff more convincing)

```text
You are the BACKEND agent in the "Flutter/Firebase Sprint". You have NO memory of earlier work: resume only from the
handoff files. You cannot run Flutter or Firebase CLIs, so write files.

1. Read PROJECT_STATE.md and the end of PLAN_LOG.md, CHECKPOINTS.md and DECISIONS.md. Append your plan to PLAN_LOG.md.
2. Goal: integrate Firebase (anonymous Auth + Cloud Firestore) without changing the UI code:
   - add firebase_core, firebase_auth and cloud_firestore to pubspec.yaml (str_replace)
   - create lib/data/firestore_task_repository.dart implementing TaskRepository (collection "tasks", snapshot stream)
   - create lib/firebase_options.dart with clearly marked PLACEHOLDER values (never real keys)
   - update lib/main.dart with small str_replace edits to initialise Firebase, sign in anonymously and use the new repository
   - create firestore.rules that require request.auth != null and validate the task fields
   - create docs/FIREBASE_SETUP.md with the manual steps (flutterfire configure, enabling anonymous auth)
3. Use search_code to find every use of TaskRepository instead of reading every file.
4. git_commit, append the hash to CHECKPOINTS.md, record your decisions (for example why anonymous auth) in DECISIONS.md,
   overwrite PROJECT_STATE.md with the next action "QA audit", then git_commit the handoff files.
Finish with a 5-line summary.
```

### Session 3: QA audit and sandbox rejection (new chat, connect `sprint-qa` ONLY)

```text
You are the QA auditor for the "Flutter/Firebase Sprint". You have read-only access plus git. You have NO memory of
earlier work: resume only from the handoff files.

1. Read PROJECT_STATE.md and the end of PLAN_LOG.md, CHECKPOINTS.md and DECISIONS.md. Run git_status and check that
   the commit hashes in CHECKPOINTS.md exist in the history and that the working tree is clean.
2. Audit with search_code (do not read every file): hardcoded secrets ("AIza", "apiKey", "private_key"), that
   placeholders are clearly marked, Firestore rules that are not open (search "if true"), that the UI only reaches
   data through TaskRepository, and leftover TODOs. Read only the lines you need.
3. Security probe. Call read_file with each of these paths and quote the exact error each time:
   "../.env", "../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini", "..\\..\\package.json", "lib/../../x", ".git/config".
   Then list the tools you actually have and state whether you could write or delete a file.
4. Give a full audit report in your final message (severity, file, line, evidence, verdict PASS or FAIL).
   Then record the audit with git_commit using allow_empty=true and the message "QA audit: <verdict>, <n> findings".
```

If the audit finds real problems, you can run a short follow-up `dev` session to fix them. That makes a better story.
You can also paste the QA report into `<WORKSPACE_ROOT>/docs/QA_REPORT.md` yourself and commit it.

## 7. Collect the evidence

```bash
npm test > submission-test-output.txt 2>&1        # path-traversal, auth and role tests
npm run evidence                                   # copies handoff files, logs, git log and a log summary into ./submission
npm run logs:summary -- --since 2026-10-08T09:00:00Z --until 2026-10-08T10:00:00Z --role dev   # per-session stats
```

Submit:

- Repository link and this README
- Three session transcripts, with tool calls visible
- `submission/logs/tool-calls.jsonl`, `submission/log-summary.md`, and `submission/logs/auth-failures.jsonl` (check the IP addresses first)
- `submission/handoff/` (`PROJECT_STATE`, `PLAN_LOG`, `CHECKPOINTS`, `DECISIONS`) and `submission/workspace-git-log.txt`
- Screenshots: Inspector tool list, sandbox error, `401` from the public URL, `pm2 status`
- Your report, written from `REPORT_TEMPLATE.md`

## What gets logged

One JSON line per call in `logs/tool-calls.jsonl`:

```json
{"ts":"2026-10-08T09:14:02.511Z","role":"qa","tool":"read_file","status":"error","ms":4,"args":{"path":"../.env"},"error":"SANDBOX VIOLATION: ..."}
```

Calls the SDK rejects before a handler runs (bad input, or a tool the role does not have, such as `qa` calling `write_file`)
are logged too, marked `"rejected_by":"protocol"`. File contents are never logged; long strings are stored as `<N chars>`.

## Project structure

```
src/index.ts       Express app: auth middleware, /mcp/dev and /mcp/qa, boot checks
src/sandbox.ts     Path resolution and containment (the security utility)
src/tools.ts       Zod schemas, 8 tool handlers, role mapping, handoff files, JSONL logger
ecosystem.config.cjs   PM2: server + ngrok tunnel
test/              sandbox.test.ts, server.test.ts (boots the real server)
scripts/           log-summary.mjs, collect-evidence.mjs
```

## Troubleshooting

- **Server exits immediately:** read the `FATAL:` line (missing/short token, missing `WORKSPACE_ROOT`, or unsafe folder choice).
- **401 from your client:** the header must be exactly `Authorization: Bearer <token>`; check for stray quotes or spaces.
- **Tool says `SANDBOX VIOLATION`:** working as intended. Use paths relative to the workspace, like `lib/main.dart`.
- **ngrok errors:** confirm the domain matches the dashboard and the authtoken is set; try the `--domain=` flag on older CLIs.
- **`pm2 start` complains about NGROK_DOMAIN:** set it in `.env`.

## Known limits (use these in your report)

- The sandbox is application-level, not an OS or container boundary. A tiny time-of-check/time-of-use window exists
  between path resolution and the file operation; agents have no tool to create symlinks.
- One shared bearer token for both roles: the QA role is separated by endpoint, not by identity. Anyone with the token can call `/mcp/dev`.
  Separate tokens per role would be the next step.
- No rate limiting, and no locking: two dev sessions editing the same file at once can overwrite each other (`if_version` would fix this).
- `git_commit` can stage anything inside the workspace, and `write_file` can overwrite any file there. Git history is the safety net.
- `search_code` uses `git grep` (POSIX extended regex) and skips `node_modules` and `.dart_tool` results.
