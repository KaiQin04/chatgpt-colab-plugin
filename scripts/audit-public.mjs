/** Audit the exact staged public source; never print matched private values. */
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", ["--no-replace-objects", ...args], { encoding: "utf8" });
const paths = (value) => value.split("\0").filter(Boolean);
const failures = [];
for (const file of paths(git("diff", "--name-only", "-z"))) {
  failures.push(`${file}: unstaged change; stage or discard before audit`);
}
for (const file of paths(git("ls-files", "--others", "--exclude-standard", "-z"))) {
  failures.push(`${file}: untracked file not covered by audit`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

const tree = git("write-tree").trim();
const entries = paths(git("ls-files", "-s", "-z")).map((entry) => {
  const tab = entry.indexOf("\t");
  const [mode, oid, stage] = entry.slice(0, tab).split(" ");
  return { mode, oid, stage, file: entry.slice(tab + 1) };
});
const forbiddenPath = /(^|\/)(?:\.env(?!\.example$)|\.dev\.vars|\.venv|\.wrangler|\.sites-runtime|node_modules|evidence|outputs|secrets|credentials)(?:[./]|$)|(?:oauth_client|client_secret).*\.json$/;
const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|GOCSPX-[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}/;
const syntheticProjects = new Set(["appgprj_YOUR_PROJECT_ID", "appgprj_synthetic", "appgprj_other"]);
const syntheticHosts = new Set(["your-site.chatgpt.site", "personal.example.chatgpt.site", "other.chatgpt.site", "a.chatgpt.site"]);
const staged = new Map();
const blobs = entries.filter(({ mode, stage, file }) => {
  if (stage !== "0" || !["100644", "100755"].includes(mode) || forbiddenPath.test(file)) {
    failures.push(`${file}: forbidden path or file type`);
    return false;
  }
  return true;
});
// One process, with byte offsets so binary blobs cannot desynchronize parsing.
const batch = execFileSync("git", ["--no-replace-objects", "cat-file", "--batch"], {
  input: blobs.map(({ oid }) => `${oid}\n`).join(""),
  maxBuffer: 64 * 1024 * 1024,
});
let offset = 0;
for (const { oid, file } of blobs) {
  const end = batch.indexOf(10, offset);
  const [actualOid, type, length] = batch.subarray(offset, end).toString("ascii").split(" ");
  const size = Number(length);
  offset = end + 1;
  if (end < 0 || actualOid !== oid || type !== "blob" || !Number.isSafeInteger(size) ||
      size < 0 || offset + size >= batch.length || batch[offset + size] !== 10) {
    throw new Error("Invalid Git blob response; public audit aborted.");
  }
  const bytes = batch.subarray(offset, offset + size);
  offset += size + 1;
  const text = bytes.toString("utf8");
  staged.set(file, text);
  if (secretPattern.test(text) || /\/Users\/[^/\s]+\//.test(text)) {
    failures.push(`${file}: credential or personal path pattern`);
  }
  const projects = [...text.matchAll(/\bappgprj_[A-Za-z0-9_-]+/g)];
  const hosts = [...text.matchAll(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.chatgpt\.site\b/gi)];
  if (projects.some(([value]) => !syntheticProjects.has(value)) ||
      hosts.some(([value]) => !syntheticHosts.has(value.toLowerCase()))) {
    failures.push(`${file}: private Site identifier pattern`);
  }
}
try {
  const manifest = JSON.parse(staged.get(".openai/hosting.json"));
  if (Object.hasOwn(manifest, "project_id")) {
    failures.push(".openai/hosting.json: hosting manifest contains a deployment ID");
  }
} catch {
  failures.push(".openai/hosting.json: missing or invalid staged manifest");
}
if (!staged.get("lib/platform/deployment.ts")?.includes('SITE_ORIGIN = "https://unconfigured.invalid";')) {
  failures.push("lib/platform/deployment.ts: deployment origin is not the public placeholder");
}
if (git("write-tree").trim() !== tree) failures.push("index changed during audit; rerun before release");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Public source audit passed for ${entries.length} staged files; tree ${tree}. Manual diff review is still required.`);
}
