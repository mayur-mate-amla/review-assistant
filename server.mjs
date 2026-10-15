// Code Review Bot: local dashboard + Jira/GitHub API integration. No dependencies (Node 18+).
// Run: node D:\review-bot\server.mjs   then open http://localhost:4300
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTeam } from "./team.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.REPO_ROOT || "D:\\znode\\znode-webstore10x-page-builder";
const DATA_FILE = join(HERE, "data.json");
const PORT = Number(process.env.PORT || 4300);
const AREAS = ["admin", "api", "webstore", "db"];
const AREA_LABEL = { admin: "Admin", api: "API", webstore: "Webstore", db: "DB" };
const MAX_DIFF_CHARS = 250000;
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } }
function loadEnv() {
  const out = {};
  const p = join(HERE, ".env");
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = { ...loadEnv(), ...process.env };
const config = { jiraSite: "amla.atlassian.net", jiraStatus: "Code Review", githubOwner: "MRRSoft", claudePath: "claude", approveAssignee: "Umashankar Pardhi", devStatuses: ["In Progress"], devScope: "mine", blockSeverity: "medium", repos: { admin: "", api: "", webstore: "", db: "" }, ...readJson(join(HERE, "config.json"), {}) };

const state = { tickets: {}, settings: { schedule: { enabled: false, times: [] } }, lastSyncAt: null, syncing: false, syncError: "", ...readJson(DATA_FILE, {}) };
state.syncing = false;
for (const t of Object.values(state.tickets)) if (t.review?.state === "running") t.review = { state: "failed", error: "Bot restarted during review. Run it again." };
const save = () => { try { writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch { /* ignore */ } };
const now = () => new Date().toISOString();
let team = null; // created after jira() is defined, see below
const cap = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const upper1 = s => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

// ---------- GitHub (REST) ----------
let ghToken = env.GITHUB_TOKEN || "";
async function githubToken() {
  if (ghToken) return ghToken;
  const ghPath = env.GH_PATH || "C:\\Users\\mayur.mate\\tools\\gh\\bin\\gh.exe";
  ghToken = await new Promise((res, rej) => execFile(ghPath, ["auth", "token"], { windowsHide: true }, (e, out) => e ? rej(new Error("No GITHUB_TOKEN in .env and `gh auth token` failed")) : res(out.trim())));
  return ghToken;
}
async function gh(path, { method = "GET", body, accept = "application/vnd.github+json" } = {}) {
  const res = await fetch(`https://api.github.com${path}`, { method, headers: { Authorization: `Bearer ${await githubToken()}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "review-bot", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`); e.status = res.status; e.body = text; throw e; }
  return accept.includes("json") ? JSON.parse(text) : text;
}
const prInfoFrom = (repo, number, p) => ({ repo, number, url: p.html_url, state: p.merged ? "merged" : p.draft ? "draft" : p.state, sha: p.head.sha, title: p.title, author: p.user?.login });
// GitHub login -> display name (cached); falls back to the login when the profile has no name.
const ghNames = new Map();
async function ghDisplayName(login) {
  if (!login) return "";
  if (ghNames.has(login)) return ghNames.get(login);
  let name = login;
  try { name = (await gh(`/users/${encodeURIComponent(login)}`)).name || login; } catch { /* keep the login */ }
  ghNames.set(login, name);
  return name;
}
async function prInfo(repo, number) {
  const info = prInfoFrom(repo, number, await gh(`/repos/${repo}/pulls/${number}`));
  info.authorName = await ghDisplayName(info.author);
  return info;
}
async function prFiles(repo, number) {
  const names = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    names.push(...r.map(f => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`));
    if (r.length < 100) break;
  }
  return names;
}
let myLogin = null;
async function whoAmI() { return (myLogin ||= (await gh("/user")).login); }

async function ghAll(path, maxPages = 10) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...r);
    if (r.length < 100) break;
  }
  return out;
}
// Review threads with their resolved/outdated flag (REST does not expose it, GraphQL does). Soft-fails to "unknown".
async function reviewThreadFlags(pr) {
  const [owner, name] = pr.repo.split("/");
  const flags = new Map(); // inline comment id -> { resolved, outdated }
  let after = null;
  for (let page = 0; page < 5; page++) {
    const res = await gh("/graphql", { method: "POST", body: { query: "query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated comments(first:100){nodes{databaseId}}}}}}}", variables: { o: owner, r: name, n: Number(pr.number), a: after } } });
    const rt = res?.data?.repository?.pullRequest?.reviewThreads;
    if (!rt) throw new Error("no reviewThreads in GraphQL response");
    for (const th of rt.nodes) for (const c of th.comments.nodes) flags.set(c.databaseId, { resolved: th.isResolved, outdated: th.isOutdated });
    if (!rt.pageInfo.hasNextPage) break;
    after = rt.pageInfo.endCursor;
  }
  return flags;
}

// Everything people have said on a PR: reviews, inline comments, general comments, and what is still open.
async function fetchThread(pr) {
  const me = await whoAmI();
  const [reviews, inline, general, flags] = await Promise.all([
    ghAll(`/repos/${pr.repo}/pulls/${pr.number}/reviews`),
    ghAll(`/repos/${pr.repo}/pulls/${pr.number}/comments`),
    ghAll(`/repos/${pr.repo}/issues/${pr.number}/comments`),
    reviewThreadFlags(pr).catch(() => null),
  ]);
  const items = [];
  for (const r of reviews) if (r.state !== "PENDING") items.push({ id: r.id, kind: "review", author: r.user?.login, bot: r.user?.type === "Bot", at: r.submitted_at, body: cap(r.body, 3000), state: r.state, url: r.html_url });
  for (const c of inline) { const fl = flags?.get(c.id); items.push({ id: c.id, kind: "inline", author: c.user?.login, bot: c.user?.type === "Bot", at: c.created_at, body: cap(c.body, 3000), path: c.path, line: c.line || c.original_line || null, replyTo: c.in_reply_to_id || null, resolved: fl ? fl.resolved : undefined, outdated: fl ? fl.outdated : undefined, url: c.html_url }); }
  for (const c of general) items.push({ id: c.id, kind: "comment", author: c.user?.login, bot: c.user?.type === "Bot", at: c.created_at, body: cap(c.body, 3000), url: c.html_url });
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const i of items) i.mine = i.author === me;
  const lastMine = items.filter(i => i.mine).map(i => i.at).sort().pop();
  const newItems = lastMine ? items.filter(i => !i.mine && !i.bot && i.at > lastMine) : [];
  // Open review threads: the first comment of every thread that is not resolved (outdated ones are listed but flagged).
  const unresolved = flags ? inline.filter(c => !c.in_reply_to_id && flags.get(c.id) && !flags.get(c.id).resolved).map(c => ({ id: c.id, author: c.user?.login, path: c.path, line: c.line || c.original_line || null, outdated: !!flags.get(c.id).outdated, body: cap(c.body, 500), url: c.html_url })) : [];
  // Latest verdict per reviewer; someone else's CHANGES_REQUESTED stays in force until they approve or it is dismissed.
  const latest = new Map();
  for (const r of reviews) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state) && r.user?.login) latest.set(r.user.login, r.state);
  const changesRequestedBy = [...latest].filter(([u, st]) => st === "CHANGES_REQUESTED" && u !== me).map(([u]) => u);
  return { items: items.slice(-200), newCount: newItems.length, fetchedAt: now(), unresolved, changesRequestedBy, threadsKnown: !!flags, total: items.length };
}

// ---------- Jira (REST v3) ----------
async function jira(path, { method = "GET", body } = {}) {
  if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN) throw new Error(`Jira is not configured: add JIRA_EMAIL and JIRA_API_TOKEN to ${join(HERE, ".env")}`);
  const res = await fetch(`https://${config.jiraSite}${path}`, { method, headers: { Authorization: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64")}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
function adfText(n) {
  if (!n) return "";
  if (typeof n === "string") return n;
  if (n.type === "text") return n.text || "";
  const inner = (n.content || []).map(adfText).join(n.type === "doc" ? "\n" : "");
  return ["paragraph", "heading", "listItem", "tableRow"].includes(n.type) ? inner + "\n" : inner;
}
// Small ADF builders (Atlassian Document Format).
const T = (text, marks) => ({ type: "text", text: String(text || " "), ...(marks ? { marks } : {}) });
const B = text => T(text, [{ type: "strong" }]);
const LINK = (text, href) => T(text, [{ type: "link", attrs: { href } }]);
const P = (...nodes) => ({ type: "paragraph", content: nodes.flat().map(n => typeof n === "string" ? T(n) : n) });
const H = (level, text) => ({ type: "heading", attrs: { level }, content: [T(text)] });
const UL = items => ({ type: "bulletList", content: items.map(nodes => ({ type: "listItem", content: [P(nodes)] })) });
const doc = content => ({ type: "doc", version: 1, content });
const addJiraComment = (key, content) => jira(`/rest/api/3/issue/${key}/comment`, { method: "POST", body: { body: doc(content) } });
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

async function syncNow() {
  if (state.syncing) return;
  state.syncing = true; state.syncError = ""; save();
  try {
    // Review stage: tickets assigned to me in the review status. Dev stage: tickets still in development (advisory pre-review check).
    const devs = (Array.isArray(config.devStatuses) ? config.devStatuses : []).filter(x => x && !/["\\]/.test(x));
    const devPart = devs.length ? ` OR (${config.devScope === "all" ? "" : "assignee = currentUser() AND "}status in (${devs.map(x => '"' + x + '"').join(", ")}))` : "";
    const jql = `(assignee = currentUser() AND status = "${config.jiraStatus}")${devPart} ORDER BY updated DESC`;
    const found = await jira(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description,comment,reporter,assignee,status,updated,created,labels,statuscategorychangedate&maxResults=50`);
    const seen = new Set();
    // Recent PRs per configured repo, fetched once per sync. Used to match the ticket key in the branch name or title,
    // because GitHub search only covers title/body/comments and many PRs carry the key only in the branch name.
    const recentCache = new Map();
    const recentPrs = async repo => {
      if (!recentCache.has(repo)) {
        const all = [];
        for (let page = 1; page <= 3; page++) { const r = await gh(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`); all.push(...r); if (r.length < 100) break; }
        recentCache.set(repo, all);
      }
      return recentCache.get(repo);
    };
    for (const issue of found.issues || []) {
      const key = issue.key; seen.add(key);
      const f = issue.fields || {};
      const t = state.tickets[key] || { key, review: { state: "none" } };
      t.summary = f.summary || ""; t.jiraUrl = `https://${config.jiraSite}/browse/${key}`; t.closed = false;
      t.criteria = adfText(f.description).slice(0, 6000);
      t.reporter = f.reporter ? { name: f.reporter.displayName || "", account: f.reporter.accountId || "" } : (t.reporter || null);
      t.jiraStatus = f.status?.name || t.jiraStatus || "";
      t.mode = t.jiraStatus && t.jiraStatus.toLowerCase() !== String(config.jiraStatus).toLowerCase() ? "dev" : "review";
      t.assignee = f.assignee?.displayName || "";
      t.labels = Array.isArray(f.labels) ? f.labels.slice(0, 10) : [];
      t.updatedAt = f.updated || t.updatedAt || null;
      t.waitingSince = f.statuscategorychangedate || f.updated || t.waitingSince || null; // when the ticket last changed status
      // PR links: description first, then comments in order (later mentions win per repo).
      const sources = [JSON.stringify(f.description || ""), ...((f.comment?.comments || []).map(c => JSON.stringify(c.body || "")))];
      const byRepo = new Map();
      for (const s of sources) for (const m of s.matchAll(PR_URL)) byRepo.set(m[1], Number(m[2]));
      if (!byRepo.size) {
        try {
          const r = await gh(`/search/issues?q=${encodeURIComponent(`${key} type:pr user:${config.githubOwner}`)}&per_page=10`);
          const cand = new Map();
          for (const it of r.items || []) {
            const m = /repos\/([\w.-]+\/[\w.-]+)\/?$/.exec(it.repository_url || "");
            if (!m) continue;
            const prev = cand.get(m[1]);
            if (!prev || (it.state === "open" && !prev.open)) cand.set(m[1], { number: it.number, open: it.state === "open" });
          }
          for (const [repo, c] of cand) byRepo.set(repo, c.number);
        } catch { /* search is best effort */ }
      }
      // Repos with no PR found yet: look for the ticket key in PR branch names and titles.
      const keyRe = new RegExp(`(^|[^A-Za-z0-9])${key}(?!\\d)`, "i");
      for (const area of AREAS) {
        const repo = config.repos[area];
        if (!repo || byRepo.has(repo)) continue;
        try {
          const hits = (await recentPrs(repo)).filter(p => keyRe.test(`${p.head?.ref || ""} ${p.title || ""}`));
          const pick = hits.find(p => p.state === "open") || hits[0];
          if (pick) byRepo.set(repo, pick.number);
        } catch { /* best effort */ }
      }
      const prs = { admin: null, api: null, webstore: null, db: null };
      for (const area of AREAS) {
        const repo = config.repos[area];
        if (repo && byRepo.has(repo)) { try { prs[area] = await prInfo(repo, byRepo.get(repo)); } catch { prs[area] = { repo, number: byRepo.get(repo), url: `https://github.com/${repo}/pull/${byRepo.get(repo)}`, state: "unknown" }; } }
      }
      t.prs = prs;
      if (t.mode === "dev" && !AREAS.some(x => prs[x]?.number)) { t.closed = true; state.tickets[key] = t; continue; } // dev stage: only tickets that already have a PR
      t.threads = t.threads || {};
      for (const area of AREAS) {
        if (!prs[area]?.number) { delete t.threads[area]; continue; }
        try { t.threads[area] = await fetchThread(prs[area]); } catch { /* keep the previous snapshot */ }
      }
      const reviewed = t.reviewData?.headShas || {};
      if (t.review?.state === "draft" && AREAS.some(a => prs[a]?.sha && reviewed[a] && prs[a].sha !== reviewed[a])) t.review = { state: "stale" };
      state.tickets[key] = t;
    }
    for (const t of Object.values(state.tickets)) if (!seen.has(t.key)) t.closed = true;
    state.lastSyncAt = now();
  } catch (e) { state.syncError = String(e.message || e); } finally { state.syncing = false; save(); }
}

// ---------- Review: one agent per PR (area-specific), then a lead pass across PRs ----------
function extractJson(text) {
  const start = text.indexOf("{"); if (start < 0) throw new Error("no JSON in model output");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in model output");
}
const agentText = name => readFileSync(join(HERE, "agents", name), "utf8");

// Hash of all agent files, stored with each review so you can tell which rubric produced it.
const rubricVersion = () => {
  const h = createHash("sha1");
  for (const f of ["base.md", "cross-pr.md", ...AREAS.map(a => `${a}.md`)]) { try { h.update(agentText(f)); } catch { /* missing file */ } }
  return h.digest("hex").slice(0, 8);
};

// One retry: covers a timeout, a CLI hiccup, or output that was not valid JSON.
async function runClaude(prompt, opts) {
  try { return await runClaudeOnce(prompt, opts); }
  catch (first) {
    try { return await runClaudeOnce(prompt + "\n\nYour previous answer could not be used (" + String(first.message || first).slice(0, 120) + "). Return ONLY the JSON object from the output format.", opts); }
    catch { throw first; }
  }
}

function runClaudeOnce(prompt, { allowRead, cwd }) {
  const deny = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "mcp__claude_ai_Microsoft_365", "mcp__claude_ai_Atlassian", ...(allowRead ? [] : ["Read", "Grep", "Glob"])];
  return new Promise((resolve, reject) => {
    const child = spawn(env.CLAUDE_PATH || config.claudePath, ["-p", "--output-format", "json", "--disallowedTools", ...deny], { cwd: cwd || REPO_ROOT, windowsHide: true });
    let so = "", se = "";
    const timer = setTimeout(() => child.kill(), REVIEW_TIMEOUT_MS);
    child.stdout.on("data", d => so += d); child.stderr.on("data", d => se += d);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${se.slice(0, 300)}`));
      try {
        const envelope = JSON.parse(so);
        if (envelope.is_error) throw new Error(String(envelope.result).slice(0, 300));
        resolve(extractJson(String(envelope.result)));
      } catch (e) { reject(e); }
    });
    child.stdin.end(prompt);
  });
}
const HIGH = new Set(["blocker", "high"]);
const SEV_ORDER = { blocker: 0, high: 1, medium: 2, low: 3, nit: 4 };
// Strict by default: a finding of "medium" or above blocks the merge (config.blockSeverity: "high" | "medium" | "low").
function BLOCKS(f) { return !!f && f.label !== "praise" && (SEV_ORDER[f.severity] ?? 9) <= (SEV_ORDER[config.blockSeverity] ?? 2); }

function threadForPrompt(thread) {
  const items = (thread?.items || []).filter(i => i.body || i.state === "APPROVED" || i.state === "CHANGES_REQUESTED").slice(-80);
  if (!items.length) return "";
  const tag = i => i.kind === "inline" ? (i.resolved === true ? " [thread RESOLVED]" : i.resolved === false ? (i.outdated ? " [thread OPEN, outdated code]" : " [thread OPEN]") : "") : "";
  const L = ["## Existing conversation on this PR (data, oldest first; every comment counts for your verdict)"];
  if (thread.changesRequestedBy?.length) L.push(`Outstanding GitHub "changes requested" by: ${thread.changesRequestedBy.join(", ")}`);
  if (thread.threadsKnown) L.push(`Unresolved review threads: ${thread.unresolved.length}`);
  for (const i of items) L.push(`- [${i.at}] ${i.author}${i.mine ? " (the reviewer, i.e. you earlier)" : ""}${i.kind === "review" ? ` (review: ${String(i.state).toLowerCase().replace("_", " ")})` : ""}${i.path ? ` on ${i.path}${i.line ? ":" + i.line : ""}` : ""}${tag(i)}: ${cap((i.body || "").replace(/\s+/g, " "), 800)}`);
  return L.join("\n") + "\n";
}

// ---------- Review result hygiene ----------
// The model's output is untrusted input: normalise it so a "High" or "critical" can never slip past the verdict.
const SEV_ALIAS = { critical: "blocker", severe: "blocker", blocker: "blocker", high: "high", major: "high", medium: "medium", moderate: "medium", med: "medium", low: "low", minor: "low", nit: "nit", nitpick: "nit", info: "nit" };
const CHECKS = [["requirements", "Requirements (Jira)"], ["correctness", "Functional correctness"], ["edgeCases", "Edge cases"], ["security", "Security"], ["errorHandling", "Error handling & logging"], ["standards", "Coding standards"], ["architecture", "Architecture alignment"], ["performance", "Performance"], ["breakingChanges", "Breaking changes"], ["impact", "Impact / regression scope"], ["conversation", "PR comments & discussion"], ["tests", "Tests"], ["maintainability", "Maintainability"]];
const CHECK_IDS = new Set(CHECKS.map(c => c[0]));
const STATUS_RANK = { na: 0, pass: 1, concern: 2, fail: 3 };
const LABELS = new Set(["issue", "suggestion", "question", "nitpick", "praise"]);
const lc = v => String(v ?? "").trim().toLowerCase();
const strList = v => Array.isArray(v) ? v.map(x => typeof x === "string" ? x : JSON.stringify(x)).filter(Boolean) : [];

function normalizeReview(r, { truncated, testsRequired }) {
  for (const k of ["edgeCases", "breakingChanges", "impact", "performance", "positives", "testing"]) r[k] = strList(r[k]);
  const cnt = v => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
  const tin = r.tests && typeof r.tests === "object" ? r.tests : {};
  if (testsRequired) {
    let passed = cnt(tin.passed), failed = cnt(tin.failed), total = cnt(tin.total);
    if (total == null && passed != null && failed != null) total = passed + failed;
    if (failed == null && total != null && passed != null) failed = Math.max(0, total - passed);
    if (passed == null && total != null && failed != null) passed = Math.max(0, total - failed);
    r.tests = { required: true, casesProvided: tin.casesProvided === true, resultsProvided: tin.resultsProvided === true, total, passed, failed, evidence: String(tin.evidence || "") };
  } else {
    r.tests = { required: false, casesProvided: false, resultsProvided: false, total: null, passed: null, failed: null, evidence: "" };
  }
  const cin = r.conversation && typeof r.conversation === "object" ? r.conversation : {};
  r.conversation = { summary: cap(cin.summary || "", 400), openPoints: (Array.isArray(cin.openPoints) ? cin.openPoints : []).filter(x => x && (x.point || x.note)).slice(0, 20).map(x => ({ author: String(x.author || ""), path: String(x.path || ""), point: cap(x.point || "", 300), status: ["resolved", "open", "unclear"].includes(lc(x.status)) ? lc(x.status) : "unclear", note: cap(x.note || "", 300) })) };
  r.requirements = (Array.isArray(r.requirements) ? r.requirements : []).filter(x => x && x.criterion).slice(0, 12).map(x => ({ criterion: cap(x.criterion, 300), met: ["yes", "no", "unclear"].includes(lc(x.met)) ? lc(x.met) : "unclear", note: cap(x.note || "", 300) }));
  const c = r.contracts && typeof r.contracts === "object" ? r.contracts : {};
  r.contracts = { endpoints: strList(c.endpoints).slice(0, 20), dbObjects: strList(c.dbObjects).slice(0, 20), models: strList(c.models).slice(0, 20), config: strList(c.config).slice(0, 20) };
  const seen = new Set();
  r.findings = (Array.isArray(r.findings) ? r.findings : []).filter(f => f && typeof f === "object" && String(f.text || "").trim()).map(f => {
    const line = Number.parseInt(f.line, 10);
    const sev = SEV_ALIAS[lc(f.severity)] || "medium";
    const conf = ["high", "medium", "low"].includes(lc(f.confidence)) ? lc(f.confidence) : "medium";
    // A low-confidence concern is a question for the author, never a blocker.
    const severity = conf === "low" && (sev === "blocker" || sev === "high") ? "medium" : sev;
    return { severity, category: CHECK_IDS.has(f.category) ? f.category : "correctness", label: LABELS.has(lc(f.label)) ? lc(f.label) : (severity === "nit" ? "nitpick" : "issue"), confidence: conf, file: String(f.file || ""), line: Number.isFinite(line) && line > 0 ? line : null, evidence: cap(f.evidence || "", 300), text: String(f.text), suggestion: f.suggestion ? String(f.suggestion) : "", solutions: strList(f.solutions).slice(0, 4).map(x => cap(x, 300)) };
  }).filter(f => testsRequired || f.category !== "tests").filter(f => { const k = `${f.file}|${f.line}|${f.text.slice(0, 60)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // Keep the list readable: everything above nit, at most 3 nits.
  let nits = 0; r.findings = r.findings.filter(f => f.severity !== "nit" || ++nits <= 2).slice(0, 25);
  r.risk = { level: ["low", "medium", "high"].includes(lc(r.risk?.level)) ? lc(r.risk.level) : "medium", reason: String(r.risk?.reason || "") };
  r.whatChanged = String(r.whatChanged || "");
  r.approvalSummary = String(r.approvalSummary || "");
  // Checklist: every item present, status valid, and never rosier than the findings say.
  const given = r.checklist && typeof r.checklist === "object" ? r.checklist : {};
  r.checklist = {};
  for (const [id] of CHECKS) {
    const g = given[id] || {};
    let status = ["pass", "concern", "fail", "na"].includes(lc(g.status)) ? lc(g.status) : "na";
    const mine = r.findings.filter(f => f.category === id && f.label !== "praise");
    const worst = mine.reduce((w, f) => Math.max(w, BLOCKS(f) ? 3 : f.severity === "medium" || f.severity === "low" ? 2 : 0), 0);
    if (status === "fail" && worst < 3) status = "concern"; // "fail" must be backed by a blocker/high finding
    if (worst >= 2 && worst > STATUS_RANK[status]) status = worst === 3 ? "fail" : "concern";
    r.checklist[id] = { status, note: cap(g.note || "", 220) };
  }
  // Facts we can compute ourselves beat the model's opinion.
  const t = r.tests, tn = r.checklist.tests;
  if (!testsRequired) { r.checklist.tests = { status: "na", note: "Not required for this area" }; }
  else {
    if (t.casesProvided && t.resultsProvided) { if (tn.status === "na") tn.status = "pass"; }
    else if (STATUS_RANK[tn.status] < 2) tn.status = "concern";
    if (!tn.note) tn.note = cap(t.evidence, 220);
  }
  if (r.breakingChanges.length && r.checklist.breakingChanges.status === "pass") r.checklist.breakingChanges.status = "concern";
  if (r.requirements.some(x => x.met === "no") && STATUS_RANK[r.checklist.requirements.status] < 2) r.checklist.requirements.status = "concern";
  if (truncated) for (const id of ["correctness", "security"]) if (r.checklist[id].status === "pass") { r.checklist[id].status = "concern"; r.checklist[id].note = "Partial diff only. " + r.checklist[id].note; }
  r.partial = !!truncated;
}

// Hard rules from the PR conversation and the test results. These add findings, so the verdict and the checklist follow from them.
function applyHardRules(r, { thread, testsRequired }) {
  const add = (severity, category, text, extra = {}) => r.findings.push({ severity, category, label: "issue", confidence: "high", file: extra.file || "PR", line: extra.line ?? null, evidence: "", text, suggestion: extra.suggestion || "", solutions: extra.solutions || [] });
  const t = r.tests;
  if (testsRequired) {
    if (!t.casesProvided) add("high", "tests", "No test cases found. API PRs must include test cases (automated tests, or a written list of cases in the PR description or a comment).", { suggestion: "Add automated tests for every changed endpoint and service method.", solutions: ["Cover success, 400, 404, 403, 204 and the edge cases of this change.", "If automated tests are not possible, list the executed cases with their results in the PR description."] });
    if (!t.resultsProvided) add("high", "tests", "Test results are not documented on the GitHub PR. Results must be in the PR description or a PR comment (cases with pass/fail, run output or a screenshot). Jira comments do not count.", { suggestion: "Paste the executed test cases and their results into the PR description.", solutions: ["Attach the test run output or a screenshot of the run to a PR comment.", "Add a table of case, expected, actual and pass/fail."] });
    else if (t.failed == null || t.passed == null) add("medium", "tests", "Test results are shown but the pass and fail counts cannot be read from them.", { suggestion: "State the totals, for example \"12 passed, 0 failed\"." });
    if (t.failed > 0) add("high", "tests", `${t.failed} of ${t.total ?? "?"} test case${t.failed === 1 ? "" : "s"} failed (${t.passed ?? "?"} passed). A PR with failing tests cannot be approved.`, { suggestion: "Fix the code so the failing cases pass, then re-run and update the results on the PR.", solutions: ["If a case is outdated by this change, update the case and explain why in the PR.", "Do not skip or delete a failing case to get a green run."] });
  }
  // Open review threads and someone else's outstanding "changes requested".
  for (const u of thread?.changesRequestedBy || []) add("high", "conversation", `${u} requested changes on GitHub and has not approved since.`, { suggestion: `Address the review comments and ask ${u} to re-review, or have the review dismissed.` });
  const pts = r.conversation.openPoints;
  for (const p of pts) {
    if (p.status === "open") add("high", "conversation", `Earlier comment${p.author ? " by " + p.author : ""} is still open: ${p.point}${p.note ? " — " + p.note : ""}`, { file: p.path || "PR" });
    else if (p.status === "unclear") add("medium", "conversation", `Earlier comment${p.author ? " by " + p.author : ""} may not be addressed: ${p.point}${p.note ? " — " + p.note : ""}`, { file: p.path || "PR" });
  }
  const open = (thread?.unresolved || []).filter(u => !u.outdated);
  const covered = pts.length;
  if (open.length > covered) add("medium", "conversation", `${open.length} unresolved review thread${open.length === 1 ? "" : "s"} on GitHub; the review covered only ${covered}. Check: ${open.slice(0, 5).map(u => `${u.path || "?"}${u.line ? ":" + u.line : ""} (${u.author})`).join(", ")}.`);
  r.conversationStats = { unresolvedThreads: thread?.threadsKnown ? (thread.unresolved || []).length : null, openPoints: pts.filter(p => p.status === "open").length, resolvedPoints: pts.filter(p => p.status === "resolved").length, unclearPoints: pts.filter(p => p.status === "unclear").length, changesRequestedBy: thread?.changesRequestedBy || [], totalComments: thread?.total ?? null };
}

// Verdict comes from the findings alone; the reason is rebuilt so the two can never disagree.
function finishReview(r, { truncated }) {
  r.findings.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  // Re-evaluate checklist items after late-added findings (tests, truncation).
  for (const f of r.findings) { const it = r.checklist[f.category]; if (!it || f.label === "praise") continue; const need = BLOCKS(f) ? "fail" : (f.severity === "medium" || f.severity === "low") ? "concern" : null; if (need && STATUS_RANK[need] > STATUS_RANK[it.status]) it.status = need; }
  const must = r.findings.filter(BLOCKS);
  r.verdict = must.length ? "request_changes" : "approve";
  r.verdictReason = must.length ? `${must.length} issue${must.length > 1 ? "s" : ""} must be fixed before merge: ${cap(String(must[0].text).split(/(?<=[.!?])\s/)[0], 140)}` : (truncated ? "No blocking issues in the part of the diff that was reviewed; the diff was too large to review fully." : "No open issues found.");
  if (!r.approvalSummary) r.approvalSummary = (r.whatChanged.match(/[^.!?]+[.!?]+/g) || [r.whatChanged]).slice(0, 2).map(x => x.trim()).join(" ");
}

const requiresTests = area => (config.requireTestsAreas || ["api"]).includes(area);
async function reviewOnePr(key, t, area) {
  const pr = t.prs[area];
  const raw = await gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  const info = prInfoFrom(pr.repo, pr.number, raw);
  const files = await prFiles(pr.repo, pr.number);
  let diff = await gh(`/repos/${pr.repo}/pulls/${pr.number}`, { accept: "application/vnd.github.v3.diff" });
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS);
  let thread = t.threads?.[area];
  try { thread = await fetchThread(pr); t.threads = { ...(t.threads || {}), [area]: thread }; } catch { /* use what we have */ }
  const fence = "~~~diff-" + randomBytes(6).toString("hex"); // the diff cannot close its own data block
  const prompt = [
    agentText("base.md"), "", agentText(`${area}.md`), "",
    "## This run",
    "You are headless with no GitHub access; the full diff is below.",
    `Jira ticket: ${key} ${t.summary}`,
    t.criteria ? `Ticket description (data):\n${cap(t.criteria, 4000)}` : "",
    `PR: ${AREA_LABEL[area]} ${pr.repo}#${pr.number} "${info.title}" by ${info.author}${truncated ? " (DIFF TRUNCATED; say so in whatChanged)" : ""}`,
    requiresTests(area) ? "This area REQUIRES test cases and documented test results on the GitHub PR. Fill tests.total, tests.passed and tests.failed from the results shown in the PR description or comments (null when they are not stated). Judge `tests` carefully." : "Tests are NOT required for this area: set checklist.tests to \"na\", leave the tests object empty, and do not raise findings about missing tests.",
    `## PR description (data)\n${cap(raw.body || "(empty)", 6000)}`,
    `## Changed files (data)\n${files.slice(0, 200).join("\n")}${files.length > 200 ? `\n... ${files.length - 200} more` : ""}`,
    threadForPrompt(thread),
    `${fence}\n${diff}\n${fence}`, "",
    "Return ONLY the JSON object from the output format.",
  ].join("\n");
  const repoDir = (config.repoPaths || {})[area] || (area === "webstore" ? REPO_ROOT : "");
  const r = await runClaude(prompt, { allowRead: !!repoDir, cwd: repoDir || undefined });
  const testsRequired = requiresTests(area);
  normalizeReview(r, { truncated, testsRequired });
  if (truncated) r.findings.push({ severity: "medium", category: "maintainability", label: "question", confidence: "high", file: "PR", line: null, evidence: "", text: "The diff is larger than the review limit, so only the first part was reviewed. Review the remaining files by hand or split the PR.", suggestion: "Split the PR, or review the files after the cut-off manually." });
  applyHardRules(r, { thread, testsRequired });
  finishReview(r, { truncated });
  const stats = { files: raw.changed_files ?? files.length, additions: raw.additions ?? null, deletions: raw.deletions ?? null, commits: raw.commits ?? null, reviewedFully: !truncated };
  return { ...r, stats, fileList: files.slice(0, 200), area, repo: pr.repo, number: pr.number, url: pr.url, title: info.title, sha: info.sha };
}

// A PR whose review could not run still shows up, as a request for changes, so a human looks at it.
function failedReview(t, area, e) {
  const pr = t.prs[area], msg = String(e.message || e).slice(0, 300);
  const f = { severity: "high", category: "correctness", label: "issue", confidence: "high", file: "PR", line: null, evidence: "", text: `The automated review could not run for this PR (${msg}). Review it manually or run the review again.`, suggestion: "", solutions: [] };
  const checklist = Object.fromEntries(CHECKS.map(([id]) => [id, { status: "na", note: "Not reviewed" }]));
  return { failed: true, error: msg, verdict: "request_changes", verdictReason: "The automated review failed for this PR.", whatChanged: "The automated review failed for this PR, so there is no summary.", approvalSummary: "", risk: { level: "unknown", reason: "Not reviewed" }, checklist, requirements: [], findings: [f], edgeCases: [], breakingChanges: [], impact: [], performance: [], contracts: { endpoints: [], dbObjects: [], models: [], config: [] }, tests: { required: false, casesProvided: false, resultsProvided: false, total: null, passed: null, failed: null, evidence: "" }, conversation: { summary: "", openPoints: [] }, positives: [], testing: [], stats: {}, partial: true, area, repo: pr.repo, number: pr.number, url: pr.url, title: pr.title || "", sha: "" };
}

async function reviewTicket(key) {
  const t = state.tickets[key];
  if (!t) throw new Error("unknown ticket");
  const areas = AREAS.filter(a => t.prs?.[a]?.number);
  if (!areas.length) throw new Error("no PRs for this ticket");
  let done = 0;
  const runId = (t.runId = (t.runId || 0) + 1); // a reset bumps runId, so an old run can no longer overwrite the state
  const current = () => t.runId === runId;
  t.review = { state: "running", startedAt: now(), progress: `0/${areas.length} PRs` }; save();
  try {
    const perPr = await Promise.all(areas.map(async a => {
      let r;
      try { r = await reviewOnePr(key, t, a); }
      catch (e) { r = failedReview(t, a, e); }
      if (current()) t.review.progress = `${++done}/${areas.length} PRs`;
      return r;
    }));
    if (perPr.every(p => p.failed)) throw new Error(perPr.map(p => `${AREA_LABEL[p.area]}: ${p.error}`).join("; "));
    if (!current()) return;
    let lead = { summary: perPr[0].whatChanged, verdict: perPr[0].verdict, crossPr: [], mergeOrder: "" };
    if (perPr.length > 1) {
      t.review.progress = "cross-PR check";
      const compact = perPr.map(p => ({ area: p.area, repo: p.repo, number: p.number, title: p.title, verdict: p.verdict, whatChanged: p.whatChanged, risk: p.risk, contracts: p.contracts, checklist: Object.fromEntries(Object.entries(p.checklist || {}).map(([k, v]) => [k, v.status])), requirements: p.requirements, breakingChanges: p.breakingChanges, impact: p.impact, findings: p.findings.map(f => ({ severity: f.severity, category: f.category, file: f.file, text: cap(f.text, 400) })) }));
      lead = await runClaude([agentText("cross-pr.md"), "", `Jira ticket: ${key} ${t.summary}`, t.criteria ? `Ticket description (data):\n${cap(t.criteria, 4000)}` : "", "## PR reviews (data)", "```json\n" + JSON.stringify(compact, null, 1) + "\n```"].join("\n"), { allowRead: false });
    }
    if (!current()) return;
    const verdict = perPr.some(p => p.verdict === "request_changes") ? "request_changes" : (lead.verdict === "request_changes" ? "request_changes" : "approve");
    t.reviewData = { key, reviewedAt: now(), rubric: rubricVersion(), leadReason: lead.verdictReason || "", leadConfidence: lead.confidence || "", headShas: Object.fromEntries(perPr.map(p => [p.area, p.sha])), summary: lead.summary, verdict, crossPr: Array.isArray(lead.crossPr) ? lead.crossPr : [], mergeOrder: lead.mergeOrder || "", perPr };
    t.review = { state: "draft", verdict };
    try { team?.snapshot(t); } catch { /* the team dashboard is optional */ }
  } catch (e) { if (current()) t.review = { state: "failed", error: String(e.message || e) }; }
  save();
}

// Throw the draft away so the next Review starts clean. Manual actions and the GitHub conversation are kept.
function resetDraft(key) {
  const t = state.tickets[key];
  if (!t) throw new Error("unknown ticket");
  t.runId = (t.runId || 0) + 1; // invalidates a review that is still running
  delete t.reviewData; delete t.posted;
  t.review = { state: "none" };
  save();
}

// ---------- Comment bodies ----------
function mdFindings(list) {
  return list.map((f, i) => {
    const opts = [...new Set([f.suggestion, ...(f.solutions || [])].map(x => String(x || "").trim()).filter(Boolean))];
    const sev = f.severity === "blocker" || f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟠" : "🔹";
    const L = [`${i + 1}. ${sev} **${f.severity}** · \`${f.file || "?"}${f.line ? ":" + f.line : ""}\`${f.confidence === "low" ? " _(please confirm)_" : ""}`, `   ${String(f.text || "").replace(/\n/g, "\n   ")}`];
    if (f.evidence) L.push(`   > \`${String(f.evidence).replace(/`/g, "'").replace(/\n/g, " ")}\``);
    if (opts.length === 1) L.push(`   **Fix:** ${opts[0].replace(/\n/g, " ")}`);
    else if (opts.length > 1) L.push("   **Fix options:**", ...opts.map((o, j) => `   ${String.fromCharCode(97 + j)}. ${o.replace(/\n/g, " ")}`));
    return L.join("\n");
  });
}
const ICON = { pass: "✅ Pass", concern: "⚠️ Check", fail: "❌ Fail", na: "➖ N/A" };
const cell = x => String(x || "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
function sevCounts(list) {
  const n = { blocker: 0, high: 0, medium: 0, low: 0, nit: 0 };
  for (const f of list) if (f.label !== "praise" && n[f.severity] != null) n[f.severity]++;
  return n;
}
function testsLine(t) {
  if (!t || !t.required) return "Not required for this area";
  if (!t.casesProvided) return "❌ No test cases found";
  if (!t.resultsProvided) return "❌ Cases found, results not documented";
  if (t.passed == null || t.failed == null) return "⚠️ Results shown, counts not stated";
  return `${t.failed > 0 ? "❌" : "✅"} ${t.passed} passed · ${t.failed} failed${t.total != null ? ` (${t.total} total)` : ""}`;
}
function commentsLine(pp) {
  const c = pp.conversationStats;
  if (!c || !c.totalComments) return "No comments on the PR";
  const parts = [`${c.totalComments} read`];
  if (c.unresolvedThreads != null) parts.push(`${c.unresolvedThreads} unresolved thread${c.unresolvedThreads === 1 ? "" : "s"}`);
  parts.push(`${c.resolvedPoints} resolved · ${c.openPoints} open${c.unclearPoints ? ` · ${c.unclearPoints} unclear` : ""}`);
  if (c.changesRequestedBy?.length) parts.push(`changes requested by ${c.changesRequestedBy.join(", ")}`);
  return (c.openPoints || c.changesRequestedBy?.length ? "❌ " : "✅ ") + parts.join(" · ");
}
function mdMetrics(pp) {
  const st = pp.stats || {}, n = sevCounts(pp.findings || []), t = pp.tests || {};
  const size = st.files != null ? `${st.files} file${st.files === 1 ? "" : "s"}${st.additions != null ? ` · +${st.additions} / −${st.deletions}` : ""}${st.commits ? ` · ${st.commits} commit${st.commits === 1 ? "" : "s"}` : ""}` : "n/a";
  const reqs = pp.requirements || [], met = reqs.filter(x => x.met === "yes").length;
  const checks = Object.values(pp.checklist || {}), applicable = checks.filter(c => c.status !== "na"), passed = applicable.filter(c => c.status === "pass").length;
  const rows = [
    ["Risk", `${upper1(pp.risk?.level || "unknown")}${pp.risk?.reason ? ` — ${pp.risk.reason}` : ""}`],
    ["Size", size],
    ["Checks passed", applicable.length ? `${passed} of ${applicable.length}` : "n/a"],
    ["Findings", `${n.blocker} blocker · ${n.high} high · ${n.medium} medium · ${n.low} low · ${n.nit} nit`],
    ["Requirements met", reqs.length ? `${met} of ${reqs.length}${reqs.some(x => x.met === "unclear") ? " (some unclear)" : ""}` : "n/a"],
    ["Tests", testsLine(t)],
    ["PR comments", commentsLine(pp)],
    ["Breaking changes", (pp.breakingChanges || []).length ? `⚠️ ${pp.breakingChanges.length} noted` : "None found"],
    ["Review coverage", pp.partial ? "⚠️ Partial diff" : "Full diff reviewed"],
  ];
  return ["| Metric | Result |", "|---|---|", ...rows.map(r => `| ${r[0]} | ${cell(r[1])} |`)];
}
function mdChecks(pp) {
  const rows = CHECKS.map(([id, label]) => { const c = pp.checklist?.[id]; return c ? `| ${label} | ${ICON[c.status] || ICON.na} | ${cell(c.note) || "—"} |` : null; }).filter(Boolean);
  if (!rows.length) return [];
  return ["### What was checked", "", "| Check | Result | Notes |", "|---|---|---|", ...rows];
}
function failedChecks(pp) {
  return CHECKS.map(([id, label]) => ({ id, label, c: pp.checklist?.[id] })).filter(x => x.c && (x.c.status === "fail" || x.c.status === "concern"));
}
function mdChecksLine(pp) {
  const applicable = Object.values(pp.checklist || {}).filter(c => c.status !== "na"), passed = applicable.filter(c => c.status === "pass").length;
  return applicable.length ? `${passed}/${applicable.length} checks passed` : "";
}
// What must change, nothing else: blocking findings with fix options, the failed checks, breaking changes, then optional notes folded away.
function blockingParts(pp) {
  const all = (pp.findings || []).filter(f => f.label !== "praise"), must = all.filter(BLOCKS), optional = all.filter(f => !BLOCKS(f));
  const P = { mustFix: "", failedChecks: "", apiTests: "", breaking: "", impact: "", optional: "", openPoints: "" };
  if (must.length) P.mustFix = [`### Must fix before merge (${must.length})`, "", ...mdFindings(must)].join("\n");
  const fc = failedChecks(pp);
  if (fc.length) P.failedChecks = ["### Checks that did not pass", "", "| Check | Result | Why |", "|---|---|---|", ...fc.map(x => `| ${x.label} | ${ICON[x.c.status]} | ${cell(x.c.note) || "—"} |`)].join("\n");
  const t = pp.tests;
  if (t?.required && (!t.casesProvided || !t.resultsProvided || t.failed > 0 || t.passed == null)) P.apiTests = `**API tests:** ${testsLine(t).replace(/^[^A-Za-z0-9]+/u, "")}${t.evidence ? " — " + t.evidence : ""}`;
  if ((pp.breakingChanges || []).length) P.breaking = ["### ⚠️ Breaking changes", ...pp.breakingChanges.map(x => `- ${x}`)].join("\n");
  if ((pp.impact || []).length) P.impact = ["### Impacted areas to cover", ...pp.impact.slice(0, 6).map(x => `- ${x}`)].join("\n");
  if (optional.length) P.optional = [`<details><summary>Optional improvements (${optional.length}, do not block)</summary>`, "", ...mdFindings(optional), "", "</details>"].join("\n");
  return P;
}
function mdBlocking(pp) {
  const P = blockingParts(pp);
  return [P.mustFix, P.failedChecks, P.apiTests, P.breaking, P.impact, P.optional].filter(Boolean).join("\n\n").split("\n");
}
function mdFindingsSection(pp) { return ["## Review findings", "", ...mdBlocking(pp)].join("\n"); }
function mdApprovedLine(pp) {
  const t = pp.tests, parts = [mdChecksLine(pp)];
  if (t?.required && t.passed != null) parts.push(`API tests ${t.passed}/${t.total ?? t.passed + (t.failed || 0)} passed`);
  parts.push("no breaking changes", "no open comments");
  return "**Checked:** " + parts.filter(Boolean).join(" · ");
}
// GitHub review body from templates/github/*.md. Placeholders: {{key}} {{area}} {{prNumber}} {{prTitle}} {{prUrl}} {{reason}} {{summary}} {{checked}} {{risk}} {{checks}} {{tests}} {{date}}
// and the blocks {{mustFix}} {{failedChecks}} {{apiTests}} {{breaking}} {{impact}} {{optional}} {{openPoints}} (empty blocks disappear).
function mdReview(key, data, pp, verdict) {
  const tpl = loadTemplate("github", verdict, pp.area);
  if (!tpl) return mdReviewBuiltin(key, data, pp, verdict);
  const P = blockingParts(pp), must = (pp.findings || []).filter(BLOCKS), opt = (pp.findings || []).filter(f => f.label !== "praise" && !BLOCKS(f));
  if (verdict === "approve") {
    P.openPoints = must.length ? [`### Open points (approved by the reviewer anyway) (${must.length})`, "", ...mdFindings(must)].join("\n") : "";
    P.optional = opt.length ? [`<details><summary>Optional improvements (${opt.length})</summary>`, "", ...mdFindings(opt), "", "</details>"].join("\n") : "";
  }
  const vals = { ...P, key, area: AREA_LABEL[pp.area] || pp.area, prNumber: pp.number, prTitle: String(pp.title || "").replace(/\s+/g, " "), prUrl: pp.url || "",
    reason: pp.verdictReason || "", summary: pp.approvalSummary || pp.whatChanged || "No open issues found.", checked: mdApprovedLine(pp),
    risk: pp.risk?.level ? upper1(pp.risk.level) : "n/a", checks: mdChecksLine(pp) || "n/a", tests: pp.tests?.required ? testsLine(pp.tests).replace(/^[^A-Za-z0-9]+/u, "") : "not required", date: new Date().toISOString().slice(0, 10) };
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => k in vals ? String(vals[k] ?? "") : m).replace(/\n{3,}/g, "\n\n").trim();
}
function mdReviewBuiltin(key, data, pp, verdict) {
  const approved = verdict === "approve", must = (pp.findings || []).filter(BLOCKS);
  const head = `## ${approved ? "✅ Approved" : "🔴 Changes requested"} · ${key} · ${AREA_LABEL[pp.area]} #${pp.number}`;
  if (approved) {
    const L = [head, "", pp.approvalSummary || pp.whatChanged || "No open issues found.", "", mdApprovedLine(pp)];
    if (must.length) L.push("", `### Open points (approved by the reviewer anyway) (${must.length})`, "", ...mdFindings(must));
    const optional = (pp.findings || []).filter(f => f.label !== "praise" && !BLOCKS(f));
    if (optional.length) L.push("", `<details><summary>Optional improvements (${optional.length})</summary>`, "", ...mdFindings(optional), "", "</details>");
    return L.join("\n");
  }
  return [head, "", pp.verdictReason ? `> ${pp.verdictReason}` : "", "", ...mdBlocking(pp)].join("\n");
}
function mdLead(data) {
  const L = [];
  if (data.crossPr?.length) L.push("", "### Cross-PR notes", ...data.crossPr.map(x => `- ${x}`));
  if (data.mergeOrder) L.push("", `**Suggested merge order:** ${data.mergeOrder}`);
  return L.length ? "\n" + L.join("\n") : "";
}
function jiraSummaryDoc(key, verdict, data, results) {
  const approved = verdict === "approve";
  const out = [H(3, `Code review ${approved ? "approved" : "needs changes"}: ${key}`)];
  if ((data.summary || "").trim()) out.push(P(cap(data.summary.trim(), 400)));
  for (const pp of data.perPr) {
    const res = results.find(r => r.area === pp.area);
    const n = sevCounts(pp.findings || []);
    const checks = Object.values(pp.checklist || {}).filter(c => c.status !== "na");
    out.push(P(B(`${AREA_LABEL[pp.area]} #${pp.number}: `), pp.verdict === "approve" ? "Approved" : "Changes requested", ` · Risk ${upper1(pp.risk?.level || "unknown")} · `, LINK("PR", pp.url), res?.url ? [" · ", LINK("GitHub review", res.url)] : (res && !res.posted ? ` · not posted (${res.message})` : "")));
    out.push(P(cap(pp.verdict === "approve" && pp.approvalSummary ? pp.approvalSummary : (pp.whatChanged || ""), 300)));
    const bits = [];
    if (checks.length) bits.push(`checks ${checks.filter(c => c.status === "pass").length}/${checks.length} passed`);
    bits.push(`findings: ${n.blocker + n.high + n.medium} must fix, ${n.low + n.nit} optional`);
    if (pp.tests?.required) bits.push(`tests: ${testsLine(pp.tests).replace(/[✅❌⚠️]/gu, "").trim()}`);
    out.push(P(bits.join(" · ")));
    const must = (pp.findings || []).filter(f => BLOCKS(f));
    if (must.length) out.push(UL(must.slice(0, 5).map(f => `${f.file && f.file !== "PR" ? f.file + (f.line ? ":" + f.line : "") + " — " : ""}${cap(f.text, 160)}`)));
    if (must.length > 5) out.push(P(`+${must.length - 5} more must-fix items.`));
  }
  if (data.crossPr?.length) out.push(P(B("Cross-PR: "), data.crossPr.slice(0, 3).map(x => cap(x, 160)).join(" | ")));
  if (data.mergeOrder) out.push(P(B("Merge order: "), cap(data.mergeOrder, 200)));
  out.push(P("Every finding with its fix is in the GitHub review."));
  return out;
}

// ---------- Jira comment templates (templates/*.md) ----------
const TEMPLATE_FILES = { approve: "approved.md", request_changes: "changes-requested.md" };
const clean = v => String(v ?? "").replace(/[*\[\]]/g, "").replace(/\s+/g, " ").trim();
function inlineAdf(text) {
  const out = [], re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let i = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push(T(text.slice(i, m.index)));
    out.push(m[1] !== undefined ? B(m[1]) : LINK(m[2], m[3]));
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push(T(text.slice(i)));
  return out;
}
function templateToAdf(md) {
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { const c = []; para.forEach((ln, i) => { if (i) c.push({ type: "hardBreak" }); c.push(...inlineAdf(ln)); }); out.push({ type: "paragraph", content: c }); para = []; } };
  const flushList = () => { if (list) { out.push({ type: "bulletList", content: list.map(x => ({ type: "listItem", content: [{ type: "paragraph", content: inlineAdf(x) }] })) }); list = null; } };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); out.push({ type: "heading", attrs: { level: h[1].length + 2 }, content: inlineAdf(h[2]) }); continue; }
    const li = /^[*-]\s+(.*)$/.exec(line);
    if (li) { flushPara(); (list ||= []).push(li[1]); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out;
}
// templates/<jira|github>/<approved|changes-requested>[-<area>].md; the area file wins, the generic file is the fallback.
function loadTemplate(kind, verdict, area) {
  const base = TEMPLATE_FILES[verdict === "approve" ? "approve" : "request_changes"];
  for (const name of [area ? base.replace(/\.md$/, "-" + area + ".md") : null, base]) {
    if (!name) continue;
    try { return readFileSync(join(HERE, "templates", kind, name), "utf8").replace(/\r\n/g, "\n"); } catch { /* try the generic one */ }
  }
  return null;
}
let myName = "";
async function reviewerName() { try { return (myName ||= (myJira ||= (await jira("/rest/api/3/myself")).displayName || "")); } catch { return "the reviewer"; } }
// info: { key, area, pr: {number,url,title,author}, pp (AI review of that PR, optional), verdict, reviewUrl, note }
// Leave comes from the "OOO was created on Amla India Holiday/Leave Calendar" notification emails in the signed-in user's Outlook,
// read through the Claude Microsoft 365 connector (no Graph credentials). Only the read-only email search tool is allowed.
function runClaudeTools(prompt, allow, timeoutMs = 300000) {
  const deny = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Read", "Grep", "Glob"];
  return new Promise((resolve, reject) => {
    const child = spawn(env.CLAUDE_PATH || config.claudePath, ["-p", "--output-format", "json", "--allowedTools", ...allow, "--disallowedTools", ...deny], { cwd: REPO_ROOT, windowsHide: true });
    let so = "", se = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", d => so += d); child.stderr.on("data", d => se += d);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${se.slice(0, 200)}`));
      try { const env2 = JSON.parse(so); if (env2.is_error) throw new Error(String(env2.result).slice(0, 200)); resolve(extractJson(String(env2.result))); } catch (e) { reject(e); }
    });
    child.stdin.end(prompt);
  });
}
async function fetchLeaveEmails() {
  const after = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const prompt = [
    "Use the Outlook email search tool (outlook_email_search; load it with tool search if it is deferred).",
    `Search for emails whose text contains "Holiday/Leave Calendar" received after ${after}. Use limit 25 and keep paging with nextOffset until there are no more results (at most 8 pages).`,
    "Do not call any other tool and do not open any email.",
    "For every email returned copy these three fields exactly as given: subject, received (the receivedDateTime) and summary.",
    'Return ONLY this JSON object: {"emails":[{"subject":"","received":"","summary":""}]}',
  ].join("\n");
  const r = await runClaudeTools(prompt, ["mcp__claude_ai_Microsoft_365__outlook_email_search"]);
  return (Array.isArray(r.emails) ? r.emails : []).filter(e => e && /Holiday\/Leave Calendar/i.test(String(e.subject || "")));
}
// Leave that members announce by email themselves (sent to the signed-in user). Claude reads the mails and returns dates; only read tools are allowed.
async function fetchMemberLeave(members) {
  const people = members.filter(m => m.email);
  if (!people.length) return [];
  const today = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), after = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const prompt = [
    `Today is ${today}. Use the Outlook email search tool (outlook_email_search; load it with tool search if it is deferred) and, only when needed, the read_resource tool to open an email.`,
    `For each person below, search for emails SENT BY them (use the sender filter with their email address) received after ${after} that tell the user about leave: leave, sick leave, OOO, out of office, vacation, half day, taking the day off, or not being available. Use a query such as: leave OR sick OR OOO OR "out of office" OR vacation OR "half day".`,
    "Ignore everything that is not a personal absence notice (GitHub notifications, code review comments, newsletters, meeting invites, test reports, mentions of the word leave in a technical sense).",
    `Report only absences whose last day is on or after ${from} (so current and future leave). Work out the first and last day from the email text; a single day has the same start and end. Do not guess: if the dates cannot be read, skip the email.`,
    "People:", ...people.map(m => `- ${m.name} <${m.email}>`),
    "Do not call any other tool. Never send, reply, delete or change anything.",
    'Return ONLY this JSON object: {"leave":[{"email":"","start":"YYYY-MM-DD","end":"YYYY-MM-DD","type":"Leave|Sick|Half day","subject":"","received":""}]}. Use {"leave":[]} when there is none.',
  ].join("\n");
  const r = await runClaudeTools(prompt, ["mcp__claude_ai_Microsoft_365__outlook_email_search", "mcp__claude_ai_Microsoft_365__read_resource"], 420000);
  const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
  return (Array.isArray(r.leave) ? r.leave : []).filter(x => x && ok(x.start) && ok(x.end) && x.end >= x.start && people.some(m => m.email.toLowerCase() === String(x.email || "").toLowerCase())).slice(0, 100).map(x => ({ email: String(x.email).toLowerCase(), start: x.start, end: x.end, type: /sick|medical/i.test(x.type) ? "Sick" : /half/i.test(x.type) ? "Half day" : "Leave", subject: String(x.subject || "").slice(0, 160), received: String(x.received || "") }));
}
team = createTeam({ jira, state, save, fetchLeaveEmails, fetchMemberLeave });
async function jiraTemplateText(info) {
  const { key, area, pr, pp, verdict, reviewUrl, note } = info;
  const tpl = loadTemplate("jira", verdict, area), lead = info.lead || {};
  const n = sevCounts(pp?.findings || []);
  const checks = Object.values(pp?.checklist || {}).filter(c => c.status !== "na");
  let issues = (pp?.findings || []).filter(BLOCKS).sort((a, b) => ["blocker", "high", "medium", "low", "nit"].indexOf(a.severity) - ["blocker", "high", "medium", "low", "nit"].indexOf(b.severity)).slice(0, 6)
    .map(f => "* " + clean((f.file && f.file !== "PR" ? f.file + (f.line ? ":" + f.line : "") + " - " : "") + cap(f.text, 220) + (BLOCKS(f) ? "" : " (" + f.severity + ")")));
  const open = (pp?.conversation?.openPoints || []).filter(p => p.status !== "resolved");
  if (!issues.length) issues = open.slice(0, 8).map(p => "* " + clean("Open PR comment" + (p.author ? " from " + p.author : "") + ": " + cap(p.point, 200)));
  if (!issues.length && note) issues = ["* " + clean(cap(note, 300))];
  if (!issues.length) issues = ["* See the review comments on the PR for the details."];
  const n8 = (pp?.findings || []).filter(BLOCKS).length;
  if (n8 > 6) issues.push("* " + (n8 - 6) + " more are in the GitHub review.");
  const comments = clean(note || (verdict === "approve" ? pp?.approvalSummary : pp?.verdictReason) || "None.");
  const vals = {
    key, area: AREA_LABEL[area] || area, prNumber: pr.number, prTitle: clean(cap(pr.title || "", 90)), prUrl: pr.url || "",
    author: clean(pr.authorName || pr.author || "unknown"), risk: pp?.risk?.level ? upper1(pp.risk.level) : "n/a",
    checks: checks.length ? checks.filter(c => c.status === "pass").length + " of " + checks.length + " passed" : "n/a",
    findings: pp ? (n.blocker + n.high + n.medium) + " must fix · " + (n.low + n.nit) + " optional" : "n/a",
    blocking: pp ? n.blocker + n.high + n.medium : 0,
    failedChecks: pp ? failedChecks(pp).map(x => x.label).join(", ") || "none" : "n/a",
    mergeOrder: clean(lead.mergeOrder || "n/a"), crossRepo: clean((lead.crossPr || []).slice(0, 3).join(" | ") || "No cross-repo issues found"),
    tests: pp?.tests?.required ? clean(testsLine(pp.tests).replace(/[✅❌⚠️]/gu, "")) : "not required",
    reviewUrl: reviewUrl || pr.url || "", reviewer: clean(await reviewerName()), date: new Date().toISOString().slice(0, 10), comments,
  };
  if (!tpl) return "# " + (verdict === "approve" ? "PR Review Status: APPROVED ✅" : "PR Review Status: CHANGES REQUESTED ⚠️") + "\n" + key + " " + vals.area + " PR [#" + vals.prNumber + "](" + vals.prUrl + ")";
  const filled = tpl.replace(/^\{\{issues\}\}\s*$/gm, issues.join("\n")).replace(/\{\{(\w+)\}\}/g, (m, k) => k in vals ? String(vals[k]) : m);
  return filled;
}
const jiraTemplateDoc = async info => templateToAdf(await jiraTemplateText(info));

async function jiraReviewDoc(key, t, verdict, data, results) {
  const out = [];
  for (const pp of data.perPr || []) {
    const res = results.find(r => r.area === pp.area);
    if (!res?.posted) continue;
    const pr = t.prs?.[pp.area] || {};
    if (out.length) out.push({ type: "rule" });
    out.push(...await jiraTemplateDoc({ key, area: pp.area, pr: { ...pr, number: pp.number, url: pp.url || pr.url, title: pp.title || pr.title }, pp, verdict, reviewUrl: res.url, lead: data }));
  }
  if (data.crossPr?.length) out.push(P(B("Cross-PR: "), data.crossPr.slice(0, 3).map(x => cap(x, 160)).join(" | ")));
  if (data.mergeOrder) out.push(P(B("Merge order: "), cap(data.mergeOrder, 200)));
  return out.length ? out : jiraSummaryDoc(key, verdict, data, results);
}
// ---------- Jira work log: time spent on each approve / request-changes review ----------
function jiraStarted() {
  const d = new Date(), p = (n, l = 2) => String(n).padStart(l, "0"), o = -d.getTimezoneOffset(), a = Math.abs(o);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000${o < 0 ? "-" : "+"}${p(Math.floor(a / 60))}${p(a % 60)}`;
}
async function logReviewTime(key, { area, pr, pp, verdict, url, note }) {
  const wl = state.settings.worklog || {};
  if (wl.enabled === false) return { posted: false, skipped: true, message: "work logging is off in Settings" };
  const dflt = Number(config.worklogMinutes) > 0 ? Number(config.worklogMinutes) : 10;
  const minutes = (verdict === "approve" ? wl.approveMinutes : wl.changesMinutes) || dflt;
  const n = sevCounts(pp?.findings || []);
  const what = verdict === "approve" ? "Approved" : "Requested changes on";
  const lines = [
    `Code review: ${what} ${AREA_LABEL[area] || area} PR #${pr.number}${pr.title ? " - " + cap(String(pr.title).replace(/\s+/g, " "), 100) : ""}`,
    `Outcome: ${verdict === "approve" ? "Approved, no blocking changes required" : "Changes requested"}${pp ? `. Findings: ${n.blocker + n.high} must fix, ${n.medium} should fix, ${n.low + n.nit} minor` : ""}.`,
    "Work done: read the Jira ticket and PR description, reviewed the diff and the PR comments, checked logic, security, error handling, performance, breaking changes and tests where required.",
    ...(note ? [`Reviewer note: ${cap(String(note).replace(/\s+/g, " "), 300)}`] : []),
  ];
  const content = [P(B(lines[0])), ...lines.slice(1).map(l => P(l)), ...(url ? [P(LINK("Open the review on GitHub", url))] : [])];
  await jira(`/rest/api/3/issue/${key}/worklog`, { method: "POST", body: { timeSpentSeconds: minutes * 60, started: jiraStarted(), comment: doc(content) } });
  return { posted: true, minutes };
}

// ---------- Jira hand-off ----------
// Approve -> config.approveAssignee. Request changes -> whoever assigned the ticket to me
// (last assignee change in the Jira history whose new value is me), else the reporter.
async function findJiraUser(name) {
  const users = (await jira(`/rest/api/3/user/search?query=${encodeURIComponent(name)}`)).filter(u => u.accountType !== "app" && u.active !== false);
  const exact = users.filter(u => (u.displayName || "").toLowerCase() === name.toLowerCase());
  const pick = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : null;
  if (!pick) throw new Error(users.length ? `Several Jira users match "${name}". Set approveAssigneeAccountId in config.json.` : `No Jira user found for "${name}".`);
  return { accountId: pick.accountId, name: pick.displayName };
}
async function previousAssigner(key, myId) {
  let startAt = 0, last = null;
  for (let page = 0; page < 20; page++) {
    const r = await jira(`/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`);
    for (const h of r.values || []) for (const it of h.items || []) if (it.field === "assignee" && it.to === myId && it.from) last = { accountId: it.from, name: it.fromString || "previous assignee" };
    startAt += (r.values || []).length;
    if (r.isLast || !(r.values || []).length) break;
  }
  if (last) return { ...last, via: "assignment history" };
  const issue = await jira(`/rest/api/3/issue/${key}?fields=reporter`);
  const rep = issue.fields?.reporter;
  if (rep?.accountId && rep.accountId !== myId) return { accountId: rep.accountId, name: rep.displayName, via: "reporter (no earlier assignee found)" };
  throw new Error("Could not work out who assigned this ticket to you.");
}
async function reassign(key, verdict) {
  const me = await jira("/rest/api/3/myself");
  let target;
  if (verdict === "approve") {
    target = config.approveAssigneeAccountId ? { accountId: config.approveAssigneeAccountId, name: config.approveAssignee || "configured assignee" } : await findJiraUser(config.approveAssignee || "Umashankar Pardhi");
  } else {
    target = await previousAssigner(key, me.accountId);
  }
  await jira(`/rest/api/3/issue/${key}/assignee`, { method: "PUT", body: { accountId: target.accountId } });
  return { ok: true, to: target.name, via: target.via || "approval hand-off" };
}

// ---------- Post the AI review (GitHub + Jira + hand-off) ----------
async function submitReview(pr, live, event, body) {
  const send = ev => gh(`/repos/${pr.repo}/pulls/${pr.number}/reviews`, { method: "POST", body: { commit_id: live.sha, body, event: ev } });
  try { const r = await send(event); return { event, url: r.html_url }; }
  catch (e) {
    if (event !== "COMMENT" && e.status === 422 && /own pull request/i.test(e.body || "")) { const r = await send("COMMENT"); return { event: "COMMENT", url: r.html_url, note: "Your own PR: GitHub only allows a comment." }; }
    throw e;
  }
}
const devBody = (key, data, pp, sha) => mdReview(key, data, pp, pp.verdict === "approve" ? "approve" : "request_changes")
  .replace("✅ Approved ·", "✅ Looks ready for review ·").replace("🔴 Changes requested ·", "🔧 Please fix before review ·")
  + mdLead(data) + `\n\n<sub>Advisory check at \`${(sha || "").slice(0, 7)}\` by Code Review Bot (rules ${data.rubric || "v0"}) while the ticket is in development. It does not approve or block the PR. Fix, push, and ask for a re-check.</sub>`;
async function postDevCheck(key) {
  const t = state.tickets[key], data = t.reviewData, results = [];
  for (const pp of data.perPr || []) {
    const pr = AREAS.map(a => t.prs?.[a]).find(p => p && p.repo === pp.repo && p.number === pp.number);
    if (!pr) { results.push({ area: pp.area, posted: false, message: "PR no longer linked to this ticket" }); continue; }
    try {
      const live = await prInfo(pr.repo, pr.number);
      if (live.state !== "open") { results.push({ area: pp.area, posted: false, message: `PR is ${live.state}` }); continue; }
      const r = await gh(`/repos/${pr.repo}/issues/${pr.number}/comments`, { method: "POST", body: { body: cap(devBody(key, data, pp, live.sha), 64000) } });
      results.push({ area: pp.area, posted: true, event: "COMMENT", url: r.html_url });
    } catch (e) { results.push({ area: pp.area, posted: false, message: e.message }); }
  }
  t.posted = { at: now(), verdict: data.verdict, dev: true, results, jira: null, assign: null, worklogs: [] };
  if (results.some(r => r.posted)) t.review = { state: "posted", verdict: data.verdict };
  for (const a of AREAS) if (t.prs?.[a]?.number) { try { t.threads = { ...(t.threads || {}), [a]: await fetchThread(t.prs[a]) }; } catch { /* ignore */ } }
  save();
  return t.posted;
}
async function postTicket(key, verdict) {
  const t = state.tickets[key];
  if (!t?.reviewData) throw new Error("no review draft");
  if (t.mode === "dev") return postDevCheck(key);
  if (verdict !== "approve" && verdict !== "request_changes") throw new Error("invalid verdict");
  const data = t.reviewData, results = [];
  for (const pp of data.perPr || []) {
    const pr = AREAS.map(a => t.prs?.[a]).find(p => p && p.repo === pp.repo && p.number === pp.number);
    if (!pr) { results.push({ area: pp.area, posted: false, message: "PR no longer linked to this ticket" }); continue; }
    const live = await prInfo(pr.repo, pr.number);
    if (data.headShas?.[pp.area] && live.sha !== data.headShas[pp.area]) { results.push({ area: pp.area, posted: false, message: "PR changed since the review. Run the review again." }); continue; }
    if (live.state !== "open") { results.push({ area: pp.area, posted: false, message: `PR is ${live.state}` }); continue; }
    try {
      const body = mdReview(key, data, pp, verdict) + mdLead(data) + `\n\n<sub>Reviewed at \`${live.sha.slice(0, 7)}\` with Code Review Bot (rules ${data.rubric || "v0"}). Reply on this PR to discuss; I will read your answers.</sub>`;
      const r = await submitReview(pr, live, verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES", body);
      results.push({ area: pp.area, posted: true, event: r.event, url: r.url, message: r.note });
    } catch (e) { results.push({ area: pp.area, posted: false, message: e.message }); }
  }
  let jiraResult = { posted: false };
  if (results.some(r => r.posted)) {
    try { await addJiraComment(key, await jiraReviewDoc(key, t, verdict, data, results)); jiraResult = { posted: true }; }
    catch (e) { jiraResult = { posted: false, message: String(e.message || e) }; }
  }
  const worklogs = [];
  for (const pp of data.perPr || []) {
    const res = results.find(r => r.area === pp.area);
    if (!res?.posted) continue;
    const pr = t.prs?.[pp.area] || {};
    try { worklogs.push({ area: pp.area, ...(await logReviewTime(key, { area: pp.area, pr: { ...pr, number: pp.number, title: pp.title || pr.title }, pp, verdict, url: res.url })) }); }
    catch (e) { worklogs.push({ area: pp.area, posted: false, message: String(e.message || e) }); }
  }
  let assignResult = null; // hand the ticket on only after the Jira comment is in
  if (jiraResult.posted) {
    try { assignResult = await reassign(key, verdict); } catch (e) { assignResult = { ok: false, message: String(e.message || e) }; }
  }
  t.posted = { at: now(), verdict, results, jira: jiraResult, assign: assignResult, worklogs };
  if (results.some(r => r.posted)) t.review = { state: "posted", verdict };
  for (const a of AREAS) if (t.prs?.[a]?.number) { try { t.threads = { ...(t.threads || {}), [a]: await fetchThread(t.prs[a]) }; } catch { /* ignore */ } }
  save();
  return t.posted;
}

// ---------- Manual action on one PR: reply, comment/question, approve, request changes ----------
async function prAction(key, { area, action, body, replyTo, replyKind, after }) {
  const t = state.tickets[key], pr = t?.prs?.[area];
  if (!pr?.number) throw new Error("PR not found for this ticket");
  body = String(body || "").trim();
  if (!["approve", "request_changes", "comment"].includes(action)) throw new Error("invalid action");
  if (t.mode === "dev" && action !== "comment") throw new Error("This ticket is still in development. Only comments are allowed until it moves to " + config.jiraStatus + ".");
  const pp = t.reviewData?.perPr?.find(x => x.area === area);
  const withFindings = action === "request_changes" && !replyTo && !!pp && (pp.findings || []).some(f => f.label !== "praise");
  if (action !== "approve" && !body && !withFindings) throw new Error("Write a comment or question first.");
  after = after || "handoff"; // GitHub, Jira and ticket hand-off by default; "jira" skips the hand-off, "none" is GitHub only
  const userBody = body;
  if (body.length > 60000) throw new Error("Comment is too long.");
  const live = await prInfo(pr.repo, pr.number);
  if (live.state !== "open") throw new Error(`PR is ${live.state}`);
  let whyApproved = "";
  if (action === "approve" && !replyTo && pp) {
    const ch = Object.values(pp.checklist || {}).filter(c => c.status !== "na"), ok = ch.filter(c => c.status === "pass").length;
    whyApproved = [pp.approvalSummary || pp.whatChanged, ch.length ? `${ok} of ${ch.length} checks passed${testsLine(pp.tests || {}) && pp.tests?.required ? ", tests: " + testsLine(pp.tests) : ""}; ${sevCounts(pp.findings || []).blocker + sevCounts(pp.findings || []).high} blocking findings.` : ""].filter(Boolean).join(" ");
    body = cap([body, body ? "" : null, "### Why this is approved", "", whyApproved, "", mdApprovedLine(pp)].filter(x => x !== null).join("\n").trim(), 64000);
  } else if (action === "approve" && !body) {
    body = "Approved: reviewed the changes and found no blocking issues.";
  }
  if (withFindings) body = cap([body, mdFindingsSection(pp)].filter(Boolean).join("\n\n---\n\n"), 64000);
  let posted;
  if (replyTo && replyKind === "inline") {
    const r = await gh(`/repos/${pr.repo}/pulls/${pr.number}/comments/${Number(replyTo)}/replies`, { method: "POST", body: { body } });
    posted = { event: "REPLY", url: r.html_url };
  } else if (replyTo || (action === "comment" && replyKind === "comment")) {
    const r = await gh(`/repos/${pr.repo}/issues/${pr.number}/comments`, { method: "POST", body: { body } });
    posted = { event: "COMMENT", url: r.html_url };
  } else {
    posted = await submitReview(pr, live, action === "approve" ? "APPROVE" : action === "request_changes" ? "REQUEST_CHANGES" : "COMMENT", body);
  }
  const result = { at: now(), area, action, event: posted.event, url: posted.url, note: posted.note };
  if ((after === "jira" || after === "handoff")) {
    const label = action === "approve" ? "approved" : action === "request_changes" ? "requested changes on" : "commented on";
    try {
      const fs = withFindings ? sevCounts(pp.findings) : null;
      const useTpl = !replyTo && action !== "comment";
      if (useTpl) await addJiraComment(key, await jiraTemplateDoc({ key, area, pr, pp, verdict: action, reviewUrl: posted.url, note: userBody, lead: t.reviewData }));
      else await addJiraComment(key, [P(B(`Manual review: ${label} ${AREA_LABEL[area]} PR #${pr.number}`), " · ", LINK("open on GitHub", posted.url || pr.url)), ...(userBody ? [P(cap(userBody.replace(/\s+/g, " "), 300))] : []), ...(whyApproved ? [P("Why approved: " + cap(whyApproved, 400))] : []), ...(fs ? [P(`Findings: ${fs.blocker + fs.high} must fix, ${fs.medium} should fix, ${fs.low + fs.nit} minor. Full details are on GitHub.`)] : [])]);
      result.jira = { posted: true };
    } catch (e) { result.jira = { posted: false, message: String(e.message || e) }; }
    if (!replyTo && action !== "comment") {
      try { result.worklog = await logReviewTime(key, { area, pr, pp, verdict: action, url: posted.url || pr.url, note: userBody }); }
      catch (e) { result.worklog = { posted: false, message: String(e.message || e) }; }
    }
    if (after === "handoff" && action !== "comment") { try { result.assign = await reassign(key, action); } catch (e) { result.assign = { ok: false, message: String(e.message || e) }; } }
  }
  t.manual = [...(t.manual || []), result].slice(-20);
  try { t.threads = { ...(t.threads || {}), [area]: await fetchThread(pr) }; } catch { /* ignore */ }
  save();
  return result;
}

// ---------- HTTP ----------
const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const sendJson = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ""; req.on("data", d => { b += d; if (b.length > 2e5) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
let myJira = null;
// Tickets that left the review status stay in data.json; the History tab lists them so they can be checked and cleared.
const archiveItem = t => {
  const n = p => { const c = sevCounts(p.findings || []); return { must: (p.findings || []).filter(BLOCKS).length, optional: c.low + c.nit }; };
  return {
    key: t.key, summary: t.summary || "", jiraUrl: t.jiraUrl || "", jiraStatus: t.jiraStatus || "", reporter: t.reporter?.name || "", updatedAt: t.updatedAt || null,
    reviewState: t.review?.state || "none", verdict: t.reviewData?.verdict || "", reviewedAt: t.reviewData?.reviewedAt || null, postedAt: t.posted?.at || null, postedVerdict: t.posted?.verdict || "",
    bytes: JSON.stringify(t).length,
    prs: AREAS.filter(a => t.prs?.[a]?.number).map(a => ({ area: a, number: t.prs[a].number, url: t.prs[a].url, repo: t.prs[a].repo, state: t.prs[a].state })),
    perPr: (t.reviewData?.perPr || []).map(p => ({ area: p.area, number: p.number, url: p.url, verdict: p.verdict, verdictReason: p.verdictReason || "", whatChanged: cap(p.whatChanged || "", 400), ...n(p) })),
  };
};
const view = () => ({ jiraSite: config.jiraSite, outlookConfigured: !!team?.leaveAvailable(), archive: Object.values(state.tickets).filter(t => t.closed).map(archiveItem).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))), dataBytes: (() => { try { return statSync(DATA_FILE).size; } catch { return 0; } })(), settings: state.settings, nextRunAt: nextScheduledRun(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, lastSyncAt: state.lastSyncAt, syncing: state.syncing, syncError: state.syncError, repos: config.repos, approveAssignee: config.approveAssignee, jiraStatus: config.jiraStatus, worklogDefault: Number(config.worklogMinutes) > 0 ? Number(config.worklogMinutes) : 10, devStatuses: Array.isArray(config.devStatuses) ? config.devStatuses : [], devScope: config.devScope || "mine", requireTestsAreas: config.requireTestsAreas || ["api"], jiraConfigured: !!(env.JIRA_EMAIL && env.JIRA_API_TOKEN), tickets: Object.values(state.tickets).filter(t => !t.closed).sort((a, b) => a.key.localeCompare(b.key)) });
const KEY = "([A-Z][A-Z0-9]+-\\d+)";

http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host)) { res.writeHead(403); return res.end("forbidden"); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(HERE, "index.html"))); }
    if (req.method === "GET" && url.pathname === "/api/me") {
      let name = "";
      try { name = (myJira ||= (await jira("/rest/api/3/myself")).displayName || ""); } catch { /* not configured */ }
      return sendJson(res, 200, { name });
    }
    let pv;
    if (req.method === "GET" && (pv = new RegExp(`^/api/preview/${KEY}$`).exec(url.pathname))) {
      const t = state.tickets[pv[1]], area = url.searchParams.get("area");
      const pp = t?.reviewData?.perPr?.find(x => x.area === area), pr = t?.prs?.[area];
      if (!pp || !pr) return sendJson(res, 404, { error: "Run the AI review first" });
      const verdict = url.searchParams.get("verdict") === "approve" ? "approve" : "request_changes";
      const github = mdReview(pv[1], t.reviewData, pp, verdict) + mdLead(t.reviewData) + `\n\n<sub>Reviewed at \`${(t.reviewData.headShas?.[area] || "").slice(0, 7)}\` with Code Review Bot (rules ${t.reviewData.rubric || "v0"}). Reply on this PR to discuss; I will read your answers.</sub>`;
      const jiraText = await jiraTemplateText({ key: pv[1], area, pr: { ...pr, number: pp.number, url: pp.url || pr.url, title: pp.title || pr.title }, pp, verdict, reviewUrl: pr.url, lead: t.reviewData });
      return sendJson(res, 200, { verdict, github, jira: jiraText });
    }
    if (req.method === "GET" && url.pathname === "/api/team") {
      const q = url.searchParams;
      return sendJson(res, 200, await team.get({ range: q.get("range") || "week", from: q.get("from") || "", to: q.get("to") || "", types: (q.get("types") || "").split(",").filter(Boolean), bucket: q.get("bucket") === "weekly" ? "weekly" : "daily", refresh: q.get("refresh") === "1" }));
    }
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, view());
    if (req.method !== "POST" || req.headers["x-review-bot"] !== "1") return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    if (url.pathname === "/api/sync") { syncNow(); return sendJson(res, 202, { ok: true }); }
    if (url.pathname === "/api/settings") {
      if (body.worklog) {
        const mins = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(480, Math.max(1, n)) : 10; };
        state.settings.worklog = { enabled: body.worklog.enabled !== false, approveMinutes: mins(body.worklog.approveMinutes), changesMinutes: mins(body.worklog.changesMinutes) };
        save(); return sendJson(res, 200, { ok: true });
      }
      const sc = body.schedule || {};
      const times = [...new Set((Array.isArray(sc.times) ? sc.times : []).map(x => String(x).trim()).filter(x => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)))].sort().slice(0, 24);
      state.settings.schedule = { enabled: sc.enabled === true, times, lastFired: state.settings.schedule?.lastFired || "" };
      save(); return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/team/members") {
      if (body.add) return sendJson(res, 200, { ok: true, member: await team.addMember(body.add.query) });
      if (body.remove) { team.removeMember(String(body.remove.id || "")); return sendJson(res, 200, { ok: true }); }
      if (body.email) return sendJson(res, 200, { ok: true, member: team.setEmail(String(body.email.id || ""), body.email.value) });
      return sendJson(res, 400, { error: "nothing to do" });
    }
    if (url.pathname === "/api/team/outlook-test") return sendJson(res, 200, await team.testLeave());
    let m;
    if ((m = new RegExp(`^/api/review/${KEY}$`).exec(url.pathname))) { if (state.tickets[m[1]]?.review?.state === "running") return sendJson(res, 409, { error: "already running" }); reviewTicket(m[1]); return sendJson(res, 202, { ok: true }); }
    if (url.pathname === "/api/archive/clear") {
      // Only tickets that already left the review status can be cleared; open tickets are never touched.
      const keys = body.all === true ? Object.values(state.tickets).filter(t => t.closed).map(t => t.key) : (Array.isArray(body.keys) ? body.keys : []).filter(k => state.tickets[k]?.closed);
      for (const k of keys) delete state.tickets[k];
      save(); return sendJson(res, 200, { ok: true, removed: keys.length });
    }
    if ((m = new RegExp(`^/api/reset/${KEY}$`).exec(url.pathname))) { resetDraft(m[1]); return sendJson(res, 200, { ok: true }); }
    if ((m = new RegExp(`^/api/post/${KEY}$`).exec(url.pathname))) return sendJson(res, 200, await postTicket(m[1], body.verdict));
    if ((m = new RegExp(`^/api/threads/${KEY}$`).exec(url.pathname))) {
      const t = state.tickets[m[1]]; if (!t) return sendJson(res, 404, { error: "unknown ticket" });
      t.threads = t.threads || {};
      for (const a of AREAS) if (t.prs?.[a]?.number) t.threads[a] = await fetchThread(t.prs[a]);
      save(); return sendJson(res, 200, { ok: true });
    }
    if ((m = new RegExp(`^/api/pr-action/${KEY}$`).exec(url.pathname))) return sendJson(res, 200, await prAction(m[1], body));
    sendJson(res, 404, { error: "not found" });
  } catch (e) { sendJson(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, "127.0.0.1", () => console.log(`Code Review Bot: http://localhost:${PORT}`)); // eslint-disable-line no-console

// ---------- Scheduled sync: runs at the times set in Settings (server local time) ----------
const pad2 = n => String(n).padStart(2, "0");
function nextScheduledRun() {
  const sc = state.settings.schedule;
  if (!sc?.enabled || !sc.times?.length) return null;
  const n = new Date();
  for (let d = 0; d < 2; d++) for (const tm of sc.times) {
    const [h, m] = tm.split(":").map(Number), c = new Date(n.getFullYear(), n.getMonth(), n.getDate() + d, h, m, 0, 0);
    if (c > n) return c.toISOString();
  }
  return null;
}
function schedulerTick() {
  const sc = state.settings.schedule;
  if (!sc?.enabled || !sc.times?.length) return;
  const n = new Date(), hm = pad2(n.getHours()) + ":" + pad2(n.getMinutes()), slot = n.toDateString() + " " + hm;
  if (!sc.times.includes(hm) || sc.lastFired === slot) return;
  sc.lastFired = slot; save();
  if (!state.syncing) syncNow();
}
setInterval(schedulerTick, 20 * 1000);
