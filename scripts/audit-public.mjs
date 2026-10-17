/** Check a source-only public release; no credentials or network access required. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const failures = [];
const forbiddenPath = /(^|\/)(?:\.env(?!\.example$)|\.dev\.vars|\.venv|\.wrangler|\.sites-runtime|node_modules|evidence|outputs|secrets|credentials)(?:[./]|$)|(?:oauth_client|client_secret).*\.json$/;
const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|GOCSPX-[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}/;
// Do not print matching values; only report the path for private inspection.
for (const file of files) {
  if (forbiddenPath.test(file) || !lstatSync(file).isFile()) { failures.push(`${file}: forbidden path or file type`); continue; }
  const text = readFileSync(file, "utf8");
  if (secretPattern.test(text) || /\/Users\/[^/\s]+\//.test(text)) failures.push(`${file}: credential or personal path pattern`);
}
const manifest = JSON.parse(readFileSync(".openai/hosting.json", "utf8"));
if (Object.hasOwn(manifest, "project_id")) failures.push("hosting manifest contains a deployment ID");
if (!readFileSync("lib/platform/deployment.ts", "utf8").includes('SITE_ORIGIN = "https://unconfigured.invalid";')) {
  failures.push("deployment origin is not the public placeholder");
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log(`Public source audit passed for ${files.length} tracked files. Manual diff review is still required.`);
