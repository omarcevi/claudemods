// Weekly search for Claude Code mods we don't list yet (.github/workflows/find-mods.yml).
//
//   GH_TOKEN=... node scripts/find-mods.mjs   # prints the issue body to stdout
//
// Candidates are repos tagged claude-code-mods or claude-mods, and repos whose
// hooks/hooks.json has a `modules` list (function hooks). Repos already in
// data/mods.json, or listed in an earlier `mod-candidates` issue, are skipped.
// Writes `count` to $GITHUB_OUTPUT so the workflow only opens an issue when there
// is something new.
import { appendFileSync } from "node:fs";
import { readJSON, config, githubRepo } from "./lib.mjs";

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || config.repo;
const LABEL = "mod-candidates";
const TOPICS = ["claude-code-mods", "claude-mods"];
const CODE_QUERY = "modules filename:hooks.json path:hooks";
const MAX_LISTED = 60; // the rest stay unreported and show up next week

async function api(path) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "claudemods-find-mods", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`GitHub API ${res.status} on ${path.split("?")[0]}`), { status: res.status });
  return res.json();
}
async function rawText(url) {
  const res = await fetch(url, { headers: { "user-agent": "claudemods-find-mods" } });
  return res.ok ? res.text() : null;
}
async function search(kind, q, maxPages = 3) {
  const items = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const r = await api(`search/${kind}?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
    total = r.total_count;
    items.push(...r.items);
    if (r.items.length < 100 || items.length >= total) break;
  }
  return { items, total };
}
// Run fn over items, a few at a time.
async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
// Repo descriptions are written by strangers: one line, no markup, no @-mentions.
const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/[<>[\]()!`|*_#~\\]/g, "").replace(/@/g, "@\u200b").trim().slice(0, 160);

// ---- what we already have -------------------------------------------------------
const key = (r) => r.toLowerCase();
const known = new Set([key(REPO)]);
for (const e of readJSON("data/mods.json")) { const r = githubRepo(e.url); if (r) known.add(key(r)); }
// Bundles can pull a plugin from another repo (karanb192's cache-tax), so count those too.
const sourceRepo = (s) => s.repo || githubRepo(s.url) || (/^[\w.-]+\/[\w.-]+$/.test(s.url || "") ? s.url : null);
for (const r of Object.values(readJSON("data/resolved.json", {}))) {
  known.add(key(r.repo));
  for (const pl of r.plugins) { const s = sourceRepo(pl.source || {}); if (s) known.add(key(s.replace(/\.git$/, ""))); }
}

const reported = new Set();
for (let page = 1; page <= 5; page++) {
  const issues = (await api(`repos/${REPO}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`)) || [];
  for (const i of issues) for (const m of (i.body || "").matchAll(/^- \[[ xX]\] \*\*\[([\w.-]+\/[\w.-]+)\]/gm)) reported.add(key(m[1]));
  if (issues.length < 100) break;
}

// ---- search ---------------------------------------------------------------------
const found = new Map(); // key -> { repo, meta, reasons: Set }
const add = (repo, reason, meta) => {
  const k = key(repo);
  const c = found.get(k) || { repo, meta: null, reasons: new Set() };
  c.reasons.add(reason);
  c.meta ||= meta;
  found.set(k, c);
};
const notes = [];

for (const t of TOPICS) {
  const { items, total } = await search("repositories", `topic:${t} fork:false archived:false`);
  for (const r of items) add(r.full_name, `topic \`${t}\``, r);
  notes.push(`topic \`${t}\`: ${total} repos`);
}

try {
  const { items, total } = await search("code", CODE_QUERY);
  notes.push(`\`hooks/hooks.json\` with \`modules\`: ${total} files`);
  // Code search matches the word anywhere, so confirm a real `modules` list (one file per repo).
  const byRepo = new Map();
  for (const it of items) if (!known.has(key(it.repository.full_name)) && !byRepo.has(it.repository.full_name)) byRepo.set(it.repository.full_name, it);
  await pool([...byRepo.values()], 8, async (it) => {
    const [, ref] = it.html_url.match(/\/blob\/([^/]+)\//) || [];
    const text = ref && (await rawText(`https://raw.githubusercontent.com/${it.repository.full_name}/${ref}/${it.path}`));
    try { if (Array.isArray(JSON.parse(text).modules)) add(it.repository.full_name, "function hooks"); } catch {}
  });
} catch (err) {
  notes.push(`code search skipped (${err.message}); add a \`MODS_SEARCH_TOKEN\` secret to enable it`);
}

// ---- filter and describe --------------------------------------------------------
const fresh = [...found.entries()].filter(([k]) => !known.has(k) && !reported.has(k)).map(([, c]) => c);
await pool(fresh, 8, async (c) => {
  c.meta ||= await api(`repos/${c.repo}`).catch(() => null);
  if (!c.meta || c.meta.fork || c.meta.archived || c.meta.private) { c.skip = true; return; }
  const ref = c.meta.default_branch || "HEAD";
  const has = async (p) => (await rawText(`https://raw.githubusercontent.com/${c.repo}/${ref}/${p}`)) !== null;
  c.manifest = (await has(".claude-plugin/marketplace.json")) ? "marketplace.json" : (await has(".claude-plugin/plugin.json")) ? "plugin.json" : null;
});
const candidates = fresh.filter((c) => !c.skip)
  .sort((a, b) => b.meta.stargazers_count - a.meta.stargazers_count || String(b.meta.pushed_at).localeCompare(String(a.meta.pushed_at)));
const listed = candidates.slice(0, MAX_LISTED);

// ---- issue body -----------------------------------------------------------------
const out = [];
if (!listed.length) {
  out.push("No new mod candidates this week.");
} else {
  out.push(
    `Found **${candidates.length}** possible mods that aren't in \`data/mods.json\` and weren't in an earlier candidates issue${candidates.length > listed.length ? ` (listing the top ${listed.length} by stars; the rest come next week)` : ""}.`,
    "",
    "Before adding one, open it and read the source: mods run with the user's full permissions. Add the good ones with the submission form or a PR to `data/mods.json`, and tick them off here.",
    "",
  );
  for (const c of listed) {
    const m = c.meta;
    const bits = [`★${m.stargazers_count}`, `updated ${String(m.pushed_at).slice(0, 10)}`, [...c.reasons].join(", "),
      c.manifest ? `has \`.claude-plugin/${c.manifest}\` (can be bundled)` : "no plugin manifest at the root"];
    out.push(`- [ ] **[${c.repo}](https://github.com/${c.repo})** · ${bits.join(" · ")}`);
    const d = clean(m.description);
    if (d) out.push(`  ${d}`);
  }
}
const inData = [...found.keys()].filter((k) => known.has(k)).length;
const before = [...found.keys()].filter((k) => !known.has(k) && reported.has(k)).length;
const dropped = fresh.filter((c) => c.skip).length;
out.push("", `<sub>Searched ${notes.join("; ")}. Skipped ${inData} already listed, ${before} reported before and ${dropped} forks or archived repos. Made by \`.github/workflows/find-mods.yml\`.</sub>`);
console.log(out.join("\n"));

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `count=${listed.length}\n`);
