// Turns a submission issue (from .github/ISSUE_TEMPLATE/submit.yml) into a
// data/mods.json entry.
//
//   ISSUE_BODY=... node scripts/issue-to-entry.mjs --dry-run   # validate only
//   ISSUE_BODY=... node scripts/issue-to-entry.mjs             # append the entry
//
// Prints a markdown summary to stdout (used as the bot's issue comment) and
// writes `id` and `bundle` to $GITHUB_OUTPUT when present.
import { appendFileSync } from "node:fs";
import { readJSON, writeEntries, validateEntries, TYPES, githubRepo } from "./lib.mjs";

const DRY = process.argv.includes("--dry-run");
const body = process.env.ISSUE_BODY || "";

// Issue forms render as "### Label\n\nvalue" blocks.
const fields = {};
for (const block of body.split(/^###\s+/m).slice(1)) {
  const [label, ...rest] = block.split("\n");
  const value = rest.join("\n").trim();
  fields[label.trim().toLowerCase()] = value === "_No response_" ? "" : value;
}
const get = (k) => (fields[k] || "").trim();

const name = get("name");
const url = get("url").replace(/\/+$/, "");
const type = get("type").split(/\s+/)[0];
const author = get("author").replace(/^@/, "");
const description = get("what does it do?").replace(/\s+/g, " ");
const tags = get("tags").split(",").map((t) => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean).slice(0, 5);
const install = get("install command (optional)");
const bundle = /- \[x\] Add it to the claudemods marketplace/i.test(get("checks"));

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const entries = readJSON("data/mods.json");
let id = slug(name) || slug(githubRepo(url) || "entry");
if (entries.some((e) => e.id === id)) id = `${id}-${slug(author)}`;

const entry = {
  id, name, type, url, author, description, tags,
  ...(install && !bundle ? { install } : {}),
  ...(bundle ? { bundle: true } : {}),
  added: new Date().toISOString().slice(0, 10),
};

const problems = validateEntries([...entries, entry]).filter((m) => m.includes(`(${id})`));
if (!TYPES[type]) problems.push(`Unknown type "${type}".`);
if (bundle && !githubRepo(url)) problems.push("Marketplace entries need a github.com repo URL.");

const out = [];
if (problems.length) {
  out.push("**This submission needs a fix before it can be added:**", "", ...problems.map((p) => `- ${p.replace(/^entry #\d+ \([^)]*\): /, "")}`),
    "", "Edit the issue and I'll check it again.");
} else {
  out.push(DRY ? "**Looks good.** A maintainer will review it and add the `approved` label." : "**Added.** Opening a pull request.",
    "", "```json", JSON.stringify(entry, null, 2), "```");
  if (!DRY) {
    entries.push(entry);
    writeEntries(entries);
  }
}
console.log(out.join("\n"));
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `ok=${problems.length ? "false" : "true"}\nid=${id}\nbundle=${bundle}\n`);
}
process.exitCode = problems.length ? 1 : 0;
