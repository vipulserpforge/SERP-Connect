// PM2 process file for the MCP server on a private VPS (PM2 keeps it running and restarts it after a crash or reboot).
// Start / reload:  pm2 startOrReload deploy/vps/ecosystem.config.cjs --update-env
//
// Settings (database address, keys, ...) are NOT stored here. They are read from one private file, by default
// ~/mcp.env of the user running PM2. Use MCP_ENV_FILE=/other/path to change it.
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const envFile = process.env.MCP_ENV_FILE || path.join(os.homedir(), "mcp.env");

module.exports = {
  apps: [
    {
      name: "serp-mcp",
      cwd: repoRoot,
      script: "scripts/start-mcp.mjs",
      // Node loads the private settings file itself (Node 20.6 or newer).
      node_args: [`--env-file=${envFile}`],
      env: {
        NODE_ENV: "production",
        // Nginx forwards https://mcp.serpforge.io to this local port. Do not open it in the firewall.
        PORT: "8787",
      },
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,
      // The server finishes in-flight requests on SIGTERM and force-exits after 5 s.
      kill_timeout: 6000,
      max_memory_restart: "400M",
      time: true,
    },
  ],
};
