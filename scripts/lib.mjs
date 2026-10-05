// Shared helpers for the claudemods scripts. No dependencies: Node 20+ only.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const p = (...parts) => join(ROOT, ...parts);

export const readJSON = (file, fallback) =>
  existsSync(p(file)) ? JSON.parse(readFileSync(p(file), "utf8")) : fallback;
export const writeJSON = (file, data) =>
  writeFileSync(p(file), JSON.stringify(data, null, 2) + "\n");

// data/mods.json keeps one entry per line so diffs and merges stay readable.
export const writeEntries = (entries) =>
  writeFileSync(p("data/mods.json"), "[\n" + entries.map((e) => "  " + JSON.stringify(e)).join(",\n") + "\n]\n");

export const config = readJSON("config.json");

// Display order + labels for every entry type. `heading` is the site's section
// heading, worded the way people search for it.
export const TYPES = {
  mod:          { label: "Mods",                 heading: "Claude Code mods",                   blurb: "Function-hook plugins that draw panes, bands, status lines and toasts, or guard what Claude does." },
  plugin:       { label: "Plugins & marketplaces", heading: "Claude Code plugins & marketplaces", blurb: "Bundles of commands, agents, skills and hooks you install with /plugin." },
  skill:        { label: "Skills",               heading: "Claude skills",                      blurb: "SKILL.md folders that teach Claude a task or workflow." },
  subagent:     { label: "Subagents",            heading: "Claude Code subagents",              blurb: "Specialist agents Claude can hand work to." },
  command:      { label: "Slash commands",       heading: "Claude Code slash commands",         blurb: "Reusable /commands and command frameworks." },
  hook:         { label: "Hooks",                heading: "Claude Code hooks",                  blurb: "Shell hooks and hook SDKs that run on Claude Code lifecycle events." },
  statusline:   { label: "Status lines",         heading: "Claude Code status lines",           blurb: "What sits under your prompt: cost, context, git and more." },
  mcp:          { label: "MCP servers",          heading: "MCP servers for Claude",             blurb: "Connect Claude to tools, data and services." },
  "claude-md":  { label: "CLAUDE.md & config",   heading: "CLAUDE.md templates & config",       blurb: "Templates and guides for project memory and setup." },
  prompt:       { label: "Prompts & guides",     heading: "Claude prompts & guides",            blurb: "Prompt libraries, system prompts and prompting courses." },
  list:         { label: "More lists",           heading: "More Claude lists",                  blurb: "Other curated lists worth following." },
};

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export { PLUGIN_NAME_RE };

export function validateEntries(entries) {
  const errors = [];
  const ids = new Set();
  const urls = new Set();
  entries.forEach((e, i) => {
    const at = `entry #${i} (${e.id ?? "no id"})`;
    for (const k of ["id", "name", "type", "url", "author", "description"]) {
      if (!e[k] || typeof e[k] !== "string") errors.push(`${at}: missing "${k}"`);
    }
    if (e.id && !ID_RE.test(e.id)) errors.push(`${at}: id must be lowercase letters, digits, . _ -`);
    if (e.id && ids.has(e.id)) errors.push(`${at}: duplicate id`);
    ids.add(e.id);
    const u = (e.url || "").toLowerCase().replace(/\/+$/, "");
    if (u && urls.has(u)) errors.push(`${at}: duplicate url ${e.url}`);
    urls.add(u);
    if (e.type && !TYPES[e.type]) errors.push(`${at}: unknown type "${e.type}" (use: ${Object.keys(TYPES).join(", ")})`);
    if (e.url && !/^https:\/\//.test(e.url)) errors.push(`${at}: url must start with https://`);
    if (e.description && e.description.length > 140) errors.push(`${at}: description over 140 chars`);
    if (e.tags && (!Array.isArray(e.tags) || e.tags.length > 6)) errors.push(`${at}: tags must be an array of at most 6`);
    if (e.bundle && !githubRepo(e.url)) errors.push(`${at}: bundle:true needs a github.com repo url`);
    if (e.acknowledge !== undefined && (typeof e.acknowledge !== "object" || !Object.entries(e.acknowledge).every(([k, v]) => FLAGS[k] && typeof v === "string" && v.trim())))
      errors.push(`${at}: acknowledge must map flag ids (${Object.keys(FLAGS).join(", ")}) to a reason`);
  });
  return errors;
}

// Risk flags scripts/footprint.mjs can raise for a bundled plugin, worst first.
export const FLAGS = {
  "runtime-fetch": { label: "Fetches code at runtime", level: "bad", blocking: true },
  "auto-approve": { label: "Skips permission prompts", level: "bad" },
  obfuscation: { label: "Hard-to-review code (eval or encoded blobs)", level: "bad" },
  credentials: { label: "Touches credentials", level: "warn" },
  processes: { label: "Runs other programs", level: "warn" },
  network: { label: "Uses the network", level: "warn" },
  "writes-files": { label: "Writes files", level: "warn" },
  "model-calls": { label: "Makes its own model calls", level: "warn" },
  prompts: { label: "Sends prompts for you", level: "warn" },
  bundled: { label: "Ships minified code", level: "warn" },
};

// A plugin that fetches code at runtime doesn't run the commit we pinned, so it
// stays out of the marketplace unless its entry says why in `acknowledge`.
export function policyErrors(e, r) {
  const errors = [];
  for (const pl of r?.plugins || []) {
    if (!pl.footprint) { errors.push(`${e.id}: plugin ${pl.name} has no footprint; run node scripts/footprint.mjs ${e.id}`); continue; }
    for (const f of pl.footprint.flags) {
      if (FLAGS[f.id]?.blocking && !e.acknowledge?.[f.id])
        errors.push(`${e.id}: plugin ${pl.name} ${FLAGS[f.id].label.toLowerCase()} (${f.where.join(", ")}). Unbundle it, or explain in "acknowledge": {"${f.id}": "..."}`);
    }
  }
  return errors;
}

// "https://github.com/owner/repo(/...)" -> "owner/repo"
export function githubRepo(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(url || "");
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
}

export const md = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
