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

// Display order + labels for every entry type.
export const TYPES = {
  mod:          { label: "Mods",                 blurb: "Function-hook plugins that draw panes, bands, status lines and toasts, or guard what Claude does." },
  plugin:       { label: "Plugins & marketplaces", blurb: "Bundles of commands, agents, skills and hooks you install with /plugin." },
  skill:        { label: "Skills",               blurb: "SKILL.md folders that teach Claude a task or workflow." },
  subagent:     { label: "Subagents",            blurb: "Specialist agents Claude can hand work to." },
  command:      { label: "Slash commands",       blurb: "Reusable /commands and command frameworks." },
  hook:         { label: "Hooks",                blurb: "Shell hooks and hook SDKs that run on Claude Code lifecycle events." },
  statusline:   { label: "Status lines",         blurb: "What sits under your prompt: cost, context, git and more." },
  mcp:          { label: "MCP servers",          blurb: "Connect Claude to tools, data and services." },
  "claude-md":  { label: "CLAUDE.md & config",   blurb: "Templates and guides for project memory and setup." },
  prompt:       { label: "Prompts & guides",     blurb: "Prompt libraries, system prompts and prompting courses." },
  list:         { label: "More lists",           blurb: "Other curated lists worth following." },
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
  });
  return errors;
}

// "https://github.com/owner/repo(/...)" -> "owner/repo"
export function githubRepo(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(url || "");
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
}

export const md = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
