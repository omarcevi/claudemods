// Resolves every `bundle: true` entry into concrete plugin entries for the
// claudemods marketplace, each pinned to the upstream commit it was reviewed at.
//
//   node scripts/sync.mjs            # refresh all bundled entries
//   node scripts/sync.mjs cc-arcade  # refresh only these ids
//
// Writes data/resolved.json. Run `node scripts/build.mjs` afterwards.
import { execFileSync } from "node:child_process";
import { readJSON, writeJSON, config, githubRepo, PLUGIN_NAME_RE } from "./lib.mjs";

const entries = readJSON("data/mods.json");
const previous = readJSON("data/resolved.json", {});
const only = new Set(process.argv.slice(2));

async function getText(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "claudemods-sync" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    // Fallback for environments where Node's fetch ignores HTTPS_PROXY.
    try {
      return execFileSync("curl", ["-fsSL", "-m", "30", url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  }
}

// Commit sha for a ref (default HEAD). Peels annotated tags.
// URLs and refs can come from an upstream marketplace.json, so they are untrusted:
// only https URLs and plain ref names reach git, and `--` stops either one being
// parsed as an option (e.g. `--upload-pack=<cmd>` would run a command).
function lsRemote(gitUrl, ref = "HEAD") {
  if (!/^https:\/\/[\w.-]+\//.test(gitUrl || "")) throw new Error(`refusing git url ${gitUrl}`);
  if (!/^\w[\w./-]*$/.test(ref || "")) throw new Error(`refusing ref ${ref}`);
  const args = ref === "HEAD" ? [ref] : [ref, `${ref}^{}`];
  const out = execFileSync("git", ["ls-remote", "--", gitUrl, ...args], {
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = out.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/));
  const peeled = lines.find(([, name]) => name.endsWith("^{}"));
  const sha = (peeled || lines[0] || [])[0];
  if (!/^[0-9a-f]{40}$/.test(sha || "")) throw new Error(`no sha for ${gitUrl} ${ref}`);
  return sha;
}
const headSha = (repo) => lsRemote(`https://github.com/${repo}`);
const toGitUrl = (u) => (/^[\w.-]+\/[\w.-]+$/.test(u) ? `https://github.com/${u}` : u);

const raw = (repo, sha, path) => `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;

// Turn an upstream plugin `source` into one that works from *our* marketplace.
function absolutize(source, repo, sha, pluginRoot) {
  if (typeof source === "string") {
    let rel = source;
    if (!rel.startsWith("./") && rel !== "." && pluginRoot) rel = `${pluginRoot.replace(/\/$/, "")}/${rel}`;
    rel = rel.replace(/^\.\/?/, "").replace(/\/$/, "");
    if (rel.includes("..")) throw new Error(`unsafe path ${source}`);
    return rel === "" || rel === "."
      ? { source: "github", repo, sha }
      : { source: "git-subdir", url: repo, path: rel, sha };
  }
  if (source && typeof source === "object") {
    // Already absolute. Pin git-based sources to a commit; leave npm/archive as published.
    const s = { ...source };
    if (!s.sha && ["github", "url", "git-subdir"].includes(s.source)) {
      const gitUrl = s.source === "github" ? `https://github.com/${s.repo}` : toGitUrl(s.url);
      s.sha = lsRemote(gitUrl, s.ref || "HEAD");
    }
    return s;
  }
  throw new Error("plugin has no source");
}

async function resolveEntry(e) {
  const repo = githubRepo(e.url);
  const sha = headSha(repo);
  const mpText = await getText(raw(repo, sha, ".claude-plugin/marketplace.json"));
  if (mpText) {
    const mp = JSON.parse(mpText);
    const pluginRoot = mp.metadata?.pluginRoot;
    const plugins = (mp.plugins || []).slice(0, config.maxPluginsPerSource);
    if ((mp.plugins || []).length > config.maxPluginsPerSource) {
      console.warn(`  ! ${e.id}: ${mp.plugins.length} plugins upstream, bundling the first ${config.maxPluginsPerSource}`);
    }
    return {
      repo, sha, upstreamMarketplace: mp.name,
      plugins: plugins.map((pl) => ({
        name: pl.name,
        description: pl.description || e.description,
        source: absolutize(pl.source, repo, sha, pluginRoot),
      })),
    };
  }
  const pjText = await getText(raw(repo, sha, ".claude-plugin/plugin.json"));
  if (pjText) {
    const pj = JSON.parse(pjText);
    return {
      repo, sha, upstreamMarketplace: null,
      plugins: [{ name: pj.name, description: pj.description || e.description, source: { source: "github", repo, sha } }],
    };
  }
  throw new Error("no .claude-plugin/marketplace.json or plugin.json at repo root");
}

const resolved = {};
let failed = 0;
for (const e of entries.filter((x) => x.bundle)) {
  if (only.size && !only.has(e.id)) { if (previous[e.id]) resolved[e.id] = previous[e.id]; continue; }
  process.stdout.write(`- ${e.id} … `);
  try {
    const r = await resolveEntry(e);
    for (const pl of r.plugins) {
      if (!PLUGIN_NAME_RE.test(pl.name || "")) throw new Error(`invalid plugin name "${pl.name}"`);
    }
    resolved[e.id] = r;
    console.log(`${r.plugins.length} plugin(s) @ ${r.sha.slice(0, 7)}`);
  } catch (err) {
    failed++;
    console.log(`FAILED: ${err.message}`);
    if (previous[e.id]) { resolved[e.id] = previous[e.id]; console.log("  keeping previous pin"); }
  }
}

writeJSON("data/resolved.json", resolved);
console.log(`\nResolved ${Object.keys(resolved).length} bundled entries (${failed} failed). Now run: node scripts/build.mjs`);
