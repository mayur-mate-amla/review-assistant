#!/usr/bin/env node
// Optional Jira fallback for the Magicians team review plugin.
// Used only when the Atlassian connector cannot reach the Jira site (for example "The app is not installed on this instance").
// Needs three environment variables in the developer's own shell (never stored by the plugin):
//   JIRA_EMAIL, JIRA_API_TOKEN  (https://id.atlassian.com/manage-profile/security/api-tokens)   and optionally JIRA_SITE (default amla.atlassian.net)
// Usage:
//   node jira.mjs whoami
//   node jira.mjs get KEY
//   node jira.mjs previous-assignee KEY
//   node jira.mjs comment KEY            (comment text on stdin)
//   node jira.mjs assign KEY "name or email"
//   node jira.mjs transition KEY "Code Review"
//   node jira.mjs worklog KEY 10         (minutes; description on stdin)
const SITE = process.env.JIRA_SITE || "amla.atlassian.net";
const EMAIL = process.env.JIRA_EMAIL, TOKEN = process.env.JIRA_API_TOKEN;
if (!EMAIL || !TOKEN) { console.error("JIRA_EMAIL and JIRA_API_TOKEN are not set in this shell. Set them for this terminal session only, or paste the ticket text instead."); process.exit(2); }

async function jira(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://${SITE}${path}`, { method, headers: { Authorization: "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64"), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) { console.error(`Jira ${res.status}: ${text.slice(0, 300)}`); process.exit(1); }
  return text ? JSON.parse(text) : {};
}
const stdin = () => new Promise(r => { let b = ""; process.stdin.on("data", d => b += d); process.stdin.on("end", () => r(b.trim())); if (process.stdin.isTTY) r(""); });
const adfText = n => !n ? "" : n.type === "text" ? (n.text || "") : (n.content || []).map(adfText).join(["paragraph", "heading", "listItem"].includes(n.type) ? "" : "") + (["paragraph", "heading", "listItem", "tableRow"].includes(n.type) ? "\n" : "");
const adf = text => ({ type: "doc", version: 1, content: String(text).split(/\n{2,}/).filter(Boolean).map(p => ({ type: "paragraph", content: p.split("\n").flatMap((l, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(l ? [{ type: "text", text: l }] : [])]) })) });
async function userByQuery(q) {
  const users = (await jira(`/rest/api/3/user/search?query=${encodeURIComponent(q)}`)).filter(u => u.accountType !== "app" && u.active !== false);
  const exact = users.filter(u => (u.emailAddress || "").toLowerCase() === q.toLowerCase() || (u.displayName || "").toLowerCase() === q.toLowerCase());
  const pick = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : null;
  if (!pick) { console.error(users.length ? `Several Jira users match "${q}": ${users.slice(0, 5).map(u => u.displayName).join(", ")}` : `No Jira user found for "${q}".`); process.exit(1); }
  return pick;
}

const [cmd, key, arg] = process.argv.slice(2);
if (cmd === "whoami") { const me = await jira("/rest/api/3/myself"); console.log(JSON.stringify({ name: me.displayName, email: me.emailAddress, accountId: me.accountId })); }
else if (cmd === "get") {
  const i = await jira(`/rest/api/3/issue/${key}?fields=summary,description,status,assignee,reporter,issuetype,comment`), f = i.fields;
  console.log(JSON.stringify({ key: i.key, summary: f.summary, type: f.issuetype?.name, status: f.status?.name, assignee: f.assignee?.displayName || "", reporter: f.reporter?.displayName || "", description: adfText(f.description).slice(0, 6000), comments: (f.comment?.comments || []).slice(-10).map(c => ({ author: c.author?.displayName, text: adfText(c.body).slice(0, 600) })) }, null, 1));
} else if (cmd === "previous-assignee") {
  const me = await jira("/rest/api/3/myself"); let last = null, startAt = 0;
  for (let p = 0; p < 20; p++) { const r = await jira(`/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`); for (const h of r.values || []) for (const it of h.items || []) if (it.field === "assignee" && it.to === me.accountId && it.from) last = { accountId: it.from, name: it.fromString }; startAt += (r.values || []).length; if (r.isLast || !(r.values || []).length) break; }
  if (!last) { const i = await jira(`/rest/api/3/issue/${key}?fields=reporter`); last = { accountId: i.fields.reporter?.accountId, name: i.fields.reporter?.displayName, via: "reporter" }; }
  console.log(JSON.stringify(last));
} else if (cmd === "comment") { const text = await stdin(); if (!text) { console.error("No comment text on stdin."); process.exit(1); } await jira(`/rest/api/3/issue/${key}/comment`, { method: "POST", body: { body: adf(text) } }); console.log("Comment added to " + key); }
else if (cmd === "assign") { const u = await userByQuery(arg || ""); await jira(`/rest/api/3/issue/${key}/assignee`, { method: "PUT", body: { accountId: u.accountId } }); console.log(`${key} assigned to ${u.displayName}`); }
else if (cmd === "transition") {
  const t = (await jira(`/rest/api/3/issue/${key}/transitions`)).transitions || [], hit = t.find(x => x.name.toLowerCase() === String(arg).toLowerCase() || x.to?.name?.toLowerCase() === String(arg).toLowerCase());
  if (!hit) { console.error(`No transition to "${arg}". Available: ${t.map(x => x.name).join(", ")}`); process.exit(1); }
  await jira(`/rest/api/3/issue/${key}/transitions`, { method: "POST", body: { transition: { id: hit.id } } }); console.log(`${key} moved with "${hit.name}"`);
} else if (cmd === "worklog") {
  const mins = Number(arg); if (!(mins > 0)) { console.error("Give the minutes, for example: worklog KEY 10"); process.exit(1); }
  const text = (await stdin()) || "Code review", d = new Date(), p = n => String(n).padStart(2, "0"), o = -d.getTimezoneOffset(), a = Math.abs(o);
  const started = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000${o < 0 ? "-" : "+"}${p(Math.floor(a / 60))}${p(a % 60)}`;
  await jira(`/rest/api/3/issue/${key}/worklog`, { method: "POST", body: { timeSpentSeconds: mins * 60, started, comment: adf(text) } }); console.log(`${mins} min logged on ${key}`);
} else { console.error("Usage: node jira.mjs whoami | get KEY | previous-assignee KEY | comment KEY | assign KEY \"name\" | transition KEY \"Status\" | worklog KEY MINUTES"); process.exit(1); }
