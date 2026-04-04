// ecosystem.config.cjs — pm2 config for multi-persona Mame instances
// Each persona runs as a separate process with its own Discord channels,
// memory scope, and tool permissions.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup    # Auto-start on reboot
//
// To add a new persona, add an entry to the apps array below.

const path = require("path");
const fs = require("fs");

const MAME_HOME = process.env.MAME_HOME || path.join(require("os").homedir(), ".mame");

// Auto-discover personas from ~/.mame/personas/
function discoverPersonas() {
  const personasDir = path.join(MAME_HOME, "personas");
  if (!fs.existsSync(personasDir)) return [];

  return fs
    .readdirSync(personasDir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => f.replace(".yml", ""));
}

const personas = discoverPersonas();

module.exports = {
  apps: personas.map((name) => ({
    name: `mame-${name}`,
    script: "./dist/index.js",
    args: `--persona ${name}`,
    cwd: __dirname,
    env: {
      MAME_HOME,
      NODE_ENV: "production",
    },
    // pm2 settings
    autorestart: true,
    watch: false,
    max_memory_restart: "256M",
    error_file: path.join(MAME_HOME, `logs/mame-${name}-error.log`),
    out_file: path.join(MAME_HOME, `logs/mame-${name}-out.log`),
    merge_logs: true,
    time: true,
  })),
};
