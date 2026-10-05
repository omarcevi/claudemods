// Resolves every `bundle: true` entry into concrete plugin entries for the
// claudemods marketplace, each pinned to the upstream commit it was reviewed at.
//
//   node scripts/sync.mjs            # refresh all bundled entries
//   node scripts/sync.mjs cc-arcade  # refresh only these ids
//   node scripts/sync.mjs --summary out.md   # also write a review summary (the sync PR body)
//
// Writes data/resolved.json, with each plugin's footprint (scripts/footprint.mjs).
// Run `node scripts/build.mjs` afterwards.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readJSON, writeJSON, config, githubRepo, PLUGIN_NAME_RE, FLAGS, policyErrors } from "./lib.mjs";
import { footprintFor, FOOTPRINT_VERSION, cleanup } from "./footprint.mjs";

const entries = readJSON("data/mods.json");
const previous = readJSON("data/resolved.json", {});
const args = process.argv.slice(2);
const summaryAt = args.indexOf("--summary");
const summaryPath = summaryAt >= 0 ? args[summaryAt + 1] : null;
const only = new Set(args.filter((a, i) => !a.startsWith("--") && !(summaryAt >= 0 && i === summaryAt + 1)));

// Many entries can share one upstream repo (one per plugin), so cache lookups per run.
const textCache = new Map();
const getText = (url) => { if (!textCache.has(url)) textCache.set(url, fetchText(url)); return textCache.get(url); };
async function fetchText(url) {
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
const shaCache = new Map();
const headSha = (repo) => { if (!shaCache.has(repo)) shaCache.set(repo, lsRemote(`https://github.com/${repo}`)); return shaCache.get(repo); };
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
      // Full https URL: Claude Code clones a bare "owner/repo" over SSH, which fails without GitHub SSH keys.
      : { source: "git-subdir", url: `https://github.com/${repo}.git`, path: rel, sha };
  }
  if (source && typeof source === "object") {
    // Already absolute. Pin git-based sources to a commit; leave npm/archive as published.
    const s = { ...source };
    if (["url", "git-subdir"].includes(s.source) && /^[\w.-]+\/[\w.-]+$/.test(s.url || "")) s.url = `https://github.com/${s.url}.git`; // see above: no SSH
    if (!s.sha && ["github", "url", "git-subdir"].includes(s.source)) {
      const gitUrl = s.source === "github" ? `https://github.com/${s.repo}` : toGitUrl(s.url);
      s.sha = lsRemote(gitUrl, s.ref || "HEAD");
    }
    return s;
  }
  throw new Error("plugin has no source");
}

// An entry can read another repo's marketplace (`marketplace`, e.g. a curated catalog)
// and take just one of its plugins (`plugin`), so each mod can be its own entry.
async function resolveEntry(e) {
  const repo = e.marketplace || githubRepo(e.url);
  const sha = headSha(repo);
  const mpText = await getText(raw(repo, sha, ".claude-plugin/marketplace.json"));
  if (mpText) {
    const mp = JSON.parse(mpText);
    const pluginRoot = mp.metadata?.pluginRoot;
    if (e.plugin && !(mp.plugins || []).some((pl) => pl.name === e.plugin)) throw new Error(`no plugin "${e.plugin}" in ${repo}'s marketplace`);
    const plugins = (mp.plugins || []).filter((pl) => !e.plugin || pl.name === e.plugin).slice(0, config.maxPluginsPerSource);
    if (!e.plugin && (mp.plugins || []).length > config.maxPluginsPerSource) {
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
      // Same pin as before: keep its footprint. A new pin gets scanned.
      const old = previous[e.id]?.plugins.find((p) => p.name === pl.name && JSON.stringify(p.source) === JSON.stringify(pl.source));
      pl.footprint = old?.footprint?.v === FOOTPRINT_VERSION ? old.footprint : await footprintFor(pl);
    }
    resolved[e.id] = r;
    console.log(`${r.plugins.length} plugin(s) @ ${r.sha.slice(0, 7)}`);
  } catch (err) {
    failed++;
    console.log(`FAILED: ${err.message}`);
    if (previous[e.id]) { resolved[e.id] = previous[e.id]; console.log("  keeping previous pin"); }
  }
}
cleanup();

writeJSON("data/resolved.json", resolved);
console.log(`\nResolved ${Object.keys(resolved).length} bundled entries (${failed} failed). Now run: node scripts/build.mjs`);

// ---- review summary -------------------------------------------------------------
// What changed in what each bumped plugin runs, so a reviewer starts from the risky parts.
function footprintLines(fp) {
  if (!fp) return [];
  return [
    ...fp.hooks.map((h) => `shell hook \`${h.event}${h.matcher ? ` (${h.matcher})` : ""}\`: \`${h.command.slice(0, 120)}\``),
    ...fp.modules.map((m) => `function-hook module \`${m}\``),
    ...(fp.events || []).map((ev) => `hooks event \`${ev}\``),
    ...fp.mcp.map((m) => `MCP server \`${m.name}\`: \`${m.url || m.command.slice(0, 120)}\``),
    ...fp.flags.map((f) => `flag **${FLAGS[f.id].label}** in ${f.where.map((w) => `\`${w}\``).join(", ")}`),
  ];
}
if (summaryPath) {
  const sections = [];
  for (const e of entries.filter((x) => x.bundle && resolved[x.id])) {
    const before = previous[e.id], after = resolved[e.id];
    if (before && before.sha === after.sha && JSON.stringify(before.plugins.map((p) => p.source)) === JSON.stringify(after.plugins.map((p) => p.source))) continue;
    const head = before
      ? `### ${e.name}: [\`${before.sha.slice(0, 7)}\` → \`${after.sha.slice(0, 7)}\`](https://github.com/${after.repo}/compare/${before.sha}...${after.sha})`
      : `### ${e.name}: new, pinned at \`${after.sha.slice(0, 7)}\``;
    const lines = [head];
    for (const pl of after.plugins) {
      const was = new Set(footprintLines(before?.plugins.find((p) => p.name === pl.name)?.footprint));
      const now = footprintLines(pl.footprint);
      const added = now.filter((l) => !was.has(l)), removed = [...was].filter((l) => !now.includes(l));
      lines.push(`- **${pl.name}**: ${added.length || removed.length ? "what it runs changed" : "no change in what it runs"}`);
      for (const l of added) lines.push(`  - ➕ ${l}`);
      for (const l of removed) lines.push(`  - ➖ ${l}`);
    }
    for (const err of policyErrors(e, after)) lines.push(`- ⛔ ${err}`);
    sections.push(lines.join("\n"));
  }
  writeFileSync(summaryPath, [
    "Upstream mods and plugins changed. Every bundled plugin runs with the user's full permissions, so review each diff before merging; the compare links show the full change.",
    "",
    sections.length ? sections.join("\n\n") : "No pins changed.",
    "",
    "<sub>Generated by `scripts/sync.mjs`. Flags are pattern matches from `scripts/footprint.mjs`: a reason to read the code, not a verdict.</sub>",
    "",
  ].join("\n"));
  console.log(`Wrote the review summary to ${summaryPath}`);
}
