# Tool-call summary

- Range: 2026-10-10T06:46:56.070Z -> 2026-10-10T10:33:59.066Z
- Total calls: **101** (errors: 7, 7%; of which sandbox rejections: 7)
- Average duration: 84 ms
- Total output returned to agents: 33808 characters

## By role

| Key | Calls | Errors | Avg ms | Output chars |
|---|---:|---:|---:|---:|
| dev | 67 | 0 | 96 | 11582 |
| qa | 34 | 7 | 59 | 22226 |

## By tool

| Key | Calls | Errors | Avg ms | Output chars |
|---|---:|---:|---:|---:|
| qa/read_file | 22 | 7 | 8 | 17332 |
| dev/search_code | 17 | 0 | 154 | 2987 |
| dev/write_file | 16 | 0 | 9 | 818 |
| dev/read_file | 12 | 0 | 51 | 4491 |
| dev/git_status | 8 | 0 | 204 | 2023 |
| dev/str_replace | 8 | 0 | 10 | 421 |
| qa/search_code | 8 | 0 | 88 | 3853 |
| dev/git_commit | 4 | 0 | 317 | 444 |
| qa/git_status | 3 | 0 | 234 | 992 |
| dev/list_files | 2 | 0 | 45 | 398 |
| qa/git_commit | 1 | 0 | 421 | 49 |

## Errors

- 2026-10-10T06:58:11.024Z [qa] read_file {"path":"../.env"} -> SANDBOX VIOLATION: Directory traversal ("..") is not allowed ("../.env"). Use a relative path inside the workspace, for example "lib/main.dart".
- 2026-10-10T06:58:11.034Z [qa] read_file {"path":"../../etc/passwd"} -> SANDBOX VIOLATION: Directory traversal ("..") is not allowed ("../../etc/passwd"). Use a relative path inside the workspace, for example "lib/main.dart".
- 2026-10-10T06:58:11.039Z [qa] read_file {"path":"/etc/passwd"} -> SANDBOX VIOLATION: Absolute paths are not allowed ("/etc/passwd"). Use a relative path inside the workspace, for example "lib/main.dart".
- 2026-10-10T06:58:11.045Z [qa] read_file {"path":"C:\\Windows\\win.ini"} -> SANDBOX VIOLATION: Drive letters and ":" are not allowed in paths ("C:\Windows\win.ini"). Use a relative path inside the workspace, for example "lib/main.dart".
- 2026-10-10T06:58:11.055Z [qa] read_file {"path":"..\\..\\package.json"} -> SANDBOX VIOLATION: Directory traversal ("..") is not allowed ("..\..\package.json"). Use a relative path inside the workspace, for example "lib/main.dart".
- 2026-10-10T06:58:11.059Z [qa] read_file {"path":"lib/../../x"} -> SANDBOX VIOLATION: Directory traversal ("..") is not allowed ("lib/../../x"). Use a relative path inside the workspace, for example "lib/main.dart".
- 2026-10-10T06:58:11.065Z [qa] read_file {"path":".git/config"} -> SANDBOX VIOLATION: Access to .git is not allowed through file tools; use git_status or git_commit. Use a relative path inside the workspace, for example "lib/main.dart".
