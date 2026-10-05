// What a bundled plugin runs, read from its pinned commit: shell-command hooks,
// function-hook modules (and the events and $ API calls they use), MCP servers,
// skill/command/agent counts, and risk flags from a pattern scan of its code.
// Stored per plugin as `footprint` in data/resolved.json and shown on the site.
// Code is only read, never run. The flags are pattern matches: a reason to read
// the source, not a verdict.
//
//   node scripts/footprint.mjs [ids…]   # recompute at the current pins (no re-pinning)
//
// sync.mjs calls footprintFor() for every plugin it pins to a new commit.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { readJSON, writeJSON, githubRepo, FLAGS } from "./lib.mjs";

// Bump when the scan changes, so sync.mjs recomputes instead of reusing old results.
export const FOOTPRINT_VERSION = 1;

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".sh", ".bash", ".zsh", ".ps1", ".py", ".rb"]);
const SHELL_EXT = new Set([".sh", ".bash", ".zsh", ".ps1"]);
// Tests, examples and docs don't run; dot-folders for other agents (.opencode, .cursor…) aren't loaded by Claude Code.
const SKIP_DIR = /^(?:node_modules|tests?|__tests__|spec|fixtures?|examples?|evals?|docs?|benchmarks?|\.(?!claude(?:-plugin)?$).*)$/i;
const MAX_FILE = 2_000_000;
const TEST_FILE = /(?:^|\/)(?:test[-_][^/]*|[^/]*[._-](?:test|spec)\.[a-z]+)$/i;
// A long base64 run whose decoded bytes are mostly printable text.
function encodedText(text) {
  for (const m of text.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, "").matchAll(/[A-Za-z0-9+/]{400,}={0,2}/g)) {
    const bytes = Buffer.from(m[0].slice(0, 2048), "base64");
    const printable = bytes.filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length;
    if (bytes.length && printable / bytes.length > 0.9) return true;
  }
  return false;
}

// Code patterns per flag. `shell`: true = shell files only, false = never in shell files.
const RULES = [
  { id: "runtime-fetch", re: /\/releases\/download\/[^\s'"`]*|\b(?:curl|wget)\b[^\n|;]*\|\s*(?:ba|z)?sh\b|\b(?:spawn|exec|execFile|execa)(?:Sync)?\s*\(\s*['"`](?:npx|bunx|uvx)\b[^)\n]*|['"`](?:npx|bunx|uvx)\s+(?:-y|--yes)\b[^'"`\n]*/ },
  { id: "auto-approve", re: /permissionDecision['"]?\s*[:=]\s*['"]allow['"]|\bbehavior['"]?\s*:\s*['"]allow['"]|\bdecision['"]?\s*[:=]\s*['"](?:approve|allow)['"]|\bautoApprove\b|--dangerously-skip-permissions/ },
  { id: "obfuscation", re: /\beval\s*\(|\bnew Function\s*\(|(?:\\x[0-9a-fA-F]{2}){24}/, shell: false },
  { id: "obfuscation", encoded: true }, // long base64 that decodes to text, i.e. hidden code (images and pixel data decode to binary)
  { id: "credentials", re: /[~/]\.ssh\b|[~/]\.aws\b|\.gnupg\b|\bid_(?:rsa|ed25519)\b|\.netrc\b|find-generic-password|['"/]\.env(?:\.\w+)?['"]|process\.env\.(?:\w+_)?(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)(?:_\w+)?\b|os\.environ(?:\.get)?\s*[[(]\s*['"](?:\w+_)?(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)(?:_\w+)?['"]|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY/ },
  { id: "processes", re: /\bchild_process\b|\bBun\.spawn\b|\bsubprocess\.(?:run|Popen|call|check_output)\b|\bos\.system\s*\(|\bDeno\.Command\b|\bexeca\b/, shell: false },
  { id: "network", re: /\bfetch\s*\(|\bhttps?\.(?:get|request)\s*\(|\bnew WebSocket\b|\bnet\.(?:connect|createConnection)\b|\bXMLHttpRequest\b|\baxios\b|\brequests\.(?:get|post|put|patch|delete|request)\s*\(|\burllib\.request\b|\bhttpx\.|\bhttp\.client\b|['"]ssh['"]/, shell: false },
  { id: "network", re: /\b(?:curl|wget|ssh|scp|rsync|nc)\s/, shell: true },
];
// Hook and MCP commands run directly, so a package runner there always fetches code.
const COMMAND_FETCH = /\b(?:npx|bunx|uvx|pnpm\s+dlx|yarn\s+dlx|pipx\s+run)\b|@latest\b|\/releases\/download\/|\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z)?sh\b/;
const COMMAND_NET = /\b(?:curl|wget|ssh|scp|nc)\s/;
// Function-hook mods get their powers from a `$` API; these calls map to flags.
const API_NS = new Set(["agent", "audio", "clock", "command", "config", "env", "fs", "http", "mcp", "model", "plugin", "process", "prompt", "session", "settings", "state", "store", "tool", "turn", "ui"]);
const CALL_FLAGS = { "process.run": "processes", "process.spawn": "processes", "http.fetch": "network", "fs.write": "writes-files", "mcp.call": "auto-approve", "model.complete": "model-calls", "model.fork": "model-calls", "prompt.submit": "prompts" };
const IGNORED_HOSTS = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|(?:[\w-]+\.)*example\.(?:com|org|net)|(?:www\.)?(?:schema\.org|w3\.org|json-schema\.org|json\.schemastore\.org))$/;

// ---- fetching -----------------------------------------------------------------
let work = null;
const trees = new Map();
// Download and unpack a repo at one commit (once per run).
export function checkout(repo, sha) {
  const key = `${repo}@${sha}`;
  if (!trees.has(key)) trees.set(key, (async () => {
    work ||= mkdtempSync(join(tmpdir(), "claudemods-footprint-"));
    const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, { headers: { "user-agent": "claudemods-footprint" } });
    if (!res.ok) throw new Error(`tarball HTTP ${res.status} for ${key}`);
    const dir = join(work, key.replace(/[^\w.-]+/g, "_"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}.tgz`, Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["-xzf", `${dir}.tgz`, "-C", dir, "--strip-components=1"]);
    return dir;
  })());
  return trees.get(key);
}
export function cleanup() { if (work) rmSync(work, { recursive: true, force: true }); work = null; trees.clear(); }

// Where a resolved plugin lives: repo, commit and folder.
export function pluginLocation(pl) {
  const s = pl.source || {};
  if (s.source === "github") return { repo: s.repo, sha: s.sha, root: "" };
  if (s.source === "git-subdir") return { repo: githubRepo(s.url) || s.url, sha: s.sha, root: String(s.path).replace(/^\.\//, "").replace(/\/+$/, "") };
  if (s.source === "url" && githubRepo(s.url)) return { repo: githubRepo(s.url), sha: s.sha, root: "" };
  return null;
}

// ---- reading ------------------------------------------------------------------
function* walk(dir, rel = "") {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (!SKIP_DIR.test(name)) yield* walk(p, rel + name + "/"); }
    else if (st.isFile()) yield { path: p, rel: rel + name, size: st.size };
  }
}
const readJson = (file, errors, label) => {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { errors.push(`${label}: invalid JSON`); return null; }
};
const hostsIn = (text) => [...text.matchAll(/['"`]https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1].toLowerCase()).filter((h) => !IGNORED_HOSTS.test(h));
const snippet = (s) => s.replace(/\s+/g, " ").trim().slice(0, 80);
const uniq = (xs) => [...new Set(xs)].sort();

export async function footprintFor(pl) {
  const empty = { v: FOOTPRINT_VERSION, hooks: [], modules: [], mcp: [], skills: 0, commands: 0, agents: 0, flags: [], scanned: 0 };
  const loc = pluginLocation(pl);
  if (!loc) return { ...empty, errors: [`source type ${pl.source?.source} is not scanned`] };
  const base = await checkout(loc.repo, loc.sha);
  const root = loc.root ? join(base, loc.root) : base;
  const errors = [];
  const hits = new Map(); // flag id -> { where, hosts, via }
  const flag = (id, where, { hosts = [], via } = {}) => {
    const h = hits.get(id) || { where: new Set(), hosts: new Set(), via: new Set() };
    h.where.add(where); hosts.forEach((x) => h.hosts.add(x)); if (via) h.via.add(snippet(via));
    hits.set(id, h);
  };

  // Hooks: hooks/hooks.json, plus paths or an inline object in plugin.json.
  const pj = readJson(join(root, ".claude-plugin/plugin.json"), errors, ".claude-plugin/plugin.json") || {};
  const hookSources = [];
  const seen = new Set();
  for (const f of ["hooks/hooks.json", ...[].concat(pj.hooks || []).filter((x) => typeof x === "string")].map((x) => x.replace(/^\.\//, ""))) {
    if (seen.has(f)) continue; seen.add(f);
    const j = readJson(join(root, f), errors, f);
    if (j) hookSources.push(j);
  }
  if (pj.hooks && typeof pj.hooks === "object" && !Array.isArray(pj.hooks)) hookSources.push(pj.hooks.hooks || pj.hooks.modules ? pj.hooks : { hooks: pj.hooks });
  const hooks = [], modules = [];
  for (const j of hookSources) {
    if (Array.isArray(j.modules)) modules.push(...j.modules.map(String));
    for (const [event, groups] of Object.entries(j.hooks || {})) {
      for (const g of Array.isArray(groups) ? groups : []) for (const h of g.hooks || []) {
        const hook = { event, ...(g.matcher ? { matcher: String(g.matcher) } : {}), ...(h.type && h.type !== "command" ? { type: String(h.type) } : {}), command: String(h.command ?? h.prompt ?? "") };
        hooks.push(hook);
        if (COMMAND_FETCH.test(hook.command)) flag("runtime-fetch", `hook:${event}`, { via: hook.command });
        if (COMMAND_NET.test(hook.command)) flag("network", `hook:${event}`, { via: hook.command });
      }
    }
  }

  // MCP servers: .mcp.json, or mcpServers in plugin.json (inline or a path).
  let mcpRaw = typeof pj.mcpServers === "string" ? readJson(join(root, pj.mcpServers), errors, pj.mcpServers) : pj.mcpServers;
  mcpRaw ||= readJson(join(root, ".mcp.json"), errors, ".mcp.json");
  const mcp = [];
  for (const [name, c] of Object.entries(mcpRaw?.mcpServers || mcpRaw || {})) {
    if (!c || typeof c !== "object") continue;
    if (c.url) {
      mcp.push({ name, url: String(c.url) });
      try { flag("network", `mcp:${name}`, { hosts: [new URL(c.url).hostname], via: c.url }); } catch {}
      continue;
    }
    const command = [c.command, ...(Array.isArray(c.args) ? c.args : [])].filter(Boolean).join(" ");
    mcp.push({ name, command });
    if (COMMAND_FETCH.test(command)) flag("runtime-fetch", `mcp:${name}`, { via: command });
  }

  // Walk the plugin: count what it ships, collect $ API use, scan code.
  let skills = 0, commands = 0, agents = 0, scanned = 0;
  const events = new Set(), calls = new Set(), env = new Set();
  for (const f of walk(root)) {
    const ext = extname(f.rel).toLowerCase();
    if (basename(f.rel) === "SKILL.md") skills++;
    else if (ext === ".md" && /(?:^|\/)commands\//.test(f.rel)) commands++;
    else if (ext === ".md" && /(?:^|\/)agents\//.test(f.rel)) agents++;
    if (!CODE_EXT.has(ext) || /\.d\.[mc]?ts$/.test(f.rel) || TEST_FILE.test(f.rel)) continue; // type declarations and tests never run
    if (f.size > MAX_FILE) { errors.push(`${f.rel}: over 2 MB, not scanned`); continue; }
    const text = readFileSync(f.path, "utf8");
    scanned++;
    const shell = SHELL_EXT.has(ext);
    for (const r of RULES) {
      if (r.shell === true && !shell) continue;
      if (r.shell === false && shell) continue;
      if (r.encoded) { if (encodedText(text)) flag(r.id, f.rel, { via: "base64 that decodes to text" }); continue; }
      const m = text.match(r.re);
      if (m) flag(r.id, f.rel, { hosts: r.id === "network" ? hostsIn(text) : [], via: m[0] });
    }
    if (f.size > 100_000 && text.split("\n").some((l) => l.length > 10_000)) flag("bundled", f.rel);
    for (const m of text.matchAll(/\$\.([a-z]\w*)\.([a-zA-Z]\w*)\b/g)) {
      if (!API_NS.has(m[1])) continue;
      const call = `${m[1]}.${m[2]}`;
      calls.add(call);
      if (CALL_FLAGS[call]) flag(CALL_FLAGS[call], f.rel, { via: `$.${call}`, hosts: call === "http.fetch" ? hostsIn(text) : [] });
    }
    for (const m of text.matchAll(/\bon\(\s*['"`]((?:[a-z]+\.)+[a-zA-Z]+|classic\.[A-Za-z]+)['"`]/g)) events.add(m[1]);
    for (const m of text.matchAll(/\$\.env\.get\(\s*['"`](\w+)['"`]/g)) {
      env.add(m[1]);
      if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_KEY)(?:_|$)/i.test(m[1])) flag("credentials", f.rel, { via: `$.env.get('${m[1]}')` });
    }
  }

  const flags = Object.keys(FLAGS).filter((id) => hits.has(id)).map((id) => {
    const h = hits.get(id);
    const where = uniq(h.where), hosts = uniq(h.hosts), via = uniq(h.via);
    return { id, where: where.slice(0, 8), ...(where.length > 8 ? { more: where.length - 8 } : {}), ...(via.length ? { via: via.slice(0, 3) } : {}), ...(hosts.length ? { hosts: hosts.slice(0, 8) } : {}) };
  });
  return {
    v: FOOTPRINT_VERSION, hooks, modules, mcp,
    ...(events.size ? { events: uniq(events) } : {}), ...(calls.size ? { calls: uniq(calls) } : {}), ...(env.size ? { env: uniq(env) } : {}),
    skills, commands, agents, flags, scanned, ...(errors.length ? { errors } : {}),
  };
}

// One-line summary for logs.
export const describe = (fp) => [
  fp.hooks.length && `hooks[${uniq(fp.hooks.map((h) => h.event)).join(",")}]`,
  fp.modules.length && "modules",
  fp.mcp.length && `mcp[${fp.mcp.map((m) => (m.url ? new URL(m.url).hostname : m.name)).join(",")}]`,
  fp.flags.length && `flags[${fp.flags.map((f) => f.id).join(",")}]`,
].filter(Boolean).join(" ") || "prompts only";

// ---- CLI ----------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = new Set(process.argv.slice(2));
  const entries = readJSON("data/mods.json");
  const resolved = readJSON("data/resolved.json", {});
  const out = {};
  const todo = entries.filter((e) => e.bundle && resolved[e.id] && (!only.size || only.has(e.id)));
  // Download every needed tarball up front, a few at a time.
  const locs = [...new Map(todo.flatMap((e) => resolved[e.id].plugins).map(pluginLocation).filter(Boolean).map((l) => [`${l.repo}@${l.sha}`, l])).values()];
  for (let i = 0; i < locs.length; i += 6) await Promise.all(locs.slice(i, i + 6).map((l) => checkout(l.repo, l.sha).catch(() => {})));
  let failed = 0;
  for (const e of entries.filter((x) => x.bundle)) {
    const r = resolved[e.id];
    if (!r) { console.log(`- ${e.id}: not pinned yet; run node scripts/sync.mjs ${e.id}`); continue; }
    if (todo.includes(e)) {
      for (const pl of r.plugins) {
        try { pl.footprint = await footprintFor(pl); console.log(`- ${e.id}/${pl.name}: ${describe(pl.footprint)}`); }
        catch (err) { failed++; console.log(`- ${e.id}/${pl.name}: FAILED ${err.message}`); }
      }
    }
    out[e.id] = r;
  }
  writeJSON("data/resolved.json", out);
  cleanup();
  console.log(`\nFootprints for ${todo.length} entries (${failed} failed). Now run: node scripts/build.mjs`);
  if (failed) process.exitCode = 1;
}
