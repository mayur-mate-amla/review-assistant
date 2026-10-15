// Team dashboard: what the team is working on, who is under-logging, velocity, bugs, breaking changes and leave.
// Pure aggregation (aggregate, parseLeaveEmails, rangeFor, ...) is separate from the Jira fetchers so it can be tested with fixtures.

const DAY = 864e5, STALE_DAYS = 14, HOURS_PER_DAY = 8;
export const TYPES = ["Story", "Bug", "Task", "Sub-task"];

// ---------- dates (server local time zone) ----------
export const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const endOfDay = d => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const weekStart = d => { const x = startOfDay(d), k = (x.getDay() + 6) % 7; return addDays(x, -k); }; // Monday
const p2 = n => String(n).padStart(2, "0");
export const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; };
const parseDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const cap = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export function rangeFor(range, from, to, nowD = new Date()) {
  const t = startOfDay(nowD);
  if (range === "lastweek") { const s = addDays(weekStart(t), -7); return { key: "lastweek", label: "Last week", from: s, to: endOfDay(addDays(s, 6)) }; }
  if (range === "sprint") return { key: "sprint", label: "The last 14 days", from: addDays(t, -13), to: endOfDay(t) };
  if (range === "custom") {
    const a = parseDay(from), b = parseDay(to);
    if (a && b && a <= b && (b - a) / DAY <= 366) return { key: "custom", label: "In this period", from: a, to: endOfDay(b) };
  }
  const s = weekStart(t);
  return { key: "week", label: "This week", from: s, to: endOfDay(addDays(s, 6)) };
}

export function typeOf(f) {
  const it = f?.issuetype || {};
  if (it.subtask) return "Sub-task";
  const n = String(it.name || "");
  return TYPES.includes(n) ? n : (/bug|defect/i.test(n) ? "Bug" : /story/i.test(n) ? "Story" : /sub/i.test(n) ? "Sub-task" : /task/i.test(n) ? "Task" : "Other");
}

export function stageOf(status, cat) {
  const s = String(status || "");
  if (cat === "done") return "done";
  if (/hold|block|defer|impediment/i.test(s)) return "hold";
  if (/backlog/i.test(s)) return "backlog";
  if (/review/i.test(s)) return "review";
  if (/qa|test|uat|verif|deploy|release/i.test(s)) return "qa";
  return cat === "new" ? "todo" : "active";
}
const hours = sec => Math.round((sec / 3600) * 10) / 10;
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------- leave from the "<Team> - <Name> - OOO was created on Amla India Holiday/Leave Calendar" emails ----------
const SUBJECT_RE = /^(?:(\S+)\s+-\s+)?(.+?)\s+-\s+(.+?)\s+was\s+(created|updated|deleted|cancell?ed)\s+on\b/i;
const WHEN_RE = /When:\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+ \d{1,2}, \d{4}),?\s*(\d{1,2}:\d{2} [AP]M)\s*to\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+ \d{1,2}, \d{4}),?\s*(\d{1,2}:\d{2} [AP]M)/i;

function memberByShortName(name, members) {
  const t = norm(name).split(" ").filter(Boolean); if (t.length < 2) return null;
  const first = t[0], last = t[t.length - 1];
  const hits = members.filter(m => { const mt = norm(m.name).split(" ").filter(Boolean); return mt.length >= 2 && mt[0] === first && mt.slice(1).some(x => x === last || (last.length === 1 && x.startsWith(last))); });
  return hits.length === 1 ? hits[0] : null;
}

export function mergeMemberLeave(parsed, memberLeave, members) {
  const byEmail = new Map(members.map(m => [String(m.email || "").toLowerCase(), m]));
  for (const x of memberLeave || []) {
    const m = byEmail.get(String(x.email || "").toLowerCase()); if (!m) continue;
    const list = (parsed.byId[m.accountId] ||= []);
    if (list.some(e => e.start === x.start && e.end === x.end)) continue;
    list.push({ start: x.start, end: x.end, type: x.type, half: x.type === "Half day", via: "email" });
    list.sort((a, b) => a.start.localeCompare(b.start));
  }
  return parsed;
}

export function parseLeaveEmails(emails, members) {
  const byId = {}, perKey = new Map(); let unmatched = 0, unreadable = 0;
  const ordered = [...(emails || [])].sort((a, b) => String(a.received).localeCompare(String(b.received)));
  for (const e of ordered) {
    const sm = SUBJECT_RE.exec(String(e.subject || "")); if (!sm) continue;
    const m = memberByShortName(sm[2], members); if (!m) { unmatched++; continue; }
    const wm = WHEN_RE.exec(String(e.summary || "")); if (!wm) { unreadable++; continue; }
    const a = new Date(wm[1] + " " + wm[2]), b = new Date(wm[3] + " " + wm[4]);
    if (isNaN(a) || isNaN(b)) { unreadable++; continue; }
    const start = startOfDay(a); let end = startOfDay(b);
    if (/^12:00 AM$/i.test(wm[4]) && end > start) end = addDays(end, -1); // the calendar end is exclusive at midnight
    const half = /half/i.test(sm[3]);
    const key = m.accountId + "|" + dayKey(start);
    if (/^(deleted|cancel)/i.test(sm[4])) perKey.delete(key);
    else perKey.set(key, { id: m.accountId, start: dayKey(start), end: dayKey(end), type: half ? "Half day" : /sick|medical/i.test(sm[3]) ? "Sick" : "Leave", half });
  }
  for (const v of perKey.values()) (byId[v.id] ||= []).push({ start: v.start, end: v.end, type: v.type, half: v.half });
  for (const k of Object.keys(byId)) byId[k].sort((x, y) => x.start.localeCompare(y.start));
  return { byId, unmatched, unreadable };
}

// working days (Mon-Fri) in [from, to] minus leave days
function workdays(from, to, events) {
  let days = 0, leaveDays = 0;
  for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const k = dayKey(d), ev = (events || []).find(e => e.start <= k && e.end >= k);
    days++; if (ev) leaveDays += ev.half ? 0.5 : 1;
  }
  return { days, leaveDays, expected: Math.max(0, days - leaveDays) * HOURS_PER_DAY };
}

// ---------- aggregation ----------
// issues: [{ key, summary, type, status, statusCat, done, inReview, assigneeId, resolved, created, updated, parent }]
// worklogs: [{ key, authorId, started, seconds }]
// metrics: { KEY: { reviewedAt, prs: [{ area, number, url, authorName, items: [] }] } }
// leave: { byId: { accountId: [{ start, end, type, half }] } }
export function aggregate({ members, issues, worklogs, metrics, leave, range, bucket = "daily", types = [], now = new Date() }) {
  const want = new Set(types.filter(x => TYPES.includes(x)));
  const typeOk = t => !want.size || want.has(t);
  const R = { from: range.from, to: range.to };
  const inRange = iso => { if (!iso) return false; const d = new Date(iso); return d >= R.from && d <= R.to; };
  const iss = new Map(issues.map(i => [i.key, i]));
  const per = new Map(members.map(m => [m.accountId, { m, assigned: 0, open: 0, closed: 0, active: 0, inReview: 0, todo: 0, stale: 0, seconds: 0, breaking: 0, bugsOpen: 0, tickets: new Map(), closedList: [], working: [], staleList: [], lastLogged: null, loggedDays: new Set(), qa: 0, hold: 0, backlog: 0 }]));
  const staleCut = now.getTime() - STALE_DAYS * DAY;

  const buckets = [];
  if (bucket === "weekly") {
    for (let w = weekStart(R.from); w <= R.to && buckets.length < 30; w = addDays(w, 7)) buckets.push({ key: dayKey(w), label: `${MON[w.getMonth()]} ${w.getDate()}`, start: w, end: endOfDay(addDays(w, 6)) });
  } else {
    for (let d = startOfDay(R.from); d <= R.to && buckets.length < 62; d = addDays(d, 1)) buckets.push({ key: dayKey(d), label: `${DOW[d.getDay()]} ${d.getDate()}`, start: d, end: endOfDay(d) });
  }
  const chart = buckets.map(b => ({ key: b.key, label: b.label, Story: 0, Bug: 0, Task: 0, "Sub-task": 0, Other: 0, total: 0 }));
  const bucketIndex = iso => { const d = new Date(iso); return buckets.findIndex(b => d >= b.start && d <= b.end); };
  const weeks = []; for (let i = 5; i >= 0; i--) { const w = addDays(weekStart(now), -7 * i); weeks.push({ key: dayKey(w), label: `${MON[w.getMonth()]} ${w.getDate()}`, start: w, end: endOfDay(addDays(w, 6)) }); }
  const matrix = new Map(members.map(m => [m.accountId, weeks.map(() => 0)]));

  let closedTotal = 0, openBugs = 0, bugsCreated = 0, bugsClosed = 0;
  for (const i of issues) {
    const m = per.get(i.assigneeId); if (!m) continue;
    if (i.type === "Bug" && !i.done) { openBugs++; m.bugsOpen++; }
    if (i.type === "Bug" && inRange(i.created)) bugsCreated++;
    if (i.type === "Bug" && i.done && inRange(i.resolved)) bugsClosed++;
    if (i.done && i.resolved && typeOk(i.type)) { const wi = weeks.findIndex(w => new Date(i.resolved) >= w.start && new Date(i.resolved) <= w.end); if (wi >= 0) matrix.get(i.assigneeId)[wi]++; }
    if (!typeOk(i.type)) continue;
    if (!i.done) {
      m.open++; m.assigned++;
      const idle = i.updated ? Math.floor((now.getTime() - new Date(i.updated).getTime()) / DAY) : null;
      const row = { key: i.key, summary: i.summary, type: i.type, status: i.status, parent: i.parent || "", updated: i.updated || null, idleDays: idle };
      const stg = i.stage || stageOf(i.status, i.statusCat);
      if (stg === "review") m.inReview++; else if (stg === "qa") m.qa++; else if (stg === "hold") m.hold++; else if (stg === "backlog") m.backlog++; else if (stg === "todo") m.todo++; else { m.active++; m.working.push(row); }
      // stale = work the developer owns (in progress, in review, ready for dev) that nobody has touched; backlog, QA and on-hold tickets wait on others
      if (["active", "review", "todo"].includes(stg) && i.updated && new Date(i.updated).getTime() < staleCut) { m.stale++; m.staleList.push(row); }
    } else if (inRange(i.resolved)) {
      m.closed++; m.assigned++; closedTotal++;
      m.closedList.push({ key: i.key, summary: i.summary, type: i.type, resolved: i.resolved });
      const bi = bucketIndex(i.resolved); if (bi >= 0) { chart[bi][i.type in chart[bi] ? i.type : "Other"]++; chart[bi].total++; }
    }
  }

  let secondsTotal = 0;
  for (const w of worklogs) {
    const m = per.get(w.authorId); if (!m || !inRange(w.started)) continue;
    const i = iss.get(w.key) || { key: w.key, summary: "", type: "Other", status: "", parent: "" };
    if (!typeOk(i.type)) continue;
    m.seconds += w.seconds; secondsTotal += w.seconds;
    if (!m.lastLogged || w.started > m.lastLogged) m.lastLogged = w.started;
    m.loggedDays.add(dayKey(w.started));
    const t = m.tickets.get(w.key) || { key: w.key, summary: i.summary, type: i.type, status: i.status, parent: i.parent || "", seconds: 0 };
    t.seconds += w.seconds; m.tickets.set(w.key, t);
  }

  // breaking changes: credited to the PR author when the name matches a member
  const nameIndex = members.map(m => ({ m, n: norm(m.name) })).filter(x => x.n);
  const breakingList = []; let breakingTotal = 0, reviewedTickets = 0;
  for (const [key, mt] of Object.entries(metrics || {})) {
    if (!inRange(mt.reviewedAt)) continue;
    reviewedTickets++;
    for (const pr of mt.prs || []) {
      const n = (pr.items || []).length; if (!n) continue;
      const a = norm(pr.authorName || pr.author), hit = nameIndex.find(x => x.n === a || (a && (x.n.includes(a) || a.includes(x.n))));
      if (!hit && members.length) continue;
      breakingTotal += n; const m = hit && per.get(hit.m.accountId); if (m) m.breaking += n;
      breakingList.push({ key, area: pr.area, number: pr.number, url: pr.url || "", member: hit ? hit.m.name : "", items: pr.items.slice(0, 5), count: n });
    }
  }

  // leave
  const today = startOfDay(now), tk = dayKey(today), horizon = dayKey(addDays(today, 7));
  const leaveList = []; let onLeaveToday = 0, expectedTotal = 0;
  const rows = members.map(m => {
    const x = per.get(m.accountId), all = leave?.byId?.[m.accountId] || [];
    const upcoming = all.filter(e => e.end >= tk && e.start <= horizon);
    const onNow = upcoming.find(e => e.start <= tk && e.end >= tk);
    if (onNow && !onNow.half) onLeaveToday++;
    for (const e of upcoming) leaveList.push({ name: m.name, start: e.start, end: e.end, type: e.type, today: e.start <= tk && e.end >= tk });
    const cutoff = now.getHours() >= 18 ? now : new Date(startOfDay(now).getTime() - 1);
    const to = R.to < cutoff ? R.to : cutoff;
    const wd = to >= R.from ? workdays(R.from, to, all) : { days: 0, leaveDays: 0, expected: 0 };
    expectedTotal += wd.expected;
    const logged = hours(x.seconds), util = wd.expected ? Math.round((logged / wd.expected) * 100) : null;
    const daysSinceLog = x.lastLogged ? Math.floor((today - startOfDay(x.lastLogged)) / DAY) : null;
    const row = {
      id: m.id, name: m.name, email: m.email, accountId: m.accountId,
      assigned: x.assigned, open: x.open, closed: x.closed, active: x.active, inReview: x.inReview, qa: x.qa, hold: x.hold, backlog: x.backlog, todo: x.todo, stale: x.stale,
      hours: logged, expected: wd.expected, utilization: util, lastLogged: x.lastLogged, daysSinceLog, loggedDays: x.loggedDays.size,
      breaking: x.breaking, bugsOpen: x.bugsOpen, onLeave: !!(onNow && !onNow.half), halfDay: !!(onNow && onNow.half), leave: upcoming,
      working: x.working.sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 6),
      staleList: x.staleList.sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0)).slice(0, 12),
      tickets: [...x.tickets.values()].sort((a, b) => b.seconds - a.seconds).map(t => ({ key: t.key, summary: t.summary, type: t.type, status: t.status, parent: t.parent, hours: hours(t.seconds), share: Math.round((t.seconds / (x.seconds || 1)) * 100) })),
      closedList: x.closedList.sort((a, b) => String(b.resolved).localeCompare(String(a.resolved))).slice(0, 100),
      weekly: matrix.get(m.accountId),
    };
    row.flags = flagsFor(row, wd, range);
    return row;
  });
  leaveList.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
  const attention = [];
  for (const r of rows) for (const f of r.flags) attention.push({ member: r.name, id: r.id, level: f.level, text: f.text });
  attention.sort((a, b) => (a.level === b.level ? 0 : a.level === "bad" ? -1 : 1));

  const out = {
    range: { key: range.key, label: range.label, from: dayKey(R.from), to: dayKey(R.to) }, bucket, types: [...want],
    totals: { active: rows.reduce((n, r) => n + r.active, 0), inReview: rows.reduce((n, r) => n + r.inReview, 0), qa: rows.reduce((n, r) => n + r.qa, 0), stale: rows.reduce((n, r) => n + r.stale, 0), open: rows.reduce((n, r) => n + r.open, 0), closed: closedTotal, breaking: breakingTotal, hours: hours(secondsTotal), expected: expectedTotal, openBugs, bugsCreated, bugsClosed, onLeave: onLeaveToday, members: members.length, reviewedTickets, attention: attention.length },
    chart, weeks: weeks.map(w => ({ key: w.key, label: w.label })), members: rows, breaking: breakingList.slice(0, 50), leave: leaveList, attention,
  };
  out.headline = headline(out);
  return out;
}

// Plain-language problems for one member. "bad" needs action today, "warn" is worth a look.
function flagsFor(r, wd, range) {
  const f = [];
  if (r.onLeave) return f; // nothing to chase while someone is away
  const elapsed = wd.days - wd.leaveDays;
  if (r.todo > 0 && r.active === 0 && r.inReview === 0) f.push({ level: "warn", text: `Nothing in progress: ${r.todo} ticket${r.todo === 1 ? "" : "s"} ready for dev, none started` });
  if (r.active > 4) f.push({ level: "warn", text: `${r.active} tickets in progress at the same time` });
  if (wd.expected >= 8) {
    if (r.hours === 0) f.push({ level: elapsed >= 2 ? "bad" : "warn", text: `No time logged in Jira (${wd.expected} h expected)` });
    else if (r.utilization != null && r.utilization < 60) f.push({ level: "warn", text: `Logged ${r.hours} h of ${wd.expected} h expected (${r.utilization}%)` });
    if (r.daysSinceLog != null && r.daysSinceLog >= 3 && r.utilization != null && r.utilization >= 60 && range.key !== "lastweek") f.push({ level: "warn", text: `Last time logged ${r.daysSinceLog} days ago` });
  }
  if (r.stale >= 8) f.push({ level: "warn", text: `${r.stale} open tickets untouched for ${STALE_DAYS}+ days` });
  if (r.bugsOpen >= 15) f.push({ level: "warn", text: `${r.bugsOpen} open bugs assigned` });
  if (r.breaking) f.push({ level: "warn", text: `${r.breaking} breaking change${r.breaking === 1 ? "" : "s"} in their PRs this period` });
  return f;
}

export function headline(o) {
  const t = o.totals, pl = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const first = o.range.key === "week" ? "This week" : o.range.key === "lastweek" ? "Last week" : "In this period";
  const att = t.attention ? ` ${pl(t.attention, "thing")} need${t.attention === 1 ? "s" : ""} attention.` : " Nothing needs attention.";
  return `${first} the team closed ${pl(t.closed, "ticket")} and logged ${t.hours} h of ${t.expected} h expected. ${pl(t.active, "ticket")} ${t.active === 1 ? "is" : "are"} in progress, ${t.breaking} breaking ${t.breaking === 1 ? "change" : "changes"} raised, ${pl(t.onLeave, "member")} on leave today.${att}`;
}

// ---------- breaking-change snapshot (called when a review finishes) ----------
export function breakingSnapshot(t) {
  const perPr = t?.reviewData?.perPr || [];
  return { reviewedAt: t?.reviewData?.reviewedAt || null, breaking: perPr.reduce((n, p) => n + (p.breakingChanges || []).length, 0), prs: perPr.map(p => ({ area: p.area, number: p.number, url: p.url || "", authorName: t.prs?.[p.area]?.authorName || t.prs?.[p.area]?.author || "", items: (p.breakingChanges || []).slice(0, 8).map(x => String(x).slice(0, 300)) })) };
}

// ---------- service ----------
// fetchLeaveEmails: async () => [{ subject, received, summary }]  (provided by server.mjs; reads Outlook through the Claude Microsoft 365 connector)
export function createTeam({ jira, state, save, now = () => new Date(), fetchLeaveEmails = null, fetchMemberLeave = null }) {
  const t = () => (state.team ||= { members: [], metrics: {} });
  const cache = new Map(), wlCache = new Map();
  let leaveBusy = false, leaveError = "", memberLeaveError = "";

  async function searchAll(jql, fields, max = 800) {
    const out = []; let next = "";
    for (let page = 0; page < 16 && out.length < max; page++) {
      const r = await jira(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=100${next ? "&nextPageToken=" + encodeURIComponent(next) : ""}`);
      out.push(...(r.issues || [])); next = r.nextPageToken || ""; if (r.isLast || !next) break;
    }
    return out;
  }
  const toIssue = i => {
    const f = i.fields || {}, cat = f.status?.statusCategory?.key || "", st = f.status?.name || "";
    return { key: i.key, summary: f.summary || "", type: typeOf(f), status: st, statusCat: cat, done: cat === "done", stage: stageOf(st, cat), assigneeId: f.assignee?.accountId || "", resolved: f.resolutiondate || null, created: f.created || null, updated: f.updated || null, parent: f.parent?.key || "" };
  };
  async function worklogsFor(key, updated, from) {
    const hit = wlCache.get(key);
    if (hit && hit.updated === updated && hit.from <= from) return hit.logs;
    const logs = []; let startAt = 0;
    for (let page = 0; page < 10; page++) {
      const r = await jira(`/rest/api/3/issue/${key}/worklog?startAt=${startAt}&maxResults=1000&startedAfter=${from}`);
      for (const w of r.worklogs || []) logs.push({ key, authorId: w.author?.accountId || "", started: w.started, seconds: w.timeSpentSeconds || 0 });
      startAt += (r.worklogs || []).length; if (startAt >= (r.total || 0) || !(r.worklogs || []).length) break;
    }
    wlCache.set(key, { updated, from, logs });
    return logs;
  }
  async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

  const lc = () => (t().leaveCache ||= { at: 0, emails: [] });
  async function refreshLeave() {
    if (!fetchLeaveEmails) throw new Error("Leave is not available: the Claude Microsoft 365 connector is not set up.");
    const [emails, mine] = await Promise.all([fetchLeaveEmails(), fetchMemberLeave ? fetchMemberLeave(t().members).catch(e => { memberLeaveError = String(e.message || e).slice(0, 160); return null; }) : Promise.resolve(null)]);
    if (mine) { lc().member = mine; memberLeaveError = ""; }
    lc().emails = (emails || []).slice(0, 500).map(e => ({ subject: String(e.subject || "").slice(0, 200), received: String(e.received || ""), summary: cap(e.summary, 700) }));
    lc().at = Date.now(); save(); cache.clear();
    return lc().emails.length;
  }
  function kickLeave(force) {
    if (!fetchLeaveEmails || leaveBusy) return;
    if (!force && Date.now() - lc().at < 6 * 3600e3) return;
    leaveBusy = true; leaveError = "";
    refreshLeave().catch(e => { leaveError = String(e.message || e).slice(0, 200); }).finally(() => { leaveBusy = false; cache.clear(); });
  }

  return {
    members: () => t().members,
    async addMember(query) {
      query = String(query || "").trim();
      if (query.length < 2) throw new Error("Enter a name or email.");
      const users = (await jira(`/rest/api/3/user/search?query=${encodeURIComponent(query)}`)).filter(u => u.accountType !== "app" && u.active !== false);
      const exact = users.filter(u => (u.emailAddress || "").toLowerCase() === query.toLowerCase() || (u.displayName || "").toLowerCase() === query.toLowerCase());
      const pick = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : null;
      if (!pick) throw new Error(users.length ? `Several Jira users match "${query}": ${users.slice(0, 5).map(u => u.displayName).join(", ")}. Use the full email.` : `No Jira user found for "${query}".`);
      if (t().members.some(m => m.accountId === pick.accountId)) throw new Error(`${pick.displayName} is already in the team.`);
      const m = { id: pick.accountId.slice(-10) + Date.now().toString(36), name: pick.displayName, email: pick.emailAddress || (query.includes("@") ? query : ""), accountId: pick.accountId };
      t().members.push(m); save(); cache.clear();
      return m;
    },
    removeMember(id) {
      const n = t().members.length; t().members = t().members.filter(m => m.id !== id);
      if (t().members.length === n) throw new Error("Member not found.");
      save(); cache.clear();
    },
    snapshot(ticket) { if (!ticket?.reviewData) return; t().metrics[ticket.key] = breakingSnapshot(ticket); },
    backfill() { for (const tk of Object.values(state.tickets || {})) if (tk.reviewData && !t().metrics[tk.key]) t().metrics[tk.key] = breakingSnapshot(tk); },
    leaveAvailable: () => !!fetchLeaveEmails,
    async testLeave() {
      const n = await refreshLeave(), p = mergeMemberLeave(parseLeaveEmails(lc().emails, t().members), lc().member, t().members), matched = Object.values(p.byId).reduce((a, v) => a + v.length, 0);
      return { ok: true, message: `Read ${n} calendar notification${n === 1 ? "" : "s"} and ${(lc().member || []).length} leave email${(lc().member || []).length === 1 ? "" : "s"} sent by members. ${matched} leave entr${matched === 1 ? "y" : "ies"} matched your team${p.unmatched ? `, ${p.unmatched} belong to people who are not in the team` : ""}.` };
    },
    async get({ range = "week", from, to, types = [], bucket = "daily", refresh = false } = {}) {
      this.backfill();
      const members = t().members, rng = rangeFor(range, from, to, now());
      kickLeave(refresh);
      const ck = JSON.stringify([range, from, to, types, bucket, members.map(m => m.accountId), lc().at]);
      const hit = cache.get(ck);
      const status = () => ({ configured: !!fetchLeaveEmails, source: "Outlook (Claude Microsoft 365 connector)", fetchedAt: lc().at ? new Date(lc().at).toISOString() : null, refreshing: leaveBusy, error: [leaveError, memberLeaveError].filter(Boolean).join("; "), memberEmails: (lc().member || []).length });
      if (!refresh && hit && Date.now() - hit.at < 5 * 60000) return { ...hit.v, leaveStatus: { ...status(), unmatched: hit.v.leaveStatus?.unmatched || 0, unreadable: hit.v.leaveStatus?.unreadable || 0 }, cached: true, updatedAt: new Date(hit.at).toISOString() };
      if (!members.length) return { empty: true, members: [], totals: {}, chart: [], weeks: [], breaking: [], leave: [], attention: [], range: { key: rng.key, label: rng.label, from: dayKey(rng.from), to: dayKey(rng.to) }, headline: "", leaveStatus: status(), updatedAt: new Date().toISOString() };
      const ids = members.map(m => `"${m.accountId}"`).join(", ");
      const since = dayKey(new Date(Math.min(rng.from.getTime(), addDays(weekStart(now()), -35).getTime())));
      const warnings = [];
      const issues = (await searchAll(`assignee in (${ids}) AND (statusCategory != Done OR resolutiondate >= "${since}") ORDER BY updated DESC`, "summary,issuetype,status,assignee,resolutiondate,created,updated,parent")).map(toIssue);
      let worklogs = [];
      try {
        const wlIssues = await searchAll(`worklogAuthor in (${ids}) AND worklogDate >= "${dayKey(rng.from)}" AND worklogDate <= "${dayKey(rng.to)}"`, "summary,issuetype,status,parent,updated");
        const byKey = new Map(issues.map(i => [i.key, i]));
        for (const i of wlIssues) if (!byKey.has(i.key)) { const x = toIssue(i); x.assigneeId = ""; issues.push(x); }
        const upd = new Map(wlIssues.map(i => [i.key, i.fields?.updated || ""]));
        const fromMs = rng.from.getTime() - DAY;
        worklogs = (await pool(wlIssues, 5, i => worklogsFor(i.key, upd.get(i.key), fromMs).catch(e => { warnings.push(`Work log for ${i.key}: ${e.message}`); return []; }))).flat();
      } catch (e) { warnings.push(`Work logs could not be read: ${e.message}`); }
      const parsed = mergeMemberLeave(parseLeaveEmails(lc().emails, members), lc().member, members);
      const out = aggregate({ members, issues, worklogs, metrics: t().metrics, leave: { byId: parsed.byId }, range: rng, bucket, types, now: now() });
      out.leaveStatus = { ...status(), unmatched: parsed.unmatched, unreadable: parsed.unreadable };
      out.warnings = warnings.slice(0, 5); out.updatedAt = new Date().toISOString();
      cache.set(ck, { at: Date.now(), v: out });
      return out;
    },
  };
}
