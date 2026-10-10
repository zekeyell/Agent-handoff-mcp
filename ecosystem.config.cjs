// PM2 process file: keeps BOTH the MCP server and the ngrok tunnel alive.
// All settings come from .env (no secrets or domains are hardcoded here).
//   pm2 start ecosystem.config.cjs
const fs = require("fs");
const path = require("path");

/** Minimal .env reader (PM2 does not load .env by itself). */
function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* handled below */
  }
  return out;
}

const env = loadEnv(path.join(__dirname, ".env"));
const PORT = env.PORT || "3000";
const DOMAIN = env.NGROK_DOMAIN;
if (!DOMAIN) {
  throw new Error("Set NGROK_DOMAIN in .env (your ngrok static domain) before starting PM2.");
}

module.exports = {
  apps: [
    {
      name: "mcp-file-server",
      script: "dist/index.js", // run `npm run build` first
      cwd: __dirname, // relative WORKSPACE_ROOT / LOG_DIR resolve against the project
      node_args: "--env-file=.env",
      autorestart: true,
      min_uptime: "5s", // a crash-loop at boot (e.g. missing token) stops after max_restarts
      max_restarts: 10,
      restart_delay: 2000,
      time: true, // timestamp PM2 log lines
    },
    {
      name: "mcp-ngrok",
      script: process.platform === "win32" ? process.env.ComSpec : "ngrok", // Windows: launch via cmd
      // Older ngrok CLIs use --domain= instead of --url=
      args: process.platform === "win32"
        ? `/c ngrok http --url=${DOMAIN} ${PORT}`
        : `http --url=${DOMAIN} ${PORT}`,
      interpreter: "none",
      autorestart: true,
      restart_delay: 5000,
      time: true,
    },
  ],
};
