/** Install the UI lockfile only from an explicit setup command. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.npm_execpath) {
  throw new Error("Run this installer with npm run install:ci.");
}

const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env };
// The Sites install report describes the root lockfile, not this nested install.
delete env.SITES_INSTALL_REPORT_PATH;
const result = spawnSync(process.execPath, [
  process.env.npm_execpath, "ci", "--prefix", join(root, "ui"), "--workspaces=false",
  "--include=dev", "--include=optional", "--prefer-offline", "--no-audit", "--no-fund",
], { cwd: root, env, stdio: "inherit", timeout: 120_000 });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
