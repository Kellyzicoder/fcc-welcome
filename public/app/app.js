// FCC Attendance app. Plain JavaScript, no build step: it talks to Supabase's REST and Auth APIs directly.
// What a signed-in person may load is decided by the database (Row Level Security, see supabase/app_setup.sql),
// not by this file: hiding a menu item here is for tidiness, the database is what keeps churches apart.

const RED_AT = 5, YELLOW_AT = 3, ARCHIVE_DAYS = 730;
const AWAY = new Set(["inactive", "moved", "left", "deceased", "transferred", "away"]);
const GONE = new Set(["moved", "left", "deceased", "transferred"]);
// Statuses and what each does, per church (Settings → Statuses): "in" stays on Check-in and Follow-up (a tick makes them Active);
// "out" is off those lists but found by searching Check-in (a tick brings them back); "gone" is off for good (Congregation only)
const STATUS0 = {Away: "in", Inactive: "in", Moved: "in", Left: "out", Transferred: "out", Deceased: "gone"};
const statusRules = (ch = S.church) => ({...STATUS0, ...(S.statusRules?.[ch] || {})});
const ruleOf = m => { const st = String(m.status || "").trim(); if (!st) return "in";
  const r = statusRules(churchOf(m)), k = Object.keys(r).find(x => norm(x) === norm(st)); return k ? r[k] : "in"; };
const ROLE = {admin: "Admin", bishop: "Bishop", lead: "Church admin", team: "Team", pastor: "Pastor"};
const ROLE_OPTS = [["team", "Team (ushers)"], ["pastor", "Pastor (only their own people)"], ["reverend", "Reverend (like a Pastor: only their own people)"], ["shepherd", "Shepherd (like a Pastor: only the people assigned to them)"],
  ["lead", "Church admin (whole church, follow-up)"],
  ["lead_pastor", "Lead pastor (whole church, plus their own people)"],
  ["bishop", "Bishop (numbers only, all churches)"], ["admin", "Admin (everything, all churches)"],
  ["tech_admin", "Tech admin (everything an admin can do; shown as Tech admin)"]];
// A lead pastor is a church admin with the title "Lead pastor" (they also get the Pastor view for their own people).
// A tech admin is an admin with the title "Tech admin": the same rights, but named apart from the church's own admins
// (in the Activity log, Sign-ins and the top bar).
// A shepherd is a pastor sign-in with the title "Shepherd": people are assigned to them the same way, and they see and tick only those.
// Sign-ins sorted by the role people see (Tech admin apart from Admin, Lead pastor apart from Church admin, Shepherd apart from Pastor)
const UKINDS = [["admin", "Admin"], ["lead", "Church admin"], ["pastor", "Pastor"], ["team", "Team (ushers)"], ["tech_admin", "Tech admin"], ["lead_pastor", "Lead pastor"], ["shepherd", "Shepherd"], ["reverend", "Reverend"], ["bishop", "Bishop"]];
// Pastor also lists people who pastor as a second role (an admin or church admin + Pastor, a Lead pastor)
// An admin or church admin's second role: Pastor, or Reverend (saved as role3 = "Reverend"); the same rights either way
const second = u => u?.pastor && ["admin", "lead"].includes(u.role) && u.title !== "Lead pastor" ? (u.role3 === "Reverend" ? "reverend" : "pastor") : "";
const inKind = (u, k) => ukind(u) === k || (k === "pastor" && !!u.pastor && ukind(u) === "lead_pastor") || (!!k && second(u) === k);
const ukind = u => ({"Tech admin": "tech_admin", "Lead pastor": "lead_pastor", "Shepherd": "shepherd", "Reverend": "reverend"})[roleName(u)] || u.role;
// A Reverend is a pastor sign-in titled Reverend: the same rights as a Pastor, just named as a Reverend.
const roleName = u => u?.role === "pastor" && u?.title === "Shepherd" ? "Shepherd" : u?.role === "pastor" && u?.title === "Reverend" ? "Reverend" : u?.role === "lead" && u?.title === "Lead pastor" ? "Lead pastor" : u?.role === "admin" && u?.title === "Tech admin" ? "Tech admin" : ROLE[u?.role] || u?.role || "";
const baseName = () => roleName({role: S.me.base, title: S.me.title});
// What each colour means, in words (the colour alone was hard to read): red and amber are the people to call.
const FLAG = {red: "Needs a call", yellow: "Check in", blue: "Missed this one", ok: "On track"};
const root = document.getElementById("root");
const S = {cfg: null, session: null, me: null, churches: [], church: "", members: [], ticks: [], names: {}, view: "dashboard",
           back: "", cal: today().slice(0, 7), filter: "need", date: today(), q: "", poll: null, numbers: null, users: null,
           seen: null, pastorList: {}, pending: 0, person: "", pq: "", roleF: "", pastor: "", actDay: today(), actShow: "all", emoji: true};

// ---------------------------------------------------------------- small helpers
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const norm = v => String(v ?? "").trim().toLowerCase();
function pad(n) { return String(n).padStart(2, "0"); }
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isoLocal() {  // local time with its UTC offset, the same shape the Streamlit site writes
  const d = new Date(), o = -d.getTimezoneOffset(), s = o >= 0 ? "+" : "-";
  return `${today()}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
}
function nice(iso, long) {
  if (!iso) return "Not yet";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-NZ", long ? {weekday: "long", day: "numeric", month: "long"} : {day: "numeric", month: "short"});
}
function full(iso) {  // a date with its year, for histories
  if (!iso) return "Never";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-NZ", {day: "numeric", month: "short", year: "numeric"});
}
function when(iso) {  // a saved timestamp as a short date and time
  const d = new Date(iso);
  return isNaN(d) ? String(iso || "") : d.toLocaleString("en-NZ", {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"});
}
const pastorsOf = m => String(m.pastor || "").split(",").map(x => x.trim()).filter(Boolean);  // someone can have more than one pastor
const shepherdsOf = m => String(m.shepherd || "").split(",").map(x => x.trim()).filter(Boolean);  // and shepherds, kept apart from pastors
// the people a pastor-type sign-in looks after: a Shepherd by the Shepherd field, a Pastor by the Pastor field
const careOf = m => S.me?.title === "Shepherd" ? shepherdsOf(m) : pastorsOf(m);
// Is this pastor the person themselves? Titles are ignored, so "Lady Pastor Rita Kpodonu" matches Rita Kpodonu.
const TITLES = /^((lady|senior|assistant|associate)\s+)?(pastor|rev(erend)?\.?|bishop|apostle|prophet(ess)?|evangelist|elder|deacon(ess)?|minister|dr\.?|mr\.?|mrs\.?|ms\.?)\s+/;
const bare = n => { let x = norm(n).replace(/\s+/g, " "); for (let i = 0; i < 3 && TITLES.test(x); i++) x = x.replace(TITLES, ""); return x; };
const TYPE = {member: "Member", first_timer: "First-timer", visitor: "Visitor"};  // attendance type; visitors are never chased on Follow-up
const typeKey = m => TYPE[m.type] ? m.type : "member", typeName = m => TYPE[typeKey(m)], typeOpts = Object.entries(TYPE);
// Titles shown short (names are saved in full, so matching people to their pastor is unchanged): Rev., Pst., LP
// Titles are saved in full words, one way (Reverend, Pastor, Lady Pastor, Bishop), so lists, reports and downloads match up
const fullTitle = n => String(n || "").replace(/\s+/g, " ").trim().replace(/^(lady\s+(pastor|pst\.?|ps\.?)|lp\.?)\s+/i, "Lady Pastor ")
  .replace(/^(reverend|revd\.?|rev\.?)\s+/i, "Reverend ").replace(/^(pastor|pst\.?|ps\.?)\s+/i, "Pastor ").replace(/^(bishop|bp\.?)\s+/i, "Bishop ");
const shortTitle = n => String(n || "").replace(/^\s*lady\s+(pastor|pst\.?|ps\.?)\s+/i, "LP ").replace(/^\s*(reverend|rev\.?)\s+/i, "Rev. ").replace(/^\s*(pastor|pst\.?|ps\.?)\s+/i, "Pst. ");
const pastorBtn = n => S.me?.role === "pastor" ? esc(shortTitle(n)) : `<button class="plink" data-to-pastor="${esc(n)}">${esc(shortTitle(n))}</button>`;  // a pastor's name: tap to see their people
const isSelf = (pastor, m) => !!bare(pastor) && bare(pastor) === bare(m.full_name);
const genderOf = m => ({f: "Female", female: "Female", m: "Male", male: "Male"})[norm(m.gender)] || "";
const rolesOf = m => String(m.role || "").split(",").map(x => x.trim().replace(/\s+/g, " ")).filter(Boolean);  // "Tech Team, Worship Team" is two roles
const byName = (a, b) => norm(a.full_name).localeCompare(norm(b.full_name));
const canApprove = () => S.me.role === "admin" || (S.me.role === "lead" && S.me.church === S.me.home);
const canTeam = () => ["admin", "lead"].includes(S.me.role);  // Team forms: an admin (every church) or a church admin (their own)
// WhatsApp text: a line is a string, or [emoji, text]; the emoji is left out when emojis are switched off
const wa = lines => lines.map(l => Array.isArray(l) ? (S.emoji ? `${l[0]} ${l[1]}` : l[1]) : l).join("\n").trim();
const isKid = m => ["child", "kid", "kids", "children"].includes(norm(m.age_group));
const churchOf = m => (m.church || "").trim() || S.me.home;
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
const initials = s => String(s || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
function toast(text) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = Object.assign(document.createElement("div"), {className: "toast", textContent: text});
  document.body.append(t); setTimeout(() => t.remove(), 3500);
}
const BACKUP_SCRIPT = String.raw`/** @OnlyCurrentDoc */
// FCC Attendance: copies everything into this Google Sheet every night. Run setup once (the Run button with setup picked).
const URL_ = "__URL__", PUBLIC_KEY = "__PUBLIC__", BACKUP_KEY = "__KEY__";
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("backup").timeBased().everyDays(1).atHour(2).create();  // every night between 2 and 3 am
  backup();
}
function backup() {
  const r = UrlFetchApp.fetch(URL_ + "/rest/v1/rpc/app_backup", {method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: {apikey: PUBLIC_KEY, Authorization: "Bearer " + PUBLIC_KEY}, payload: JSON.stringify({backup_key: BACKUP_KEY})});
  const ss = SpreadsheetApp.getActive(), log = ss.getSheetByName("Backup log") || ss.insertSheet("Backup log");
  if (r.getResponseCode() !== 200) { log.appendRow([new Date(), "Failed", r.getContentText().slice(0, 300)]); throw new Error("Backup failed: " + r.getContentText()); }
  const d = JSON.parse(r.getContentText()), home = d.home || "Home church", done = [], kept = new Set(["Backup log"]), order = [], churchTabs = [];
  // the look: a soft blue-grey heading in small capitals, roomy rows, thin lines between them
  const FONT = "Inter", HEAD_BG = "#e8edf3", HEAD_INK = "#5b6675", INK = "#1f2933", LINE = "#e2e7ee", WHITE = "#ffffff", SECTION = "#d6e4f5";
  const CAME = "#188038", MISSED = "#c5221f", MIDWEEK = "#e37400", NONE = "#c4c9d0";  // came; missed; came midweek but not on Sunday; no service that Sunday
  const SOLID = SpreadsheetApp.BorderStyle.SOLID;
  const tab = name => { const sh = ss.getSheetByName(name) || ss.insertSheet(name); sh.clear(); sh.clearConditionalFormatRules(); kept.add(name);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart(); return sh; };
  const text = rows => rows.map(r => r.map(v => v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)));
  const tz = Session.getScriptTimeZone(), today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"), yr = +today.slice(0, 4);
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const day = (s, k) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + k)).toISOString().slice(0, 10);
  const sundays = []; for (let t = new Date(Date.UTC(yr, 0, 1)); t.getUTCFullYear() === yr; t = new Date(t.getTime() + 864e5)) if (t.getUTCDay() === 0) sundays.push(t.toISOString().slice(0, 10));
  const nice = s => s ? +s.slice(8, 10) + " " + MON[+s.slice(5, 7) - 1].charAt(0) + MON[+s.slice(5, 7) - 1].slice(1).toLowerCase() + (+s.slice(0, 4) === yr ? "" : " " + s.slice(0, 4)) : "";
  const churchOf = x => String(x.church || "").trim() || home;
  const came = {}; for (const t of d.attendance || []) (came[t.member_id] = came[t.member_id] || new Set()).add(t.service_date);
  // each person's group on the tab, in this order. Here & Now: members who don't come around much (worked out each night, below)
  const GROUPS = [["Members", (x, hn) => !x.status && x.type !== "first_timer" && x.type !== "visitor" && !/child/i.test(x.age_group || "") && !hn],
    ["Here & Now", (x, hn) => !x.status && x.type !== "first_timer" && x.type !== "visitor" && !/child/i.test(x.age_group || "") && hn],
    ["Children", x => !x.status && /child/i.test(x.age_group || "")], ["First-timers", x => !x.status && x.type === "first_timer"],
    ["Visitors", x => !x.status && x.type === "visitor"], ["Away, moved or left", x => !!x.status]];
  // one tab per church: a title and key, then each group (numbered), every Sunday of the year in colour, and the totals
  for (const c of [...new Set([home, ...(d.churches || []).map(x => x.name)])]) {
    const people = (d.members || []).filter(x => churchOf(x) === c).sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))), ids = new Set(people.map(x => x.id));
    const held = new Set((d.attendance || []).filter(t => ids.has(t.member_id) && t.service_date <= today).map(t => t.service_date));  // days this church had a service
    const past = sundays.filter(s => s <= today && held.has(s));  // Sundays so far this year with a service
    // before someone joined (or, for a first-timer or visitor, first came), their Sundays stay blank and aren't counted as missed
    const startOf = x => [x.first_visit, x.date_joined, ...(x.type === "first_timer" || x.type === "visitor" ? [...(came[x.id] || [])] : [])].filter(Boolean).sort()[0] || "";
    const status = (x, s) => { const mine = came[x.id] || new Set(), start = startOf(x);
      if (s > today || (start && s < start)) return WHITE; if (mine.has(s)) return CAME;
      for (let k = -6; k < 0; k++) if (mine.has(day(s, k))) return MIDWEEK;  // came to a service that week, just not on the Sunday
      return held.has(s) ? MISSED : NONE; };
    // Here & Now: came (on the Sunday or midweek) to fewer than 1 in 4 of the Sundays held in the last 3 months (counted from when they joined)
    const recent = [...held].filter(s => new Date(s + "T00:00:00Z").getUTCDay() === 0 && s > day(today, -91));
    const hereNow = x => { const ss2 = recent.map(s => status(x, s)).filter(k => k !== WHITE && k !== NONE);
      return ss2.length >= 4 && ss2.filter(k => k === CAME || k === MIDWEEK).length / ss2.length < .25; };
    const FIXED = ["#", "NAME", "PHONE", "PASTOR", "LAST CAME", "MISSED THIS YEAR", "NOTE"], n = FIXED.length, cols = n + sundays.length;
    const sh = tab(c); order.push(sh); churchTabs.push(c); done.push(c + " " + people.length);
    const blank = () => Array(cols).fill(""), vals = [], bg = [], kinds = [];
    const add = (row, colours, kind) => { vals.push(row); bg.push(colours || Array(cols).fill(WHITE)); kinds.push(kind); };
    // title and key
    add(Object.assign(blank(), {0: "SUNDAY ATTENDANCE '" + String(yr).slice(2) + " · " + c.toUpperCase()}), null, "title");
    const key = Object.assign(blank(), {1: "Came", 2: "Missed", 3: "Came midweek, not Sunday", 4: "No service"}), keyBg = Array(cols).fill(WHITE);
    keyBg[1] = CAME; keyBg[2] = MISSED; keyBg[3] = MIDWEEK; keyBg[4] = NONE; add(key, keyBg, "key"); add(blank(), null, "gap");
    // two heading rows: the month over its Sundays, then the day of the month
    const months = [...FIXED, ...Array(sundays.length).fill("")], days = [...FIXED.map(() => ""), ...sundays.map(s => String(+s.slice(8, 10)))];
    sundays.forEach((s, i) => { if (!i || s.slice(5, 7) !== sundays[i - 1].slice(5, 7)) months[n + i] = MON[+s.slice(5, 7) - 1]; });
    const headAt = vals.length + 1; add(months, Array(cols).fill(HEAD_BG), "head"); add(days, Array(cols).fill(HEAD_BG), "head");
    const totals = sundays.map(() => [0, 0]);
    for (const [label, test] of GROUPS) {
      const list = people.filter(x => test(x, hereNow(x))); if (!list.length) continue;
      add(Object.assign(blank(), {0: label.toUpperCase() + " · " + list.length}), Array(cols).fill(SECTION), "section");
      list.forEach((x, i) => {
        const mine = came[x.id] || new Set(), last = [...mine].filter(t => t <= today).sort().pop(), colours = sundays.map(s => status(x, s));
        const missed = colours.filter(k => k === MISSED).length, counted = colours.filter((k, j) => k !== WHITE && k !== NONE && held.has(sundays[j])).length;
        colours.forEach((k, j) => { if (k === CAME) totals[j][0]++; else if (k === MISSED || k === MIDWEEK) totals[j][1]++; });
        add([String(i + 1), x.full_name || "(no name)", x.phone, x.pastor, nice(last), counted ? missed + " of " + counted : "", x.status || (x.type === "first_timer" && x.first_visit ? "First came " + nice(x.first_visit) : ""),
          ...sundays.map(() => "")], [...Array(n).fill(WHITE), ...colours], "person");
      });
    }
    add(blank(), null, "gap");
    add(Object.assign([...FIXED.map(() => ""), ...totals.map((t, j) => sundays[j] <= today && held.has(sundays[j]) ? String(t[0]) : "")], {1: "PRESENT"}), null, "total");
    add(Object.assign([...FIXED.map(() => ""), ...totals.map((t, j) => sundays[j] <= today && held.has(sundays[j]) ? String(t[1]) : "")], {1: "ABSENT"}), null, "total");
    // write it all, then the styling
    const all = sh.getRange(1, 1, vals.length, cols);
    all.setNumberFormat("@").setValues(text(vals)).setBackgrounds(bg).setFontFamily(FONT).setFontSize(10).setFontColor(INK).setVerticalAlignment("middle").setWrap(false);
    const rowsOf = k => kinds.map((x, i) => x === k ? i + 1 : 0).filter(Boolean);
    for (const i of rowsOf("person")) sh.getRange(i, 1, 1, cols).setBorder(null, null, true, null, null, null, LINE, SOLID);
    for (const i of rowsOf("person")) sh.getRange(i, n + 1, 1, sundays.length).setBorder(true, true, true, true, true, false, WHITE, SOLID);  // white gaps between the squares
    sh.getRange(1, 1, 1, cols).setFontSize(15).setFontWeight("bold");
    sh.getRange(2, 2, 1, 4).setFontColor(WHITE).setFontWeight("bold").setFontSize(9).setHorizontalAlignment("center");
    sh.getRange(headAt, 1, 2, cols).setFontColor(HEAD_INK).setFontWeight("bold").setFontSize(9);
    sh.getRange(headAt + 1, 1, 1, cols).setBorder(null, null, true, null, null, null, "#cfd6df", SOLID);
    for (let i = 0; i < sundays.length; i++) if (months[n + i]) { let k = 1; while (n + i + k < cols && !months[n + i + k]) k++; sh.getRange(headAt, n + i + 1, 1, k).merge(); }
    for (let j = 1; j <= n; j++) sh.getRange(headAt, j, 2, 1).merge();
    sh.getRange(headAt, n + 1, 2, sundays.length).setHorizontalAlignment("center");
    for (const i of rowsOf("section")) sh.getRange(i, 1, 1, cols).setFontWeight("bold").setFontSize(9).setFontColor("#1f4f8a");
    for (const i of rowsOf("person")) { sh.getRange(i, 2).setFontWeight("bold"); sh.getRange(i, 1).setFontColor(HEAD_INK).setHorizontalAlignment("right"); sh.getRange(i, 6).setHorizontalAlignment("center"); }
    for (const i of rowsOf("total")) sh.getRange(i, 1, 1, cols).setFontWeight("bold").setHorizontalAlignment("center").setBackground(HEAD_BG);
    sh.setRowHeights(1, vals.length, 30); sh.setRowHeight(1, 40); sh.setRowHeights(headAt, 2, 22);
    sh.setFrozenRows(headAt + 1); sh.setFrozenColumns(2); sh.setHiddenGridlines(true);
    [34, 200, 120, 190, 100, 130, 150].forEach((w, j) => sh.setColumnWidth(j + 1, w));
    sh.setColumnWidths(n + 1, sundays.length, 30);
  }
  // everything else, kept for a full restore but hidden so the sheet stays tidy (to see them: View → Hidden sheets)
  const raw = (name, list) => { const sh = tab(name), keys = [...new Set((list || []).flatMap(x => Object.keys(x)))]; sh.hideSheet(); done.push(name + " " + (list || []).length);
    if (keys.length) sh.getRange(1, 1, list.length + 1, keys.length).setNumberFormat("@").setValues(text([keys, ...list.map(x => keys.map(k => x[k]))])); };
  for (const [name, key] of [["data: people", "members"], ["data: attendance", "attendance"], ["data: churches", "churches"], ["data: services", "services"],
    ["data: service parts", "service_parts"], ["data: service ticks", "service_ticks"], ["data: bacentas", "bacentas"], ["data: bacenta attendance", "bacenta_ticks"], ["data: bacenta weeks off", "bacenta_skips"], ["data: bacenta-only people", "bacenta_guests"], ["data: bacenta-only attendance", "bacenta_guest_ticks"],
    ["data: pastor lists", "lists"], ["data: sign-ins", "signins"]]) raw(name, d[key]);
  // A church that's gone (deleted or renamed in the app) keeps its last copy: renamed "… (removed date)", moved to the end, never deleted.
  // Older layouts' tabs go. Any tab of your own stays.
  const props = PropertiesService.getScriptProperties(), before = JSON.parse(props.getProperty("churchTabs") || "[]");
  for (const sh of ss.getSheets()) { const nm = sh.getName(); if (kept.has(nm)) continue;
    if (before.includes(nm)) { sh.setName(nm + " (removed " + nice(today) + " " + yr + ")"); sh.setTabColor("#9aa0a6"); }
    else if (/( – people| – attendance| – details|^members$|^attendance$|^churches$|^services$|^service_parts$|^service_ticks$|^lists$|^signins$)/.test(nm)) ss.deleteSheet(sh); }
  props.setProperty("churchTabs", JSON.stringify(churchTabs));
  // tabs in order: the churches, then the Backup log (removed churches and your own tabs after)
  order.push(log); order.forEach((sh, i) => { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }); if (order[0]) ss.setActiveSheet(order[0]);
  log.appendRow([new Date(), "Done", done.join(" · ")]);
}`;
function download(name, rows) {
  const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(new Blob(["﻿" + csv], {type: "text/csv"})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// A popup form. fields: [{k, label, value, type?: "text"|"tel"|"select", options?: [[value, label]], hint?}].
// save(values) does the work and may throw; the popup shows the message and stays open so nothing typed is lost.
// What is wrong with a typed email address, in plain words; "" when it looks right. Catches the usual slips too.
const SLIPS = {"gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmail.con": "gmail.com", "gmail.co": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmail.comm": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmail.con": "hotmail.com", "outlok.com": "outlook.com", "outlook.con": "outlook.com", "yaho.com": "yahoo.com", "yahoo.con": "yahoo.com", "icloud.con": "icloud.com"};
function emailProblem(raw) {
  const x = String(raw || "").trim().toLowerCase();
  if (!x) return "Type an email address.";
  if (/\s/.test(x)) return `${x} has a space in it.`;
  if ((x.match(/@/g) || []).length !== 1) return `${x} needs one @, like name@example.com.`;
  const [name, host] = x.split("@");
  if (!name || !/^[a-z0-9._%+'-]+$/.test(name) || /^\.|\.$|\.\./.test(name)) return `${x}: the part before the @ doesn't look right.`;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) || /(^|\.)-|-(\.|$)/.test(host)) return `${x}: the part after the @ doesn't look right, e.g. gmail.com.`;
  if (SLIPS[host]) return `${x}: did you mean ${name}@${SLIPS[host]}?`;
  return "";
}
// What is wrong with a phone number, in plain words; "" when it looks right. needed: a first-timer must give one.
function phoneProblem(raw, needed) {
  const x = String(raw || "").trim(), digits = x.replace(/\D/g, "").length;
  if (!x) return needed ? "A first-timer needs a phone number." : "";
  if (!/^\+?[0-9 ]+$/.test(x) || digits < 7 || digits > 15) return "Check the phone number: it needs 7 to 15 digits.";
  return "";
}
// Phone boxes take numbers only (plus + and spaces), whether typed or pasted.
function digitsOnly(e) { const v = e.target.value.replace(/[^0-9+ ]/g, ""); if (v !== e.target.value) e.target.value = v; }
// Phones only: WhatsApp's web page does not open messages well on a computer, so there the message is copied instead.
const onPhone = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
function formDialog(title, fields, save, button = "Save", danger = null) {
  document.querySelectorAll(".modal").forEach(m => m.remove());
  const d = document.createElement("div");
  d.className = "modal";
  d.innerHTML = `<form class="sheet narrow" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="card-head"><h2>${esc(title)}</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
    <div class="fields">${fields.map(f => `<div><label class="f" for="fd-${f.k}">${esc(f.label)}</label>${f.type === "multi"
      ? `<div class="checks" id="fd-${f.k}">${f.options.map(([v, t]) => `<label class="chk"><input type="checkbox" value="${esc(v)}" ${f.value.includes(v) ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}</div>`
      : f.type === "select"
      ? `<select class="in" id="fd-${f.k}">${f.options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(f.value ?? "") ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`
      : `<input class="in" id="fd-${f.k}" type="${f.type || "text"}" value="${esc(f.value ?? "")}" maxlength="120" ${f.required ? "required" : ""} autocomplete="off">`}
      ${f.suggest ? `<div class="suggest" id="fs-${f.k}" aria-label="Suggestions"></div>` : ""}
      ${f.hint ? `<p class="note" style="margin:6px 2px 0">${esc(f.hint)}</p>` : ""}</div>`).join("")}</div>
    <div class="msg bad" id="fd-err" hidden></div>
    <div class="modal-foot"><button type="button" class="pill-btn" data-x>Cancel</button><button class="pill-btn primary" id="fd-go">${esc(button)}</button>
      ${danger ? `<button type="button" class="pill-btn danger" id="fd-del">${esc(danger.label)}</button>` : ""}</div></form>`;
  document.body.append(d);
  const close = () => { d.remove(); document.removeEventListener("keydown", onKey); }, onKey = e => { if (e.key === "Escape") close(); };
  d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
  document.addEventListener("keydown", onKey);
  const del = d.querySelector("#fd-del");
  if (del) { let armed = false; del.onclick = async () => {  // a second tap is needed, and it is undone if left for a few seconds
    if (!armed) { armed = true; del.textContent = danger.confirm; setTimeout(() => { armed = false; del.textContent = danger.label; }, 4000); return; }
    del.disabled = true; const err = d.querySelector("#fd-err");
    try { await danger.run(); close(); } catch (ex) { err.textContent = ex.message; err.hidden = false; del.disabled = false; }
  }; }
  d.querySelector("form").onsubmit = async e => {
    e.preventDefault();
    const go = d.querySelector("#fd-go"), err = d.querySelector("#fd-err"), values = Object.fromEntries(fields.map(f => [f.k, f.type === "multi"
      ? [...d.querySelectorAll(`#fd-${f.k} input:checked`)].map(i => i.value).join(", ")
      : d.querySelector("#fd-" + f.k).value.trim().replace(/\s+/g, " ")]));
    go.disabled = true; err.hidden = true;
    try { await save(values); close(); } catch (ex) { err.textContent = ex.message; err.hidden = false; go.disabled = false; }
  };
  // Autofill: as you type, the choices already in use appear under the box; tap one to fill it in.
  // With f.many the box holds several, separated by commas, and only the one being typed is completed.
  for (const f of fields.filter(x => x.suggest)) {
    const inp = d.querySelector("#fd-" + f.k), box = d.querySelector("#fs-" + f.k);
    const show = () => {
      const parts = f.many ? inp.value.split(",") : [inp.value], typing = norm(parts.pop()), have = parts.map(norm);
      const hits = f.suggest.filter(r => !have.includes(norm(r)) && norm(r) !== typing && norm(r).includes(typing))
        .sort((a, b) => norm(b).startsWith(typing) - norm(a).startsWith(typing)).slice(0, 8);
      box.innerHTML = hits.map(r => `<button type="button" class="chip sm" data-s="${esc(r)}">${esc(r)}</button>`).join("");
    };
    inp.oninput = inp.onfocus = show;
    box.onclick = e => {
      const b = e.target.closest("[data-s]"); if (!b) return;
      const kept = f.many ? inp.value.split(",").slice(0, -1).map(x => x.trim()).filter(Boolean) : [];
      inp.value = [...kept, b.dataset.s].join(", ") + (f.many ? ", " : "");
      inp.focus(); show();
    };
  }
  d.querySelectorAll('input[type="tel"]').forEach(i => i.addEventListener("input", digitsOnly));
  d.querySelector("input, select")?.focus();
}

// Where a finished summary can go. WhatsApp is always there on phones; Settings → Sharing summaries adds the others.
const SHARE = [["instagram", "Instagram"], ["messenger", "Messenger"], ["telegram", "Telegram"], ["sms", "Text message"], ["email", "Email"]];
const shareTo = () => { const v = look().share; return Array.isArray(v) ? v.filter(k => SHARE.some(s => s[0] === k)) : []; };
function shareOut(k, msg, subject) {
  const enc = encodeURIComponent(msg);
  if (k === "native") return navigator.share({text: msg}).catch(() => {});
  if (k === "telegram") return window.open("https://t.me/share/url?url=%20&text=" + enc, "_blank", "noopener");
  if (k === "sms") { location.href = "sms:?&body=" + enc; return; }
  if (k === "email") { location.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + enc; return; }
  // Instagram and Messenger can't be handed text by a link: copy it, then open the app to paste it into a chat
  navigator.clipboard?.writeText(msg).catch(() => {});
  toast(`Copied. Paste it into a chat in ${k === "instagram" ? "Instagram" : "Messenger"}.`);
  window.open(k === "instagram" ? "https://www.instagram.com/direct/inbox/" : "https://www.messenger.com/", "_blank", "noopener");
}

// A popup for a WhatsApp message: options on the left, a live preview on the right, then Copy.
// build({names, link}) returns the text; opts says which options this message offers.
// The preview, laid out for reading: headings, labels and numbers lined up, WhatsApp's *bold* shown bold.
// Only for looking at: Copy, Send and Share always use the message exactly as written.
function prettyMsg(t) {
  const fmt = x => esc(x).replace(/\*([^*\n]+)\*/g, "<b>$1</b>");
  const cap = x => x !== x.toUpperCase() ? x : x.toLowerCase().replace(/(^|[\s/(])([a-z])/g, (_, a, c) => a + c.toUpperCase());  // "PREACHER NAME" -> "Preacher Name"
  const row = (cls, k, v) => `<div class="pm-row ${cls}"><span>${fmt(k)}</span><b>${fmt(v)}</b></div>`;
  let first = true, gap = false;
  return t.split("\n").map(raw => {
    const l = raw.trim();
    if (!l) { if (first) return ""; gap = true; return ""; }
    const sp = gap ? " pm-gap" : ""; gap = false;
    let m;
    if (first) { first = false; return `<div class="pm-title">${fmt(cap(l.replace(/^\*|\*$/g, "")))}</div>`; }
    if ((m = l.match(/^[—–-]{1,2}\s*(.+?)\s*[—–-]{1,2}$/))) return `<div class="pm-sec${sp}">${fmt(m[1])}</div>`;
    if ((m = l.match(/^\*([^*]+?)\s*-\s*(\d[\d,]*)\*?$/))) return row("pm-total" + sp, m[1], m[2]);
    if ((m = l.match(/^\[(.+?)\s*-\s*([^\]]*)\]$/))) return row("pm-sub" + sp, m[1].replace(/:\s*$/, ""), m[2].trim());
    if ((m = l.match(/^([A-Z][A-Z0-9 /&'().]+?)\s*(?:-|:)\s*(.*)$/)) && m[1].length <= 30) return `<div class="pm-field${sp}"><span>${fmt(cap(m[1]))}</span><b>${fmt(/^[A-Z][A-Z ]+$/.test(m[2]) ? cap(m[2]) : m[2]) || "–"}</b></div>`;
    if ((m = l.match(/^(.{2,60}?)\s*(?:-|:)\s*(\*?\d[\d,]*\*?)$/))) return row(sp, m[1], m[2]);
    return `<div class="pm-line${sp}">${fmt(l)}</div>`;
  }).filter(Boolean).reduce((out, h) => {  // details that follow each other sit together in two columns
    if (h.startsWith('<div class="pm-field') && out.at(-1)?.startsWith('<div class="pm-fields">')) out[out.length - 1] = out.at(-1).slice(0, -6) + h + "</div>";
    else out.push(h.startsWith('<div class="pm-field') ? `<div class="pm-fields">${h}</div>` : h);
    return out;
  }, []).join("");
}
// A friendlier date picker for the app's date boxes: the date shows as a pill, and tapping it opens a month calendar.
// Days with a recorded service have a dot, today has a ring, and days after the box's latest allowed day can't be picked.
// The original date box stays (hidden), so everything that listens to it keeps working.
const svcDays = () => new Set((S.ticks || []).map(t => t.service_date));
function calPick(inp, marked = svcDays()) {
  if (!inp || inp.dataset.cal) return;
  inp.dataset.cal = "1"; inp.classList.add("cal-src"); inp.tabIndex = -1;
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "cal-btn"; btn.setAttribute("aria-haspopup", "dialog");
  const label = () => { const v = inp.value;
    btn.innerHTML = `${svg("calpick")}<span>${v ? new Date(v + "T12:00:00").toLocaleDateString([], {weekday: "short", day: "numeric", month: "short", year: "numeric"}) : "Pick a date"}</span>${svg("caret")}`; };
  inp.after(btn); label();
  if (inp.id) document.querySelectorAll(`label[for="${inp.id}"]`).forEach(l => l.onclick = e => { e.preventDefault(); btn.click(); });
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let pop = null;
  const close = () => { if (!pop) return; pop.remove(); pop = null; btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", out, true); document.removeEventListener("keydown", key); removeEventListener("resize", close); removeEventListener("scroll", close); };
  const out = e => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); };
  const key = e => { if (e.key === "Escape") { close(); btn.focus(); } };
  const pick = k => { if (inp.max && k > inp.max || inp.min && k < inp.min) return;
    inp.value = k; label(); close(); inp.dispatchEvent(new Event("change", {bubbles: true})); };
  btn.onclick = () => {
    if (pop) return close();
    const sel = inp.value || today(); let view = new Date(sel.slice(0, 7) + "-01T12:00:00");
    pop = document.createElement("div"); pop.className = "cal-pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Pick a date");
    const draw = () => {
      const y = view.getFullYear(), m = view.getMonth(), lead = (new Date(y, m, 1, 12).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate(), t = today();
      const cells = Array.from({length: Math.ceil((lead + days) / 7) * 7}, (_, i) => new Date(y, m, 1 - lead + i, 12));
      const nextOk = !inp.max || iso(new Date(y, m + 1, 1, 12)) <= inp.max;
      pop.innerHTML = `<div class="cal-head"><b>${view.toLocaleDateString([], {month: "long", year: "numeric"})}</b><span class="gap"></span>
          <button type="button" data-m="-1" aria-label="Previous month">${svg("prev")}</button><button type="button" data-today>Today</button>
          <button type="button" data-m="1" aria-label="Next month" ${nextOk ? "" : "disabled"}>${svg("next")}</button></div>
        <div class="cal-grid">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(w => `<i>${w}</i>`).join("")}${cells.map(d => { const k = iso(d), bad = inp.max && k > inp.max || inp.min && k < inp.min;
          return `<button type="button" data-d="${k}" class="${d.getMonth() !== m ? "off" : ""} ${k === sel ? "on" : ""} ${k === t ? "now" : ""} ${marked.has(k) ? "has" : ""}" ${bad ? "disabled" : ""}
            aria-label="${d.toLocaleDateString([], {weekday: "long", day: "numeric", month: "long"})}${marked.has(k) ? ", a service" : ""}" aria-pressed="${k === sel}">${d.getDate()}</button>`; }).join("")}</div>
        ${marked.size ? `<p class="cal-key"><i></i>A service was recorded</p>` : ""}`;
      pop.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { view = new Date(y, m + +b.dataset.m, 1, 12); draw(); });
      pop.querySelector("[data-today]").onclick = () => pick(t);
      pop.querySelectorAll("[data-d]").forEach(b => b.onclick = () => pick(b.dataset.d));
    };
    draw(); document.body.append(pop); btn.setAttribute("aria-expanded", "true");
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(12, Math.min(r.left, innerWidth - w - 12)) + "px";
    pop.style.top = (r.bottom + 8 + h > innerHeight && r.top - h - 8 > 0 ? r.top - h - 8 : Math.min(r.bottom + 8, Math.max(12, innerHeight - h - 12))) + "px";
    setTimeout(() => { document.addEventListener("pointerdown", out, true); document.addEventListener("keydown", key); addEventListener("resize", close); addEventListener("scroll", close, {passive: true}); }, 0);
    pop.querySelector("button.on, button.now")?.focus({preventScroll: true});
  };
  inp.addEventListener("change", label);  // changed elsewhere: keep the pill's text up to date
}
function waDialog(title, build, opts = {}) {
  document.querySelectorAll(".modal").forEach(m => m.remove());
  const st = {names: false, link: "", follow: false, day: opts.day || ""}, d = document.createElement("div");
  const memo = () => `fcc-wa:${S.church}:${st.day}`, recall = () => { try { return JSON.parse(localStorage.getItem(memo()) || "{}"); } catch { return {}; } };
  // A day with more than one service: the boxes come once per service (preacher, Zoom, YouTube... for each),
  // and the message keeps the services apart. It's switched on by the person, or already on when Check-in split the day.
  const FKEY = /^(preacher|sermon|zoomA|zoomK|yt|fb|converts|time|end|px[a-z0-9]+)(_\d)?$/;
  const loadDraft = () => { for (const k of Object.keys(st)) if (FKEY.test(k)) delete st[k]; const r = recall();
    Object.assign(st, Object.fromEntries(Object.entries(r).filter(([k]) => FKEY.test(k))), {_at: r._at || 0,
      multi: r.multi ?? partsOf(st.day).length > 1, count: Math.min(3, Math.max(2, r.count || partsOf(st.day).length || 2))}); };
  if (opts.fields) loadDraft();
  let liveStarts = [], liveList = [];  // the day's livestreamed services: start times for naming the boxes, and their peaks
  const hm = t => new Date(t).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
  const others = shareTo().filter(k => k !== "sms" || onPhone()), native = onPhone() && !!navigator.share;
  // what can be added to the message, as chips: [id, label, on, a short note]
  const incl = [...(opts.names ? [["m-names", opts.fields ? "First-timers' names" : "Names", false, opts.fields ? "" : "Leave names off for big group chats."]] : []),
    ...(opts.follow ? [["m-follow", "Follow-up", false, "Follow-up lists who missed services."]] : []),
    ...(opts.noEmoji ? [] : [["m-emoji", "Emojis", S.emoji, ""]])];
  // On the Summary page each part is a card that opens and closes; in a pop-up the parts just follow each other
  const acc = (title, body, open = true) => opts.into ? `<details class="wa-acc" id="wa-${title.toLowerCase().replace(/[^a-z]+/g, "-")}" ${open ? "open" : ""}><summary><span>${title}</span>${svg("caret")}</summary><div class="wa-acc-b">${body}</div></details>` : body;
  const toggle = (id, label, hint, on) => `<label class="switch"><span><b>${label}</b><small>${hint}</small></span><input type="checkbox" id="${id}" ${on ? "checked" : ""}><i></i></label>`;
  d.className = opts.into ? "wa-page" : "modal";  // opts.into: shown on a page (the Summary tab) instead of as a pop-up
  d.innerHTML = `<div class="${opts.into ? "card" : "sheet"} wa-sheet" ${opts.into ? "" : `role="dialog" aria-modal="true"`} aria-label="${esc(title)}">
    ${opts.into ? "" : `<div class="card-head"><h2>${esc(title)}</h2><span class="gap"></span><button class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>`}
    <div class="modal-grid"><div class="opts">
        ${acc("Service", `${opts.day ? `<div class="opt wa-row"><div class="wa-txt"><b><label for="m-day">Service date</label></b><small>The service this summary is for</small></div><input class="in wa-pill" id="m-day" type="date" value="${opts.day}" max="${today()}"></div>` : ""}`)}
        ${opts.fields ? acc("Service details", `<div class="wa-sec"><b>Service details</b></div>${opts.fields.some(f => f[0] === "yt") && ["admin", "lead"].includes(S.me.role)
          ? `<div class="live-fill" role="note">${svg("live")}<span><b>Livestream numbers fill in by themselves.</b> Set the start and end times below.</span></div>` : ""}<div id="m-fields"></div>${opts.plat ? `<div class="plat-row" id="m-plat"></div>` : ""}`) : ""}
        ${incl.length ? acc("Include in the message", `<div class="opt wa-inc"><div class="wa-txt"><b>Include in the message</b><small>Tap to add or leave out. ${esc(incl.map(c => c[3]).join(" "))}</small></div>
          <div class="wa-chips">${incl.map(([id, t, on]) => `<label class="wa-chip"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><span>${svg("tick")}${t}</span></label>`).join("")}</div></div>`) : ""}
        ${opts.link ? acc("Livestream link", `<div class="opt wa-row"><div class="wa-txt"><b><label for="m-link">Livestream link</label></b><small>Optional. It goes at the end of the message</small></div><input class="in" id="m-link" type="url" inputmode="url" placeholder="https://…"></div>`, false) : ""}
        ${opts.fields ? `<div class="draft-line"><span id="m-draft"></span><button type="button" class="pill-btn sm" data-clear hidden>Start again</button></div>` : ""}
      </div>
      ${opts.into ? `<aside class="wa-side" aria-label="Preview">  <!-- the message as a document on the side, updating as the boxes are filled in -->
        <div class="wa-prev-head"><b>Preview</b><div class="pv-seg" role="group" aria-label="How the preview looks"><button type="button" data-pv="nice" aria-pressed="${S.pvRaw ? "false" : "true"}">Formatted</button><button type="button" data-pv="raw" aria-pressed="${S.pvRaw ? "true" : "false"}">Plain text</button></div></div>
        <div class="wa-paper"><div class="preview ${S.pvRaw ? "" : "nice"}" id="m-text" tabindex="0"></div></div>
        <p class="wa-paper-note">Plain text is exactly what Copy and WhatsApp send.</p>
        <div class="wa-side-card wa-send"><p id="wa-state" class="wa-state"></p><div id="wa-actions"></div></div></aside>` : ""}
      ${opts.into ? "" : `<div class="opt"><div class="prev-top"><span class="f">Preview</span><div class="pv-seg" role="group" aria-label="How the preview looks"><button type="button" data-pv="nice" aria-pressed="${S.pvRaw ? "false" : "true"}">Formatted</button><button type="button" data-pv="raw" aria-pressed="${S.pvRaw ? "true" : "false"}">Plain text</button></div></div>
        <div class="preview ${S.pvRaw ? "" : "nice"}" id="m-text" tabindex="0"></div></div>`}</div>
    ${others.length || native ? `<div class="share-row"><small>Send to</small>${others.map(k => `<button type="button" class="chip" data-share="${k}">${SHARE.find(s => s[0] === k)[1]}</button>`).join("")}
      ${native ? `<button type="button" class="chip" data-share="native">More apps…</button>` : ""}</div>` : ""}
    <div class="modal-foot">${opts.fields ? `<button class="pill-btn" id="m-save">Save draft</button>` : `<button class="pill-btn" data-x>Close</button>`}<button class="pill-btn ${onPhone() ? "" : "primary"}" id="m-copy">Copy</button>${onPhone() ? `<button class="pill-btn primary" id="m-send">Open in WhatsApp</button>` : ""}</div></div>`;
  (opts.into || document.body).append(d);
  calPick(d.querySelector("#m-day"));
  if (opts.into) {  // on the page: Copy / WhatsApp / Send to live in the side column, and its links open and show each part
    const acts = d.querySelector("#wa-actions"); acts.append(...[d.querySelector(".modal-foot"), d.querySelector(".share-row")].filter(Boolean));
    d.querySelectorAll("[data-jump]").forEach(b => b.onclick = () => { const c = d.querySelector("#" + b.dataset.jump); if (!c) return; c.open = true; c.scrollIntoView({behavior: "smooth", block: "start"}); });
  }
  const text = d.querySelector("#m-text");
  let turn = 0, msg = "";  // msg: the message exactly as it's copied and sent; the preview can show it laid out for reading
  const show = () => { text.classList.toggle("nice", !S.pvRaw && !text.classList.contains("muted"));
    if (S.pvRaw || text.classList.contains("muted")) text.textContent = msg; else text.innerHTML = prettyMsg(msg); };
  d.querySelectorAll("[data-pv]").forEach(b => b.onclick = () => { S.pvRaw = b.dataset.pv === "raw";
    d.querySelectorAll("[data-pv]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); show(); });
  const draw = async () => {  // build may load numbers for the chosen day; null means there is nothing for that day
    const mine = ++turn, send = d.querySelector("#m-send"), copy = d.querySelector("#m-copy");
    let out; try { out = await build(st); } catch (err) { out = null; text.dataset.why = err.message; }
    if (mine !== turn) return;
    const none = out == null;
    msg = none ? (text.dataset.why || `No summary for ${st.day ? nice(st.day, true) : "this day"}. No service was recorded.`) : out;
    delete text.dataset.why; text.classList.toggle("muted", none); show(); copy.disabled = none;
    const ws = d.querySelector("#wa-state"); if (ws) { ws.textContent = none ? msg : "The message is ready. Copy it, or open WhatsApp and pick the chat."; ws.classList.toggle("muted", none); } if (send) send.disabled = none;
    d.querySelectorAll("[data-share]").forEach(b => b.disabled = none);
  };
  // Drafts: what's typed is kept for this church and day, so it can be closed, checked and finished later
  const drafted = () => { const box = d.querySelector("#m-draft"); if (!box) return;
    box.textContent = st._at ? `Draft saved at ${hm(st._at)}. Close and come back any time.` : "";
    d.querySelector("[data-clear]").hidden = !st._at; };
  const keepDraft = () => { st._at = Date.now();
    try { localStorage.setItem(memo(), JSON.stringify({...Object.fromEntries(Object.entries(st).filter(([k, v]) => FKEY.test(k) && v)), multi: st.multi, count: st.count, _at: st._at})); } catch {} drafted(); };
  // the boxes: one set, or one set per service. With more than one, each service's livestream peaks show under its own boxes.
  // Livestream peaks as they go in the boxes. Zoom counts the host and co-host as viewers, so 2 are taken off (never below 0).
  const liveNums = x => ({yt: x.youtube > 0 ? x.youtube : null, fb: x.facebook > 0 ? x.facebook : null, zoomA: x.zoom > 0 ? Math.max(0, x.zoom - 2) : null});
  const zoomWhy = x => x.zoom > 0 ? `Zoom ${x.zoom} − 2 for the host and co-host = ${Math.max(0, x.zoom - 2)}` : "";
  // the livestream that goes with a service starting at t ("HH:MM"): the one whose start is nearest, within 2 hours (or that was running then)
  const liveAt = (t, e) => { if (!t || !liveList.length || !st.day) return null; const ms = v => { const [h, m] = v.split(":").map(Number); return new Date(st.day + "T00:00:00").setHours(h, m); }, at = ms(t);
    if (e && ms(e) > at) { const to = ms(e), over = x => Math.min(to, x.end || x.start + 36e5) - Math.max(at, x.start);  // with an end time: the stream that overlaps the service most
      const best = [...liveList].sort((a, b) => over(b) - over(a))[0]; if (over(best) > 0) return best; }
    const on = liveList.find(x => at >= x.start - 30 * 6e4 && at <= (x.end || x.start)); if (on) return on;  // running then (or about to start)
    const x = [...liveList].sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0];
    return Math.abs(x.start - at) <= 2 * 3600e3 ? x : null; };
  const liveUnder = j => { const x = liveAt(st[`time_${j + 1}`], st[`end_${j + 1}`]) || liveList[j]; return x ? `<small class="wide svc-live">${svg("live")}Livestream ${hm(x.start)}: YouTube ${x.youtube} · Facebook ${x.facebook} · Zoom ${x.zoom} (${Math.max(0, x.zoom - 2)} without hosts)</small>` : ""; };
  // When a service's start time is picked: offer that time's livestream peaks for its boxes
  // When a service's times are picked: offer the highest on each platform between those times (the livestream's own peaks
  // if the live dashboard can't give them for part of a stream), Zoom 2 less for the host and co-host
  let askTurn = 0;
  const offerLive = async n => {
    const box = d.querySelector(`[data-ask="${n}"]`), t = st[`time_${n}`], e = st[`end_${n}`]; if (!box || !t || !liveOk()) return;
    const x = liveAt(t, e), sfx = st.multi ? "_" + n : "", when = e ? `${clock(t)} to ${clock(e)}` : clock(t), mine = ++askTurn;
    box.hidden = false;
    if (!x) { box.innerHTML = liveList.length ? `<span>No livestream ${e ? "during" : "near"} ${when}. Livestreams started at ${liveList.map(y => hm(y.start)).join(", ")}.</span><button type="button" class="pill-btn sm" data-no>OK</button>`
        : `<span>No livestream numbers for this day.</span><button type="button" class="pill-btn sm" data-no>OK</button>`;
      box.querySelector("[data-no]").onclick = () => { box.hidden = true; }; return; }
    const ms = v => { const [h, m] = v.split(":").map(Number); return new Date(st.day + "T00:00:00").setHours(h, m); };
    const from = ms(t), to = e && ms(e) > from ? ms(e) : (x.end || x.start + 36e5);
    box.innerHTML = `<span>Checking the livestream for ${when}…</span>`;
    let p = null;
    try { const r = await fetch(`/app-live?church=${encodeURIComponent(S.church)}&from=${from}&to=${to}&peaks=1`, {cache: "no-store", headers: {Authorization: "Bearer " + S.session.access_token}});
      const j = r.ok ? await r.json() : null; if (j?.peaks?.minutes > 0) p = j.peaks; } catch {}
    if (mine !== askTurn || !box.isConnected) return;
    const src = p || x, v = liveNums(src), zoomA = Math.max(0, src.zoom - 2);
    box.innerHTML = `<b>${svg("live")}Fill in the livestream for the ${when} service?</b>
      <small>${p ? `Highest on each between ${clock(t)} and ${hm(to)}:` : `Highest on each during the livestream (${hm(x.start)} to ${x.end ? hm(x.end) : "now"}):`}</small>
      <div class="ask-nums"><i>YouTube<em>${v.yt ?? 0}</em></i><i>Facebook<em>${v.fb ?? 0}</em></i><i>Zoom<em>${v.zoomA ?? 0}</em></i></div>
      ${src.zoom > 0 ? `<small>Zoom ${src.zoom} − 2 for the host and co-host = ${zoomA}</small>` : ""}
      <div class="live-ask-btns"><button type="button" class="pill-btn primary sm" data-yes>Fill in these numbers</button><button type="button" class="pill-btn sm" data-no>Not now</button></div>`;
    box.querySelector("[data-yes]").onclick = () => { for (const [k, val] of Object.entries(v)) { st[k + sfx] = val === null ? "" : String(val); const i = d.querySelector(`#m-${k}${sfx}`); if (i) i.value = st[k + sfx]; }
      keepDraft(); draw(); box.hidden = true; toast("Filled in from the livestream. Check them before sending."); };
    box.querySelector("[data-no]").onclick = () => { box.hidden = true; };
  };
  const liveOk = () => opts.fields?.some(f => f[0] === "yt") && ["admin", "lead"].includes(S.me.role);
  // Each service's start time can be set by hand (it starts as the livestream's start, if there was one) and names the service in the message
  const startOf = i => st[`time_${i}`] || (liveStarts[i - 1] ? (d => `${pad(d.getHours())}:${pad(d.getMinutes())}`)(new Date(liveStarts[i - 1])) : "");
  const clock = t => { const [h, m] = t.split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}); };
  const groupName = i => { const part = partsOf(st.day)[i - 1]?.name, t = startOf(i), e = st[`end_${i}`], w = t ? clock(t) + (e ? `–${clock(e)}` : "") : "";
    return part ? (w ? `${part} · ${w}` : part) : w ? `${w} service` : `Service ${i}`; };
  const drawFields = () => {
    const box = d.querySelector("#m-fields"); if (!box) return;
    st.groups = Array.from({length: st.count}, (_, j) => groupName(j + 1));  // the services' names, for the message
    const set = (sfx, head) => `<div class="opt fields-grid">${head || ""}${head && liveOk() ? `<div class="wide live-note live-ask" data-ask="${sfx ? sfx.slice(1) : 1}" hidden></div>` : ""}${opts.fields.map(([k, label, kind]) => `<div class="${kind === "num" ? "" : "wide"}"><label class="f" for="m-${k}${sfx}">${label}</label>
      <input class="in" id="m-${k}${sfx}" data-field="${k}${sfx}" ${kind === "num" ? `type="number" inputmode="numeric" min="0" placeholder="0"` : `maxlength="80"`} value="${esc(st[k + sfx] ?? "")}"></div>`).join("")}${sfx ? liveUnder(+sfx.slice(1) - 1) : ""}
</div>`;
    // one service: its start time too, so the livestream that goes with it can be offered
    const times = (n, start) => `<span class="svc-times"><label class="svc-time">Starts <input class="in sm" type="time" data-time="${n}" value="${esc(start)}" aria-label="Service ${n} start time"></label>
        <label class="svc-time">Ends <input class="in sm" type="time" data-end="${n}" value="${esc(st[`end_${n}`] || "")}" aria-label="Service ${n} end time"></label></span>`;
    // Usually one service; "Add a second service" splits the day (and a third, if ever needed). Each service keeps its own boxes.
    box.innerHTML = (!st.multi ? set("", liveOk() ? `<div class="wide svc-top"><b class="svc-head">Service time</b>${times(1, st.time_1 || "")}</div>` : "")
      : Array.from({length: st.count}, (_, j) => set("_" + (j + 1), `<div class="wide svc-top"><b class="svc-head">${esc(groupName(j + 1))}</b>${times(j + 1, startOf(j + 1))}</div>`)).join(""))
      + `<div class="svc-more">${!st.multi ? `<button type="button" class="pill-btn sm" data-svc-two>${svg("plus")}Add a second service</button>`
        : `${st.count < 3 ? `<button type="button" class="pill-btn sm" data-svc-add>${svg("plus")}Add a third service</button>` : ""}<button type="button" class="pill-btn sm ci-remove" data-svc-less>Remove the ${st.count === 3 ? "third" : "second"} service</button>`}</div>`;
    box.querySelectorAll("[data-field]").forEach(i => i.oninput = () => { st[i.dataset.field] = i.value.trim(); keepDraft(); draw(); });
    // a time changed: keep it, rename that service, and offer its livestream; the boxes aren't redrawn, so typing the time isn't interrupted
    let wait; const timed = (k, n, v) => { st[`${k}_${n}`] = v; keepDraft(); st.groups = Array.from({length: st.count}, (_, j) => groupName(j + 1));
      if (st.multi) { const h = box.querySelectorAll(".svc-head")[n - 1]; if (h) h.textContent = groupName(n); }
      draw(); clearTimeout(wait); wait = setTimeout(() => offerLive(n), 350); };
    box.querySelectorAll("[data-time]").forEach(i => i.onchange = i.oninput = () => timed("time", +i.dataset.time, i.value));
    box.querySelectorAll("[data-end]").forEach(i => i.onchange = i.oninput = () => timed("end", +i.dataset.end, i.value));
    const keys = opts.fields.map(f => f[0]);
    box.querySelector("[data-svc-two]")?.addEventListener("click", () => {  // what was typed for the one service becomes the first service's
      for (const k of keys) if (st[k] && !st[k + "_1"]) st[k + "_1"] = st[k];
      st.multi = true; st.count = 2; keepDraft(); drawFields(); liveNote(); draw(); });
    box.querySelector("[data-svc-add]")?.addEventListener("click", () => { st.count = 3; keepDraft(); drawFields(); liveNote(); draw(); });
    box.querySelector("[data-svc-less]")?.addEventListener("click", () => {
      if (st.count > 2) st.count = 2;
      else { for (const k of keys) if (st[k + "_1"] && !st[k]) st[k] = st[k + "_1"]; st.multi = false; }  // back to one service, keeping the first's boxes
      keepDraft(); drawFields(); liveNote(); draw(); });
  };
  drawFields();
  d.querySelector("#m-multi")?.addEventListener("change", e => { st.multi = e.target.checked; keepDraft(); drawFields(); liveNote(); draw(); });
  const close = () => { d.remove(); document.removeEventListener("keydown", esc2); }, esc2 = e => { if (e.key === "Escape") close(); };
  d.onclick = e => { if (e.target === d && !opts.into || e.target.closest("[data-x]")) close(); };
  if (!opts.into) document.addEventListener("keydown", esc2);
  const saveBtn = d.querySelector("#m-save"); if (saveBtn) saveBtn.onclick = () => { keepDraft(); toast("Draft saved. Open the summary again any time to finish it."); };
  d.querySelector("[data-clear]")?.addEventListener("click", () => { try { localStorage.removeItem(memo()); } catch {}
    for (const k of Object.keys(st)) if (FKEY.test(k)) delete st[k]; st._at = 0; drawFields(); drafted(); draw(); });
  d.querySelectorAll("[data-share]").forEach(b => b.onclick = () => shareOut(b.dataset.share, msg, title));
  drafted();
  // Livestream numbers for the chosen day's services. Morning prayers (streams that start between 4:30 and 6:30 am) aren't counted,
  // and Zoom has 2 taken off each service for the host and co-host. They're shown as a note, or filled in for you (Settings → Sharing summaries).
  const prayers = t => { const x = new Date(t), m = x.getHours() * 60 + x.getMinutes(); return m >= 270 && m < 390; };
  const liveNote = async () => {
    d.querySelector(".live-note:not(.live-ask)")?.remove();  // the old note, not the boxes that offer a service's livestream
    if (!opts.fields?.some(f => f[0] === "yt") || !["admin", "lead"].includes(S.me.role) || !st.day || !S.session) return;
    const day = st.day, from = new Date(day + "T00:00:00").getTime(), to = from + 86400000;  // that day, on this phone's clock
    const get = async q => { const r = await fetch("/app-live?church=" + encodeURIComponent(S.church) + q, {cache: "no-store",
      headers: {Authorization: "Bearer " + S.session.access_token}}); return r.ok ? r.json() : null; };
    try {
      let list = [];
      const s = await get(`&from=${from}&to=${to}`);
      if (s?.services) list = s.services.filter(x => !prayers(x.start)).sort((a, b) => a.start - b.start);  // the day's services, in order
      else if (day === today()) {  // a church without saved services (its own YouTube channel): today's recent counts
        const j = await get(""); const h = (j?.history || []).filter(x => x.t >= from && !prayers(x.t) && x.total > 0);
        if (h.length) list = [{start: h[0].t, total: Math.max(...h.map(x => x.total)), youtube: Math.max(...h.map(x => x.total)), facebook: 0, zoom: 0}];
      }
      list = list.filter(x => x.youtube > 0 || x.facebook > 0 || x.zoom > 2);
      if (!list.length || !d.isConnected || st.day !== day) return;
      liveStarts = list.map(x => x.start); liveList = list;
      if (st.multi) { const keep = document.activeElement?.dataset?.field; drawFields(); if (keep) d.querySelector(`[data-field="${keep}"]`)?.focus(); }
      const nums = liveNums;  // Zoom with the host and co-host taken off
      const line = x => { const n = nums(x); return `YouTube ${n.yt ?? "–"} · Facebook ${n.fb ?? "–"} · Zoom ${n.zoomA ?? "–"}${x.zoom > 0 ? ` (${x.zoom} − 2)` : ""}`; };
      const put = (got, sfx) => { for (const [k, v] of Object.entries(got)) if (v !== null && !st[k + sfx]) { st[k + sfx] = String(v); const i = d.querySelector(`#m-${k}${sfx}`); if (i) i.value = v; } };
      const fill = () => { if (st.multi) Array.from({length: st.count}, (_, i) => liveAt(st[`time_${i + 1}`], st[`end_${i + 1}`]) || list[i]).forEach((x, i) => x && put(nums(x), "_" + (i + 1)));
        else put(nums(list.length === 1 ? list[0] : [...list].sort((a, b) => (b.youtube + b.facebook + b.zoom) - (a.youtube + a.facebook + a.zoom))[0]), ""); keepDraft(); draw(); };
      if (opts.into) return;  // the Summary page offers each service's livestream under its times instead of this note
      const box = document.createElement("div"); box.className = "live-note";
      const zoomNote = `<small>Zoom: 2 taken off for hosts. Split adults and children yourself. 5–6 am prayers aren't counted.</small>`;
      if (!st.multi && list.length > 1) {  // the livestream saw more than one service, but the boxes are for one: ask
        box.innerHTML = `<b>${svg("live")}The livestream had ${list.length} services today</b>${list.map(x => `<span>${hm(x.start)}: ${line(x)}</span>`).join("")}
          ${zoomNote}<button type="button" class="pill-btn sm" data-multi-on>Yes, fill in each service</button>`;
        box.querySelector("[data-multi-on]").onclick = () => { st.multi = true; st.count = Math.min(3, Math.max(2, list.length)); const m = d.querySelector("#m-multi"); if (m) m.checked = true;
          drawFields(); fill(); liveNote(); toast("Each service now has its own boxes. Check them before sending."); };
      } else {
        box.innerHTML = `<b>${svg("live")}Livestream peaks</b>${st.multi ? `<span>Each service's peaks are under its own boxes.</span>` : list.slice(0, 1).map(x => `<span>${hm(x.start)} service: ${line(x)}</span>`).join("")}
          ${zoomNote}<button type="button" class="pill-btn sm" data-fill>Fill in the empty boxes</button>`;
        box.querySelector("[data-fill]").onclick = () => { fill(); toast("Filled in from the livestream. Check them before sending."); };
        if (look().liveFill) { fill(); box.querySelector("[data-fill]").textContent = "Filled in for you"; }
      }
      d.querySelector("#m-fields")?.before(box);
    } catch {}
  };
  liveNote();
  const fol = d.querySelector("#m-follow"); if (fol) fol.onchange = e => { st.follow = e.target.checked; draw(); };
  const emo = d.querySelector("#m-emoji"); if (emo) emo.onchange = e => { S.emoji = e.target.checked; try { localStorage.setItem("fcc-emoji", S.emoji ? "on" : "off"); } catch {} draw(); };
  const names = d.querySelector("#m-names"), link = d.querySelector("#m-link"), day = d.querySelector("#m-day");
  if (day) day.onchange = e => { st.day = e.target.value || opts.day; if (!e.target.value) e.target.value = opts.day;
    if (opts.fields) { loadDraft(); liveStarts = []; liveList = []; const m = d.querySelector("#m-multi"); if (m) m.checked = st.multi; drawFields(); drafted(); }  // each day keeps its own online numbers
    liveNote(); draw(); };
  if (names) names.onchange = e => { st.names = e.target.checked; draw(); };
  if (link) link.oninput = e => { st.link = e.target.value.trim(); draw(); };
  // opens WhatsApp with exactly what the preview shows (emojis, names and link as chosen); the person picks the chat and sends
  const sendBtn = d.querySelector("#m-send"); if (sendBtn) sendBtn.onclick = () => { window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank", "noopener"); };
  d.querySelector("#m-copy").onclick = async e => {
    try { await navigator.clipboard.writeText(msg); e.target.textContent = "Copied"; toast("Copied."); setTimeout(() => { e.target.textContent = "Copy"; }, 2500); }
    catch {  // no clipboard access here: show it as sent and select it, so it can be copied by hand
      S.pvRaw = true; d.querySelectorAll("[data-pv]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.pv === "raw"))); show();
      const r = document.createRange(); r.selectNodeContents(text); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      toast("The message is selected. Press and hold it, then choose Copy.");
    }
  };
  draw(); if (!opts.into) d.querySelector("#m-copy").focus();
}

// ---------------------------------------------------------------- sign-in and the API
const store = {
  get() { try { return JSON.parse(localStorage.getItem("fcc-session")); } catch { return null; } },
  set(s) { S.session = s; try { s ? localStorage.setItem("fcc-session", JSON.stringify(s)) : localStorage.removeItem("fcc-session"); } catch {} },
};
function keep(t) { store.set({access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000}); }
async function auth(path, body, token) {
  const r = await fetch(S.cfg.url + "/auth/v1/" + path, {method: "POST", body: JSON.stringify(body || {}),
    headers: {apikey: S.cfg.key, "Content-Type": "application/json", ...(token ? {Authorization: "Bearer " + token} : {})}});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || j.error_description || j.message || "That didn't work. Please try again.");
  return j;
}
async function refresh() {
  if (!S.session?.refresh_token) return false;
  try { keep(await auth("token?grant_type=refresh_token", {refresh_token: S.session.refresh_token})); rtToken(); return true; }
  catch { store.set(null); return false; }
}
// Live updates without checking every few seconds (event-driven, like a computer's interrupts): the app keeps one quiet
// connection to the database and sleeps. The database sends a short note only when something it's watching changes, and
// the page then fetches just what changed. In the background the connection is closed; it reconnects when the app is opened.
const RT = {ws: null, open: false, ref: 0, hb: 0, subs: new Map()};
const rtSend = m => { if (RT.ws?.readyState === 1) RT.ws.send(JSON.stringify({...m, ref: String(++RT.ref)})); };
const rtJoin = (topic, s) => rtSend({topic: "realtime:" + topic, event: "phx_join", payload: {access_token: S.session?.access_token,
  config: {broadcast: {self: false}, presence: {key: ""}, private: false, postgres_changes: s.tables.map(table => ({event: "*", schema: "public", table}))}}});
function rtToken() { for (const topic of RT.subs.keys()) rtSend({topic: "realtime:" + topic, event: "access_token", payload: {access_token: S.session?.access_token}}); }
function rtConnect() {
  if (!S.cfg || (RT.ws && RT.ws.readyState <= 1)) return;
  let ws; try { ws = RT.ws = new WebSocket(S.cfg.url.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=" + encodeURIComponent(S.cfg.key) + "&vsn=1.0.0"); }
  catch { for (const s of RT.subs.values()) s.bad?.(); return; }
  ws.onopen = () => { RT.open = true; RT.wait = 0; for (const [topic, s] of RT.subs) rtJoin(topic, s);
    clearInterval(RT.hb); RT.hb = setInterval(() => rtSend({topic: "phoenix", event: "heartbeat", payload: {}}), 25000); };  // "still here", twice a minute
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; }
    const s = RT.subs.get(String(m.topic || "").replace(/^realtime:/, "")); if (!s) return;
    if (m.event === "phx_reply" && m.payload?.status === "ok" && m.payload?.response?.postgres_changes) s.good?.();
    else if (m.event === "phx_error" || (m.event === "phx_reply" && m.payload?.status === "error") || (m.event === "system" && m.payload?.status === "error")) s.bad?.();
    else if (m.event === "postgres_changes") s.on(m.payload?.data); };
  ws.onclose = () => { if (RT.ws !== ws) return; RT.open = false; RT.ws = null; clearInterval(RT.hb);
    for (const s of RT.subs.values()) s.bad?.();
    RT.wait = Math.min(120000, (RT.wait || 2500) * 2);  // try again, waiting longer each time (5 s, 10 s... up to 2 minutes)
    if (RT.subs.size && !document.hidden) setTimeout(rtConnect, RT.wait); };
}
// Hear about changes to these tables until the returned function is called. good/bad: connected, or fall back to checking
function rtWatch(topic, tables, on, good, bad) {
  if (!("WebSocket" in window) || !S.cfg) { bad(); return () => {}; }
  const s = {tables, on, good, bad}; RT.subs.set(topic, s);
  if (RT.open) rtJoin(topic, s); else rtConnect();
  return () => { if (RT.subs.get(topic) !== s) return; RT.subs.delete(topic); rtSend({topic: "realtime:" + topic, event: "phx_leave", payload: {}});
    if (!RT.subs.size) { clearInterval(RT.hb); const w = RT.ws; RT.ws = null; RT.open = false; w?.close(); } };
}
document.addEventListener("visibilitychange", () => {  // the background: hang up and use nothing; back in front: reconnect
  if (document.hidden) { if (RT.ws) { clearInterval(RT.hb); const w = RT.ws; RT.ws = null; RT.open = false; w.close(); } }
  else if (RT.subs.size) rtConnect();
});
async function api(path, {method = "GET", body, prefer, retry = true} = {}) {
  if (S.preview && method !== "GET" && !/^rpc\/(app_(me|ask|db_size|last_seen|set_my_name)|church_(numbers|trend|days))\b/.test(path)) throw new Error(viewOnly());  // View as: look, don't change (the church_ ones only read)
  if (S.session && S.session.expires_at - Date.now() < 60000) await refresh();
  const r = await fetch(S.cfg.url + "/rest/v1/" + path, {method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: {apikey: S.cfg.key, Authorization: "Bearer " + (S.session?.access_token || S.cfg.key), "Content-Type": "application/json",
              ...(prefer ? {Prefer: prefer} : {})}});
  if (r.status === 401 && retry && await refresh()) return api(path, {method, body, prefer, retry: false});
  if (r.status === 401) { store.set(null); start(); throw new Error("Please sign in again."); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || "The database refused that."); }
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function all(path) {  // PostgREST returns at most 1000 rows a time
  let out = [], from = 0;
  for (;;) {
    const page = await api(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${from}`);
    out = out.concat(page);
    if (page.length < 1000) return out;
    from += 1000;
  }
}

// Sign in two ways: an emailed code (or the link in the same email), or a password once one has been set.
function loginView(message, bad) {
  let mode = "code"; try { if (localStorage.getItem("fcc-pw")) mode = "pw"; } catch {}
  root.innerHTML = `<div class="center"><form class="login" id="login">
    <div class="brand" style="padding:0"><span class="brand-mark">✝</span>Favourite Child Church</div>
    <h1>Sign in</h1>
    <div class="seg2" role="tablist" aria-label="How to sign in"><button type="button" role="tab" data-m="code">Email code</button><button type="button" role="tab" data-m="pw">Password</button></div>
    <p id="how"></p>
    <label class="f" for="email">Email</label><input class="in" id="email" name="username" type="email" inputmode="email" autocapitalize="none" autocomplete="username" required>
    <div id="pw" hidden><label class="f" for="password">Password</label><input class="in" id="password" name="password" type="password" autocomplete="current-password"></div>
    <div id="code" hidden><label class="f" for="token">Code from the email</label><input class="in" id="token" inputmode="numeric" autocomplete="one-time-code"></div>
    <button class="pill-btn primary block" id="go"></button>
    <button type="button" class="pill-btn block resend" id="resend" hidden disabled></button>
    <button type="button" class="link" id="forgot" hidden>Forgot it? Get an email code instead</button>
    ${message ? `<div class="msg ${bad ? "bad" : ""}">${esc(message)}</div>` : ""}
    <p class="note" style="margin-top:14px">No email? Check Spam. No access? Ask your church admin.</p>
  </form></div>`;
  const f = root.querySelector("#login"), pw = f.querySelector("#pw"), code = f.querySelector("#code"), go = f.querySelector("#go");
  let sent = false, sentTo = "", tick = null;
  const resend = f.querySelector("#resend"), emailIn = f.querySelector("#email");
  const say = (text, bad) => { f.querySelectorAll(".msg").forEach(m => m.remove()); f.insertAdjacentHTML("beforeend", `<div class="msg ${bad ? "bad" : ""}">${esc(text)}</div>`); };
  // "Resend code": grey and counting down for 25 seconds after a code is sent, then a solid button with white text.
  const countdown = (secs = 25) => {
    clearInterval(tick); resend.disabled = true; resend.classList.remove("ready");
    const draw = () => { resend.textContent = secs > 0 ? `Resend code in ${secs}s` : "Resend code"; };
    draw();
    tick = setInterval(() => {
      if (!document.body.contains(resend)) return clearInterval(tick);
      secs -= 1; draw();
      if (secs <= 0) { clearInterval(tick); resend.disabled = false; resend.classList.add("ready"); }
    }, 1000);
  };
  const sendCode = async email => {
    try { await auth("otp?redirect_to=" + encodeURIComponent(location.origin + location.pathname), {email, create_user: true}); }
    catch (err) {  // Supabase allows one email per address every so often and says how long to wait
      const wait = +(err.message.match(/after (\d+) seconds?/i) || [])[1];
      if (wait && sent && email === sentTo) { countdown(wait); say(`Please wait ${wait} seconds, then tap Resend code.`, true); return false; }
      throw err;
    }
    sent = true; sentTo = email; show("code"); countdown();
    say(`Check ${email} for an email from us. Type the code above, or tap the link in the email.`);
    f.querySelector("#token").focus();
    return true;
  };
  const show = m => {
    mode = m; f.querySelectorAll("[data-m]").forEach(b => b.setAttribute("aria-selected", b.dataset.m === m));
    pw.hidden = m !== "pw"; code.hidden = m !== "code" || !sent; f.querySelector("#forgot").hidden = m !== "pw";
    resend.hidden = m !== "code" || !sent;
    f.querySelector("#how").textContent = m === "pw" ? "Use the password you set in the app." : "We'll email you a code. You can also tap the link in that email.";
    go.textContent = m === "pw" ? "Sign in" : sent ? "Sign in with the code" : "Email me a code";
  };
  let had = ""; try { had = localStorage.getItem("fcc-pw") || ""; } catch {}
  if (had) f.querySelector("#email").value = had;
  f.querySelectorAll("[data-m]").forEach(b => b.onclick = () => show(b.dataset.m));
  f.querySelector("#forgot").onclick = () => show("code");
  // Typed the wrong email? Changing it goes back to "Email me a code" for the new address.
  emailIn.addEventListener("input", () => {
    if (!sent || emailIn.value.trim().toLowerCase() === sentTo) return;
    sent = false; clearInterval(tick); f.querySelector("#token").value = ""; f.querySelectorAll(".msg").forEach(m => m.remove()); show(mode);
  });
  resend.onclick = async () => {
    const email = emailIn.value.trim().toLowerCase(), wrong = emailProblem(email);
    if (wrong) return say(wrong, true);
    resend.disabled = true;
    try { if (await sendCode(email)) say(`A new code is on its way to ${email}. Use the newest email.`); }
    catch (err) { say(err.message, true); resend.disabled = false; }
  };
  show(mode);
  f.onsubmit = async e => {
    e.preventDefault();
    const email = f.querySelector("#email").value.trim().toLowerCase(), wrong = emailProblem(email);
    if (wrong) { f.querySelectorAll(".msg").forEach(m => m.remove()); f.insertAdjacentHTML("beforeend", `<div class="msg bad">${esc(wrong)}</div>`); return; }
    go.disabled = true;
    try {
      if (mode === "pw") { const password = f.querySelector("#password").value; keep(await auth("token?grant_type=password", {email, password})); S.via = "password"; try { localStorage.setItem("fcc-pw", email); } catch {}
        rememberPassword(email, password); }
      else if (sent && f.querySelector("#token").value.trim()) { keep(await auth("verify", {type: "email", email, token: f.querySelector("#token").value.trim()})); S.via = "email"; }
      else if (sent && email === sentTo) { go.disabled = false; f.querySelector("#token").focus(); return say("Type the code from the email first, or tap Resend code.", true); }
      else { await sendCode(email); go.disabled = false; return; }
      clearInterval(tick); start();
    } catch (err) {
      go.disabled = false;
      if (mode === "code" && sent) return say(/expired|invalid/i.test(err.message) ? "That code didn't work. Check it, or tap Resend code for a new one." : err.message, true);
      clearInterval(tick); loginView(/invalid login/i.test(err.message) ? "That email and password don't match. Try again, or get an email code instead." : err.message, true); }
  };
}

// Save a new password for the signed-in person (Supabase keeps it; the app only remembers which email has one).
// Password rules: shown as a live checklist under the two boxes, and checked again before saving.
// A passphrase (3 or more words, 16+ characters, e.g. "sunday choir sings loud") is long enough on its own and easier to type,
// so it doesn't need the capital, number and symbol. Supabase must then be set to "No required characters" (see README).
const isPhrase = a => a.trim().length >= 16 && a.trim().split(/\s+/).length >= 3;
const PW_RULES = [
  ["len", "At least 10 characters", (a) => a.length >= 10],
  ["case", "A capital and a small letter", (a) => isPhrase(a) || (/[A-Z]/.test(a) && /[a-z]/.test(a))],
  ["num", "At least one number", (a) => isPhrase(a) || /\d/.test(a)],
  ["sym", "At least one symbol, like ! # @ or ?", (a) => isPhrase(a) || /[!@#$%^&*()_+\-=\[\]{};':"\\|<>?,.\/`~]/.test(a)],  // the same symbols Supabase accepts
  ["same", "Both passwords match", (a, b) => a.length > 0 && a === b],
];
const pwProblem = (a, b) => (PW_RULES.find(([, , ok]) => !ok(a, b)) || [])[1] || "";
// Wires a checklist (ticks) and green/red borders to two password boxes; the button only works when all rules pass.
function pwChecks(box, p1, p2, go) {
  box.innerHTML = `<li class="phrase" data-r="phrase"><i>${svg("checkin")}</i><span>Easiest: a phrase of 3 or more words, 16+ characters, like <b>sunday choir sings loud</b>.</span></li>`
    + PW_RULES.map(([k, t]) => `<li data-r="${k}"><i>${svg("checkin")}</i>${esc(t)}</li>`).join("");
  const draw = () => {
    const a = p1.value, b = p2.value;
    PW_RULES.forEach(([k, , ok]) => {
      const li = box.querySelector(`[data-r="${k}"]`), good = ok(a, b), touched = k === "same" ? b.length > 0 : a.length > 0;
      li.className = good ? "ok" : touched ? "bad" : "";
    });
    const ph = box.querySelector('[data-r="phrase"]'); ph.className = "phrase" + (isPhrase(a) ? " ok" : "");
    ph.querySelector("span").innerHTML = isPhrase(a) ? "Passphrase: long enough, nothing else needed" : "Easiest: a phrase of 3 or more words, 16+ characters, like <b>sunday choir sings loud</b>.";
    for (const k of ["case", "num", "sym"]) box.querySelector(`[data-r="${k}"]`).classList.toggle("skip", isPhrase(a));
    const firstOk = PW_RULES.filter(([k]) => k !== "same").every(([, , ok]) => ok(a, b));
    p1.classList.toggle("ok", firstOk); p1.classList.toggle("bad", a.length > 0 && !firstOk);
    p2.classList.toggle("ok", b.length > 0 && a === b && firstOk); p2.classList.toggle("bad", b.length > 0 && a !== b);
    go.disabled = !!pwProblem(a, b);
  };
  p1.addEventListener("input", draw); p2.addEventListener("input", draw); draw();
  return draw;
}
async function savePassword(a, b) {
  const wrong = pwProblem(a, b); if (wrong) throw new Error(wrong === "Both passwords match" ? "The two passwords don't match." : `The password needs: ${wrong.toLowerCase()}.`);
  if (S.session.expires_at - Date.now() < 60000) await refresh();
  const r = await fetch(S.cfg.url + "/auth/v1/user", {method: "PUT", body: JSON.stringify({password: a}),
    headers: {apikey: S.cfg.key, "Content-Type": "application/json", Authorization: "Bearer " + S.session.access_token}});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const m = j.msg || j.error_description || j.message || "";
    throw new Error(/at least one character|weak|requirements/i.test(m) && isPhrase(a) ? "Passphrases aren't switched on yet. Use a capital, small letter, number and symbol for now, or ask the admin to allow passphrases." : m || "The password was not accepted."); }
  try { localStorage.setItem("fcc-pw", S.me.email); } catch {}
  rememberPassword(S.me.email, a);
}
// Ask the browser to save the password (Chrome, Edge and Android show their own "Save password?"; iPhone offers it from the form).
async function rememberPassword(email, password) {
  try { if (window.PasswordCredential && navigator.credentials?.store) await navigator.credentials.store(new PasswordCredential({id: email, password, name: S.me?.name || email})); } catch {}
}
// After signing in with an email code or link: offer a password for next time, unless they have one or said no for good.
function offerPassword() {
  const key = "fcc-pw-never:" + S.me.email;
  try { if (localStorage.getItem("fcc-pw") === S.me.email || localStorage.getItem(key)) return; } catch { return; }
  const d = document.createElement("div"); d.className = "modal";
  d.innerHTML = `<form class="sheet narrow" role="dialog" aria-modal="true" aria-label="Sign in faster next time">
    <div class="card-head"><h2>Sign in faster next time?</h2></div>
    <p class="note" style="margin-top:0">Set a password to sign in without waiting for an email.</p>
    <input type="email" autocomplete="username" value="${esc(S.me.email)}" readonly hidden>
    <div class="fields"><div><label class="f" for="op1">New password</label><input class="in" id="op1" type="password" autocomplete="new-password" maxlength="72" required></div>
      <div><label class="f" for="op2">Type it again</label><input class="in" id="op2" type="password" autocomplete="new-password" maxlength="72" required></div></div>
    <ul class="pw-rules" id="op-rules" aria-live="polite"></ul>
    <div class="msg bad" id="op-err" hidden></div>
    <div class="modal-foot"><button type="button" class="pill-btn" data-later>Remind me next time</button><button class="pill-btn primary" id="op-go">Save password</button></div>
    <button type="button" class="link" data-never style="display:block;margin:14px auto 0">Don't show this again</button></form>`;
  document.body.append(d);
  const close = () => d.remove();
  d.querySelector("[data-later]").onclick = close;
  const redraw = pwChecks(d.querySelector("#op-rules"), d.querySelector("#op1"), d.querySelector("#op2"), d.querySelector("#op-go"));
  d.querySelector("[data-never]").onclick = () => { try { localStorage.setItem(key, "1"); } catch {} close(); toast("OK. You can set a password any time in Your account."); };
  d.querySelector("form").onsubmit = async e => {
    e.preventDefault(); const go = d.querySelector("#op-go"), err = d.querySelector("#op-err"); go.disabled = true; err.hidden = true;
    try { await savePassword(d.querySelector("#op1").value, d.querySelector("#op2").value); close(); toast("Password saved. Next time choose Password and sign in straight away."); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; redraw(); }
  };
}

async function start() {
  clearInterval(S.poll);
  if (!S.cfg) {
    S.cfg = await fetch("/app-config").then(r => r.json()).catch(() => null);
    if (!S.cfg?.url || !S.cfg?.key) { root.innerHTML = `<div class="center"><p class="empty">The app isn't connected to the database yet.</p></div>`; return; }
  }
  const teamTok = new URLSearchParams(location.search).get("team");  // a Team form link: no sign-in needed
  if (teamTok) return teamForm(teamTok);
  const hash = new URLSearchParams(location.hash.slice(1));  // arriving from the emailed link
  if (hash.get("access_token")) { keep(Object.fromEntries(hash)); history.replaceState(null, "", location.pathname); S.via = "email"; }
  else if (hash.get("error_description")) { history.replaceState(null, "", location.pathname); return loginView(hash.get("error_description").replace(/\+/g, " "), true); }
  S.session = S.session || store.get();
  if (!S.session) return loginView();
  try { S.me = await api("rpc/app_me", {method: "POST", body: {}}); } catch (e) { return S.session ? fatal(e.message) : null; }
  if (!S.me?.role) {
    root.innerHTML = `<div class="center"><div class="login"><h1>Not set up yet</h1>
      <p>${esc(S.me?.email || "This email")} can't use the app yet. Ask your church admin to add it.</p>
      <button class="pill-btn block" id="out">Sign out</button></div></div>`;
    root.querySelector("#out").onclick = signOut; return;
  }
  // An admin or church admin who is also a pastor can switch to Pastor view without signing in again.
  S.me.base = S.me.role;
  S.canSwitch = !!(S.me.pastor && ["admin", "lead"].includes(S.me.role));
  try { if (S.canSwitch && localStorage.getItem("fcc-as:" + S.me.email) === "pastor") S.me.role = "pastor"; } catch {}
  // An admin can look at the app as another role (e.g. an usher at one church) without a second email: see viewAs()
  S.preview = null;
  if (S.me.base === "admin") { let as = null; try { as = JSON.parse(localStorage.getItem("fcc-preview:" + S.me.email) || "null"); } catch {}
    if (as && PREVIEW[as.role]) { S.preview = as; S.canSwitch = false; Object.assign(S.me, {role: as.role === "shepherd" ? "pastor" : as.role, church: as.church || null,  // a Shepherd is a pastor sign-in titled Shepherd
      pastor: ["pastor", "shepherd"].includes(as.role) ? as.pastor : S.me.pastor, title: as.role === "shepherd" ? "Shepherd" : null}); } }
  S.view = S.me.role === "bishop" ? "overview" : S.view;
  if (!S.landed) { S.landed = true; const st = look().start; if (st) S.view = st; }  // the start page this person picked in Settings
  let back = null; try { back = JSON.parse(sessionStorage.getItem("fcc-back") || "null"); sessionStorage.removeItem("fcc-back"); } catch {}
  if (back) {  // just loaded a newer version: open where they were
    if (back.view) S.view = back.view; if (back.date) S.date = back.date; if (back.repTab) S.repTab = back.repTab; if (back.church) S.church = back.church;
    if (back.y) for (const ms of [300, 900, 1800]) setTimeout(() => { if (scrollY < 10) scrollTo(0, back.y); }, ms);  // once the page has drawn
  }
  if (S.me.role !== "bishop") {
    S.churches = (await api("churches?select=name,livestream&order=name")).map(c => c.name);
    S.church = S.me.role === "admin" ? (S.churches.includes(S.church) ? S.church : S.me.home) : S.me.church || S.me.home;
    if (S.me.role === "pastor" && S.me.base === "admin" && !S.preview) S.church = await pastorChurch();
    await load();
    S.pending = canApprove() ? await api("registrations?select=created_at&status=eq.pending").then(newSignups).catch(() => 0) : 0;
  }
  render();
  let seen = true; try { seen = localStorage.getItem("fcc-tour:" + S.me.email) === TOUR_V; } catch {}
  if (!seen && !S.preview) setTimeout(tour, 500);  // first time on this phone or laptop: a short tour of where things are
  else if (S.via === "email") setTimeout(offerPassword, 600);  // just signed in with an email code or link
  S.via = "";
}
// A short welcome tour: a few cards for this person's role on where to find things. Shown once per device; Help can show it again.
const TOUR_V = "2";  // bump this whenever the tour's steps change, so everyone sees the new version once
function tour() {
  const r = S.me.role, phone = matchMedia("(max-width: 1080px)").matches, Q = q => document.querySelector(q);
  // the menu item for a page: in the side menu on laptops; on phones the bottom bar, or More when it isn't there
  const nav = v => () => phone ? Q(`.dock [data-view="${v}"]`) || Q(".top [data-menu]") : Q(`.side .nav[data-view="${v}"]`);
  const more = v => phone && !Q(`.dock [data-view="${v}"]`) ? " Tap More to find it." : "";
  const steps = [[null, "dashboard", 1, "Welcome to FCC Attendance", `A quick look around. See it again any time from Help.`],
    [() => phone ? Q(".top [data-menu]") : Q(".side .ngrp-h") || Q(".side .nav"), "menu", 1, "Menu", r === "pastor" || r === "bishop" ? "Every page is here." : "Every page is here, in groups. Tap a group to open it."],
    ...(r === "bishop" ? [[nav("overview"), "overview", 1, "All churches", "Every church's numbers in one place. Tap a church for its own dashboard, or a day in the calendar to look back."],
                          [() => Q("#addw"), "plus", 4, "Make it yours", "Add widgets, drag them by the handle, or resize them from ⋯. Your layout is only yours."]]
      : r === "pastor" ? [[nav("mine"), "mine", 1, "Home: your people", "Everyone assigned to you, who came, and who needs a call. Tap a name for their history."],
                          [nav("checkin"), "checkin", 2, "Check-in", "Tick your people in at a service. Ushers see the ticks straight away." + more("checkin")]]
      : [[nav("dashboard"), "dashboard", 1, "Dashboard", "How the last service went, at a glance. This is where the app opens."],
         [nav("checkin"), "checkin", 2, "Check-in", "Tick people in as they arrive, or tap a team to tick a group. Press Save & lock when the service is done." + more("checkin")],
         [nav("followup"), "followup", 3, "Follow-up", "Amber (Check in) and red (Needs a call) show who has missed services in a row, so pastors know who to call." + more("followup")],
         [nav("people"), "people", 5, "Congregation", "Everyone on the register. Tap a name for their history. Import people or load an old register from here." + more("people")],
         [() => Q("#addw"), "plus", 4, "Your dashboard", "Add widgets, drag them by the handle, or resize them from ⋯. Your layout is only yours."]]),
    [nav("help"), "help", 6, "Help", "Answers for your role, and Contact the admin if you're stuck." + more("help")],
    [() => Q(".acct"), "person", 1, "Your account", "Your details, password and settings: colours, text size, pages you see."]];
  let i = 0;
  const cover = document.createElement("div"), spot = document.createElement("div"), d = document.createElement("div");
  cover.className = "tour-cover"; spot.className = "tour-spot"; d.className = "tour-pop";
  const done = () => { try { localStorage.setItem("fcc-tour:" + S.me.email, TOUR_V); } catch {} [cover, spot, d].forEach(x => x.remove());
      document.removeEventListener("keydown", onKey); removeEventListener("resize", place); removeEventListener("scroll", place); },
    onKey = e => { if (e.key === "Escape") done(); else if (e.key === "ArrowRight" && i < steps.length - 1) { i++; draw(); } else if (e.key === "ArrowLeft" && i) { i--; draw(); } };
  // ring the menu item for this step and put the card beside it (or in the middle when there's nothing to point at)
  function place() {
    const el = steps[i][0]?.(), r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null, W = innerWidth, H = innerHeight;
    cover.classList.toggle("dim", !r); spot.hidden = !r; d.classList.toggle("mid", !r); d.style.cssText = "";
    if (!r) return;
    const pad = 6; Object.assign(spot.style, {left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px",
      borderRadius: Math.min(parseFloat(getComputedStyle(el).borderRadius) || 12, r.height / 2) + pad + "px"});  // the ring follows the item's shape
    const cw = d.offsetWidth, ch = d.offsetHeight, clampX = x => Math.max(12, Math.min(W - cw - 12, x)), clampY = y => Math.max(12, Math.min(H - ch - 12, y));
    if (!phone && r.right < W * .4) { d.style.left = r.right + 18 + "px"; d.style.top = clampY(r.top + r.height / 2 - ch / 2) + "px"; d.dataset.arrow = "left"; }
    else if (r.top > H / 2) { d.style.left = clampX(r.left + r.width / 2 - cw / 2) + "px"; d.style.top = r.top - ch - 18 + "px"; d.dataset.arrow = "down"; }
    else { d.style.left = clampX(r.right - cw) + "px"; d.style.top = r.bottom + 18 + "px"; d.dataset.arrow = "up"; }
  }
  const draw = () => {
    const [at, ic, h, t, x] = steps[i], last = i === steps.length - 1;
    d.innerHTML = `<div role="dialog" aria-modal="true" aria-label="Welcome tour"><div class="tour-head"><span class="tour-ico" style="--wc:var(--h${h});--wb:var(--h${h}b)">${svg(ic)}</span>
      <h2>${esc(t)}</h2></div><p>${esc(x)}</p>
      <div class="tour-foot"><span class="tour-dots" aria-label="Step ${i + 1} of ${steps.length}">${steps.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("")}</span>
        ${last ? "" : `<button type="button" class="pill-btn sm" data-skip>Skip</button>`}
        ${i ? `<button type="button" class="pill-btn sm" data-prev>Back</button>` : ""}<button type="button" class="pill-btn sm primary" data-next>${last ? "Got it" : "Next"}</button></div></div>`;
    d.querySelector("[data-next]").onclick = () => last ? done() : (i++, draw());
    d.querySelector("[data-prev]")?.addEventListener("click", () => { i--; draw(); });
    d.querySelector("[data-skip]")?.addEventListener("click", done);
    const el = at?.(); el?.closest(".ngrp:not(.open)")?.classList.add("open");  // a page in a closed menu group: open the group so it can be ringed
    if (el) el.scrollIntoView({block: "nearest"});
    place(); requestAnimationFrame(place); setTimeout(place, 350);  // again once the page and the bottom bar have settled d.querySelector("[data-next]").focus({preventScroll: true});
  };
  document.querySelectorAll(".modal, .tour-cover, .tour-spot, .tour-pop").forEach(m => m.remove());
  document.body.append(cover, spot, d); document.addEventListener("keydown", onKey); addEventListener("resize", place); addEventListener("scroll", place, {passive: true}); draw();
}
// Which church's pastor list has this person's pastor name (for the main admin, who has no single church)
async function pastorChurch() {
  const lists = await api("settings?select=key,value&key=like.pastors:*").catch(() => []);
  const hit = lists.find(r => (r.value || "").split("\n").some(n => norm(n) === norm(S.me.pastor)));
  return hit && S.churches.includes(hit.key.slice(8)) ? hit.key.slice(8) : S.me.home;
}
async function switchView(to) {
  try { localStorage.setItem("fcc-as:" + S.me.email, to); } catch {}
  S.view = to === "pastor" ? "mine" : "dashboard"; S.hist = []; S.shown = "";
  await start();
  toast(to === "pastor" ? `${pview()} view: just your own people.` : `Back to ${baseName()} view.`);
}
// View as: the admin picks a role (and church, and pastor name for Pastor) and the whole app shows what that person would see.
// Only the screens change, and it's view only: nothing is saved while viewing as someone else (see api()).
const viewOnly = () => `You're viewing as ${previewName()}, which is view only. Tap Back to Admin to make changes.`;
const PREVIEW = {team: "Team (usher)", lead: "Church admin", pastor: "Pastor", shepherd: "Shepherd", bishop: "Bishop"};
function viewAs() {
  const allP = [...new Set(Object.values(S.pastorList || {}).flat())], allS = [...new Set(Object.values(S.shepherdList || {}).flat())];
  formDialog("View the app as another role", [
    {k: "role", label: "Role", type: "select", value: "team", options: Object.entries(PREVIEW)},
    {k: "church", label: "Church", type: "select", value: S.church, options: S.churches.map(c => [c, c]), hint: "Not used for Bishop, who sees every church."},
    {k: "pastor", label: "Pastor or shepherd name (only for Pastor or Shepherd)", value: "", suggest: [...allP, ...allS], hint: "As it is on the Pastors or Shepherds list. It decides whose people show."}],
    async v => {
      const care = v.role === "pastor" || v.role === "shepherd", lists = v.role === "shepherd" ? S.shepherdList : S.pastorList, word = v.role === "shepherd" ? "Shepherds" : "Pastors";
      if (care && !v.pastor) throw new Error(`Type a name as it is on the ${word} list.`);
      if (care) { const hit = Object.entries(lists || {}).find(([, l]) => l.some(n => norm(n) === norm(v.pastor))); if (hit) v.church = hit[0]; }
      try { localStorage.setItem("fcc-preview:" + S.me.email, JSON.stringify({role: v.role, church: v.role === "bishop" ? null : v.church, pastor: v.pastor || ""})); } catch {}
      S.view = v.role === "bishop" ? "overview" : care ? "mine" : "dashboard"; S.hist = []; S.shown = "";
      await start(); toast(`Now showing the app as ${PREVIEW[v.role]}. Tap Back to Admin at the top to return.`);
    }, "Show me");
}
async function endPreview() {
  try { localStorage.removeItem("fcc-preview:" + S.me.email); } catch {}
  S.view = "dashboard"; S.hist = []; S.shown = ""; await start(); toast("Back to your Admin view.");
}
const previewName = () => S.preview ? `${PREVIEW[S.preview.role]}${["pastor", "shepherd"].includes(S.preview.role) ? " · " + S.preview.pastor : ""}${S.preview.church ? " · " + S.preview.church : ""}` : "";
const pview = () => S.me.role3 === "Reverend" ? "Reverend" : "Pastor";  // an admin whose second role is Reverend switches to Reverend view
const switchLabel = () => S.me.role === "pastor" ? `Switch to ${baseName()} view` : `Switch to ${pview()} view`;
function fatal(text) { root.innerHTML = `<div class="center"><div class="login"><h1>Something went wrong</h1><p>${esc(text)}</p><button class="pill-btn block" onclick="location.reload()">Try again</button></div></div>`; }
async function signOut() { try { await auth("logout", {}, S.session?.access_token); } catch {} store.set(null); S.me = null; loginView(); }

// ---------------------------------------------------------------- data for the church being looked at
async function load() {
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const [members, ticks, services, seen, lists, parts, pticks] = await Promise.all([
    all("members?select=id,full_name,phone,email,address,birthday,type,status,age_group,gender,pastor,shepherd,church,role,group_name,date_joined,first_visit,created_at,version&order=full_name")
      .catch(() => all("members?select=id,full_name,phone,email,address,type,status,age_group,gender,pastor,shepherd,church,role,group_name,date_joined,first_visit,created_at,version&order=full_name"))  // before the birthday column is added
      .catch(() => all("members?select=id,full_name,phone,type,status,age_group,gender,pastor,church,role,date_joined,first_visit,created_at,version&order=full_name"))  // before the address column is added
      .catch(() => all("members?select=id,full_name,phone,type,status,age_group,pastor,church,role,date_joined,first_visit,created_at,version&order=full_name")),
    all(`attendance?select=service_date,member_id,checked_at&service_date=gte.${since}&order=service_date`),
    all(`services?select=service_date,name&service_date=gte.${since}`),
    api("rpc/app_last_seen", {method: "POST", body: {}}).catch(() => null),  // null until the newer setup SQL has been run
    api("settings?select=key,value&key=like.pastors:*").catch(() => []),  // each church's list of pastors to choose from
    // days split into more than one service (null until the newer setup SQL has been run)
    all(`service_parts?select=service_date,part,name&church=eq.${encodeURIComponent(S.church)}&service_date=gte.${since}&order=service_date,part`).catch(() => null),
    all(`service_ticks?select=service_date,part,member_id&service_date=gte.${since}`).catch(() => [])]);
  S.pastorList = Object.fromEntries(lists.map(r => [r.key.slice(8), (r.value || "").split("\n").map(x => x.trim()).filter(Boolean)]));
  S.statusRules = await api("rpc/app_status_rules", {method: "POST", body: {}}).catch(() => S.statusRules || {});  // Settings → Statuses, per church
  S.shepherdList = await api("settings?select=key,value&key=like.shepherds:*")
    .then(r => Object.fromEntries(r.map(x => [x.key.slice(10), (x.value || "").split("\n").map(y => y.trim()).filter(Boolean)]))).catch(() => ({}));
  S.seen = seen && Object.fromEntries(seen.map(r => [r.member_id, r.last_seen]));
  S.members = S.me.role === "pastor" && S.me.base !== "pastor"  // an admin in Pastor view: only the people assigned to them
    ? members.filter(m => careOf(m).some(n => norm(n) === norm(S.me.pastor))) : members;
  S.ticks = ticks; S.names = Object.fromEntries(services.map(s => [s.service_date, s.name]));
  S.partsOk = parts !== null; S.parts = {}; for (const r of parts || []) (S.parts[r.service_date] ??= []).push({part: r.part, name: r.name});
  S.pticks = pticks;
  S.bacList = await all("bacentas?select=id,church,name,shepherd,pastor,meet_day,active,created_at&order=name").catch(() => null);  // for Check-in's Service | Bacenta switch
  S.bacHelp = await all("bacenta_helpers?select=bacenta,email,role").catch(() => []);  // who leads or assists which Bacenta
  // names added at a Bacenta waiting for a church admin to approve (the count on the Bacentas menu item)
  S.bacPending = ["admin", "lead"].includes(S.me.role) ? (await all("bacenta_guests?select=id,bacenta&status=eq.pending").catch(() => []))
    .filter(g => (S.bacList || []).some(b => b.id === g.bacenta && b.church === S.church)).length : 0;
}
// Before a page opens: what may have changed lately (people, and the last two weeks' ticks and services). Quicker than load().
let freshAt = 0;
async function freshen() {
  if (Date.now() - freshAt < 15000) return false;  // just done
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const [members, ticks, services, parts, pticks, pending, teamPending] = await Promise.all([
    all("members?select=id,full_name,phone,email,address,birthday,type,status,age_group,gender,pastor,shepherd,church,role,group_name,date_joined,first_visit,created_at,version&order=full_name")
      .catch(() => all("members?select=id,full_name,phone,email,address,type,status,age_group,gender,pastor,shepherd,church,role,group_name,date_joined,first_visit,created_at,version&order=full_name"))  // before the birthday column is added
      .catch(() => all("members?select=id,full_name,phone,type,status,age_group,gender,pastor,church,role,date_joined,first_visit,created_at,version&order=full_name"))
      .catch(() => all("members?select=id,full_name,phone,type,status,age_group,pastor,church,role,date_joined,first_visit,created_at,version&order=full_name")),
    all(`attendance?select=service_date,member_id,checked_at&service_date=gte.${since}&order=service_date`),
    all(`services?select=service_date,name&service_date=gte.${since}`),
    all(`service_parts?select=service_date,part,name&church=eq.${encodeURIComponent(S.church)}&service_date=gte.${since}&order=service_date,part`).catch(() => null),
    all(`service_ticks?select=service_date,part,member_id&service_date=gte.${since}`).catch(() => null),
    canApprove() ? api("registrations?select=created_at&status=eq.pending").then(newSignups).catch(() => S.pending) : 0,
    canTeam() ? api("team_requests?select=id&status=eq.pending").then(r => r.length).catch(() => 0) : 0]);  // all at once, not one after another
  const sig = JSON.stringify([members, ticks, services, parts, pticks, pending, teamPending]), changed = sig !== S.freshSig; S.freshSig = sig;
  S.members = S.me.role === "pastor" && S.me.base !== "pastor" ? members.filter(m => careOf(m).some(n => norm(n) === norm(S.me.pastor))) : members;
  S.ticks = S.ticks.filter(t => t.service_date < since).concat(ticks);
  for (const k of Object.keys(S.names)) if (k >= since) delete S.names[k];
  for (const s of services) S.names[s.service_date] = s.name;
  if (parts) { for (const k of Object.keys(S.parts)) if (k >= since) delete S.parts[k]; for (const r of parts) (S.parts[r.service_date] ??= []).push({part: r.part, name: r.name}); }
  if (pticks) S.pticks = S.pticks.filter(t => t.service_date < since).concat(pticks);
  S.pending = pending; S.teamPending = teamPending; freshAt = Date.now();
  return changed;  // true when anything is different from last time (the first time too)
}
// A day split into services (two or more): each one's name and how many of this church's people came to it.
// The day's own ticks still decide who was there, so someone at both services counts once in the day's total.
const partsOf = d => (S.parts?.[d] || []).length > 1 ? S.parts[d] : [];
const ORDINAL = ["", "First", "Second", "Third", "Fourth", "Fifth"];
// A service's name on a day with more than one: the name it was given, or "First service", "Second service"…
const partName = (d, n) => { const x = partsOf(d).find(x => x.part === n)?.name; return x && x !== "Service" ? x : `${ORDINAL[n] || "Another"} service`; };
function partCounts(p, d) {
  const day = p.byDate[d] || {};
  return partsOf(d).map(x => ({...x, n: new Set(S.pticks.filter(t => t.service_date === d && t.part === x.part && day[t.member_id]).map(t => t.member_id)).size}));
}
const isSunday = d => new Date(d + "T12:00:00").getDay() === 0;
function picture(upTo = today()) {  // everything the pages show, as things stood on upTo (today unless a past service is asked for)
  const mine = S.members.filter(m => churchOf(m) === S.church);
  const ids = new Set(mine.map(m => m.id)), byDate = {};
  for (const t of S.ticks) if (ids.has(t.member_id) && t.service_date <= upTo) (byDate[t.service_date] ??= {})[t.member_id] = t.checked_at;
  const dates = Object.keys(byDate).sort(), cutoff = new Date(Date.now() - ARCHIVE_DAYS * 864e5).toISOString().slice(0, 10);
  const people = [], archived = [];
  for (const m of mine) {
    if (ruleOf(m) !== "in") continue;  // only statuses set to stay on the lists are in Follow-up (Settings → Statuses)
    const start = [m.date_joined, m.first_visit].filter(Boolean).sort()[0] || "0000";
    let missed = 0, seen = null;
    // only Sunday services count as missed; coming to any service (midweek too) counts as being seen
    for (let i = dates.length - 1; i >= 0 && dates[i] >= start; i--) { if (byDate[dates[i]][m.id]) { seen = dates[i]; break; } if (isSunday(dates[i])) missed++; }
    if (!seen) seen = [...dates].reverse().find(d => byDate[d][m.id]) || S.seen?.[m.id] || null;
    const sign = seen || (start !== "0000" ? start : (m.created_at || "").slice(0, 10));
    if (sign && sign < cutoff) { archived.push({...m, seen, kid: isKid(m)}); continue; }  // not seen for two years
    const level = m.type === "visitor" ? "ok" : missed >= RED_AT ? "red" : missed >= YELLOW_AT ? "yellow" : "ok";
    people.push({...m, missed, seen, level, flag: level !== "ok" ? level : missed && m.type !== "visitor" ? "blue" : "ok", kid: isKid(m)});
  }
  const last = dates[dates.length - 1], here = last ? byDate[last] : {};
  const present = mine.filter(m => here[m.id]);
  const order = {red: 0, yellow: 1, blue: 2, ok: 3};
  people.sort((a, b) => order[a.flag] - order[b.flag] || b.missed - a.missed || norm(a.full_name).localeCompare(norm(b.full_name)));
  return {mine, people, archived, dates, byDate, last, here, present, kids: present.filter(isKid).length,
          first: present.filter(m => m.type === "first_timer").length, visitors: present.filter(m => m.type === "visitor").length,
          count: f => people.filter(p => p.flag === f).length};
}

// ---------------------------------------------------------------- page frame
const ICON = {
  expand: '<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/>',
  shrink: '<path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/>',
  calpick: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  caret: '<path d="M7 10l5 5 5-5"/>',
  tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  summary: '<path d="M20 11.5a8 8 0 0 1-11.6 7.2L4 20l1.3-4.2A8 8 0 1 1 20 11.5z"/><path d="M8.5 10h7M8.5 13.5h4.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  upload: '<path d="M12 15V4"/><path d="M7 9l5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  dashboard: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  live: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  checkin: '<path d="M5 12l5 5 9-10"/>',
  followup: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  people: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  overview: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  mine: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  inbox: '<path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h4.5l1 2h5l1-2H20"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  dots: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bars: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  gauge: '<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/>',
  compare: '<path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/>',
  split: '<rect x="3" y="9" width="18" height="6" rx="3"/><path d="M10 9v6M15 9v6"/>',
  pastors: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a7 7 0 0 1 4 6.5"/>',
  person: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  signups: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h5"/>',
  shepherds: '<path d="M9 21V9a4 4 0 1 1 8 0v1"/><path d="M6 21h6"/><circle cx="17" cy="12.5" r=".6"/>',
  bacentas: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><circle cx="9.5" cy="14" r="1.6"/><circle cx="14.5" cy="14" r="1.6"/><path d="M7.5 20a2 2 0 0 1 4 0M12.5 20a2 2 0 0 1 4 0"/>',
  teamforms: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 11l2 2 4-4"/>',
  archive: '<rect x="3" y="5" width="18" height="4" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  reports: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 8l9 6 9-6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  ask: '<path d="M4 5h16v11H9l-5 4z"/><path d="M9 9.5h6M9 12.5h4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><path d="M12 17h.01"/>',
  out: '<path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
// A church's short name for the icons-only menu: the first letters of its words ("New Plymouth" -> NP), or the first three
// letters of a one-word name ("Auckland" -> AUC)
const churchAbbr = c => { const w = String(c || "").trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w.slice(0, 3).map(x => x[0]) .join("") : (w[0] || "").slice(0, 3)).toUpperCase(); };
// The menu's groups open and close like dropdowns; the one with the page you're on is open. A group of one is just its page.
const GICON = {ATTENDANCE: "checkin", PEOPLE: "people", SHARE: "reports", CHURCHES: "overview", ADMIN: "admin", RECORDS: "activity"};
function menuOpen() { try { return JSON.parse(localStorage.getItem("fcc-menu-open:" + (S.me?.email || "")) || "[]"); } catch { return []; } }
function navGroup(h, items, btns) {
  if (!h || items.length < 2) return btns;
  const here = items.some(([k]) => k === S.view), open = here || menuOpen().includes(h), name = h.charAt(0) + h.slice(1).toLowerCase();
  const n = items.reduce((t, [k]) => t + (k === "signups" ? S.pending || 0 : k === "teamforms" ? S.teamPending || 0 : k === "bacentas" ? S.bacPending || 0 : 0), 0);
  return `<div class="ngrp${open ? " open" : ""}"><button type="button" class="nav ngrp-h" data-grp="${h}" aria-expanded="${open}" title="${name}">${svg(GICON[h] || items[0][0])}<span class="nl">${name}</span>${n ? `<span class="count">${n}</span>` : ""}<span class="ngrp-c">${svg("caret")}</span></button><div class="ngrp-b">${btns}</div></div>`;
}
function pages() {  // the menu, in groups; what each role can actually load is decided by the database
  const r = S.me.role;
  if (r === "bishop") return [["", [["overview", "All churches"], ["help", "Help"]]]];
  if (r === "pastor") return [["", [["mine", "Home"], ["checkin", "Check-in"], ...((S.bacList || []).some(b => b.active && bacMine(b)) ? [["bacentas", "Bacentas"]] : []), ["ask", "Ask a question"], ["help", "Help"]]]];  // a pastor: just their own people (and the Bacentas they oversee or shepherd)
  // Grouped by what people come to do: take attendance, look after people, share the numbers, run the churches, settings
  return [["ATTENDANCE", [["dashboard", "Dashboard"], ["checkin", "Check-in"], ["followup", "Follow-up"]]],
          ["PEOPLE", [["people", "Congregation"], ["pastors", "Pastors"], ["shepherds", "Shepherds"], ...(["admin", "lead"].includes(r) || (S.bacList || []).some(b => b.active && bacMine(b)) ? [["bacentas", "Bacentas"]] : []), ...(canApprove() ? [["signups", "Sign-ups"]] : []), ...(canTeam() ? [["teamforms", "Team forms"]] : []), ["archive", "Archive"]]],
          ["SHARE", [["reports", "Reports"]]],
          ...(r === "admin" ? [["CHURCHES", [["overview", "Churches"]]]] : []),
          ...(r === "team" ? [] : [[r === "admin" ? "ADMIN" : "RECORDS", [...(r === "admin" ? [["admin", "Admin"]] : []), ["activity", "Activity log"]]]]),
          ["", [["ask", "Ask a question"], ["help", "Help"]]]];
}
// Settings each person picks for themselves: colour, theme, text size and so on. Kept on this phone or laptop, per person.
const ACCENTS = [["#1f6fe5", "Blue"], ["#0e8a7c", "Teal"], ["#6250d6", "Violet"], ["#c8417a", "Pink"], ["#dc5f26", "Orange"], ["#2b9348", "Green"], ["#b8860b", "Gold"]];
const LOOK0 = {accent: "", theme: "", text: "normal", motion: false, contrast: false, muted: false, start: "", share: [], liveFill: false, home: "", hide: []};  // hide: pages left out of this person's menu  // home: "" opens the home-screen icon in the browser, "app" full screen
const sysDark = matchMedia("(prefers-color-scheme: dark)");
function look() { let v = {}; try { v = JSON.parse(localStorage.getItem("fcc-look:" + (S.me?.email || "")) || "{}"); } catch {} return {...LOOK0, ...v}; }
function saveLook(ch) {
  const v = ch ? {...look(), ...ch} : {...LOOK0};
  try { if (ch) localStorage.setItem("fcc-look:" + (S.me?.email || ""), JSON.stringify(v)); else localStorage.removeItem("fcc-look:" + (S.me?.email || "")); } catch {}
  applyLook(v); return v;
}
function inkOn(hex) {  // white or near-black text, whichever reads better on this colour
  const n = parseInt(hex.slice(1), 16), [r, g, b] = [n >> 16, n >> 8 & 255, n & 255].map(c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b > .4 ? "#10151c" : "#ffffff";
}
// Full screen (hides the browser's bars) where the browser allows it: Android, iPad and computers. iPhones don't allow it for
// web pages, and it isn't needed when the app already opens full screen from the home screen.
const fsOk = () => !!(document.fullscreenEnabled && document.documentElement.requestFullscreen) && !matchMedia("(display-mode: standalone)").matches
  && onPhone() && matchMedia("(max-width: 900px)").matches;  // phones only
document.addEventListener("fullscreenchange", () => document.querySelectorAll("[data-fs]").forEach(b => {
  const on = !!document.fullscreenElement; b.innerHTML = svg(on ? "shrink" : "expand"); b.title = on ? "Show the browser again" : "Full screen: hide the browser";
  b.setAttribute("aria-label", on ? "Exit full screen" : "Full screen"); }));
function applyLook(v = look()) {
  const d = document.documentElement;
  setMode(v.theme === "system" ? (sysDark.matches ? "dark" : "light") : v.theme || d.dataset.theme);
  if (/^#[0-9a-f]{6}$/i.test(v.accent)) { d.style.setProperty("--accent", v.accent); d.style.setProperty("--accent-ink", inkOn(v.accent));
    d.style.setProperty("--accent-soft", `color-mix(in srgb, ${v.accent} 14%, var(--panel))`); }
  else ["--accent", "--accent-ink", "--accent-soft"].forEach(k => d.style.removeProperty(k));
  d.dataset.text = v.text; d.classList.toggle("calm", !!v.motion); d.classList.toggle("strong", !!v.contrast); d.classList.toggle("muted", !!v.muted);
  // the home-screen icon: the phone reads this when the app is added to the home screen (full screen, or in the browser)
  const man = document.querySelector('link[rel="manifest"]'); if (man) man.href = v.home === "app" ? "/app/manifest-app.webmanifest" : "/app/manifest.webmanifest";
  let cap = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
  if (v.home === "app" && !cap) { cap = Object.assign(document.createElement("meta"), {name: "apple-mobile-web-app-capable", content: "yes"}); document.head.append(cap); }
  else if (v.home !== "app") cap?.remove();
}
sysDark.addEventListener?.("change", () => { if (S.me && look().theme === "system") applyLook(); });
function setMode(mode, remember) {
  document.documentElement.dataset.theme = mode;
  if (remember) { try { localStorage.setItem("fcc-mode", mode); } catch {} }
  document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === mode));
}
function render() {
  clearInterval(S.poll); S.poll = 0; S.unwatch?.(); S.unwatch = null; S.onShow = null;  // the last page's listening stops
  const moved = S.shown !== S.view;  // a different page: it eases in (see pageIn)
  if (S.shown && S.shown !== S.view && !S.goingBack) {  // moved to another page: remember where from
    S.hist = [...(S.hist || []), S.shown].slice(-30);
    try { history.pushState({fcc: S.hist.length}, ""); } catch {}
  }
  if (S.view === "checkin" && S.shown !== "checkin") { S.ciTopOpen = false; if (S.ciModeKeep) S.ciModeKeep = false; else ciDefaultMode(); }  // Service or Bacenta  // the Service card starts folded each time you come to Check-in
  S.goingBack = false; S.shown = S.view;
  const groups = pages(), who = S.me.name || S.me.email, allowed = [...groups.flatMap(g => g[1].map(x => x[0])), "account", ...(S.me.role === "bishop" ? [] : ["person"])];
  if (S.view === "summary") { S.view = "reports"; S.repTab = "summary"; }  // the WhatsApp summary is a tab on Reports now
  if (!allowed.includes(S.view)) S.view = allowed[0];
  const short = {dashboard: "Home", overview: "Churches", people: "People", followup: "Follow-up"};  // the bottom bar on phones: the four most-used pages, then More
  // pages someone turned off in Settings → Pages you see: left out of their menu and bottom bar (the first page always stays)
  const hid = new Set(look().hide || []), menuGroups = groups.map(([h, items]) => [h, items.filter(([k]) => !hid.has(k) || k === allowed[0])]).filter(g => g[1].length);
  const dock = menuGroups.flatMap(g => g[1]).filter(x => ["mine", "dashboard", "checkin", "followup", "people", "overview"].includes(x[0])).slice(0, 5).map(([k, t]) => [k, short[k] || t]);
  const go = to => {  // a page opens straight away from what's already loaded; the latest is fetched behind it, and only if
    // something changed is the page redrawn, in place (same scroll, and not while a box is open or someone is typing)
    const me = S.goTok = (S.goTok || 0) + 1; S.view = to; render();
    freshen().then(changed => {
      if (!changed || me !== S.goTok || S.view !== to || document.querySelector(".modal") || document.activeElement?.matches?.("input, textarea, select")) return;
      const y = scrollY; render(); scrollTo(0, y);
    }).catch(() => {});
  };
  const where = S.me.role === "bishop" ? "All churches" : S.church;
  if (S.mini === undefined) { try { S.mini = localStorage.getItem("fcc-mini") === "1"; } catch { S.mini = false; } }
  root.innerHTML = `<div class="shell ${S.mini ? "mini" : ""}">
    <div class="scrim" data-close></div>
    <aside class="side" id="menu"><div class="brand"><button type="button" class="brand-home" data-view="${allowed[0]}" title="Go to the home page" aria-label="Favourite Child Church: go to the home page"><span class="brand-mark">✝</span><span class="brand-txt">Favourite Child Church</span></button>
        <button type="button" class="side-tg" data-mini aria-label="${S.mini ? "Show menu names" : "Icons only"}" title="${S.mini ? "Show menu names" : "Icons only"}" aria-pressed="${!!S.mini}">${svg("panel")}</button></div>
      ${S.me.role === "bishop" ? "" : `<div class="side-church">${S.me.role === "admin"  // the church being worked in, at the top; only an admin can change it
        ? `<button type="button" class="church on" data-chpick aria-haspopup="listbox" aria-expanded="false" title="Working in ${esc(S.church)}: tap to switch church"><i></i><b class="ch-ab" aria-hidden="true">${esc(churchAbbr(S.church))}</b><span>${esc(S.church)}</span><em>Change</em></button>`
        : `<div class="church on" title="Your church"><i></i><b class="ch-ab" aria-hidden="true">${esc(churchAbbr(S.church))}</b><span>${esc(S.church)}</span></div>`}</div>`}
      ${menuGroups.map(([h, items]) => navGroup(h, items, items.map(([k, t]) => `<button class="nav ${S.view === k ? "on" : ""}" data-view="${k}" title="${t}" style="--nc:var(--h${NAVHUE[k] || 1})">${svg(k)}<span class="nl">${t}</span>${
        k === "signups" && S.pending ? `<span class="count">${S.pending}</span>` : k === "teamforms" && S.teamPending ? `<span class="count">${S.teamPending}</span>` : k === "bacentas" && S.bacPending ? `<span class="count" title="Names added at a Bacenta waiting for you to approve">${S.bacPending}</span>` : ""}</button>`).join(""))).join("")}
      <div class="side-foot">${S.me.base === "admin" ? (S.preview ? `<button class="nav" data-unpreview title="Back to Admin">${svg("back")}<span class="nl">Back to Admin</span></button>`
          : `<button class="nav" data-viewas title="View as another role">${svg("eye")}<span class="nl">View as another role</span></button>`) : ""}${S.canSwitch ? `<button class="nav" data-switch title="${switchLabel()}">${svg("pastors")}<span class="nl">${switchLabel()}</span></button>` : ""}<button class="nav out" data-out title="Log out">${svg("out")}<span class="nl">Log out</span></button></div></aside>
    <main class="main">${S.preview ? `<div class="preview-bar">${svg("eye")}<span>Viewing as <b>${esc(previewName())}</b>. View only: nothing you do here is saved.</span>
        <button class="pill-btn sm" data-unpreview>Back to Admin</button></div>` : ""}<div class="top"><button type="button" class="menu-tg" data-menu aria-label="Menu" aria-controls="menu" aria-expanded="false">${svg("menu")}</button>${S.hist?.length && S.view !== allowed[0] ? `<button class="back" data-back>${svg("back")}Back</button>` : ""}<span class="gap"></span>
        ${fsOk() ? `<button class="refresh-btn fs-btn" data-fs title="${document.fullscreenElement ? "Show the browser again" : "Full screen: hide the browser"}" aria-label="${document.fullscreenElement ? "Exit full screen" : "Full screen"}">${svg(document.fullscreenElement ? "shrink" : "expand")}</button>` : ""}
        ${S.me.role === "bishop" ? "" : `<button class="refresh-btn" data-refresh title="Load the latest check-ins and changes" aria-label="Refresh">${svg("refresh")}<span>Refresh</span></button>`}
        <div class="mode" role="group" aria-label="Colour mode"><button data-mode="light">Light</button><button data-mode="dark">Dark</button></div>
        <button class="acct" data-view="account" title="Your account and settings" aria-label="Your account and settings"><span class="acct-pic">${esc(initials(who))}</span><span><b>${esc(who)}</b><small>${roleName(S.me)} · ${esc(where)}</small></span></button>
        <button class="out-btn" data-out title="Log out">${svg("out")}<span>Log out</span></button></div>
      <div class="body" id="view"></div></main>
    <nav class="dock" aria-label="Main">${dock.map(([k, t]) => `<button class="${S.view === k ? "on" : ""} ${t.length > 9 ? "long" : ""}" data-view="${k}" aria-label="${t}">${svg(k)}<span>${t}</span></button>`).join("")}
</nav></div>`;  // everything else: the ☰ menu at the top left
  const shell = root.querySelector(".shell"), menuBtn = root.querySelector("[data-menu]");
  const menu = open => { shell.classList.toggle("open", open); menuBtn.setAttribute("aria-expanded", open); };
  S.menu = menu;  // the phone swipe below opens and closes it too
  menuBtn.onclick = () => menu(!shell.classList.contains("open"));
  root.querySelector("[data-mini]").onclick = e => {  // laptop menu: icons only, or icons with names; remembered on this device
    S.mini = !S.mini; try { localStorage.setItem("fcc-mini", S.mini ? "1" : "0"); } catch {}
    shell.classList.toggle("mini", S.mini); const b = e.currentTarget, t = S.mini ? "Show menu names" : "Icons only";
    b.setAttribute("aria-pressed", S.mini); b.setAttribute("aria-label", t); b.title = t;
  };
  root.querySelector("[data-close]").onclick = () => menu(false);
  document.onkeydown = e => { if (e.key === "Escape") menu(false); };
  applyLook();
  root.querySelectorAll("[data-view]").forEach(b => b.onclick = () => go(b.dataset.view));
  root.querySelectorAll("[data-grp]").forEach(b => b.onclick = () => {  // open or close a menu group in place; remembered on this device
    const g = b.closest(".ngrp"), on = !g.classList.contains("open"); g.classList.toggle("open", on); b.setAttribute("aria-expanded", on);
    const list = new Set(menuOpen()); if (on) list.add(b.dataset.grp); else list.delete(b.dataset.grp);
    try { localStorage.setItem("fcc-menu-open:" + (S.me?.email || ""), JSON.stringify([...list])); } catch {} });
  // Change church: a short list opens right there; picking one switches church and stays on the same page
  root.querySelectorAll("[data-chpick]").forEach(b => b.onclick = e => {
    e.stopPropagation();
    const old = document.querySelector(".ch-pop"); if (old) { old.remove(); b.setAttribute("aria-expanded", "false"); return; }
    const pop = document.createElement("div"), r = b.getBoundingClientRect(), mini = root.querySelector(".shell.mini") && innerWidth > 900;
    pop.className = "ch-pop"; pop.setAttribute("role", "listbox"); pop.setAttribute("aria-label", "Churches");
    pop.innerHTML = `<p>Switch church</p>${S.churches.map(c => `<button type="button" role="option" aria-selected="${c === S.church}" data-chto="${esc(c)}"><i></i><span>${esc(c)}</span>${c === S.me.home ? "<small>Home</small>" : ""}${c === S.church ? svg("tick") : ""}</button>`).join("")}
      <button type="button" class="ch-all" data-chall>${svg("overview")}See all churches</button>`;
    document.body.append(pop);
    const h = pop.offsetHeight, top = Math.max(8, Math.min(r.bottom + 6, innerHeight - h - 8));
    Object.assign(pop.style, {left: (mini ? r.right + 8 : r.left) + "px", top: (mini ? Math.max(8, Math.min(r.top, innerHeight - h - 8)) : top < r.bottom ? Math.max(8, r.top - h - 6) : top) + "px", width: mini ? "240px" : Math.max(220, r.width) + "px"});
    b.setAttribute("aria-expanded", "true");
    const close = () => { pop.remove(); b.setAttribute("aria-expanded", "false"); document.removeEventListener("click", out, true); document.removeEventListener("keydown", key); },
      out = ev => { if (!pop.contains(ev.target) && ev.target !== b && !b.contains(ev.target)) close(); },
      key = ev => { if (ev.key === "Escape") { close(); b.focus(); } };
    setTimeout(() => document.addEventListener("click", out, true));
    document.addEventListener("keydown", key);
    pop.querySelector('[aria-selected="true"]')?.focus();
    pop.onclick = ev => {
      const t = ev.target.closest("[data-chto]"), all = ev.target.closest("[data-chall]"); if (!t && !all) return;
      close(); menu(false);
      if (all) return go("overview");
      if (t.dataset.chto === S.church) return;
      S.church = t.dataset.chto; render(); toast(`Now in ${S.church}.`);
    };
  });
  root.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { setMode(b.dataset.mode, true); if (look().theme) saveLook({theme: b.dataset.mode}); });
  root.querySelectorAll("[data-out]").forEach(b => b.onclick = signOut);
  // Refresh: loads the latest check-ins and changes made by others, only when tapped (nothing runs in the background,
  // so no battery use and the page never moves while someone is working on it). The page stays where it was scrolled to.
  root.querySelectorAll("[data-fs]").forEach(b => b.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({navigationUI: "hide"})).catch(() => toast("This browser won't go full screen.")));
  root.querySelectorAll("[data-refresh]").forEach(b => { if (S.newVersion) { b.classList.add("new"); b.title = "A newer version of the app is ready: tap to load it"; } });
  root.querySelectorAll("[data-refresh]").forEach(b => b.onclick = async () => {
    if (S.newVersion || await freshCheck(true)) return reloadApp();  // a newer version is out: load it, on this same page
    if (b.classList.contains("busy")) return;
    b.classList.add("busy");
    try {
      await load();
      S.pending = canApprove() ? await api("registrations?select=created_at&status=eq.pending").then(newSignups).catch(() => S.pending) : 0;
      const y = scrollY; render(); scrollTo(0, y); setTimeout(() => scrollTo(0, y), 350); toast("Up to date.");
    } catch (e) { b.classList.remove("busy"); toast("Couldn't refresh: " + e.message); }
  });
  root.querySelectorAll("[data-viewas]").forEach(b => b.onclick = () => { menu(false); viewAs(); });
  root.querySelectorAll("[data-unpreview]").forEach(b => b.onclick = endPreview);
  root.querySelectorAll("[data-switch]").forEach(b => b.onclick = () => switchView(S.me.role === "pastor" ? S.me.base : "pastor"));
  const view = document.getElementById("view");
  view.onclick = e => {
    const b = e.target.closest("[data-person]"); if (b) { S.person = b.dataset.person; go("person"); return; }
    const t = e.target.closest("[data-to-pastor]"); if (t) { S.pastor = t.dataset.toPastor; S.pastorJump = true; go("pastors"); }
  };
  root.querySelectorAll("[data-back]").forEach(b => b.onclick = () => history.back());  // same as the phone's back gesture
  if (moved) pageIn(view);
  ({mine, dashboard, checkin, bacentas, summary: summaryPage, followup, pastors, shepherds, people, person, signups, teamforms, archive, activity, reports, overview, admin, account, help, ask}[S.view] || dashboard)(view);
}
// Smooth movement. A new page eases in for a moment only, so ticking or editing later never makes things flicker.
const stillMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("calm");
function pageIn(el) {
  if (stillMotion()) return;
  el.classList.add("page-in"); clearTimeout(S.pageInT); S.pageInT = setTimeout(() => el.classList.remove("page-in"), 900);
}
// Popups, messages and the church list fade out instead of vanishing. A copy does the fading while the real one goes
// straight away, so the next popup (and anything looking for its fields) is never confused by the old one.
{
  const drop = Element.prototype.remove;
  Element.prototype.remove = function () {
    if (this.isConnected && this.classList?.length && /^(modal|toast|ch-pop)$/.test(this.classList[0]) && !this.classList.contains("leaving") && !stillMotion()) {
      const ghost = this.cloneNode(true); ghost.classList.add("leaving"); ghost.setAttribute("aria-hidden", "true"); ghost.inert = true;
      ghost.querySelectorAll("[id]").forEach(x => x.removeAttribute("id")); ghost.removeAttribute("id");
      this.after(ghost); setTimeout(() => drop.call(ghost), 220);
    }
    return drop.call(this);
  };
}
// An arrow that jumps back to the top of a long page; it shows once you have scrolled down a fair way.
{
  const up = Object.assign(document.createElement("button"), {className: "to-top", type: "button", title: "Back to top", innerHTML: svg("up")});
  up.setAttribute("aria-label", "Back to top"); up.hidden = true;
  up.onclick = () => scrollTo({top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"});
  document.body.append(up);
  const check = () => { up.hidden = scrollY < 400 || !S.me; };
  addEventListener("scroll", check, {passive: true}); addEventListener("resize", check);
}
// The phone's back gesture (and the Back button, which uses it) returns to the page you came from.
// Phones: swipe right across the page to pull the menu open (the page slides over with your finger, as in Threads),
// and swipe left to close it. Up-and-down scrolling, and anything that scrolls sideways itself, are left alone.
(() => {
  let st = null;
  addEventListener("touchstart", e => {
    st = null;
    if (innerWidth > 1080 || e.touches.length !== 1 || document.querySelector(".modal, .tour-pop")) return;
    const sh = document.querySelector(".shell"), side = document.querySelector(".side"); if (!sh || !side) return;
    if (e.target.closest?.("input, textarea, select, .chart, .dock")) return;
    for (let n = e.target; n && n !== document.body; n = n.parentElement) {  // something that scrolls sideways keeps its own swipe
      if (n === side) break;
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowX) && n.scrollWidth > n.clientWidth + 2) return; }
    const t = e.touches[0]; st = {x: t.clientX, y: t.clientY, open: sh.classList.contains("open"), drag: false, w: side.offsetWidth, sh, p: 0};
  }, {passive: true});
  addEventListener("touchmove", e => {
    if (!st) return;
    const t = e.touches[0], dx = t.clientX - st.x, dy = t.clientY - st.y;
    if (!st.drag) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { st = null; return; }  // scrolling up or down
      if (Math.abs(dx) < 14) return;
      if (st.open ? dx > 0 : dx < 0) { st = null; return; }
      st.drag = true; st.sh.classList.add("dragging");
    }
    st.p = Math.min(st.w, Math.max(0, (st.open ? st.w : 0) + dx)); st.sh.style.setProperty("--pull", st.p + "px");
  }, {passive: true});
  const end = () => {
    if (!st) return; const s = st; st = null; if (!s.drag) return;
    s.sh.classList.remove("dragging"); s.sh.style.removeProperty("--pull");
    S.menu?.(s.p > s.w * (s.open ? .7 : .3));  // past a third of the way: it opens; back under two thirds: it closes
  };
  addEventListener("touchend", end); addEventListener("touchcancel", end);
})();
addEventListener("popstate", () => {
  if (!S.me || !S.hist?.length) return;
  S.view = S.hist.pop(); S.goingBack = true; document.querySelectorAll(".modal").forEach(m => m.remove()); render();
});
const TITLE = {mine: "Home", dashboard: "Dashboard", checkin: "Check-in", followup: "Follow-up", pastors: "Pastors", shepherds: "Shepherds", people: "Congregation", person: "Person", account: "Your account", help: "Help", ask: "Ask a question", signups: "Sign-ups", teamforms: "Team forms", archive: "Archive",
               activity: "Activity", reports: "Reports", overview: "All churches", admin: "Admin"};
const NAVHUE = {dashboard: 1, mine: 1, checkin: 2, bacentas: 3, summary: 6, followup: 3, pastors: 4, shepherds: 2, people: 5, signups: 6, teamforms: 3, archive: 4, activity: 2, reports: 3, overview: 1, admin: 4, ask: 5, help: 6, account: 1, person: 5};
// A greeting on the home pages: "Good morning, Kelvin", or "Welcome back, Pastor Grace" after a day or more away.
// Pastors and bishops are greeted with their title; a title already in their name (Pastor, Rev, Elder...) is kept.
const GREET_TITLES = /^(pastor|ps|bishop|reverend|rev|elder|deacon|deaconess|lady|prophet|prophetess|apostle|evangelist|dr|mrs?|ms|minister)\.?$/i;
function greetName() {
  // Always the signed-in person's own name (Your account). The name on the Pastors list can be someone else's,
  // for example while an admin looks at the app as a pastor.
  const raw = String(S.me?.name || "").trim().replace(/\s+/g, " "); if (!raw) return "";
  const w = raw.split(" "), lead = [];
  if (S.me.title === "Shepherd") {  // shepherds: just their first name, never "Shepherd Frank" or "Pastor Frank"
    while (w.length > 1 && (GREET_TITLES.test(w[0]) || /^shepherd$/i.test(w[0]))) w.shift();
    return w[0];
  }
  while (w.length > 1 && GREET_TITLES.test(w[0])) lead.push(w.shift());
  const first = w[0];
  if (GREET_TITLES.test(first)) return raw;  // the name is only a title, e.g. "Bishop"
  if (lead.length) return shortTitle(`${lead.join(" ")} ${first}`);
  const role = S.me.role, title = S.me.title, pastors = role === "pastor" || title === "Lead pastor" || (!S.preview && S.me.pastor);
  if (title === "Shepherd") return first;  // a shepherd is not called Pastor
  return role === "bishop" ? `Bishop ${first}` : title === "Reverend" || (!S.preview && S.me.pastor && S.me.role3 === "Reverend") ? `Rev. ${first}` : pastors ? `Pst. ${first}` : first;
}
function greeting() {
  const name = greetName(), h = new Date().getHours(), key = "fcc-seen:" + (S.me?.email || "");
  if (S.greet === undefined) {  // worked out once per visit: away a day or more, or a first visit, says welcome back
    let last = 0; try { last = Number(localStorage.getItem(key)) || 0; localStorage.setItem(key, String(Date.now())); } catch {}
    S.greet = last && Date.now() - last > 864e5 ? "Welcome back" : "";
  }
  const part = S.greet || (h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");
  return `${part}${name ? `, ${esc(name)}` : ""}`;
}
const head = (title, sub, buttons = "") => `<div class="head">${ICON[S.view] ? `<span class="hico" style="--wc:var(--h${NAVHUE[S.view] || 1});--wb:var(--h${NAVHUE[S.view] || 1}b)">${svg(S.view)}</span>` : ""}<div><h1>${["dashboard", "mine"].includes(S.view) ? greeting() : title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><span class="gap" style="flex:1"></span>${buttons}</div>`;
const FLAG_WHY = {red: `Red: missed ${RED_AT} or more services in a row. Give them a call.`, yellow: `Amber: missed ${YELLOW_AT}–${RED_AT - 1} services in a row. A quick check-in.`,
  blue: "Missed this service, but not enough in a row to worry yet.", ok: "Coming regularly."};
const badge = f => `<span class="badge ${f}" title="${esc(FLAG_WHY[f] || "")}">${FLAG[f]}</span>`;

// ---------------------------------------------------------------- dashboard
// The church's standard attendance message. No emojis. Online numbers, preacher and sermon are typed in the popup;
// adults and children "Attending" come from the ticks. Follow-up is added only when asked for.
const dmy = d => d.split("-").reverse().join("/");
// Which of this church's people came to one of a day's services (Check-in split the day into services).
function membersAt(p, d, part) {
  const day = p.byDate[d] || {}, ids = new Set(S.pticks.filter(t => t.service_date === d && t.part === part && day[t.member_id]).map(t => t.member_id));
  return p.mine.filter(m => ids.has(m.id));
}
// Other platforms added on the Summary (TikTok, Instagram...): [name, the box's key]
const platKeys = () => (S.platforms || []).map(nm => [nm, "px" + nm.toLowerCase().replace(/[^a-z0-9]/g, "")]);
// The standard message for a day with more than one service: each service on its own, then the whole day (each person once).
function reportMulti(p, o) {
  const XP = platKeys(), day = p.last, n = o.count || 2, parts = partsOf(day), num = k => Math.max(0, parseInt(o[k], 10) || 0);
  const sum = k => Array.from({length: n}, (_, j) => num(`${k}_${j + 1}`)).reduce((a, b) => a + b, 0);
  const out = [`${svcName(day).toUpperCase()} ATTENDANCE (${n} SERVICES)`, "", `DAY - ${new Date(day + "T12:00:00").toLocaleDateString("en-NZ", {weekday: "long"}).toUpperCase()}`, "",
    `DATE - ${dmy(day)}`, "", `BRANCH/MISSION - ${S.church}`, ""];
  for (let i = 1; i <= n; i++) {
    const part = parts[i - 1], ppl = part ? membersAt(p, day, part.part) : null, kidsIn = ppl ? ppl.filter(isKid).length : 0, adultsIn = ppl ? ppl.length - kidsIn : 0;
    out.push(`— ${(o.groups?.[i - 1] || part?.name || `Service ${i}`).toUpperCase()} —`, `PREACHER NAME - ${o["preacher_" + i] || ""}`, `SERMON TITLE: ${o["sermon_" + i] || ""}`, "",
      `*ADULTS - ${adultsIn + num("zoomA_" + i) + num("yt_" + i) + num("fb_" + i) + XP.reduce((a, [, k]) => a + num(k + "_" + i), 0)}`, ...(ppl ? [`[Attending: Adults - ${adultsIn}]`] : []),
      `[Zoom: Adults - ${num("zoomA_" + i)}]`, `[Youtube -  ${num("yt_" + i)}]`, `[Facebook -  ${num("fb_" + i)}]`, ...XP.map(([nm, k]) => `[${nm} -  ${num(k + "_" + i)}]`), "",
      `*CHILDREN - ${kidsIn + num("zoomK_" + i)}`, ...(ppl ? [`[Attending - ${kidsIn}]`] : []), `[Zoom - ${num("zoomK_" + i)}]`, "", `New Converts - ${num("converts_" + i)}`, "");
  }
  const kidsIn = p.kids, adultsIn = p.present.length - kidsIn, online = sum("zoomA") + sum("yt") + sum("fb") + XP.reduce((a, [, k]) => a + sum(k), 0);
  const firsts = p.present.filter(m => m.type === "first_timer");
  out.push("— WHOLE DAY (each person counted once) —", `*ADULTS - ${adultsIn + online}`, `[Attending: Adults - ${adultsIn}]`, `[Online - ${online}]`, "",
    `*CHILDREN - ${kidsIn + sum("zoomK")}`, `[Attending - ${kidsIn}]`, `[Zoom - ${sum("zoomK")}]`, "",
    `First timers - ${firsts.length}`, ...(o.names && firsts.length ? [firsts.map(m => m.full_name).join(", ")] : []), "",
    `Visitors - ${p.visitors}`, ...(o.names && p.visitors ? [p.present.filter(m => m.type === "visitor").map(m => m.full_name).join(", ")] : []), "",
    `New Converts - ${sum("converts")}`);
  if (o.follow) {
    const f = lv => p.people.filter(x => x.level === lv);
    out.push("", "FOLLOW-UP", `Missed ${RED_AT}+ in a row - ${f("red").length}`, ...(f("red").length ? [f("red").map(x => x.full_name).join(", ")] : []),
      `Missed ${YELLOW_AT}-${RED_AT - 1} in a row - ${f("yellow").length}`, ...(f("yellow").length ? [f("yellow").map(x => x.full_name).join(", ")] : []));
  }
  if (o.link) out.push("", `Livestream: ${o.link}`);
  return out.join("\n").trim();
}
function report(p, o = {}) {
  if (o.multi) return reportMulti(p, o);
  const day = p.last, kidsIn = p.kids, adultsIn = p.present.length - kidsIn, n = k => Math.max(0, parseInt(o[k], 10) || 0);
  const XP = platKeys(), adults = adultsIn + n("zoomA") + n("yt") + n("fb") + XP.reduce((a, [, k]) => a + n(k), 0), kids = kidsIn + n("zoomK");
  const firsts = p.present.filter(m => m.type === "first_timer");
  const out = [`${svcName(day).toUpperCase()} ATTENDANCE`, "", `DAY - ${new Date(day + "T12:00:00").toLocaleDateString("en-NZ", {weekday: "long"}).toUpperCase()}`, "",
    `DATE - ${dmy(day)}`, "", `PREACHER NAME - ${o.preacher || ""}`, "", `SERMON TITLE: ${o.sermon || ""}`, "", `BRANCH/MISSION - ${S.church}`, "",
    ...(partsOf(day).length ? [`SERVICES - ${partCounts(p, day).map(x => `${x.name}: ${x.n}`).join(", ")} (${p.present.length} people in total)`, ""] : []),
    `*ADULTS - ${adults}`, `[Attending: Adults - ${adultsIn}]`, `[Zoom: Adults - ${n("zoomA")}]`, `[Youtube -  ${n("yt")}]`, `[Facebook -  ${n("fb")}]`, ...XP.map(([nm, k]) => `[${nm} -  ${n(k)}]`), "",
    `*CHILDREN - ${kids}`, `[Attending - ${kidsIn}]`, `[Zoom - ${n("zoomK")}]`, "",
    `First timers - ${firsts.length}`, ...(o.names && firsts.length ? [firsts.map(m => m.full_name).join(", ")] : []), "",
    `Visitors - ${p.visitors}`, ...(o.names && p.visitors ? [p.present.filter(m => m.type === "visitor").map(m => m.full_name).join(", ")] : []), "",
    `New Converts - ${n("converts")}`];
  if (o.follow) {
    const f = lv => p.people.filter(x => x.level === lv);
    out.push("", "FOLLOW-UP", `Missed ${RED_AT}+ in a row - ${f("red").length}`, ...(f("red").length ? [f("red").map(x => x.full_name).join(", ")] : []),
      `Missed ${YELLOW_AT}-${RED_AT - 1} in a row - ${f("yellow").length}`, ...(f("yellow").length ? [f("yellow").map(x => x.full_name).join(", ")] : []));
  }
  if (o.link) out.push("", `Livestream: ${o.link}`);
  return out.join("\n").trim();
}
function summary(p, o = {}) {
  const who = list => o.names && list.length ? [list.map(x => x.full_name).join(", ")] : [];
  const flagged = f => p.people.filter(x => x.flag === f);
  return wa([`*FCC ${S.church}*${S.emoji ? " ⛪" : ""}`, p.last ? `${S.names[p.last] || "Service"} · ${nice(p.last, true)}` : "No services recorded yet", "",
    ["✅", `Present: *${p.present.length}*`], ...(p.last && partsOf(p.last).length ? partCounts(p, p.last).map(x => ["⛪", `${x.name}: *${x.n}*`]) : []),
    ["🧑", `Adults: *${p.present.length - p.kids}*`], ["🧒", `Kids: *${p.kids}*`],
    ["👋", `First-timers: *${p.first}*`], ...who(p.present.filter(m => m.type === "first_timer")),
    ...(p.visitors ? [["🤝", `Visitors: *${p.visitors}*`], ...who(p.present.filter(m => m.type === "visitor"))] : []), "", "*Follow-up*",
    ["🔴", `Missed ${RED_AT}+ in a row: *${p.count("red")}*`], ...who(flagged("red")),
    ["🟡", `Missed ${YELLOW_AT}–${RED_AT - 1} in a row: *${p.count("yellow")}*`], ...who(flagged("yellow")),
    ...(o.link ? ["", ["📺", `Livestream: ${o.link}`]] : [])]);
}
function chart(el, rows, pick, active) {  // one bar per service: everyone who came (adults and kids together, one colour so nothing reads as
  // an extra piece on top); tapping a bar opens that day's Check-in, or calls pick(day). The day the page is showing (active,
  // or else the latest) is in colour with its adults and kids shown; the others are greyed back.
  const narrow = innerWidth < 640; rows = rows.slice(narrow ? -5 : -10);  // the latest 5 services on a phone, 10 on a bigger screen
  const on = rows.some(r => r[0] === active) ? active : rows[rows.length - 1]?.[0];
  if (!rows.length) { el.innerHTML = `<p class="empty">No services recorded yet.</p>`; return; }
  const W = narrow ? 340 : 640, H = 230, L = 28, B = 26, T = 18, max = Math.max(20, Math.ceil(Math.max(...rows.map(r => r[1] + r[2])) / 20) * 20);
  const step = (W - L) / rows.length, bw = Math.min(26, step * .5), y = v => T + (H - T - B) * (1 - v / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="People present at recent services">`;
  for (const t of [0, .25, .5, .75, 1].map(f => Math.round(max * f))) s += `<line class="gridline" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  rows.forEach(([d, a, k], i) => {
    const cx = L + step * i + step / 2, x = cx - bw / 2, yk = y(a + k), h = y(0) - yk, r = Math.min(4, h / 2);
    s += `<g class="col ${d === on ? "on" : "dim"}" tabindex="0" data-i="${i}"><rect class="hit" x="${cx - step / 2}" y="${T - 8}" width="${step}" height="${H - T - B + 8}" rx="8"/>
      ${h > 0 ? `<path d="M${x},${y(0)} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z" fill="var(--adults)"/>` : ""}
      <text class="total" x="${cx}" y="${yk - 6}" text-anchor="middle">${a + k}</text><text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(nice(d))}</text></g>`;
  });
  el.innerHTML = `<div class="tip"></div>${s}</svg>`;
  const tip = el.querySelector(".tip");
  el.querySelectorAll("g.col").forEach(g => {
    const show = () => {
      const [d, a, k] = rows[g.dataset.i], r = g.querySelector(".hit").getBoundingClientRect(), c = el.getBoundingClientRect();
      tip.innerHTML = `<b>${esc(nice(d))}</b><br>${a + k} present<br><small>${a} ${a === 1 ? "adult" : "adults"} · ${k} ${k === 1 ? "kid" : "kids"}</small>`;
      tip.style.left = Math.max(70, Math.min(c.width - 70, r.left - c.left + r.width / 2)) + "px";
      tip.style.top = (g.querySelector(".total").getBoundingClientRect().top - c.top) + "px"; tip.style.opacity = 1;
    };
    g.onpointerenter = g.onfocus = show; g.onpointerleave = g.onblur = () => { const a = el.querySelector("g.col.on"); a && a !== g ? a.show() : tip.style.opacity = 0; };
    g.show = show;
    g.onclick = g.onkeydown = e => { if (e.type === "keydown" && e.key !== "Enter") return; if (pick) return pick(rows[g.dataset.i][0]); S.date = rows[g.dataset.i][0]; S.view = "checkin"; render(); };
  });
  requestAnimationFrame(() => el.querySelector("g.col.on")?.show?.());  // the day shown: its numbers sit above its bar
}
// Each name gets one of six colours from its letters, so the same person always has the same colour circle.
const hueOf = s => 1 + [...norm(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;
const avaStyle = s => `style="background:var(--h${hueOf(s)}b);color:var(--h${hueOf(s)}t)"`;
const whoBtn = m => `<button class="who" data-person="${esc(m.id)}" title="See their attendance history"><span ${avaStyle(m.full_name)}>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</button>`;
function donut(el, parts) {  // parts: [flag, label, count]; a ring with a gap between segments and the total in the middle
  const total = parts.reduce((n, x) => n + x[2], 0), R = 54, C = 2 * Math.PI * R, gap = total && parts.filter(x => x[2]).length > 1 ? 3 : 0;
  let at = 0, s = `<svg viewBox="0 0 140 140" role="img" aria-label="Pastoral care: ${parts.map(x => `${x[2]} ${x[1]}`).join(", ")}">
    <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--line)" stroke-width="16"/>`;
  parts.forEach(([f, label, n], i) => {
    if (!n) return;
    const len = C * n / total;
    s += `<circle class="seg" tabindex="0" data-i="${i}" cx="70" cy="70" r="${R}" fill="none" stroke="var(--${f === "blue" ? "info" : f})" stroke-width="16"
      stroke-dasharray="${Math.max(len - gap, 1)} ${C}" stroke-dashoffset="${-at}" transform="rotate(-90 70 70)"/>`;
    at += len;
  });
  el.innerHTML = `<div class="tip"></div>${s}<text class="big" x="70" y="68" text-anchor="middle">${total}</text><text x="70" y="86" text-anchor="middle">${total === 1 ? "person" : "people"}</text></svg>`;
  const tip = el.querySelector(".tip");
  el.querySelectorAll(".seg").forEach(c => {
    const show = () => { const [f, label, n] = parts[c.dataset.i]; tip.innerHTML = `<b>${esc(FLAG[f])}</b><br>${n} of ${total} · ${Math.round(100 * n / total)}%<br>${esc(label)}`;
      tip.style.left = "50%"; tip.style.top = "8px"; tip.style.opacity = 1; };
    c.onpointerenter = c.onfocus = show; c.onpointerleave = c.onblur = () => tip.style.opacity = 0;
  });
}
function calendar(el, p) {  // a month of services: days with a service show how many came; tapping a day opens Check-in for it
  const [y, m] = S.cal.split("-").map(Number), first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate(), now = today();
  const shift = n => { const d = new Date(y, m - 1 + n, 1); S.cal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; calendar(el, p); };
  let cells = "<span></span>".repeat(first.getDay());
  for (let d = 1; d <= days; d++) {
    const iso = `${S.cal}-${pad(d)}`, n = p.byDate[iso] ? Object.keys(p.byDate[iso]).length : 0;
    const label = new Date(y, m - 1, d).toLocaleDateString("en-NZ", {weekday: "long", day: "numeric", month: "long"}) + (n ? `, ${n} present` : ", no service recorded");
    cells += `<button class="day ${n ? "has" : ""} ${iso === now ? "today" : ""}" data-day="${iso}" aria-label="${label}. Open check-in for this day">${d}${n ? `<small>${n}</small>` : ""}</button>`;
  }
  el.innerHTML = `<div class="card-head"><h2>${first.toLocaleDateString("en-NZ", {month: "long", year: "numeric"})}</h2><span class="gap"></span>
      <button class="icon-btn sm" data-cal="-1" aria-label="Previous month">${svg("prev")}</button><button class="icon-btn sm" data-cal="1" aria-label="Next month">${svg("next")}</button></div>
    <div class="cal"><b>Sun</b><b>Mon</b><b>Tue</b><b>Wed</b><b>Thu</b><b>Fri</b><b>Sat</b>${cells}</div>
    <p class="note">Tap a day to check people in for it.</p>`;
  el.querySelectorAll("[data-cal]").forEach(b => b.onclick = () => shift(Number(b.dataset.cal)));
  el.querySelectorAll("[data-day]").forEach(b => b.onclick = () => { S.date = b.dataset.day; S.view = "checkin"; render(); });
}
function rowsHtml(list, cols) {
  return list.map(p => `<tr><td>${whoBtn(p)}</td><td>${badge(p.flag)}</td><td>${p.missed}</td>
    <td class="muted hide-sm">${esc(nice(p.seen))}</td>${cols ? `<td class="muted hide-sm">${esc(p.pastor || "")}</td>` : ""}<td class="muted">${esc(p.phone || "")}</td></tr>`).join("");
}
// ---------------------------------------------------------------- dashboard: widgets each person can add, remove, drag and resize
// Each widget: name, sub (line under the title), size (full = whole row, wide/narrow = left/right column), hue (its colour), draw(body, p).
// A person's layout is a list like ["tiles", "trend@full"]: the key, and a size if they changed it. Nobody else's dashboard is touched.
const DASH_DEFAULT = ["people", "calendar", "tiles", "stands", "followup"];
const SIZES = [["full", "Full width"], ["wide", "Large"], ["narrow", "Small"]];
const sameDayBefore = (p, d) => [...p.dates].reverse().find(x => x < d && new Date(x + "T12:00:00").getDay() === new Date(d + "T12:00:00").getDay());
function countsOn(p, d) {  // who was at one service: adults and kids exclude first-timers and visitors, so the parts add up
  const ids = Object.keys(p.byDate[d] || {}), by = Object.fromEntries(p.mine.map(m => [m.id, m]));
  const first = ids.filter(i => by[i]?.type === "first_timer").length, visitors = ids.filter(i => by[i]?.type === "visitor").length;
  const rest = ids.filter(i => !["first_timer", "visitor"].includes(by[i]?.type)), kidsAll = ids.filter(i => by[i] && isKid(by[i])).length;
  const kids = rest.filter(i => by[i] && isKid(by[i])).length;
  return {present: ids.length, adults: ids.length - kidsAll, kids: kidsAll, first, visitors, mAdults: rest.length - kids, mKids: kids};
}
const delta = (x, y, unit = "") => x === y ? `<span class="delta same">Same</span>` : `<span class="delta ${x > y ? "up" : "down"}">${x > y ? "▲" : "▼"} ${Math.abs(x - y)}${unit}</span>`;
const TREND = {sun: ["Sundays", "Last 10 Sundays"], all: ["Every service", "Last 12 services"], mid: ["Midweek", "Last 10 midweek services"], month: ["Monthly", "Average a service, each month"]};
const trendView = () => { if (!S.trendView) { try { S.trendView = localStorage.getItem("fcc-trend"); } catch {} } return TREND[S.trendView] ? S.trendView : "sun"; };
const WIDGETS = {
  tiles: {name: "Service overview", sub: p => p.last ? `${svcName(p.last)} · ${nice(p.last, true)}` : "No services recorded yet", desc: "Present, adults, kids and first-timers at the latest service.", size: "wide", icon: "checkin", hue: 1,
    draw(el, p) {
      const c = p.last ? countsOn(p, p.last) : {present: 0, adults: 0, kids: 0, first: 0, visitors: 0}, pc = n => c.present ? Math.round(n / c.present * 100) + "% of those here" : "";
      el.innerHTML = `<div class="ov">${[["Present", c.present, 5, `of ${p.mine.filter(m => !AWAY.has(norm(m.status))).length} on the register`], ["Adults", c.adults, 1, pc(c.adults)],
        ["Kids", c.kids, 2, pc(c.kids)], ["First-timers", c.first, 3, c.visitors ? `+ ${c.visitors} ${c.visitors === 1 ? "visitor" : "visitors"}` : "at this service"]]
        .map(([t, n, h, sub]) => `<button type="button" class="ov-cell" title="Open Check-in for this service"><b>${n}</b><span>${t}</span><small><i style="background:var(--h${h})"></i>${esc(sub)}</small></button>`).join("")}</div>
        ${p.last && partsOf(p.last).length ? `<p class="ov-parts">${partCounts(p, p.last).map(x => `${esc(x.name)}: <b>${x.n}</b>`).join(" · ")} · someone at both counts once in Present</p>` : ""}`;
      el.querySelectorAll(".ov-cell").forEach(t => t.onclick = () => { S.date = p.last || today(); S.view = "checkin"; render(); });
    }},
  compare: {name: "Compared with last time", sub: p => { const prev = p.last && sameDayBefore(p, p.last); return prev ? `Against ${svcName(prev)} · ${nice(prev, true)}` : "The same day last week"; }, desc: "Each number against the last service on the same day.", size: "wide", icon: "compare", hue: 4,
    draw(el, p) {
      const prev = p.last && sameDayBefore(p, p.last);
      if (!prev) { el.innerHTML = `<p class="empty">Needs two services on the same day of the week first.</p>`; return; }
      const a = countsOn(p, p.last), b = countsOn(p, prev);
      el.innerHTML = `<div class="ov">${[["Present", "present", 5], ["Adults", "adults", 1], ["Kids", "kids", 2], ["First-timers", "first", 3]].map(([t, k, h]) =>
        `<div class="ov-cell"><b>${a[k]}</b><span>${t}</span><small><i style="background:var(--h${h})"></i>${b[k]} on ${esc(nice(prev))} ${delta(a[k], b[k], a[k] > b[k] ? " more" : a[k] < b[k] ? " fewer" : "")}</small></div>`).join("")}</div>`;
    }},
  people: {name: "People present", sub: "How many came to each service · tap a bar to open it", size: "wide", icon: "dashboard", hue: 1,
    draw(el, p) {
      const kidIds = new Set(p.mine.filter(isKid).map(m => m.id));
      const series = p.dates.map(d => { const ids = Object.keys(p.byDate[d]), k = ids.filter(i => kidIds.has(i)).length; return [d, ids.length - k, k]; });
      el.innerHTML = `<div class="chart"></div>`;
      chart(el.querySelector(".chart"), series, null, p.last);
    }},
  calendar: {name: "Calendar", sub: "Services this month and how many came", size: "narrow", icon: "followup", hue: 2, draw(el, p) { calendar(el, p); }},
  trend: {name: "Attendance trend", sub: () => TREND[trendView()][1], desc: "Attendance over time: Sundays, all services, midweek or monthly.", size: "full", icon: "trend", hue: 1,
    draw(el, p) {
      const v = trendView(), w = el.closest(".w"), tools = w.querySelector(".w-tools");
      tools.innerHTML = `<select class="in sel" aria-label="What the trend shows">${Object.entries(TREND).map(([k, [t]]) => `<option value="${k}" ${k === v ? "selected" : ""}>${t}</option>`).join("")}</select>`;
      tools.querySelector("select").onchange = e => { S.trendView = e.target.value; try { localStorage.setItem("fcc-trend", S.trendView); } catch {}
        w.querySelector(".w-tt p").textContent = TREND[S.trendView][1]; WIDGETS.trend.draw(el, p); };
      const cnt = d => Object.keys(p.byDate[d] || {}).length;
      let pts;
      if (v === "month") {
        const by = {}; for (const d of p.dates) (by[d.slice(0, 7)] ??= []).push(cnt(d));
        pts = Object.keys(by).sort().map(k => { const xs = by[k], dt = new Date(k + "-15T12:00:00");
          return {v: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), lab: dt.toLocaleDateString("en-NZ", {month: "short"}), long: `${dt.toLocaleDateString("en-NZ", {month: "long", year: "numeric"})} · ${xs.length} ${xs.length === 1 ? "service" : "services"}`}; });
      } else {
        const ds = v === "sun" ? p.dates.filter(isSunday) : v === "mid" ? p.dates.filter(d => !isSunday(d)) : p.dates;
        pts = ds.map(d => ({v: cnt(d), lab: nice(d), long: `${svcName(d)} · ${nice(d, true)}`}));
      }
      const N = v === "sun" || v === "mid" ? 10 : 12, now = pts.slice(-N), before = pts.slice(-2 * N, -N);
      const avg = xs => xs.length ? Math.round(xs.reduce((n, x) => n + x.v, 0) / xs.length) : 0, aNow = avg(now), aBefore = avg(before);
      const unit = v === "month" ? "months" : v === "all" ? "services" : v === "mid" ? "midweek services" : "Sundays";
      el.innerHTML = `<div class="trend"><div class="trend-head">
          <small class="muted">${v === "month" ? "Latest month, average" : "Latest"}</small><div class="big">${now.at(-1)?.v ?? "–"}</div>
          <div class="note" style="margin:0">${now.length ? esc(now.at(-1).long) : "Nothing recorded yet"}</div>
          ${before.length ? `<p class="note" style="margin:12px 0 0">${delta(aNow, aBefore)} Average ${aNow}, ${aNow === aBefore ? "same as" : `${Math.abs(aNow - aBefore)} ${aNow > aBefore ? "more" : "fewer"} than`} the ${before.length} ${unit} before</p>` : ""}
          <div class="legend" style="margin-top:12px"><span><i style="background:var(--h1)"></i>Last ${now.length}</span>${before.length ? `<span><i style="background:var(--ink-3)"></i>${before.length} before</span>` : ""}</div></div>
        <div class="chart tline"></div></div>`;
      const box = el.querySelector(".tline");
      if (!now.length) { box.innerHTML = `<p class="empty">No ${v === "mid" ? "midweek services" : v === "sun" ? "Sunday services" : "services"} recorded yet.</p>`; return; }
      const W = 640, H = 220, L = 30, B = 26, T = 14, n = Math.max(now.length, before.length, 2), max = Math.max(10, Math.ceil(Math.max(...[...now, ...before].map(x => x.v)) / 10) * 10);
      const x = i => L + (W - L - 10) * i / (n - 1), y = val => T + (H - T - B) * (1 - val / max);
      const line = xs => xs.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
      let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(TREND[v][1])}"><defs><linearGradient id="tgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--h1);stop-opacity:.42"/><stop offset="1" style="stop-color:var(--h1);stop-opacity:0"/></linearGradient></defs>`;
      for (const t of [0, .5, 1].map(f => Math.round(max * f))) s += `<line class="gridline" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
      s += `<path d="${line(now)} L${x(now.length - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#tgrad)"/>`;
      if (before.length) s += `<path d="${line(before)}" fill="none" stroke="var(--ink-3)" stroke-width="2" stroke-dasharray="5 5"/>`;
      s += `<path d="${line(now)}" fill="none" stroke="var(--h1)" stroke-width="2.5" stroke-linejoin="round"/>`;
      const every = Math.ceil(now.length / (innerWidth < 640 ? 4 : 6));
      now.forEach((d, i) => { if ((now.length - 1 - i) % every === 0) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(d.lab)}</text>`; });
      s += `<line class="cursor" x1="0" x2="0" y1="${T}" y2="${y(0)}" stroke="var(--ink-3)" stroke-dasharray="3 3" opacity="0"/><circle class="dot" r="5" fill="var(--h1)" stroke="var(--card)" stroke-width="2" opacity="0"/>`;
      box.innerHTML = `<div class="tip"></div>${s}</svg>`;
      const svgEl = box.querySelector("svg"), tip = box.querySelector(".tip"), cur = svgEl.querySelector(".cursor"), dot = svgEl.querySelector(".dot");
      svgEl.onpointermove = svgEl.onpointerdown = e => {
        const r = svgEl.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width * W, i = Math.max(0, Math.min(now.length - 1, Math.round((fx - L) / ((W - L - 10) / (n - 1)))));
        const px = x(i), b = before[i];
        cur.setAttribute("x1", px); cur.setAttribute("x2", px); cur.setAttribute("opacity", 1); dot.setAttribute("cx", px); dot.setAttribute("cy", y(now[i].v)); dot.setAttribute("opacity", 1);
        tip.innerHTML = `<b>${esc(now[i].long)}</b><br><i style="background:var(--h1)"></i>${now[i].v} ${v === "month" ? "a service" : "present"}${b ? `<br><i style="background:var(--ink-3)"></i>${b.v} · ${esc(b.long)}` : ""}`;
        tip.style.left = Math.max(90, Math.min(r.width - 90, px / W * r.width)) + "px"; tip.style.top = (y(now[i].v) / H * r.height) + "px"; tip.style.opacity = 1;
      };
      svgEl.onpointerleave = () => { tip.style.opacity = 0; cur.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); };
    }},
  split: {name: "Who came", sub: p => p.last ? `${svcName(p.last)} · ${nice(p.last, true)}` : "The latest service", desc: "Adults, kids, first-timers and visitors at the latest service.", size: "narrow", icon: "split", hue: 3,
    draw(el, p) {
      if (!p.last) { el.innerHTML = `<p class="empty">No service recorded yet.</p>`; return; }
      const c = countsOn(p, p.last), prev = sameDayBefore(p, p.last), b = prev ? countsOn(p, prev) : null;
      const parts = [["Adults", "mAdults", 1], ["Kids", "mKids", 2], ["First-timers", "first", 3], ["Visitors", "visitors", 4]];
      el.innerHTML = `<div class="split-top"><b>${c.present}</b> present</div>
        <div class="split-bar">${parts.filter(([, k]) => c[k]).map(([t, k, h]) => `<i style="flex:${c[k]};background:var(--h${h})" title="${t}: ${c[k]}"></i>`).join("") || "<i></i>"}</div>
        <div class="split-rows">${parts.map(([t, k, h]) => `<div><span><i style="background:var(--h${h})"></i>${t} <em>(${c[k]})</em></span>${b ? `<small>${delta(c[k], b[k])} vs ${esc(nice(prev))}</small>` : ""}</div>`).join("")}</div>`;
    }},
  live: {name: "Livestream", sub: "Watching now on YouTube, Facebook and Zoom", desc: "How many are watching your church's livestream right now, and the peak this service. Other churches connect their YouTube channel with its link.", size: "wide", icon: "live", hue: 5,
    only: () => ["admin", "lead"].includes(S.me.role),  // the home church uses the main live dashboard; other churches connect their YouTube channel
    draw(el) {
      const PL = [["youtube", "YouTube"], ["facebook", "Facebook"], ["zoom", "Zoom"]];
      // A platform split bar with its legend, and a line of the numbers through the service
      const PC = {youtube: "#ff0000", facebook: "#4267b2", zoom: "#2d8cff"};  // the platforms' own colours
      const split = rows => { const all = rows.reduce((s, r) => s + r[2], 0);
        return `<div class="lv-bar" aria-hidden="true">${all ? rows.filter(r => r[2] > 0).map(r => `<i style="flex-grow:${r[2]};background:${PC[r[0]]}"></i>`).join("") : "<i></i>"}</div>
          <div class="lv-legend">${rows.map(r => `<span><i style="background:${PC[r[0]]}"></i>${r[1]} <b>${r[3]}</b>${r[4] ? ` <em>${r[4]}</em>` : ""}</span>`).join("")}</div>`; };
      const line = v => { const top = Math.max(1, ...v), n = v.length - 1, X = i => i / n * 96, Y = y => 6 + (1 - y / top) * 80, last = v[n];
        const pts = v.map((y, i) => `${X(i).toFixed(2)},${Y(y).toFixed(2)}`).join(" ");
        return `<div class="lv-line" aria-hidden="true"><svg viewBox="0 0 100 90" preserveAspectRatio="none"><defs><linearGradient id="lvg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--red)" stop-opacity=".22"/><stop offset="1" stop-color="var(--red)" stop-opacity="0"/></linearGradient></defs>
          <polygon points="0,90 ${pts} 96,90" fill="url(#lvg)"/><polyline points="${pts}" fill="none" stroke="var(--red)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>
          <span class="lv-now" style="top:${Y(last) / 90 * 100}%"><em>now ${last}</em></span></div>`; };
      // "Viewers" chart, like a learning-progress chart: a smooth glowing line over a grid, dots, a tooltip on hover or tap,
      // and This service / This week; beside it a ring of how the viewers split across YouTube, Facebook and Zoom
      const curve = p => p.map((q, i, a) => { if (!i) return `M${q[0].toFixed(1)},${q[1].toFixed(1)}`;
        const a0 = a[i - 2] || a[i - 1], a1 = a[i - 1], a3 = a[i + 1] || q, f = v => v.toFixed(1);
        const cy = v => f(Math.min(200, Math.max(0, v)));  // never dips below 0 or over the top
        return `C${f(a1[0] + (q[0] - a0[0]) / 6)},${cy(a1[1] + (q[1] - a0[1]) / 6)} ${f(q[0] - (a3[0] - a1[0]) / 6)},${cy(q[1] - (a3[1] - a1[1]) / 6)} ${f(q[0])},${f(q[1])}`; }).join(" ");
      const progChart = (pts, empty, wide = 0, col = "", noHint = false) => {  // wide: the graph's width in pixels, to swipe back through; col: its colour
        const gid = "lvp" + (col || "red").replace(/\W/g, ""), line = col || "var(--red)";
        if (pts.length < 2) return `<p class="lv-empty">${empty}</p>`;
        const max = Math.max(1, ...pts.map(p => p.v)), step = Math.max(1, Math.ceil(max / 4)), top = step * 4, W = 600, H = 200;
        const xy = pts.map((p, i) => [i / (pts.length - 1) * W, H - p.v / top * H]), every = Math.max(1, Math.ceil(pts.length / 7)), keep = new Set();
        for (let i = 0; i < pts.length; i += every) keep.add(i);
        const lastM = Math.max(...keep); if (lastM && pts.length - 1 - lastM < every * 0.7) keep.delete(lastM); keep.add(pts.length - 1);  // labels never crowd
        if (wide) { keep.clear(); pts.forEach((p, i) => { if (p.hour) keep.add(i); }); }  // the long graph: a label each hour
        // Each platform in its own colour, stacked: YouTube at the bottom, then Facebook, then Zoom; the top edge is the total
        const split = pts.some(p => p.yt != null);
        const bands = !split ? "" : [["zoom", p => (p.yt || 0) + (p.fb || 0) + (p.zm || 0)], ["facebook", p => (p.yt || 0) + (p.fb || 0)], ["youtube", p => p.yt || 0]]
          .map(([k, f]) => { const q = pts.map((p, i) => [i / (pts.length - 1) * W, H - f(p) / top * H]);
            return `<path d="${curve(q)} L${W},${H} L0,${H} Z" style="fill:color-mix(in srgb, ${PC[k]} 20%, var(--card))"/><path d="${curve(q)}" class="lv-path lv-pl" style="stroke:${PC[k]}" vector-effect="non-scaling-stroke"/>`; }).join("");
        return `<div class="lv-chart" data-n="${pts.length}"><div class="lv-y">${[4, 3, 2, 1, 0].map(k => `<span>${k * step}</span>`).join("")}</div>
          ${wide ? `<div class="lv-scroll"><div class="lv-wide" style="width:${wide}px">` : ""}<div class="lv-plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${line}" stop-opacity=".28"/><stop offset="1" stop-color="${line}" stop-opacity="0"/></linearGradient></defs>
            ${[0, 1, 2, 3, 4].map(k => `<line x1="0" x2="${W}" y1="${k * H / 4}" y2="${k * H / 4}" class="lv-grid" vector-effect="non-scaling-stroke"/>`).join("")}
            ${split ? bands : `<path d="${curve(xy)} L${W},${H} L0,${H} Z" fill="url(#${gid})"/><path d="${curve(xy)}" class="lv-path" ${col ? `style="stroke:${col};filter:none"` : ""} vector-effect="non-scaling-stroke"/>`}</svg>
            ${xy.map(([x, y], i) => keep.has(i) && !split && !(wide && !pts[i].v) ? `<i class="lv-dot" style="left:${x / W * 100}%;top:${y / H * 100}%${col ? `;border-color:${col};box-shadow:none` : ""}"></i>` : "").join("")}
            <i class="lv-guide" hidden></i><div class="lv-tip" hidden></div><div class="lv-hit"></div></div>
          <div class="lv-x">${pts.map((p, i) => keep.has(i) ? `<span style="left:${i / (pts.length - 1) * 100}%">${esc(p.label)}</span>` : "").join("")}</div>${wide ? "</div></div>" : ""}</div>
          ${split ? `<div class="lv-legend lv-chart-key">${[["youtube", "YouTube"], ["facebook", "Facebook"], ["zoom", "Zoom"]].map(([k, t]) => `<span><i style="background:${PC[k]}"></i>${t}</span>`).join("")}</div>` : ""}
          ${wide && !noHint ? `<p class="lv-hint">Swipe the graph sideways to move through the day.</p>` : ""}`;
      };
      const ring = (rows, note) => { const all = rows.reduce((s, r) => s + r[2], 0); let at = 0;
        return `<div class="lv-ring-wrap"><b class="lv-side-t">Platforms</b><div class="lv-ring"><svg viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="15.9" class="lv-ring-bg"/>
          ${all ? rows.filter(r => r[2] > 0).map(r => { const pc = r[2] / all * 100, s = `<circle cx="21" cy="21" r="15.9" stroke="${PC[r[0]]}" stroke-dasharray="${Math.max(0, pc - 1.5)} ${100 - Math.max(0, pc - 1.5)}" stroke-dashoffset="${25 - at}"/>`; at += pc; return s; }).join("") : ""}</svg>
          <span><b>${all}</b><small>${note}</small></span></div>
          <div class="lv-ring-legend">${rows.map(r => `<span><i style="background:${PC[r[0]]}"></i>${r[1]}<em><b>${r[2]}</b> · ${all ? Math.round(r[2] / all * 100) : 0}%</em></span>`).join("")}</div></div>`; };
      const word = x => x.status === "live" ? (x.viewers === null ? "Hidden" : "Live") : {offline: "Offline", not_configured: "Not set up", error: "Error"}[x.status] || "Off";
      const church = S.church, call = async (init = {}, q = "") => {
        if (S.session.expires_at - Date.now() < 60000) await refresh();
        const r = await fetch("/app-live" + (init.method ? "" : "?church=" + encodeURIComponent(church) + q), {cache: "no-store", ...init,
          headers: {Authorization: "Bearer " + S.session.access_token, "Content-Type": "application/json"}});
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || "The livestream numbers couldn't be loaded.");
        return j;
      };
      // Another church's admin connects their YouTube channel by pasting its link
      const connect = (now = "") => {
        el.innerHTML = `<form class="live-set"><p>Show <b>${esc(church)}</b>'s YouTube livestream here: paste your church's YouTube channel link.</p>
          <div class="live-row"><input class="in" name="link" placeholder="youtube.com/@yourchurch" value="${esc(now)}" autocomplete="off" inputmode="url">
          <button class="pill-btn primary">Connect</button></div>
          <p class="note">Shows YouTube viewers. Ask the admin to add Facebook or Zoom.</p>${now ? `<button type="button" class="pill-btn sm" data-unlink>Disconnect this channel</button>` : ""}</form>`;
        const f = el.querySelector("form"), go = async link => {
          if (S.preview) return toast("Not saved: you're viewing as someone else, which is view only.");
          f.querySelector("button.primary").disabled = true;
          try { const j = await call({method: "POST", body: JSON.stringify({church, link})}); toast(j.channel ? `Connected: ${j.channel}.` : "Channel disconnected."); el.innerHTML = `<p class="empty">Loading the livestream…</p>`; pull(); }
          catch (e) { toast(e.message); f.querySelector("button.primary").disabled = false; }
        };
        f.onsubmit = e => { e.preventDefault(); const v = f.link.value.trim(); if (v) go(v); };
        el.querySelector("[data-unlink]")?.addEventListener("click", () => go(""));
      };
      const pull = async () => {  // every 30 seconds while the widget is on screen
        if (!el.isConnected) return clearInterval(t);
        if (el.querySelector(".live-set")) return;  // don't wipe a link someone is typing
        if (document.hidden && el.querySelector(".live-top")) return;  // the app is in the background: save the battery
        if (!el._live && el.querySelector(".live-top") && Date.now() - (el._at || 0) < 300000) return;  // not live: look again every 5 minutes, not every 30 seconds
        try {
          const j = await call();
          if (j.setup) return connect();
          const live = Object.values(j.platforms).some(x => x.status === "live"), h = j.history || [], top = Math.max(1, ...h.map(x => x.total));
          // Same numbers as last time (or someone is pointing at the chart): only the "Updated" time changes, so nothing on the page moves
          el._live = live; el._at = Date.now();
          const sig = JSON.stringify([live, j.platforms, h.length, h[h.length - 1]?.total]);
          if (el.dataset.sig === sig || (el.querySelector(".live-top") && (el.matches(":hover") || el.contains(document.activeElement)))) {
            const u = el.querySelector(".live-top small"); if (u) u.textContent = `Updated ${new Date(j.updatedAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}`;
            return; }
          el.dataset.sig = sig;
          // "peak this service" is this stream's peak only: morning prayers (4:30 to 6:30 am) are their own, and nothing shows between services
          const prayer = x => { const d = new Date(x), m = d.getHours() * 60 + d.getMinutes(); return m >= 270 && m < 390; };
          const peakNow = live ? Math.max(j.total, ...h.filter(x => prayer(x.t) === prayer(Date.now())).map(x => x.total)) : null;
          // the new numbers replace the old without the widget shrinking for a moment (which made the page jump)
          if (el.offsetHeight) { el.style.minHeight = el.offsetHeight + "px"; setTimeout(() => { el.style.minHeight = ""; }, 1500); }
          el.innerHTML = `<div class="live-top"><span class="live-dot ${live ? "on" : ""}">${live ? "Live now" : "Not live right now"}</span><span class="gap" style="flex:1"></span>
              <small>Updated ${new Date(j.updatedAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}</small></div>
            <div class="lv-card live-nums">
              <div class="lv-pair lv-one"><div><span class="lv-key"><i class="ring hot"></i>Watching now</span><b class="lv-big">${j.total}</b><small class="${live ? "lv-up" : ""}">${live ? "right now" : "not live"}</small></div></div>
              ${PL.some(([k]) => j.platforms[k].status !== "live") ? `<p class="lv-off">${PL.filter(([k]) => j.platforms[k].status !== "live").map(([k, t]) => `${t}: ${word(j.platforms[k])}`).join(" · ")}</p>` : ""}</div>
            <div class="lv-prog"><div class="lv-prog-main"><div class="lv-prog-top"><b class="lv-side-t">Viewers <small class="lv-when"></small></b>
                  ${j.home ? `<select class="in sel lv-range" aria-label="Show"><option value="day">The day picked above</option><option value="week" ${S.lvRange === "week" ? "selected" : ""}>Last 7 days</option></select>` : ""}</div>
                <div class="lv-prog-body"></div></div></div>
            ${j.platforms.zoom.status === "live" ? `<p class="note" style="margin:10px 0 0">Zoom counts hosts: take 2 off.</p>` : ""}
            ${j.channel ? `<div class="live-ch"><small>YouTube channel: <b>${esc(j.channel)}</b></small><button type="button" class="pill-btn sm" data-change>Change</button></div>` : ""}`;
          el.querySelector("[data-change]")?.addEventListener("click", () => connect(j.channel));
          // the chart: this service from the recent history, or the week from the saved services (each day's highest)
          const hmm = t => new Date(t).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
          const drawProg = () => {
            const body = el.querySelector(".lv-prog-body"); if (!body) return;
            const week = S.lvRange === "week" && j.home, L = S.liveAll, DAYMS = 864e5, when = el.querySelector(".lv-when");
            const dk = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
            let pts, wide = 0, skey = "h", firstAt = -1;
            if (week) {
              skey = "week"; if (when) when.textContent = "· last 7 days";
              if (!L) { body.innerHTML = `<p class="lv-empty">Loading the week…</p>`; }
              else {
                pts = Array.from({length: 7}, (_, i) => { const t = Date.now() - (6 - i) * DAYMS, k = dk(t), best = L.list.filter(x => dk(x.start) === k).reduce((b, x) => !b || x.youtube + x.facebook + x.zoom > b.youtube + b.facebook + b.zoom ? x : b, null),
                    v = best ? best.youtube + best.facebook + best.zoom : 0;
                  return {v, yt: best?.youtube || 0, fb: best?.facebook || 0, zm: best?.zoom || 0, label: new Date(t).toLocaleDateString([], {weekday: "short"}), tip: `${new Date(t).toLocaleDateString([], {weekday: "short", day: "numeric", month: "short"})} · ${v} watched`}; }); }
            } else if (j.home) {  // the day picked in the row above, in 5-minute steps; swipe sideways through it
              const key = S.lvDayKey || dk(Date.now()), now = Date.now(), isToday = key === dk(now);
              const from = new Date(key + "T00:00:00").getTime(), to = isToday ? now : from + DAYMS, D = (S.lvDays ??= {})[key];
              skey = key;
              if (when) when.textContent = "· " + (isToday ? "today" : new Date(key + "T12:00:00").toLocaleDateString([], {weekday: "short", day: "numeric", month: "short"}));
              if ((!D || (isToday && now - D.at > 60000)) && !(S.lvDayBusy ??= {})[key]) {  // a past day is loaded once; today again each minute
                S.lvDayBusy[key] = true;
                call({}, `&from=${from}&to=${to}&minutes=1`).then(r => { S.lvDays[key] = {at: Date.now(), to, list: Array.isArray(r.points) ? r.points : null}; })
                  .catch(() => { S.lvDays[key] = {at: Date.now(), to, list: null}; })
                  .finally(() => { delete S.lvDayBusy[key]; if (body.isConnected && (S.lvDayKey || dk(Date.now())) === key) drawProg(); });
              }
              if (!D) body.innerHTML = `<p class="lv-empty">Loading ${isToday ? "today" : "that day"}…</p>`;
              else if (D.list) {
                const step = 3e5, n = Math.max(2, Math.floor((D.to - from) / step) + 1), by = new Map(), pl = D.list.some(p => p.youtube != null);
                for (const p of D.list) { const k = Math.floor(p.t / step) * step, o = by.get(k), v = Number(p.total) || 0;
                  if (!o || v > o.v) by.set(k, {v, yt: Number(p.youtube) || 0, fb: Number(p.facebook) || 0, zm: Number(p.zoom) || 0}); }
                pts = Array.from({length: n}, (_, i) => { const t = from + i * step, o = by.get(t) || {v: 0, yt: 0, fb: 0, zm: 0}, v = o.v;
                  return {v, ...(pl ? {yt: o.yt, fb: o.fb, zm: o.zm} : {}), label: hmm(t), hour: new Date(t).getMinutes() === 0, tip: `${hmm(t)} · ${v} watching`}; });
                wide = n * 8;  // 8 pixels for each 5 minutes: about 2½ hours on a phone, 8 on a computer
                if (!isToday) firstAt = pts.findIndex(p => p.v > 0);  // a past day opens at its first stream
              } else pts = h.map(x => ({v: x.total, label: hmm(x.t), tip: `${hmm(x.t)} · ${x.total} watching`}));  // the dashboard can't give the day yet: the last few hours
            } else pts = h.map(x => ({v: x.total, label: hmm(x.t), tip: `${hmm(x.t)} · ${x.total} watching`}));
            if (pts && !week && !wide && h.length === pts.length && h[0]?.youtube != null) pts = pts.map((p, i) => ({...p, yt: h[i].youtube || 0, fb: h[i].facebook || 0, zm: h[i].zoom || 0}));
            if (!pts) return;
            // One graph for each platform, in its own colour, one under the other (they move together when swiped)
            const empty = live ? "The line starts after a minute or two of the livestream." : "Not live right now. Pick This week to see the last seven days.";
            const sets = pts.some(p => p.yt != null) ? [["youtube", "YouTube", "yt"], ["facebook", "Facebook", "fb"], ["zoom", "Zoom", "zm"]]
              .map(([k, t, f]) => ({k, t, ps: pts.map(p => ({v: p[f] || 0, label: p.label, hour: p.hour, tip: p.tip.split(" · ")[0]}))})) : [{k: "", t: "", ps: pts}];
            // The graphs start folded: a row with each platform's highest, tap to open them (remembered until the app is closed)
            const open = !!S.lvOpen, tops = sets.map(s => [s.k, s.t || "Watching", Math.max(0, ...s.ps.map(p => p.v))]);
            const tg = `<button type="button" class="lv-tg" aria-expanded="${open}">${open ? "<span></span>" : `<span class="lv-tops"><small>Highest</small>${tops.map(([k, t, v]) => `<span>${k ? `<i style="background:${PC[k]}"></i>` : ""}${t} <b>${v}</b></span>`).join("")}</span>`}<em>${open ? "Hide graphs" : "Show graphs"}${svg("caret")}</em></button>`;
            const tgBind = () => { const b = body.querySelector(".lv-tg"); if (b) b.onclick = () => { S.lvOpen = !open; S.lvJust = true; drawProg(); }; };
            if (!open) { body.innerHTML = tg; tgBind(); return; }
            body.classList.toggle("lv-in", !!S.lvJust); if (S.lvJust) { S.lvJust = false; setTimeout(() => body.classList.remove("lv-in"), 500); }
            body.innerHTML = sets.map(s => s.k ? `<div class="lv-mini"><div class="lv-mini-t"><span><i style="background:${PC[s.k]}"></i>${s.t}</span><small>highest <b>${Math.max(0, ...s.ps.map(p => p.v))}</b></small></div>${progChart(s.ps, empty, wide, PC[s.k], true)}</div>`
              : progChart(s.ps, empty, wide, "", true)).join("") + (wide ? `<p class="lv-hint">Swipe sideways to move through the day.</p>` : "") + tg;
            tgBind();
            const scs = [...body.querySelectorAll(".lv-scroll")];
            if (scs.length) {  // opens at now (or a past day's first stream); stays where it was swiped to when the numbers update
              const back = (S.lvBackBy ??= {})[skey];
              const place = () => scs.forEach(sc => { sc.scrollLeft = back != null ? sc.scrollWidth - sc.clientWidth - back
                : firstAt > 0 ? firstAt / (pts.length - 1) * sc.scrollWidth - 40 : firstAt === -1 && skey !== "h" && skey !== dk(Date.now()) ? 0 : sc.scrollWidth; });
              place(); requestAnimationFrame(place);
              let sync = false;
              scs.forEach(sc => {
                const mine = () => { sc.dataset.user = "1"; };  // only a person's own swipe moves where it opens next time
                for (const ev of ["pointerdown", "touchstart", "wheel"]) sc.addEventListener(ev, mine, {passive: true});
                sc.onscroll = () => { if (sync) return; sync = true; scs.forEach(o => { if (o !== sc) o.scrollLeft = sc.scrollLeft; }); sync = false;
                  if (sc.dataset.user) S.lvBackBy[skey] = sc.scrollWidth - sc.clientWidth - sc.scrollLeft; };
              });
            }
            body.querySelectorAll(".lv-chart").forEach((chart, ci) => {
              const ps = sets[ci]?.ps; if (!ps) return;
              const plot = chart.querySelector(".lv-plot"), tip = chart.querySelector(".lv-tip"), guide = chart.querySelector(".lv-guide"), n = ps.length;
              const at = e => { const r = plot.getBoundingClientRect(), x = ((e.touches?.[0] || e).clientX - r.left) / r.width, i = Math.max(0, Math.min(n - 1, Math.round(x * (n - 1))));
                const p = ps[i], top = Math.max(1, Math.ceil(Math.max(1, ...ps.map(q => q.v)) / 4)) * 4, left = i / (n - 1) * 100, y = 100 - p.v / top * 100;
                guide.hidden = tip.hidden = false; guide.style.left = left + "%"; tip.style.left = Math.max(12, Math.min(88, left)) + "%"; tip.style.top = y + "%";
                tip.innerHTML = `<b>${p.v}</b>${esc(p.tip.split(" · ")[0])}`; };
              const hit = chart.querySelector(".lv-hit"); hit.onmousemove = at; hit.ontouchstart = hit.ontouchmove = at;
              hit.onmouseleave = () => { guide.hidden = tip.hidden = true; };
            });
          };
          drawProg();
          el.querySelector(".lv-range")?.addEventListener("change", e => { S.lvRange = e.target.value; drawProg(); });
          if (j.home) {  // the services the live dashboard keeps (30 days): pick a day from the row; the numbers stay after a stream ends
            const box = document.createElement("div"); box.className = "live-day"; el.querySelector(".live-nums").after(box);
            const DAY = 864e5, dkey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
            const hm = t => new Date(t).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
            const sum = x => x.youtube + x.facebook + x.zoom;  // each platform's own peak, added together
            const show = () => {
              const L = S.liveAll, todayK = dkey(Date.now()), yK = dkey(Date.now() - DAY);
              if (!L) { drawProg(); box.innerHTML = `<p class="note">Loading the saved numbers…</p>`; return; }
              const by = {}; for (const x of L.list) (by[dkey(x.start)] ??= []).push(x);
              const days = [...new Set([...Object.keys(by), todayK])].sort();
              const sel = S.liveSel && days.includes(S.liveSel) ? S.liveSel : by[todayK] ? todayK : days.filter(k => by[k]).pop() || todayK;
              const list = by[sel] || [], best = Math.max(0, ...list.map(sum));
              S.lvDayKey = sel; drawProg();  // the graph shows the day picked in this row
              const label = k => k === todayK ? "Today" : k === yK ? "Yesterday" : (d => `${d.toLocaleDateString([], {weekday: "short"})} ${d.getDate()}`)(new Date(k + "T12:00:00"));
              box.innerHTML = `<div class="ld-days" role="tablist" aria-label="Pick a day">${days.map(k => `<button type="button" role="tab" class="${k === sel ? "on" : ""}" aria-selected="${k === sel}" data-lk="${k}">
                  <b>${esc(label(k))}</b></button>`).join("")}</div>
                ${L.failed ? `<p class="note">Some days couldn't be loaded. Try again in a minute.</p>` : ""}
                ${list.length ? `${`<div class="lv-svcs">${list.map(x => `<div class="lv-card">
                  <div class="lv-svc-top"><b>${hm(x.start)} – ${x.end ? hm(x.end) : "now"}</b>${x.end ? "" : "<small>still going</small>"}</div>
                  <div class="lv-svc-date">${new Date(x.start).toLocaleDateString([], {weekday: "short", day: "numeric", month: "short", year: "numeric"})}</div>
                  <b class="lv-big">${sum(x)} <small>watched</small></b>
                  ${split([["youtube", "YouTube", x.youtube, x.youtube], ["facebook", "Facebook", x.facebook, x.facebook], ["zoom", "Zoom", x.zoom, x.zoom]])}</div>`).join("")}</div>`}`
                : `<p class="note">No livestream yet today: the numbers stay here after it ends.</p>`}`;
              const row = box.querySelector(".ld-days"), on = row.querySelector(".on");
              row.scrollLeft = S.liveScroll ?? (on ? on.offsetLeft - row.clientWidth + on.offsetWidth + 8 : row.scrollWidth);
              row.onscroll = () => { S.liveScroll = row.scrollLeft; };
              row.querySelectorAll("[data-lk]").forEach(b => b.onclick = () => { S.liveSel = b.dataset.lk; if (S.lvRange === "week") { S.lvRange = "day"; const r = el.querySelector(".lv-range"); if (r) r.value = "day"; } show(); });  // already loaded: no waiting
            };
            show();
            const L = S.liveAll, now = Date.now();
            if (L && now - L.at < 60000) return;  // fresh enough
            // Everything once (30 days, in 3-day pieces asked for together), then only the last 3 days each minute
            const early = t => { const x = new Date(t), m = x.getHours() * 60 + x.getMinutes(); return m >= 270 && m < 390; };  // morning prayers, left out
            const end = new Date(); end.setHours(24, 0, 0, 0);
            const n = L && !L.failed && now - L.full < 600000 ? 1 : 10;
            const parts = await Promise.all(Array.from({length: n}, (_, i) =>
              call({}, `&from=${end.getTime() - (i + 1) * 3 * DAY}&to=${end.getTime() - i * 3 * DAY}`).then(s => s.services || []).catch(() => null)));
            if (!box.isConnected) return;
            if (parts.every(x => !x) && L) return;  // keep showing what we had
            const fresh = parts.flat().filter(x => x && !early(x.start) && (x.youtube > 0 || x.facebook > 0 || x.zoom > 2));  // not just the host and co-host on Zoom
            const keep = n === 1 && L ? L.list.filter(x => x.start < end.getTime() - 3 * DAY) : [];
            S.liveAll = {at: now, full: n === 1 ? L.full : now, failed: parts.some(x => !x), list: [...keep, ...fresh].sort((a, b) => a.start - b.start)};
            show();
          }
        } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
      };
      el.innerHTML = `<p class="empty">Loading the livestream…</p>`;
      const t = setInterval(pull, 30000); pull();
    }},
  busiest: {name: "Biggest services", sub: "Recent services, the biggest one highlighted", size: "full", icon: "bars", hue: 4,
    draw(el, p) {
      const rows = p.dates.slice(innerWidth < 640 ? -7 : -10).map(d => [d, Object.keys(p.byDate[d] || {}).length]);
      const best = p.dates.reduce((b, d) => { const v = Object.keys(p.byDate[d] || {}).length; return v > b[1] ? [d, v] : b; }, ["", 0]);
      const top = Math.max(1, ...rows.map(r => r[1])), topDay = [...rows].reverse().find(r => r[1] === top)?.[0];  // the latest of any tie
      el.innerHTML = rows.length ? `<div class="vbars">${rows.map(([d, v]) => `<button type="button" class="vbar ${d === topDay ? "on" : ""}" data-day="${d}" title="${esc(svcName(d))} · ${esc(nice(d, true))}: ${v}">
          <b>${d === topDay ? v : ""}</b><span style="height:${Math.max(6, v / top * 100)}%"></span><small>${esc(nice(d))}</small></button>`).join("")}</div>
          <p class="note" style="margin:12px 0 0">Highest so far: <b>${best[1]}</b> at ${esc(svcName(best[0]))}, ${esc(nice(best[0], true))}.</p>` : `<p class="empty">No services recorded yet.</p>`;
      el.querySelectorAll("[data-day]").forEach(b => b.onclick = () => { S.date = b.dataset.day; S.view = "checkin"; render(); });
    }},
  returning: {name: "Return rate", sub: "First-timers, and how many came back within 4 weeks", size: "full", icon: "gauge", hue: 3,
    draw(el, p) {
      // Each month (or week): first-timers whose first visit fell in it, and how many of them came back within 4 weeks.
      const DAY = 864e5, iso = t => new Date(t).toISOString().slice(0, 10), at = d => new Date(d + "T12:00:00").getTime(), now = Date.now();
      const view = S.rrView || "month", kind = S.rrKind || "line", w = el.closest(".w");
      w.querySelector(".w-tools").innerHTML = `<select class="in sel" id="rr-view" aria-label="Time interval"><option value="month" ${view === "month" ? "selected" : ""}>Monthly</option><option value="week" ${view === "week" ? "selected" : ""}>Weekly</option></select>
        <div class="seg" role="group" aria-label="Chart type"><button type="button" data-rk="line" aria-pressed="${kind === "line"}">${svg("trend")}Line</button><button type="button" data-rk="bar" aria-pressed="${kind === "bar"}">${svg("bars")}Bar</button></div>`;
      w.querySelector("#rr-view").onchange = e => { S.rrView = e.target.value; WIDGETS.returning.draw(el, p); };
      w.querySelectorAll("[data-rk]").forEach(b => b.onclick = () => { S.rrKind = b.dataset.rk; WIDGETS.returning.draw(el, p); });
      const firsts = p.mine.filter(m => m.first_visit && m.type !== "visitor");
      const cameBack = m => p.dates.some(d => d > m.first_visit && at(d) <= at(m.first_visit) + 28 * DAY && p.byDate[d][m.id]);
      const periods = [];
      if (view === "month") { const t = new Date(); for (let i = (innerWidth < 640 ? 5 : 7); i >= 0; i--) { const s = new Date(t.getFullYear(), t.getMonth() - i, 1), e = new Date(t.getFullYear(), t.getMonth() - i + 1, 0);
        periods.push({from: `${s.getFullYear()}-${pad(s.getMonth() + 1)}-01`, to: `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`, lab: s.toLocaleDateString("en-NZ", {month: "short"}), long: s.toLocaleDateString("en-NZ", {month: "long", year: "numeric"})}); } }
      else { const sun = new Date(); sun.setHours(12, 0, 0, 0); sun.setDate(sun.getDate() - sun.getDay());
        for (let i = (innerWidth < 640 ? 7 : 11); i >= 0; i--) { const s = sun.getTime() - i * 7 * DAY; periods.push({from: iso(s), to: iso(s + 6 * DAY), lab: nice(iso(s)), long: `Week of ${nice(iso(s), true)}`}); } }
      const rows = periods.map(x => { const f = firsts.filter(m => m.first_visit >= x.from && m.first_visit <= x.to);
        return {...x, first: f.length, back: f.filter(cameBack).length, counting: at(x.to) + 28 * DAY > now}; });
      const done = rows.filter(r => !r.counting), tf = done.reduce((n, r) => n + r.first, 0), tb = done.reduce((n, r) => n + r.back, 0), pct = tf ? Math.round(tb / tf * 100) : null;
      const W = innerWidth < 640 ? 380 : 760, H = innerWidth < 640 ? 220 : 250, L = 30, B = 28, T = 16, n = rows.length, max = Math.max(4, Math.ceil(Math.max(...rows.map(r => r.first)) / 4) * 4);
      const step = (W - L - 12) / n, x = i => L + step * i + step / 2, y = v => T + (H - T - B) * (1 - v / max);
      let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="First-timers and how many came back, ${view === "month" ? "by month" : "by week"}"><defs><linearGradient id="rrg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--h3);stop-opacity:.28"/><stop offset="1" style="stop-color:var(--h3);stop-opacity:0"/></linearGradient></defs>`;
      for (const t of [0, .25, .5, .75, 1].map(f => Math.round(max * f))) s += `<line class="gridline" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
      if (kind === "bar") {
        const bw = Math.min(16, step * .28);
        rows.forEach((r, i) => { s += `<rect x="${x(i) - bw - 1}" y="${y(r.first)}" width="${bw}" height="${y(0) - y(r.first)}" rx="3" fill="var(--line)"/>
          <rect x="${x(i) + 1}" y="${y(r.back)}" width="${bw}" height="${y(0) - y(r.back)}" rx="3" fill="var(--h3)" ${r.counting ? 'opacity=".45"' : ""}/>`; });
      } else {
        const line = k => rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r[k]).toFixed(1)}`).join(" ");
        rows.forEach((r, i) => { const bh = (y(0) - y(r.first)) * .35; s += `<rect x="${x(i) - step * .3}" y="${y(0) - bh}" width="${step * .6}" height="${bh}" rx="3" fill="var(--soft)"/>`; });
        s += `<path d="${line("back")} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#rrg)"/>`;
        s += `<path d="${line("first")}" fill="none" stroke="var(--ink-3)" stroke-width="2" stroke-linejoin="round"/><path d="${line("back")}" fill="none" stroke="var(--h3)" stroke-width="2.5" stroke-linejoin="round"/>`;
      }
      const every = Math.ceil(n / (innerWidth < 640 ? 4 : 8));
      rows.forEach((r, i) => { if ((n - 1 - i) % every === 0) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(r.lab)}</text>`; });
      s += `<line class="cursor" x1="0" x2="0" y1="${T}" y2="${y(0)}" stroke="var(--h3)" stroke-dasharray="4 4" opacity="0"/><circle class="dot" r="5" fill="var(--h3)" stroke="var(--card)" stroke-width="2" opacity="0"/>`;
      el.innerHTML = `<div class="rr-top"><div><b>${pct === null ? "–" : pct + "%"}</b><span>came back within 4 weeks</span></div>
          <div class="legend"><span><i style="background:var(--h3)"></i>Came back ${tb}</span><span><i style="background:var(--ink-3)"></i>First-timers ${tf}</span></div></div>
        <div class="chart rr-chart"><div class="tip"></div>${s}</svg></div>
        <p class="note" style="margin:8px 0 0">${pct === null ? "No first-timers in these " + (view === "month" ? "months" : "weeks") + " yet. " : ""}Target: half come back. The latest ${view === "month" ? "month isn't" : "few weeks aren't"} counted yet.</p>`;
      const box = el.querySelector(".rr-chart"), svgEl = box.querySelector("svg"), tip = box.querySelector(".tip"), cur = svgEl.querySelector(".cursor"), dot = svgEl.querySelector(".dot");
      svgEl.onpointermove = svgEl.onpointerdown = e => {
        const r = svgEl.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width * W - L) / step))), row = rows[i], px = x(i);
        cur.setAttribute("x1", px); cur.setAttribute("x2", px); cur.setAttribute("opacity", 1); dot.setAttribute("cx", px); dot.setAttribute("cy", y(row.back)); dot.setAttribute("opacity", kind === "line" ? 1 : 0);
        tip.innerHTML = `<b>${esc(row.long)}</b><br><i style="background:var(--h3)"></i>Came back <b>${row.back}</b><br><i style="background:var(--ink-3)"></i>First-timers <b>${row.first}</b>${row.first ? `<br>${Math.round(row.back / row.first * 100)}%${row.counting ? " so far" : ""}` : ""}`;
        tip.style.left = Math.max(80, Math.min(r.width - 80, px / W * r.width)) + "px"; tip.style.top = (y(row.first) / H * r.height) + "px"; tip.style.opacity = 1;
      };
      svgEl.onpointerleave = () => { tip.style.opacity = 0; cur.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); };
    }},
  followup: {name: "Needs a follow-up call", sub: `Missed ${YELLOW_AT} or more Sundays in a row`, size: "full", icon: "followup", hue: 3,
    draw(el, p) {
      const need = p.people.filter(x => x.level !== "ok");
      el.closest(".w").querySelector(".w-tools").innerHTML = `<button class="pill-btn sm" data-go="followup">See all ${need.length}</button>`;
      el.innerHTML = need.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Missed in a row</th><th class="hide-sm">Last seen</th><th>Phone</th></tr></thead>
        <tbody>${rowsHtml(need.slice(0, 6))}</tbody></table></div>` : `<p class="empty">Nobody has missed ${YELLOW_AT} or more services in a row.</p>`;
    }},
  stands: {name: "Pastoral care", sub: "Came, missed once, or need a call", size: "narrow", icon: "people", hue: 5,
    draw(el, p) {
      const stands = [["ok", "came this service"], ["blue", "missed this service"], ["yellow", `missed ${YELLOW_AT}–${RED_AT - 1} in a row`], ["red", `missed ${RED_AT} or more`]].map(([f, t]) => [f, t, p.count(f)]);
      el.innerHTML = `<div class="stand"><div class="donut"></div><div class="stand-rows">
        ${stands.map(([f, t, n]) => `<div class="status-row">${badge(f)}<span class="txt"><small>${t}</small></span><b>${n}</b></div>`).join("")}</div></div>`;
      donut(el.querySelector(".donut"), stands);
    }},
};
// Two boards share each person's saved list: the Dashboard's widgets as "key", the All-churches page's as "c:key"
// (either may end "@size"). "h:" and "c:" mark a board the person has set, so an emptied board stays empty.
const BOARDS = {home: {defs: () => WIDGETS, def: () => DASH_DEFAULT, pre: "", mark: "h:", where: "dashboard"},
                church: {defs: () => CWIDGETS, def: () => CDASH_DEFAULT, pre: "c:", mark: "c:", where: "page"}};
const dashKey = x => x.split("@")[0];
const sizeIn = (defs, x) => SIZES.some(s => s[0] === x.split("@")[1]) ? x.split("@")[1] : defs[dashKey(x)]?.size;
const dashSize = x => sizeIn(WIDGETS, x);
// Each person's widgets are saved in the database (so phone and laptop match), with this device as a fallback.
async function loadPrefs() {
  if (S.prefs !== undefined) return S.prefs;
  let list = null;
  try { const r = await api(`app_prefs?select=dash&email=eq.${encodeURIComponent(S.me.email)}`); list = r[0]?.dash || null; S.dashDb = true; } catch { S.dashDb = false; }
  if (!list) { try { list = JSON.parse(localStorage.getItem("fcc-dash:" + S.me.email) || "null"); } catch {} }
  return S.prefs = Array.isArray(list) ? list : null;
}
function boardList(b) {
  const raw = S.prefs, B = BOARDS[b], defs = B.defs();
  let mine;
  if (b === "home") mine = raw && (raw.includes("h:") || !raw.includes("c:")) ? raw.filter(x => x !== "h:" && !x.startsWith("c:")) : null;  // older saves hold the Dashboard only
  else mine = raw && raw.includes("c:") ? raw.filter(x => x.startsWith("c:") && x !== "c:").map(x => x.slice(2)) : null;
  return (mine || B.def()).filter(k => defs[dashKey(k)] && (!defs[dashKey(k)].only || defs[dashKey(k)].only()));  // some widgets are only for some people
}
async function saveBoard(b, list) {
  const home = b === "home" ? list : boardList("home"), church = b === "church" ? list : boardList("church");
  const raw = S.prefs = [...home, "h:", ...church.map(k => "c:" + k), "c:"];
  if (S.preview) return;  // View as: rearranging is fine to try, but it isn't kept
  try { localStorage.setItem("fcc-dash:" + S.me.email, JSON.stringify(raw)); } catch {}
  if (S.dashDb !== false) try { await api("app_prefs?on_conflict=email", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {email: S.me.email, dash: raw}}); } catch { S.dashDb = false; }
}
// The summary, as its own page: the settings on the left, the message's preview on the right, Copy / Open in WhatsApp under them
function summaryPage(el) {
  const p = picture();
  if (S.platforms === undefined) {  // other platforms added for every church (TikTok, Instagram...): loaded once
    el.innerHTML = `<p class="empty">Loading…</p>`;
    api("settings?select=value&key=eq.platforms").then(r => r?.[0]?.value || "").catch(() => "")
      .then(v => { S.platforms = String(v).split("\n").map(x => x.trim()).filter(Boolean); if (el.isConnected) summaryPage(el); });
    return;
  }
  el.innerHTML = head("Summary", "The service summary. Fill in each part, then copy it or send it from the side.") + `<div id="sumbox"></div>`;
  waDialog("Summary", o => !p.dates.includes(o.day) ? null : report(o.day !== p.last ? picture(o.day) : p, o), {names: true, link: true, follow: true, noEmoji: true, day: p.last || today(),
    fields: [["preacher", "Preacher name"], ["sermon", "Sermon title"], ["zoomA", "Zoom: adults", "num"], ["zoomK", "Zoom: children", "num"], ["yt", "YouTube", "num"], ["fb", "Facebook", "num"], ...platKeys().map(([nm, k]) => [k, nm, "num"]), ["converts", "New converts", "num"]],
    plat: ["admin", "lead"].includes(S.me.role), into: el.querySelector("#sumbox")});
  // Other platforms: a chip for each (tap × twice to remove), and Add a platform. Each gets its own box and line in the message.
  const box = el.querySelector("#m-plat"); if (!box) return;
  box.innerHTML = `<span class="plat-t">Other platforms</span>${S.platforms.map((nm, i) => `<span class="chip">${esc(nm)}<button type="button" class="plat-x" data-prm="${i}" aria-label="Remove ${esc(nm)}" title="Remove ${esc(nm)}">×</button></span>`).join("")}
    <button type="button" class="pill-btn sm" data-padd>${svg("plus")}Add a platform</button>`;
  const save = async list => {
    await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key: "platforms", value: list.join("\n")}});
    S.platforms = list; if (el.isConnected) summaryPage(el);
  };
  box.querySelector("[data-padd]").onclick = () => formDialog("Add a platform", [{k: "name", label: "Platform name", value: "",
      hint: "For example TikTok or Instagram. It gets its own box under Service details and its own line in the message, counted with the adults online. Every church sees it."}],
    async v => { const nm = String(v.name || "").trim().replace(/\s+/g, " ").slice(0, 30);
      if (!nm || !/[a-z0-9]/i.test(nm)) throw new Error("Type the platform's name.");
      if ([...S.platforms, "YouTube", "Facebook", "Zoom"].some(x => norm(x) === norm(nm))) throw new Error(`${nm} is already there.`);
      await save([...S.platforms, nm]); toast(`${nm} added.`); }, "Add");
  box.querySelectorAll("[data-prm]").forEach(b => b.onclick = async () => {
    const i = +b.dataset.prm, nm = S.platforms[i];
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Remove?"; return; }
    try { await save(S.platforms.filter((_, j) => j !== i)); toast(`${nm} removed.`); } catch (e) { toast("Not saved: " + e.message); }
  });
}
async function dashboard(el) {
  const p = picture();
  el.innerHTML = head("Dashboard", p.last ? `${esc(svcName(p.last))} · ${esc(nice(p.last, true))}` : "No services recorded yet",
    `<button class="pill-btn" id="addw">${svg("plus")}Add widget</button><button class="pill-btn" id="wa">Summary</button><button class="pill-btn primary" data-go="checkin">${svg("checkin")}Check people in</button>`) + `<div class="wgrid" id="wgrid"></div>`;
  el.querySelector("#wa").onclick = () => { S.view = "reports"; S.repTab = "summary"; render(); };  // the WhatsApp summary: a tab on Reports
  el.querySelector("#addw").onclick = () => addWidget("home");
  el.querySelector("[data-go]").onclick = () => { S.view = "checkin"; render(); };
  await loadPrefs();
  if (S.view !== "dashboard") return;
  drawBoard(el.querySelector("#wgrid"), "home", p);
}
// Draws one board's widgets into grid: each a card with a drag handle, coloured icon, title, tools and a ⋯ menu.
function drawBoard(grid, b, ctx) {
  const defs = BOARDS[b].defs(), list = boardList(b), save = l => saveBoard(b, l), size = x => sizeIn(defs, x);
  grid.innerHTML = list.length ? list.map((x, i) => { const k = dashKey(x), W = defs[k], sub = typeof W.sub === "function" ? W.sub(ctx) : W.sub, sz = size(x);
    return `<section class="w w-${sz} card" data-w="${k}" data-x="${esc(x)}" style="--wc:var(--h${W.hue});--wb:var(--h${W.hue}b)">
      <header class="w-head"><button type="button" class="w-grip" aria-label="Drag ${esc(W.name)} to move it" title="Drag to move">${svg("grip")}</button>
        <span class="w-ico">${svg(W.icon)}</span><div class="w-tt"><h2>${esc(W.name)}</h2><p>${esc(sub)}</p></div><div class="w-tools"></div>
        <div class="w-menu"><button class="icon-btn sm w-dots" data-wm="${k}" aria-label="Options for ${esc(W.name)}" aria-haspopup="true">${svg("dots")}</button>
          <div class="w-pop" hidden>${i ? `<button data-up="${i}">Move up</button>` : ""}${i < list.length - 1 ? `<button data-down="${i}">Move down</button>` : ""}
            <small>Size</small>${SIZES.map(([s, t]) => `<button data-size="${i}:${s}" class="${s === sz ? "on" : ""}">${t}</button>`).join("")}
            <button class="danger" data-rm="${i}">Remove</button></div></div></header>
      <div class="w-body"></div></section>`; }).join("")
    : `<div class="card w-full"><p class="empty">Nothing here yet. Tap <b>Add widget</b> to choose what to see.</p></div>`;
  for (const x of list) {
    const k = dashKey(x), body = grid.querySelector(`[data-w="${k}"] .w-body`);
    try { defs[k].draw(body, ctx); } catch (e) { body.innerHTML = `<p class="empty">This widget couldn't load.</p>`; }
  }
  grid.querySelectorAll("[data-wm]").forEach(btn => btn.onclick = e => { e.stopPropagation(); const pop = btn.nextElementSibling, open = pop.hidden;
    grid.querySelectorAll(".w-pop").forEach(x => x.hidden = true); pop.hidden = !open; });
  document.addEventListener("click", () => grid.querySelectorAll(".w-pop").forEach(x => x.hidden = true), {once: true});
  const move = (i, j) => { const l = [...list]; [l[i], l[j]] = [l[j], l[i]]; save(l); render(); };
  grid.querySelectorAll("[data-up]").forEach(x => x.onclick = () => move(+x.dataset.up, +x.dataset.up - 1));
  grid.querySelectorAll("[data-down]").forEach(x => x.onclick = () => move(+x.dataset.down, +x.dataset.down + 1));
  grid.querySelectorAll("[data-size]").forEach(x => x.onclick = () => { const [i, s] = x.dataset.size.split(":"), l = [...list], k = dashKey(l[i]);
    l[i] = s === defs[k].size ? k : `${k}@${s}`; save(l); render(); });
  grid.querySelectorAll("[data-rm]").forEach(x => x.onclick = () => { const k = dashKey(list[+x.dataset.rm]); save(list.filter((_, i) => i !== +x.dataset.rm));
    toast(`${defs[k].name} removed. Add it back any time with Add widget.`); render(); });
  grid.querySelectorAll("[data-go]").forEach(x => x.onclick = () => { S.view = x.dataset.go; render(); });
  // bar charts with more bars than fit slide sideways; a fade on the right edge shows there's more
  grid.querySelectorAll(".vbars").forEach(v => { const f = () => v.classList.toggle("more", v.scrollLeft + v.clientWidth < v.scrollWidth - 4); v.onscroll = f; requestAnimationFrame(f); });
  dragWidgets(grid, size, save);
}
// Drag a widget by its handle (mouse or finger): the others make room as you go, and the new order is saved for you only.
function dragWidgets(grid, size, save) {
  grid.querySelectorAll(".w-grip").forEach(h => h.onpointerdown = e => {
    if (e.button > 0) return;
    e.preventDefault();
    const w = h.closest(".w"), r = w.getBoundingClientRect(), start = [...grid.querySelectorAll(".w")].map(x => x.dataset.x).join("|");
    const ghost = w.cloneNode(true); ghost.classList.add("w-ghost"); ghost.removeAttribute("data-w"); Object.assign(ghost.style, {width: r.width + "px", height: r.height + "px", left: r.left + "px", top: r.top + "px"});
    document.body.append(ghost); w.classList.add("w-hole");
    const dx = e.clientX - r.left, dy = e.clientY - r.top, oneCol = () => getComputedStyle(grid).gridTemplateColumns.split(" ").length < 2;
    let scroller = 0;
    const at = ev => {
      ghost.style.left = ev.clientX - dx + "px"; ghost.style.top = ev.clientY - dy + "px";
      clearInterval(scroller);  // near the top or bottom of the screen, keep scrolling
      const edge = ev.clientY < 70 ? -1 : ev.clientY > innerHeight - 90 ? 1 : 0;
      if (edge) scroller = setInterval(() => scrollBy(0, edge * 14), 16);
      ghost.hidden = true; const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".w"); ghost.hidden = false;
      if (!under || under === w || under.parentElement !== grid) return;
      const u = under.getBoundingClientRect(), after = oneCol() || size(under.dataset.x) === "full" ? ev.clientY > u.top + u.height / 2 : ev.clientX > u.left + u.width / 2;
      if (after ? under.nextElementSibling !== w : under.previousElementSibling !== w) grid.insertBefore(w, after ? under.nextElementSibling : under);
    };
    const end = () => {
      clearInterval(scroller); removeEventListener("pointermove", at); removeEventListener("pointerup", end); removeEventListener("pointercancel", end);
      ghost.remove(); w.classList.remove("w-hole");
      const order = [...grid.querySelectorAll(".w")].map(x => x.dataset.x);
      if (order.join("|") !== start) { save(order); toast("Layout saved. Only your view changes."); render(); }
    };
    addEventListener("pointermove", at); addEventListener("pointerup", end); addEventListener("pointercancel", end);
  });
}
// The Add widget popup: every widget not on this board, with its icon, what it shows, and Select.
function addWidget(b) {
  document.querySelectorAll(".modal").forEach(m => m.remove());
  const B = BOARDS[b], defs = B.defs(), have = boardList(b), left = Object.keys(defs).filter(k => !have.some(x => dashKey(x) === k) && (!defs[k].only || defs[k].only()));
  const d = document.createElement("div"); d.className = "modal";
  d.innerHTML = `<div class="sheet narrow" role="dialog" aria-modal="true" aria-label="Add widget">
    <div class="card-head"><h2>Add widget</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
    ${left.length ? `<div class="wlist">${left.map(k => { const W = defs[k]; return `<button type="button" class="witem" data-add="${k}" style="--wc:var(--h${W.hue});--wb:var(--h${W.hue}b)">
      <span class="wico">${svg(W.icon)}</span><span class="wtxt"><b>${esc(W.name)}</b><span>${esc(W.desc || W.sub)}</span></span><span class="wadd">${svg("plus")}Add</span></button>`; }).join("")}</div>` : `<p class="empty">Every widget is already on this ${B.where}.</p>`}
    <p class="note">Drag a widget by its handle to move it. Only your view changes.</p>
    <div class="modal-foot one"><button type="button" class="pill-btn" data-reset>Back to the standard layout</button></div></div>`;
  document.body.append(d);
  const close = () => { d.remove(); document.removeEventListener("keydown", onKey); }, onKey = e => { if (e.key === "Escape") close(); };
  d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
  document.addEventListener("keydown", onKey);
  d.querySelectorAll("[data-add]").forEach(x => x.onclick = async () => { await saveBoard(b, [...have, x.dataset.add]); close(); toast(`${defs[x.dataset.add].name} added at the bottom. Drag it to where you want it.`); render(); });
  d.querySelector("[data-reset]").onclick = async () => { await saveBoard(b, [...B.def()]); close(); toast("Back to the standard layout."); render(); };
}
// ---------------------------------------------------------------- check-in
async function log(kind, member_id, result = "done", detail = "") {
  try { await api("activity_log", {method: "POST", prefer: "return=minimal", body: {id: newId() + newId(), at: isoLocal(), kind, service_date: S.date,
    member_id, detail, by_name: `${S.me.name || S.me.email} (${roleName(S.me)})`, result}}); } catch {}
}
// A service's title. Until someone types one, Sunday and Wednesday get the usual names.
const svcName = d => S.names[d] || (S.titles?.[d]) || ({0: "Sunday Service", 3: "Midweek Service"})[new Date(d + "T12:00:00").getDay()] || "Service";
async function setPresent(id, on, seen, at = isoLocal(), part = 0) {
  if (on) {
    // the service row only needs saving once per date; doing it on every tick doubled the wait
    if (!S.names[S.date] && !(S.svcSaved ??= {})[S.date]) {
      await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, name: svcName(S.date)}});
      S.svcSaved[S.date] = true;
    }
    await api("attendance?on_conflict=service_date,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, member_id: id, checked_at: at}});
    if (part) await api("service_ticks?on_conflict=service_date,part,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, part, member_id: id, checked_at: at}});
    log("tick", id, "done", part ? partName(S.date, part) : "");
    const m = S.members.find(x => x.id === id);  // someone marked Away or Inactive who comes back is Active again (whoever ticks them)
    if (m && String(m.status || "").trim() && ruleOf(m) !== "gone")
      api("rpc/app_back_active", {method: "POST", body: {mid: id}})
        .then(ok => { if (ok) { Object.assign(m, {status: "", version: (Number(m.version) || 1) + 1}); toast(`${m.full_name} is back, so they're Active again.`); } }).catch(() => {});
    return "done";
  }
  if (part) {  // off one of the day's services; off the day too once they're at none of them
    await api(`service_ticks?service_date=eq.${S.date}&part=eq.${part}&member_id=eq.${encodeURIComponent(id)}`, {method: "DELETE", prefer: "return=minimal"});
    const still = await api(`service_ticks?select=part&service_date=eq.${S.date}&member_id=eq.${encodeURIComponent(id)}`).catch(() => []);
    if (!still?.length) await api(`attendance?service_date=eq.${S.date}&member_id=eq.${encodeURIComponent(id)}`, {method: "DELETE", prefer: "return=minimal"});
    log("untick", id, "done", partName(S.date, part)); return "done";
  }
  // only remove the tick this phone was showing; a newer tick from another phone is left alone
  const gone = await api(`attendance?service_date=eq.${S.date}&member_id=eq.${encodeURIComponent(id)}${seen ? "&checked_at=eq." + encodeURIComponent(seen) : ""}`, {method: "DELETE", prefer: "return=representation"});
  const result = gone?.length ? "done" : "changed";
  if (gone?.length && S.partsOk) await api(`service_ticks?service_date=eq.${S.date}&member_id=eq.${encodeURIComponent(id)}`, {method: "DELETE", prefer: "return=minimal"}).catch(() => {});  // off the whole day: off each of its services too
  log("untick", id, result); return result;
}
function checkin(el) {
  if (S.ciMode === "bacenta" && bacTickable().length) return bacentas(el, "take");  // Check-in → Bacenta
  const mine = S.members.filter(m => churchOf(m) === S.church && ruleOf(m) === "in").sort((a, b) => norm(a.full_name).localeCompare(norm(b.full_name)));
  const back = S.members.filter(m => churchOf(m) === S.church && ruleOf(m) === "out");  // off the lists: found by searching; ticking brings them back
  let here = {};
  const pastor = S.me.role === "pastor";  // a pastor ticks their own people only (locks work as for ushers): no adding or renaming
  // Laid out like Admin → Sign-ins: numbers on top, then pills to filter, team and search on the right, a table of names, 25 a page
  el.innerHTML = head("Check-in", pastor ? "Your people" : esc(S.church)) + ciSwitch() + `
    <details class="card ci-top" style="margin-bottom:14px" ${S.ciTopOpen ? "open" : ""}>
      <summary><span class="ci-top-t"><b>Service</b><small id="ci-top-sum"></small></span>${svg("caret")}</summary><div class="row">
      <div style="flex:0 0 170px"><label class="f" for="d">Service date</label><input class="in" id="d" type="date" value="${S.date}"></div>
      <div><label class="f" for="svc">Service</label><input class="in" id="svc" list="svc-list" maxlength="60" autocomplete="off" value="${esc(svcName(S.date))}" ${pastor ? "readonly" : ""}>
        <datalist id="svc-list">${[...new Set(["Sunday Service", "Midweek Service", "Prayer Meeting", "Special Service", ...Object.values(S.names)])].map(n => `<option value="${esc(n)}">`).join("")}</datalist></div></div>
      <div id="ci-parts"></div></details>
    <div class="tiles"><div class="card tile"><div class="label">Checked in</div><div class="num" id="n-in">0</div></div>
      <div class="card tile"><div class="label">Adults</div><div class="num" id="n-ad">0</div></div>
      <div class="card tile"><div class="label">Kids</div><div class="num" id="n-kid">0</div></div>
      <div class="card tile"><div class="label">Not yet</div><div class="num" id="n-not">0</div></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2 id="ci-title">Names A to Z</h2><span class="gap"></span><button type="button" class="pill-btn sm" id="ci-list">${svg("checkin")}Tick from a list</button><button type="button" class="pill-btn sm" id="ci-lock">${svg("lock")}Save &amp; lock</button></div>
      <label class="find-bar">${svg("search")}<input id="q" type="search" placeholder="Search by name, phone or team" value="${esc(S.q)}" aria-label="Search by name, phone or team" autocomplete="off"></label>
      <div class="rpills ci-teams" id="ci-teams" aria-label="Teams" hidden></div>
      <div class="bulk" id="ci-bulk" hidden style="position:static;box-shadow:none"><b id="ci-count"></b><span class="gap"></span><button type="button" class="pill-btn sm primary" id="ci-all">Tick all</button><button type="button" class="pill-btn sm" id="ci-none">Untick all</button></div>
      <div class="msg locked" id="ci-locked" hidden></div>
      <div id="names"></div><div id="ci-pager"></div>
      <div style="margin-top:12px;text-align:right" id="ci-clear-wrap" hidden><button type="button" class="pill-btn sm" id="ci-clear">Untick everyone</button></div></div>
    ${pastor ? "" : `<form class="card" id="add"><div class="card-head"><h2>Add someone new</h2></div><div class="row">
      <div><label class="f" for="a-name">Full name</label><input class="in" id="a-name" required></div>
      <div><label class="f" for="a-phone">Phone <span class="muted">(optional)</span></label><input class="in" id="a-phone" type="tel" inputmode="tel" maxlength="20" autocomplete="off"></div>
      <div><label class="f" for="a-type">Attendance Type</label><select class="in" id="a-type"><option value="first_timer">First-timer</option><option value="visitor">Visitor</option><option value="member">Member</option></select></div>
      <div><label class="f" for="a-age">Age group</label><select class="in" id="a-age"><option>Adult</option><option>Child</option></select></div>
      <div><label class="f" for="a-gender">Gender</label><select class="in" id="a-gender"><option value="">Not given</option><option>Female</option><option>Male</option></select></div>
      <div style="flex:0 0 auto;display:flex;gap:8px;flex-wrap:wrap"><button class="pill-btn primary">Add &amp; check in</button><button class="pill-btn" data-only>Add only</button></div></div>
      </form>`}`;
  const box = el.querySelector("#names");
  wireSwitch(el);
  // A day can hold more than one service: pick which one you're ticking for, or the whole day
  const curPart = () => { const ps = partsOf(S.date); if (!ps.length) return 0; const v = S.ciParts?.[S.date]; return v && ps.some(x => x.part === v) ? v : ps[0].part; };
  let armedPart = false;
  // The top card folds away: its title line still shows the day and the service being ticked
  const topSum = () => { const s = el.querySelector("#ci-top-sum"); if (!s) return; const ps = partsOf(S.date);
    s.textContent = `${nice(S.date, true)} · ${ps.length ? partName(S.date, curPart()) : el.querySelector("#svc")?.value || svcName(S.date)}`; };
  el.querySelector(".ci-top")?.addEventListener("toggle", e => { S.ciTopOpen = e.target.open; });
  el.querySelector("#svc")?.addEventListener("input", topSum);
  const lastPart = () => { const ps = partsOf(S.date); return ps.length > 1 ? Math.max(...ps.map(x => x.part)) : 0; };  // the one Remove takes away (never the first)
  const drawParts = () => {
    topSum();
    const ps = partsOf(S.date), n = curPart(), wrap = el.querySelector("#ci-parts"), boss = ["admin", "lead"].includes(S.me.role);
    if (!S.partsOk || (pastor && !ps.length)) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = ps.length ? `<div class="ci-parts"><div class="ci-pick"><span class="f">Ticking for</span><div class="seg ci-seg" role="group" aria-label="Which service">${ps.map(x =>
        `<button type="button" data-part="${x.part}" aria-pressed="${n === x.part}">${esc(partName(S.date, x.part))}</button>`).join("")}</div></div>
        ${pastor ? "" : `<div class="ci-part-acts">${ps.length < 3 ? `<button type="button" class="pill-btn sm" data-split>${svg("plus")}Add ${ORDINAL[ps.length + 1].toLowerCase()} service</button>` : ""}
        ${boss ? `<button type="button" class="pill-btn sm ci-remove" data-unsplit>${armedPart ? `Tap again to remove ${esc(partName(S.date, lastPart()))}` : `Remove ${esc(partName(S.date, lastPart()))}`}</button>` : ""}</div>`}</div>
        <p class="note ci-part-note">Ticks here are for <b>${esc(partName(S.date, n))}</b>. Someone at several services counts once in the day's total.</p>`
      : pastor ? "" : `<button type="button" class="pill-btn sm" data-split style="margin-top:12px" title="Two services today? Split the day into services">${svg("plus")}Add a second service</button>`;
    wrap.querySelectorAll("[data-part]").forEach(b => b.onclick = () => { (S.ciParts ??= {})[S.date] = +b.dataset.part; armedPart = false; here = {}; svc.value = svcLabel(); drawParts(); draw(); pull(); });
    wrap.querySelector("[data-split]")?.addEventListener("click", split);
    wrap.querySelector("[data-unsplit]")?.addEventListener("click", unsplit);
  };
  const svcLabel = () => { const n = curPart(); return n ? partName(S.date, n) : svcName(S.date); };
  const sqlNeeded = err => /service_parts|service_ticks|schema cache|does not exist/i.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message;
  // All or nothing: one call to the database, which saves every step together or none of them (like a bank transfer).
  // Until the latest setup SQL has been run, the old way (one step at a time) is used instead.
  const together = async (fn, body, old) => {
    try { return await api("rpc/" + fn, {method: "POST", body}); }
    catch (err) { if (/Could not find the function|PGRST202|schema cache/i.test(err.message)) return old(); throw err; }
  };
  const split = async () => {
    if (lock) return toast("This service is locked. Unlock it to make changes.");
    const day = S.date, have = S.parts[day] || [], first = svcName(day);
    const next = have.length > 1 ? Math.max(...have.map(x => x.part)) + 1 : 2;
    if (have.length >= 3) return toast("Three services is the most for one day.");
    const name1 = S.names[day] || S.titles?.[day] ? first : "First service";  // the first follows the service's title, if it has one
    const rows = have.length > 1 ? [{church: S.church, service_date: day, part: next, name: `${ORDINAL[next] || "Another"} service`}]
      : [{church: S.church, service_date: day, part: 1, name: name1}, {church: S.church, service_date: day, part: 2, name: "Second service"}];
    try {
      // the service, its parts and who was at the first one: saved together, or not at all
      const list = await together("app_add_service", {ch: S.church, d: day, title: first, first_name: name1}, async () => {
        await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: day, name: first}});
        await api("service_parts?on_conflict=church,service_date,part", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows});
        if (have.length < 2) {  // everyone ticked so far today was at the first service
          const ticked = Object.entries(here).filter(([id]) => mine.some(m => m.id === id));
          if (ticked.length) await api("service_ticks?on_conflict=service_date,part,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
            body: ticked.map(([id, at]) => ({service_date: day, part: 1, member_id: id, checked_at: at}))});
          S.pticks.push(...ticked.map(([id]) => ({service_date: day, part: 1, member_id: id})));
        }
        return [...(have.length > 1 ? have : [{part: 1, name: name1}]), {part: next, name: rows.at(-1).name}];
      });
      S.parts[day] = list.map(x => ({part: x.part, name: x.name})).sort((a, b) => a.part - b.part);
      const added = S.parts[day].at(-1);
      (S.ciParts ??= {})[day] = added.part; log("edit", "", "done", `${S.church} · ${day}: added ${added.name}`);
      toast(have.length > 1 ? "Service added. Rename it in the Service box." : "Two services today. Everyone ticked so far is in the first one. Rename this one in the Service box.");
      here = {}; svc.value = svcLabel(); drawParts(); draw(); pull();
    } catch (err) { toast(sqlNeeded(err)); }
  };
  const unsplit = async () => {  // removes the last service added; the first service always stays
    const day = S.date, n = lastPart(); if (!n) return;
    if (!armedPart) { armedPart = true; drawParts(); setTimeout(() => { if (armedPart) { armedPart = false; if (S.view === "checkin") drawParts(); } }, 4000); return; }
    armedPart = false;
    const left = (S.parts[day] || []).filter(x => x.part !== n), gone = left.length < 2 ? [n, ...left.map(x => x.part)] : [n];
    const ids = mine.map(m => m.id);
    try {
      // the service's ticks and the service itself: removed together, or not at all
      const list = await together("app_remove_service", {ch: S.church, d: day}, async () => {
        for (const k of gone) for (let i = 0; i < ids.length; i += 80)  // only this church's people: part numbers are per church
          await api(`service_ticks?service_date=eq.${day}&part=eq.${k}&member_id=in.(${ids.slice(i, i + 80).map(x => `"${x}"`).join(",")})`, {method: "DELETE", prefer: "return=minimal"});
        await api(`service_parts?church=eq.${encodeURIComponent(S.church)}&service_date=eq.${day}&part=in.(${gone.join(",")})`, {method: "DELETE", prefer: "return=minimal"});
        return left.length < 2 ? [] : left;
      });
      S.pticks = S.pticks.filter(t => !(t.service_date === day && gone.includes(t.part) && ids.includes(t.member_id)));
      S.parts[day] = list.length < 2 ? [] : list.map(x => ({part: x.part, name: x.name})).sort((a, b) => a.part - b.part); if (S.ciParts) delete S.ciParts[day];
      log("edit", "", "done", `${S.church} · ${day}: removed ${partName(day, n)}`);
      toast(left.length < 2 ? "Back to one service today. Everyone ticked is still in the day's total." : "Service removed. Everyone ticked is still in the day's total.");
      here = {}; svc.value = svcLabel(); drawParts(); draw(); pull();
    } catch (err) { toast(sqlNeeded(err)); }
  };
  const teams = {};  // each role in this church with how many people have it
  for (const m of mine) for (const r of new Set(rolesOf(m).map(norm))) (teams[r] ??= {label: rolesOf(m).find(x => norm(x) === r), n: 0}).n++;
  if (S.ciRole && !teams[S.ciRole]) S.ciRole = "";
  // team pills, each in its own colour (the same colour every time, from the team's name)
  const teamKeys = Object.keys(teams).sort(), teamBox = el.querySelector("#ci-teams");
  teamBox.hidden = !teamKeys.length;
  // Everyone, then the five biggest teams (plus the one picked); "+ more" shows the rest
  const drawTeams = () => {
    const big = [...teamKeys].sort((a, b) => teams[b].n - teams[a].n || a.localeCompare(b)).slice(0, 5);
    if (S.ciRole && !big.includes(S.ciRole)) big.push(S.ciRole);
    const show = S.ciMore ? teamKeys : teamKeys.filter(k => big.includes(k)), more = teamKeys.length - show.length;
    teamBox.innerHTML = `<button type="button" class="rpill" data-team="" aria-pressed="${!S.ciRole}">Everyone <span>${mine.length}</span></button>` + show.map(k => { const h = hueOf(teams[k].label);
      return `<button type="button" class="rpill" data-team="${esc(k)}" aria-pressed="${S.ciRole === k}" style="--rc:var(--h${h});--rb:var(--h${h}b);--rt:var(--h${h}t)"><i></i>${esc(teams[k].label)} <span>${teams[k].n}</span></button>`; }).join("")
      + (more ? `<button type="button" class="rpill more" data-more>+ ${more} more</button>` : S.ciMore && teamKeys.length > 5 ? `<button type="button" class="rpill more" data-more>Show less</button>` : ""); };
  teamBox.onclick = e => { if (e.target.closest("[data-more]")) { S.ciMore = !S.ciMore; drawTeams(); return; }
    const b = e.target.closest("[data-team]"); if (!b) return; S.ciRole = S.ciRole === b.dataset.team ? "" : b.dataset.team; S.ciPage = 1; armed = false; drawTeams(); draw(); };
  drawTeams();
  const PER = 60;  // three columns of 20
  let armed = false, armedAll = false, busy = false;
  const narrowedTo = () => { const q = norm(S.q);  // team and search; the pills then pick within these
    return (q ? [...mine, ...back] : mine).filter(m => (!S.ciRole || rolesOf(m).some(r => norm(r) === S.ciRole)) && (!q || norm(m.full_name).includes(q) || norm(m.phone).includes(q) || rolesOf(m).some(r => norm(r).includes(q)))); };
  const showing = () => narrowedTo();
  const draw = () => {
    const shown = narrowedTo(), narrowed = !!(S.ciRole || norm(S.q)), ticked = shown.filter(m => here[m.id]).length;
    const pages = Math.max(1, Math.ceil(shown.length / PER)); S.ciPage = Math.min(Math.max(1, S.ciPage || 1), pages);
    const page = shown.slice((S.ciPage - 1) * PER, S.ciPage * PER);
    const nums = [...new Set([1, S.ciPage - 1, S.ciPage, S.ciPage + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
    box.innerHTML = shown.length ? `<div class="names">${page.map(m => `<label class="name ${here[m.id] ? "on" : ""}"><input type="checkbox" data-id="${esc(m.id)}" ${here[m.id] ? "checked" : ""} ${lock ? "disabled" : ""}>
        <span class="nava" ${avaStyle(m.full_name)}>${esc(initials(m.full_name))}</span><span class="nn">${esc(m.full_name)}</span><small>${[m.type === "first_timer" ? "first-timer" : m.type === "visitor" ? "visitor" : "", isKid(m) ? "child" : "", m.status ? String(m.status).toLowerCase() : ""].filter(Boolean).map(esc).join(" · ")}</small></label>`).join("")}</div>`
      : `<p class="empty">${norm(S.q) ? "Nobody matches that search." : "Nobody here. Try another filter or team."}</p>`;
    el.querySelector("#ci-pager").innerHTML = pages > 1 ? `<div class="pager"><span class="muted">Page ${S.ciPage} of ${pages} · ${shown.length} people</span><span class="gap"></span>
        <button class="pg" data-cpg="${S.ciPage - 1}" ${S.ciPage === 1 ? "disabled" : ""} aria-label="Previous page">${svg("prev")}</button>
        ${nums.map((n, i) => (i && n - nums[i - 1] > 1 ? `<span class="muted">…</span>` : "") + `<button class="pg ${n === S.ciPage ? "on" : ""}" data-cpg="${n}">${n}</button>`).join("")}
        <button class="pg" data-cpg="${S.ciPage + 1}" ${S.ciPage === pages ? "disabled" : ""} aria-label="Next page">${svg("next")}</button></div>` : shown.length ? `<p class="note" style="margin:10px 2px 0">Showing ${shown.length} of ${mine.length}</p>` : "";
    el.querySelectorAll("[data-cpg]").forEach(b => b.onclick = () => { S.ciPage = +b.dataset.cpg; draw(); });
    el.querySelector("#ci-title").textContent = S.ciRole ? teams[S.ciRole].label : "Names A to Z";
    // ticking a whole group is only offered once the list is narrowed to a team, a search or a pill, never for the whole church
    const bar = el.querySelector("#ci-bulk"); bar.hidden = !narrowed || !shown.length;
    el.querySelector("#ci-count").textContent = `${ticked} of ${shown.length} here`;
    const all = el.querySelector("#ci-all"), none = el.querySelector("#ci-none");
    all.textContent = `Tick all ${shown.length}`; all.disabled = busy || ticked === shown.length;
    none.textContent = armed ? `Tap again to untick ${ticked}` : "Untick all"; none.disabled = busy || !ticked || !!lock; all.disabled = all.disabled || !!lock;
    // clearing the whole service is for admins and church admins, and only from the full list
    const total = mine.filter(m => here[m.id]).length, wrap = el.querySelector("#ci-clear-wrap"), clear = el.querySelector("#ci-clear");
    wrap.hidden = narrowed || !total || S.me.role === "team" || pastor;
    clear.textContent = armedAll ? `Tap again to untick all ${total}` : "Untick everyone"; clear.disabled = busy || !!lock;
    const ids = mine.filter(m => here[m.id]), kids = ids.filter(isKid).length;
    el.querySelector("#n-in").textContent = ids.length; el.querySelector("#n-ad").textContent = ids.length - kids;
    el.querySelector("#n-kid").textContent = kids; el.querySelector("#n-not").textContent = mine.length - ids.length;
  };
  const pull = async () => {
    const n = curPart(), day0 = S.date;
    const [rows, prows] = await Promise.all([api(`attendance?select=member_id,checked_at&service_date=eq.${day0}`).catch(() => null),
      n ? api(`service_ticks?select=member_id,checked_at,part&service_date=eq.${day0}`).catch(() => null) : null]);
    readLock();
    if (!rows || S.view !== "checkin" || day0 !== S.date || n !== curPart()) return;
    const dayHere = Object.fromEntries(rows.map(r => [r.member_id, r.checked_at]));
    if (prows) S.pticks = S.pticks.filter(t => t.service_date !== day0).concat(prows.map(r => ({service_date: day0, part: r.part, member_id: r.member_id})));
    // one service: who was ticked for it (and is still ticked for the day); the whole day: everyone
    here = n ? Object.fromEntries((prows || []).filter(r => r.part === n && dayHere[r.member_id]).map(r => [r.member_id, r.checked_at || dayHere[r.member_id]])) : dayHere;
    for (const [id, v] of pending) { if (v) here[id] ??= v; else delete here[id]; }  // taps still saving win over an older copy from the server
    S.ticks = S.ticks.filter(t => t.service_date !== S.date).concat(rows.map(r => ({...r, service_date: S.date})));
    const sig = JSON.stringify(Object.keys(here).sort());  // the same ticks as last time: nothing on the page changes
    if (sig !== pullSig && document.activeElement?.type !== "checkbox") { pullSig = sig; draw(); }
  };
  let pullSig = "";
  const pending = new Map();  // ticks shown straight away while they save in the background
  // Save & lock: once a service is done, its ticks are frozen on every phone until someone unlocks it
  let lock = null; const lockKey = () => `lock:${S.date}:${S.church}`;
  const showLock = () => {
    const b = el.querySelector("#ci-lock"), note = el.querySelector("#ci-locked");
    b.innerHTML = lock ? `${svg("unlock")}Unlock` : `${svg("lock")}Save &amp; lock`; b.classList.toggle("primary", !lock);
    note.hidden = !lock; if (lock) note.textContent = `Saved and locked${lock.by ? " by " + lock.by : ""}. Unlock to make changes.`;
    for (const id of ["ci-all", "ci-none", "ci-clear"]) { const x = el.querySelector("#" + id); if (x && lock) x.disabled = true; }
    const go = el.querySelector("#add button.primary"); if (go) go.disabled = !!lock;
  };
  const readLock = async () => {
    const want = lockKey(), rows = await api(`settings?select=value&key=eq.${encodeURIComponent(want)}`).catch(() => null);
    if (!rows || want !== lockKey() || S.view !== "checkin") return;
    let v = null; try { v = rows[0]?.value ? JSON.parse(rows[0].value) : null; } catch {}
    if (JSON.stringify(v) !== JSON.stringify(lock)) { lock = v; draw(); }
    showLock();
  };
  el.querySelector("#ci-lock").onclick = async () => {
    const next = lock ? "" : JSON.stringify({by: S.me.name || S.me.email, at: isoLocal()});
    if (!lock && pending.size) return toast("Still saving the last ticks. Try again in a moment.");
    try {
      await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key: lockKey(), value: next}});
      lock = next ? JSON.parse(next) : null; log(lock ? "lock" : "unlock", "", "done", `${S.church} · ${S.date}`);
      toast(lock ? "Saved and locked." : "Unlocked. You can change ticks again."); draw(); showLock();
    } catch (err) { toast(/row-level|policy/i.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
  };
  box.onchange = async e => {
    if (lock) { e.target.checked = !e.target.checked; return toast("This service is locked. Unlock it to make changes."); }
    const id = e.target.dataset.id, on = e.target.checked, seen = here[id], at = isoLocal();
    if (on) here[id] = at; else delete here[id];
    pending.set(id, on ? at : null); e.target.blur(); draw();
    try {
      const result = await setPresent(id, on, curPart() ? undefined : seen, at, curPart());
      if (result === "changed") toast("That tick was changed on another phone, so it was left as it is.");
    } catch (err) {
      if (seen) here[id] = seen; else delete here[id];
      toast("Not saved: " + err.message);
    }
    pending.delete(id); draw(); pull();
  };
  el.querySelector("#q").oninput = e => { S.q = e.target.value; S.ciPage = 1; armed = false; draw(); };
  el.querySelector("#ci-all").onclick = async () => {
    const todo = showing().filter(m => !here[m.id]); if (!todo.length || busy) return;
    busy = true; armed = false; draw();
    try {
      await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, name: svcName(S.date)}});
      const at = isoLocal();  // one request for the whole group; anyone already ticked on another phone is left as they are
      await api("attendance?on_conflict=service_date,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: todo.map(m => ({service_date: S.date, member_id: m.id, checked_at: at}))});
      if (curPart()) await api("service_ticks?on_conflict=service_date,part,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
        body: todo.map(m => ({service_date: S.date, part: curPart(), member_id: m.id, checked_at: at}))});
      for (const m of todo) { here[m.id] = at; log("tick", m.id, "done", S.ciRole ? `with ${teams[S.ciRole].label}` : "with a group"); }
      toast(`Ticked ${todo.length} ${todo.length === 1 ? "person" : "people"}. Untick anyone who isn't here.`);
    } catch (err) { toast("Not saved: " + err.message); }
    busy = false; draw(); pull();
  };
  // Tick from a list: paste names (from a sign-in sheet, a WhatsApp message or a file) and everyone found is ticked at once.
  // Names are matched to this church's list however they're written ("MENSAH Ama", "ama mensah", "Ama K. Mensah").
  el.querySelector("#ci-list").onclick = () => {
    if (lock) return toast("This service is locked. Unlock it to make changes.");
    document.querySelectorAll(".modal").forEach(m => m.remove());
    const d = document.createElement("div"); d.className = "modal";
    d.innerHTML = `<form class="sheet narrow" role="dialog" aria-modal="true" aria-label="Tick from a list">
      <div class="card-head"><h2>Tick from a list</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
      <div class="fields">
        <p class="note" style="margin:0">For <b>${esc(curPart() ? partName(S.date, curPart()) : svcName(S.date))}</b>, ${esc(nice(S.date, true))}. Paste names, one per line, or pick a file.</p>
        <label class="bk-drop" style="padding:12px"><input type="file" id="tl-file" accept=".csv,.txt,text/csv,text/plain"><span class="bk-drop-btn" style="font-size:15px;padding:10px 18px">${svg("upload")}<span>Choose a file</span></span></label>
        <textarea class="in" id="tl-text" rows="6" placeholder="Ama Mensah&#10;Kofi Boateng&#10;Efua Owusu"></textarea>
        <div id="tl-prev"></div>
      </div>
      <div class="modal-foot"><button type="button" class="pill-btn" data-x>Cancel</button><button class="pill-btn primary" id="tl-go" disabled>Tick people</button></div></form>`;
    document.body.append(d);
    const $ = id => d.querySelector("#" + id), close = () => { d.remove(); document.removeEventListener("keydown", onKey); }, onKey = e => { if (e.key === "Escape") close(); };
    d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
    document.addEventListener("keydown", onKey);
    const words = x => norm(x).replace(/[^\p{L}\s'-]/gu, " ").split(/\s+/).filter(w => w.length > 1);
    const byFull = new Map(mine.map(m => [words(m.full_name).sort().join(" "), m]));
    const find = name => {  // same words in any order, or the same first and last name
      const w = words(name); if (!w.length) return null;
      const k = byFull.get([...w].sort().join(" ")); if (k) return k;
      const hits = mine.filter(m => { const mw = words(m.full_name); return mw.length && w.includes(mw[0]) && w.includes(mw.at(-1)); });
      return hits.length === 1 ? hits[0] : null;
    };
    let found = [], missing = [];
    const read = () => {
      const lines = $("tl-text").value.split(/\r?\n|,(?![^"]*")/).map(x => x.replace(/^\s*\d+[.)]\s*/, "").replace(/["*]/g, "").trim())
        .filter(x => x && !/^(name|names|full name)$/i.test(x) && /\p{L}/u.test(x) && !/^\+?[\d\s()-]+$/.test(x));
      const seen = new Set(); found = []; missing = [];
      for (const l of lines) { const m = find(l); if (m) { if (!seen.has(m.id)) { seen.add(m.id); found.push(m); } } else if (!missing.some(x => norm(x) === norm(l))) missing.push(l); }
      const already = found.filter(m => here[m.id]);
      $("tl-prev").innerHTML = lines.length ? `<div class="bk-prev tl"><b>${found.length - already.length} to tick</b>${already.length ? ` · ${already.length} already ticked` : ""}${missing.length ? ` · <span style="color:var(--red)">${missing.length} not found</span>` : ""}
        <ul>${found.map(m => `<li><span>${esc(m.full_name)}</span><small>${here[m.id] ? "already ticked" : "will be ticked"}</small></li>`).join("")}
        ${missing.map(x => `<li class="skip"><span>${esc(x)}</span><small>not on ${esc(S.church)}'s list</small></li>`).join("")}</ul>
        ${missing.length && !pastor ? `<label class="tl-add"><input type="checkbox" id="tl-new"> Add the ${missing.length} not found as first-timers and tick them too</label>` : ""}</div>` : "";
      const go = () => { const n = found.length - already.length + ($("tl-new")?.checked ? missing.length : 0); $("tl-go").disabled = !n; $("tl-go").textContent = n ? `Tick ${n} ${n === 1 ? "person" : "people"}` : "Tick people"; };
      $("tl-new")?.addEventListener("change", go); go();
    };
    $("tl-text").oninput = read;
    $("tl-file").onchange = async e => { const f = e.target.files[0]; if (!f) return; if (f.size > 2e6) return toast("That file is too big."); $("tl-text").value = await f.text(); read(); };
    $("tl-text").focus();
    d.querySelector("form").onsubmit = async e => {
      e.preventDefault(); if (busy) return;
      const go = $("tl-go"); go.disabled = true; go.textContent = "Ticking…"; busy = true;
      try {
        const at = isoLocal(), added = [];
        if ($("tl-new")?.checked && missing.length) {
          for (const raw of missing) { const name = raw.replace(/\s+/g, " ").slice(0, 80);
            added.push({id: newId(), full_name: name, phone: "", type: "first_timer", status: "", age_group: "Adult", church: S.church, created_at: at, first_visit: S.date}); }
          await api("members", {method: "POST", prefer: "return=minimal", body: added});
          S.members.push(...added); mine.push(...added);
        }
        const todo = [...found.filter(m => !here[m.id]), ...added];
        await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, name: svcName(S.date)}});
        for (let i = 0; i < todo.length; i += 200) {
          const part = todo.slice(i, i + 200);
          await api("attendance?on_conflict=service_date,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: part.map(m => ({service_date: S.date, member_id: m.id, checked_at: at}))});
          if (curPart()) await api("service_ticks?on_conflict=service_date,part,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
            body: part.map(m => ({service_date: S.date, part: curPart(), member_id: m.id, checked_at: at}))});
        }
        for (const m of todo) { here[m.id] = at; log("tick", m.id, "done", "from a list"); }
        close(); toast(`Ticked ${todo.length} ${todo.length === 1 ? "person" : "people"}${added.length ? `, ${added.length} of them new` : ""}.`);
      } catch (err) { toast("Not saved: " + err.message); go.disabled = false; go.textContent = "Try again"; }
      busy = false; draw(); pull();
    };
  };
  el.querySelector("#ci-none").onclick = async () => {
    const todo = showing().filter(m => here[m.id]); if (!todo.length || busy) return;
    if (!armed) { armed = true; draw(); setTimeout(() => { if (armed) { armed = false; if (S.view === "checkin") draw(); } }, 4000); return; }
    busy = true; armed = false; draw();
    try {  // all of them come off together, or none do
      const n = await together("app_clear_service", {d: S.date, ids: todo.map(m => m.id), p: curPart() || null}, async () => {
        let k = 0; for (const m of todo) { if (await setPresent(m.id, false, curPart() ? undefined : here[m.id], undefined, curPart()) === "done") { delete here[m.id]; k++; } } return k; });
      for (const m of todo) delete here[m.id];
      log("clear_service", "", "done", `${n} unticked · ${S.church}`); toast(`Unticked ${n} ${n === 1 ? "person" : "people"}.`);
    } catch (err) { toast("Not saved: " + err.message); }
    busy = false; draw(); pull();
  };
  el.querySelector("#ci-clear").onclick = async () => {
    const todo = mine.filter(m => here[m.id]); if (!todo.length || busy) return;
    if (!armedAll) { armedAll = true; draw(); setTimeout(() => { if (armedAll) { armedAll = false; if (S.view === "checkin") draw(); } }, 4000); return; }
    busy = true; armedAll = false; draw();
    try {  // everyone comes off together (the day and its services), or nobody does
      const n = await together("app_clear_service", {d: S.date, ids: todo.map(m => m.id), p: curPart() || null}, async () => {
        let k = 0;
        if (curPart()) { for (const m of todo) if (await setPresent(m.id, false, undefined, undefined, curPart()) === "done") k++; }
        else for (let i = 0; i < todo.length; i += 80) {
          const gone = await api(`attendance?service_date=eq.${S.date}&member_id=in.(${todo.slice(i, i + 80).map(m => `"${m.id}"`).join(",")})`, {method: "DELETE", prefer: "return=representation"});
          k += gone?.length || 0;
        }
        return k;
      });
      here = {}; log("clear_service", "", "done", `${n} unticked · ${S.church}`);
      toast(`Unticked ${n} ${n === 1 ? "person" : "people"}.`);
    } catch (err) { toast("Not saved: " + err.message); }
    busy = false; draw(); pull();
  };
  const svc = el.querySelector("#svc"); svc.value = svcLabel(); drawParts();
  calPick(el.querySelector("#d"));
  el.querySelector("#d").onchange = e => { S.date = e.target.value || today(); armedPart = false; svc.value = svcLabel(); here = {}; lock = null; drawParts(); draw(); showLock(); pull(); };
  if (!pastor) svc.onchange = async () => {
    const name = svc.value.trim().replace(/\s+/g, " "), n = curPart(), was = svcLabel();
    if (!name) { svc.value = was; return; }
    if (name === was) return;
    if (n) {  // renaming one of the day's services
      try {
        const firstPart = n === S.parts[S.date][0].part;  // the first service's name is also the day's title: both change together
        await together("app_rename_service", {ch: S.church, d: S.date, p: n, new_name: name}, async () => {
          await api(`service_parts?church=eq.${encodeURIComponent(S.church)}&service_date=eq.${S.date}&part=eq.${n}`, {method: "PATCH", prefer: "return=minimal", body: {name: name.slice(0, 60)}});
          if (firstPart) await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {service_date: S.date, name}}).catch(() => {});
        });
        const x = S.parts[S.date].find(y => y.part === n); if (x) x.name = name.slice(0, 60);
        if (firstPart) S.names[S.date] = name;
        log("edit", "", "done", `service title: ${name}`); toast("Saved."); drawParts();
      } catch (err) { svc.value = was; toast(sqlNeeded(err)); }
      return;
    }
    (S.titles ??= {})[S.date] = name;  // used when the first person is ticked, if the service isn't saved yet
    try {
      await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {service_date: S.date, name}});
      S.names[S.date] = name; log("edit", "", "done", `service title: ${name}`); toast("Saved.");
    } catch (err) {
      if (S.names[S.date]) { delete S.titles[S.date]; svc.value = was; toast(/row-level|policy|permission/i.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
      else toast("Saved.");  // nothing ticked yet: the title goes in with the first tick
    }
  };
  // Other phones' ticks: the database says when a tick changes, and only then does the list catch up (nothing checks every
  // few seconds). If that connection can't be made, it checks every 10 seconds instead, until the connection works.
  const watchTicks = () => {
    let wait = 0; const soon = () => { clearTimeout(wait); wait = setTimeout(pull, 400); };  // a burst of ticks: one catch-up
    S.unwatch = rtWatch("checkin", ["attendance", "service_ticks"], soon,
      () => { clearInterval(S.poll); S.poll = 0; }, () => { if (!S.poll && S.view === "checkin") S.poll = setInterval(pull, 10000); });
    S.onShow = pull;  // opened again: catch up once
  };
  if (pastor) { draw(); pull(); watchTicks(); return; }  // no Add form for pastors
  el.querySelector("#a-phone").oninput = digitsOnly;
  el.querySelector("#add").onsubmit = async e => {
    e.preventDefault();
    const name = el.querySelector("#a-name").value.trim().replace(/\s+/g, " "), type = el.querySelector("#a-type").value;
    if (!name) return;
    const phone = el.querySelector("#a-phone").value.trim(), bad = phoneProblem(phone, false);  // optional here (numbers are often not at hand yet); checked only if typed
    if (bad) { toast(bad); el.querySelector("#a-phone").focus(); return; }
    const known = S.members.find(m => churchOf(m) === S.church && norm(m.full_name) === norm(name));
    const id = known?.id || newId(), only = e.submitter?.hasAttribute("data-only");
    try {
      if (!known) {
        const m = {id, full_name: name, phone: el.querySelector("#a-phone").value.trim(), type, status: "", age_group: el.querySelector("#a-age").value, ...(el.querySelector("#a-gender").value ? {gender: el.querySelector("#a-gender").value} : {}),
                   church: S.church, created_at: isoLocal(), [type === "member" ? "date_joined" : "first_visit"]: S.date};
        await api("members", {method: "POST", prefer: "return=minimal", body: m});
        S.members.push(m); mine.push(m); mine.sort((a, b) => norm(a.full_name).localeCompare(norm(b.full_name)));
      }
      if (only) { e.target.reset(); toast(known ? `${name} is already on the list.` : `${name} is added to the register.`); draw(); return; }
      await setPresent(id, true, undefined, undefined, curPart());
      e.target.reset(); toast(`${name} is checked in${known ? " (already on the list)" : ""}.`); pull();
    } catch (err) { toast("Not saved: " + err.message); }
  };
  draw(); pull(); watchTicks();
}

// ---------------------------------------------------------------- follow-up and people
function followup(el) {
  // any service date can be looked at: the lists show how things stood after that service
  const p0 = picture(), day = S.fuDay && S.fuDay !== p0.last ? S.fuDay : p0.last, had = !!day && p0.dates.includes(day);
  const p = had && day !== p0.last ? picture(day) : p0;
  const started = x => ([x.date_joined, x.first_visit].filter(Boolean).sort()[0] || (x.created_at || "").slice(0, 10) || "0000") <= day;
  const tabs = {need: "Needs follow-up", red: `Needs a call (${RED_AT}+ missed)`, yellow: `Check in (${YELLOW_AT}–${RED_AT - 1} missed)`, blue: "Missed this service", all: "Everyone"};
  const pick = {need: x => x.level !== "ok", red: x => x.flag === "red", yellow: x => x.flag === "yellow", blue: x => !p.here[x.id] && started(x), all: () => true};
  const list = had ? p.people.filter(pick[S.filter]) : [];
  el.innerHTML = head("Follow-up", esc(S.church),
    `<button class="pill-btn" id="dl">Download this list</button>`) + `
    <div class="row sortbar"><div style="flex:0 0 200px"><label class="f" for="fu-day">Service date</label><input class="in" id="fu-day" type="date" value="${day || today()}" max="${today()}"></div>
      ${had ? `<p class="note" style="margin:0 0 4px;flex:1">${esc(S.names[day] || "Service")} · ${esc(nice(day, true))}${day !== p0.last ? ` · <button class="link" id="fu-latest" style="margin:0">Back to the latest service</button>` : ""}</p>` : ""}</div>
    <div class="chips">${Object.entries(tabs).map(([k, t]) => `<button class="chip ${S.filter === k ? "on" : ""}" data-f="${k}">${t}</button>`).join("")}</div>
    <p class="flag-key">${badge("red")}<span>missed ${RED_AT}+ in a row: call them</span>${badge("yellow")}<span>missed ${YELLOW_AT}–${RED_AT - 1} in a row: check in</span></p>
    <div class="card"><div class="card-head"><h2>${tabs[S.filter]}</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${list.length} people</span></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Missed in a row</th><th class="hide-sm">Last seen</th><th class="hide-sm">Pastor</th><th>Phone</th></tr></thead>
      <tbody>${rowsHtml(list, true)}</tbody></table></div>` : `<p class="empty">${had ? "Nobody in this list." : `No service was recorded on ${esc(nice(day || today(), true))}.`}</p>`}</div>`;
  el.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.filter = b.dataset.f; render(); });
  calPick(el.querySelector("#fu-day"));
  el.querySelector("#fu-day").onchange = e => { S.fuDay = e.target.value; render(); };
  const back = el.querySelector("#fu-latest"); if (back) back.onclick = () => { S.fuDay = ""; render(); };
  el.querySelector("#dl").onclick = () => download(`${norm(tabs[S.filter]).replace(/ /g, "_")}_${S.church}_${day || today()}.csv`,
    [["Church", "Name", "Status", "Missed in a row", "Last seen", "Phone", "Pastor", "Age group"],
     ...list.map(x => [S.church, x.full_name, FLAG[x.flag], x.missed, x.seen || "", x.phone || "", x.pastor || "", x.kid ? "Child" : "Adult"])]);
}
// Congregation → Import people: a church admin or the team adds a list of names at once. Pick a CSV file or paste a list.
// Files don't have to follow a set layout: each column is matched to Name, First name, Last name, Phone, Type, Age group or
// Gender (guessed from its heading and what's in it, and changeable), and the names and numbers are tidied before importing.
// Names already on this church's list are skipped, so the same list can be imported twice safely.
// A phone number typed into the name, e.g. "Ama Mensah 0211234567" or "Ama Mensah – 021 123 4567": gives [name, phone]
const NAME_PHONE = /^(.*?\p{L}.*?)[\s,;:–—-]+(\+?\d[\d\s().-]{6,}\d)\s*$/u;
const splitNamePhone = s => { const m = String(s || "").match(NAME_PHONE); return m && m[2].replace(/\D/g, "").length >= 8 ? [m[1].replace(/[\s,;:–—-]+$/, "").trim(), m[2].replace(/[^\d+]/g, "")] : null; };
// An Excel file (.xlsx), read in the browser with nothing to install: each tab's cells, with their text and fill colour.
async function readXlsx(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer), files = {};
  let e = buf.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("That isn't an Excel file. In Google Sheets use File → Download → Microsoft Excel (.xlsx).");
  for (let i = 0, p = dv.getUint32(e + 16, true); i < dv.getUint16(e + 10, true); i++) {  // the zip's list of files
    const nl = dv.getUint16(p + 28, true);
    files[new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl))] = {method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), at: dv.getUint32(p + 42, true)};
    p += 46 + nl + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  const xml = async name => { const f = files[name]; if (!f) return null;
    const start = f.at + 30 + dv.getUint16(f.at + 26, true) + dv.getUint16(f.at + 28, true), data = buf.subarray(start, start + f.size);
    const text = f.method === 8 ? await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text() : new TextDecoder().decode(data);
    return new DOMParser().parseFromString(text, "application/xml"); };
  const all = (doc, tag) => doc ? [...doc.getElementsByTagNameNS("*", tag)] : [];
  const strings = all(await xml("xl/sharedStrings.xml"), "si").map(si => all(si, "t").map(t => t.textContent).join(""));
  const styles = await xml("xl/styles.xml"), fills = all(all(styles, "fills")[0], "fill").map(f => {
    const pf = all(f, "patternFill")[0], fg = pf && pf.getAttribute("patternType") === "solid" ? all(pf, "fgColor")[0] : null, rgb = fg?.getAttribute("rgb");
    return rgb ? "#" + rgb.slice(-6).toLowerCase() : ""; });
  const fillOf = all(all(styles, "cellXfs")[0], "xf").map(x => fills[+x.getAttribute("fillId") || 0] || "");
  const book = await xml("xl/workbook.xml"), rels = all(await xml("xl/_rels/workbook.xml.rels"), "Relationship");
  const tabs = [];
  for (const s of all(book, "sheet")) {
    const id = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || s.getAttribute("r:id");
    const target = rels.find(r => r.getAttribute("Id") === id)?.getAttribute("Target") || ""; const doc = await xml("xl/" + target.replace(/^\/?xl\//, ""));
    const rows = [];
    for (const c of all(doc, "c")) {
      const [, col, row] = c.getAttribute("r").match(/^([A-Z]+)(\d+)$/), j = [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, t = c.getAttribute("t");
      const v = all(c, "v")[0]?.textContent ?? "", text = t === "s" ? strings[+v] ?? "" : t === "inlineStr" ? all(c, "t").map(x => x.textContent).join("") : v;
      ((rows[+row - 1] ??= [])[j] = {text: String(text).trim(), fill: fillOf[+c.getAttribute("s") || 0] || ""});
    }
    tabs.push({name: s.getAttribute("name"), rows});
  }
  return tabs;
}
// Old register → the app: an admin or church admin picks the Excel file of a paper-style register (names down the side, Sundays across,
// green = came), checks who each name is, and the green squares become check-ins. Nothing is saved until "Add the check-ins".
function oldRegister() {
  document.querySelectorAll(".modal").forEach(m => m.remove());
  const d = document.createElement("div"); d.className = "modal";
  d.innerHTML = `<form class="sheet" role="dialog" aria-modal="true" aria-label="Load an old register">
    <div class="card-head"><h2>Load an old register</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
    <div class="fields">
      <p class="note" style="margin:0 2px">Names down the side, Sundays across the top. A green square or a mark (✓, P, 1) means they came. From Google Sheets: <b>File → Download → .xlsx</b>.</p>
      <label class="bk-drop"><input type="file" id="or-file" accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv">
        <span class="bk-drop-btn">${svg("upload")}<span>Choose the file</span></span><small>Nothing is saved until you press Add.</small></label>
      <div id="or-opts"></div><div id="or-list"></div>
    </div>
    <div class="msg bad" id="or-err" hidden></div>
    <div class="modal-foot"><button type="button" class="pill-btn" data-x>Cancel</button><button class="pill-btn primary" id="or-go" disabled>Add the check-ins</button></div></form>`;
  document.body.append(d);
  const $ = id => d.querySelector("#" + id), close = () => { d.remove(); document.removeEventListener("keydown", onKey); }, onKey = e => { if (e.key === "Escape") close(); };
  d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
  document.addEventListener("keydown", onKey);
  const fail = t => { $("or-err").textContent = t; $("or-err").hidden = !t; };
  const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const asDay = (t, yr) => { const m = String(t).toLowerCase().match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-\/.]*([a-z]{3})/) || null;
    if (m && MON.includes(m[2])) return `${yr}-${pad(MON.indexOf(m[2]) + 1)}-${pad(+m[1])}`;
    const k = String(t).toLowerCase().match(/^([a-z]{3})[a-z]*\.?[\s\-\/]*(\d{1,2})(?:st|nd|rd|th)?$/); if (k && MON.includes(k[1])) return `${yr}-${pad(MON.indexOf(k[1]) + 1)}-${pad(+k[2])}`;  // "Jan 4"
    const n = String(t).match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/); if (n) return `${+n[3] < 100 ? 2000 + +n[3] : n[3]}-${pad(+n[2])}-${pad(+n[1])}`;
    if (/^\d{5}$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + t * 864e5).toISOString().slice(0, 10);  // an Excel date number
    return ""; };
  // the colour of a square: green came, orange came midweek (no date to tick), anything else not counted
  const kind = hex => { if (!hex) return ""; const n = parseInt(hex.slice(1), 16), r = n >> 16, g = n >> 8 & 255, b = n & 255;
    return g > 120 && g > r + 40 && g > b + 40 ? "came" : r > 180 && g > 90 && g < 200 && b < 90 ? "midweek" : ""; };
  // or a mark typed in the square: ✓, P, Y, yes, 1, present, L (late) count as came; A, N, 0 and blanks don't; X is whatever the sheet says it means
  const CAME = /^(✓|✔|☑|√|v|p|y|yes|1|present|came|here|l|late)$/i;
  const mark = t => { t = String(t ?? "").trim().replace(/\.$/, ""); return CAME.test(t) ? "came" : /^[x×]$/i.test(t) ? "x" : ""; };
  // a CSV (or tab-separated) register: no colours, just the marks
  const readCsv = text => { text = text.replace(/^\uFEFF/, ""); const l0 = text.split(/\r?\n/)[0], sep = [",", ";", "\t"].sort((a, b) => l0.split(b).length - l0.split(a).length)[0];
    const rows = [[]]; let cell = "", q = false; const put = () => { rows[rows.length - 1].push({text: cell.trim(), fill: ""}); cell = ""; };
    for (let i = 0; i < text.length; i++) { const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true; else if (ch === sep) put(); else if (ch === "\n") { put(); rows.push([]); } else if (ch !== "\r") cell += ch; }
    put(); return [{name: "CSV", rows}]; };
  // names: numbering, titles and notes in brackets come off, so "23. Aunty Cha" looks for Cha
  const TITLES = /^(aunty|auntie|aunt|uncle|unlce|ps|pst|pastor|lp|lady|bishop|bp|brother|bro|sister|sis|mama|papa|mr|mrs|ms|miss|dr|rev|reverend|elder|deacon|deaconess|prophet|apostle|evangelist)\.?$/i;
  const clean = raw => String(raw).replace(/^\s*\d+\s*[.)\-:]\s*/, "").replace(/\(.*?\)?$/s, "").replace(/\(.*?\)/g, "").replace(/\s+\d+\s*$/, "").replace(/\s+/g, " ").trim();
  const words = n => norm(n).replace(/[^\p{L}\s'-]/gu, " ").split(/\s+/).filter(w => w && !TITLES.test(w));
  const people = S.members.filter(m => churchOf(m) === S.church).sort(byName), ws = new Map(people.map(m => [m.id, words(m.full_name)]));
  const guess = raw => {  // [the person, if it's clear who; the likely people otherwise]
    const w = words(clean(raw)); if (!w.length) return [null, []];
    const full = people.filter(m => ws.get(m.id).join(" ") === w.join(" ")); if (full.length === 1) return [full[0], full];
    const both = w.length > 1 ? people.filter(m => ws.get(m.id)[0] === w[0] && ws.get(m.id).includes(w[w.length - 1])) : []; if (both.length === 1) return [both[0], both];
    const first = people.filter(m => ws.get(m.id)[0] === w[0]); if (first.length === 1 && w.length === 1) return [first[0], first];
    return [null, [...new Set([...both, ...first, ...people.filter(m => ws.get(m.id).includes(w[0]))])].slice(0, 8)]; };
  const newName = raw => clean(raw).split(" ").filter(w => !TITLES.test(w)).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").slice(0, 80) || clean(raw);  // "Aunty Cha" → "Cha"
  let tabs = [], rows = [], dates = [];
  const read = () => {  // find the row of dates, then everyone below it with their green squares
    fail(""); const tab = tabs[+($("or-tab")?.value || 0)], yr = +$("or-year").value || new Date().getFullYear();
    const grid = Array.from(tab.rows, r => r || []), head = grid.findIndex(r => r.filter(c => c && asDay(c.text, yr)).length >= 4);
    if (head < 0) { rows = []; dates = []; $("or-list").innerHTML = ""; $("or-go").disabled = true; return fail("Couldn't find a row of Sunday dates (like 4th Jan, 11th Jan…) on this tab."); }
    const cols = grid[head].map((c, j) => c && asDay(c.text, yr) ? [j, asDay(c.text, yr)] : null).filter(Boolean), first = cols[0][0];
    const nameCol = [...Array(first).keys()].reverse().find(j => grid.slice(head + 1).filter(r => r[j]?.text).length) ?? 0;
    const SKIP = /^(adults?|children|kids|names?|dates?|attendance|total.*|first timers?|visitors?|h\s*&\s*n.*|here\s*&\s*now.*|members?)$/i;
    rows = []; let sect = "member";  // the heading a name sits under: first-timers and visitors are added as such if they're new
    for (const r of grid.slice(head + 1)) {
      const name = r[nameCol]?.text || ""; if (/^totals?\b/i.test(name)) break;  // the totals row ends the names (but not "Totally…")
      if (name && SKIP.test(clean(name))) { const h = norm(clean(name)); sect = /first/.test(h) ? "first_timer" : /visitor/.test(h) ? "visitor" : /child|kid/.test(h) ? "child" : "member"; continue; }
      if (!name || !/\p{L}/u.test(name)) continue;
      const xIs = $("or-x")?.value || "came", hit = c => kind(c?.fill) === "came" || mark(c?.text) === "came" || (mark(c?.text) === "x" && xIs === "came");
      const came = cols.filter(([j]) => hit(r[j])).map(([, day]) => day), mid = cols.filter(([j]) => kind(r[j]?.fill) === "midweek").length;
      const [m, likely] = guess(name); rows.push({name, came, mid, pick: m?.id || "", sure: !!m, likely, sect});
    }
    const taken = {}; rows.forEach(x => { if (x.pick) (taken[x.pick] ??= []).push(x); });
    for (const list of Object.values(taken)) if (list.length > 1) list.forEach(x => { x.sure = false; x.pick = ""; });  // two names on one person: both need a look
    dates = [...new Set(rows.flatMap(x => x.came))].sort(); draw();
  };
  const opts = people.map(m => `<option value="${esc(m.id)}">${esc(m.full_name)}</option>`).join("");
  const draw = () => {
    const use = rows.filter(x => x.pick && x.came.length), n = use.reduce((a, x) => a + x.came.length, 0), check = rows.filter(x => !x.sure && x.came.length).length;
    const notFound = rows.filter(x => !x.pick && !x.likely?.length && x.came.length);
    $("or-list").innerHTML = rows.length ? `${notFound.length ? `<div class="or-sum"><button type="button" class="pill-btn sm" id="or-new">${svg("plus")}<span>Add ${notFound.length} as new</span></button></div>` : ""}
      <div class="scroll or-scroll"><table class="utable"><thead><tr><th>On the sheet</th><th>Who it is in the app</th><th>Sundays</th></tr></thead><tbody>
      ${rows.map((x, i) => `<tr class="${x.sure || !x.came.length ? "" : "or-check"}"><td>${esc(x.name)}${!x.sure && x.came.length ? ` <span class="badge">Check</span>` : ""}</td>
        <td><select class="in sm" data-or="${i}" aria-label="Who ${esc(x.name)} is"><option value="">${x.sure ? "Leave out" : "Choose who this is…"}</option><option value="+new">+ Add as a new person (${esc(newName(x.name))})</option>
          ${x.likely?.length && !x.sure ? `<optgroup label="Likely">${x.likely.map(m => `<option value="${esc(m.id)}">${esc(m.full_name)}</option>`).join("")}</optgroup><optgroup label="Everyone">${opts}</optgroup>` : opts}</select></td><td class="muted">${x.came.length}</td></tr>`).join("")}</tbody></table></div>` : "";
    $("or-list").querySelectorAll("[data-or]").forEach(s => { s.value = rows[+s.dataset.or].pick;
      s.onchange = () => { const x = rows[+s.dataset.or]; x.pick = s.value; x.sure = !!s.value; draw(); }; });
    $("or-list").querySelector("#or-new")?.addEventListener("click", () => { notFound.forEach(x => { x.pick = "+new"; x.sure = true; }); draw(); });
    $("or-go").disabled = !n; $("or-go").textContent = n ? `Add ${n} check-ins` : "Add the check-ins";
  };
  $("or-file").onchange = async e => {
    const f = e.target.files[0]; if (!f) return; fail("");
    try { tabs = /\.(csv|tsv|txt)$/i.test(f.name) ? readCsv(await f.text()) : await readXlsx(f); } catch (err) { return fail(/DecompressionStream/.test(err.message) ? "This browser can't open Excel files: try Chrome or Safari." : err.message); }
    const yr = (f.name.match(/'?(\d{2})\b(?!.*\d)/) || [])[1];
    $("or-opts").innerHTML = `<div class="bk-two">${tabs.length > 1 ? `<div><label class="f" for="or-tab">Tab</label><select class="in" id="or-tab">${tabs.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join("")}</select></div>` : ""}
      <div><label class="f" for="or-year">Year of the dates</label><input class="in" id="or-year" inputmode="numeric" maxlength="4" value="${yr ? 2000 + +yr : new Date().getFullYear()}"></div>
      ${tabs.some(t => t.rows.some(r => r?.some(c => mark(c?.text) === "x"))) ? `<div><label class="f" for="or-x">An X means</label><select class="in" id="or-x"><option value="came">Came</option><option value="missed">Missed</option></select></div>` : ""}</div>`;
    $("or-opts").querySelectorAll("select, input").forEach(x => x.onchange = read); read();
  };
  d.querySelector("form").onsubmit = async e => {
    e.preventDefault(); const go = $("or-go"), use = rows.filter(x => x.pick && x.came.length); if (!use.length) return;
    go.disabled = true; go.textContent = "Adding…"; let n = 0;
    try {
      const fresh = use.filter(x => x.pick === "+new");  // new people first, so their check-ins have someone to belong to
      if (fresh.length) {
        const list = fresh.map(x => { const type = x.sect === "first_timer" || x.sect === "visitor" ? x.sect : "member", d0 = [...x.came].sort()[0];
          return {id: newId(), full_name: newName(x.name), phone: "", type, status: "", age_group: x.sect === "child" ? "Child" : "Adult", church: S.church, created_at: isoLocal(),
                  date_joined: type === "member" ? d0 : null, first_visit: type === "member" ? null : d0}; });  // the same fields on every row, as a batch needs
        await api("members", {method: "POST", prefer: "return=minimal", body: list}); S.members.push(...list);
        fresh.forEach((x, i) => x.pick = list[i].id);
        log("edit", "", "done", `added ${list.length} people from an old register`);
      }
      for (const day of dates) {
        const ids = [...new Set(use.filter(x => x.came.includes(day)).map(x => x.pick))]; if (!ids.length) continue;
        const t = new Date(day + "T10:00:00"), o = -t.getTimezoneOffset(), at = `${day}T10:00:00${o >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
        await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: day, name: svcName(day)}});
        await api("attendance?on_conflict=service_date,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: ids.map(id => ({service_date: day, member_id: id, checked_at: at}))});
        n += ids.length;
      }
      log("edit", "", "done", `loaded an old register: ${n} check-ins over ${dates.length} Sundays · ${S.church}`);
      close(); toast(`Added ${n} check-ins.`); await load(); render();
    } catch (err) { fail("Stopped part-way (" + n + " added): " + err.message + ". Press Add again to carry on: nothing is added twice."); go.disabled = false; go.textContent = "Add the check-ins"; }
  };
}
function bulkAdd() {
  document.querySelectorAll(".modal").forEach(m => m.remove());
  const d = document.createElement("div"); d.className = "modal";
  d.innerHTML = `<form class="sheet narrow" role="dialog" aria-modal="true" aria-label="Import people">
    <div class="card-head"><h2>Import people</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
    <div class="fields">
      <label class="bk-drop" id="bk-drop"><input type="file" id="bk-file" accept=".csv,.txt,.tsv,text/csv,text/plain">
        <span class="bk-drop-btn">${svg("upload")}<span>Import a CSV file</span></span>
        <small>Adds people from a list.</small></label>
      ${["admin", "lead"].includes(S.me.role) && !S.preview ? `<div style="display:grid;gap:6px;justify-items:center;text-align:center"><button type="button" class="pill-btn sm" id="bk-old">${svg("upload")}<span>Load an old register</span></button>
        <small style="color:var(--ink-2);font-size:12.5px;margin:0 2px">Adds past Sundays' check-ins.</small></div>` : ""}
      <div class="bk-or"><span>or type the names</span></div>
      <div><label class="f" for="bk-text">Names, one per line</label>
        <textarea class="in" id="bk-text" rows="6" placeholder="Ama Mensah, 021 555 0101&#10;Kofi Boateng&#10;Efua Owusu, 022 555 0123, child"></textarea>
        <p class="note" style="margin:6px 2px 0">Optional: a phone number after a comma, and "child" or "first-timer".</p></div>
      <div id="bk-map"></div>
      <div class="bk-two"><div><label class="f" for="bk-type">Everyone is</label><select class="in" id="bk-type">${typeOpts.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("")}</select></div>
        <div><label class="f" for="bk-age">Age group</label><select class="in" id="bk-age"><option>Adult</option><option>Child</option></select></div></div>
      <p class="note" style="margin:0 2px">They go on <b>${esc(S.church)}</b>'s list. You can change anyone below.</p>
      <div id="bk-prev"></div>
    </div>
    <div class="msg bad" id="bk-err" hidden></div>
    <div class="modal-foot"><button type="button" class="pill-btn" data-x>Cancel</button><button class="pill-btn primary" id="bk-go" disabled>Import people</button></div></form>`;
  document.body.append(d);
  const $ = id => d.querySelector("#" + id), close = () => { d.remove(); document.removeEventListener("keydown", onKey); }, onKey = e => { if (e.key === "Escape") close(); };
  d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
  document.addEventListener("keydown", onKey);
  const cells = line => { const out = []; let cur = "", q = false;  // one CSV line, with "quoted, values"
    for (let i = 0; i < line.length; i++) { const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === "," || c === "\t" || c === ";") { out.push(cur); cur = ""; } else cur += c; }
    out.push(cur); return out.map(x => x.trim()); };
  const TYPES = {member: "member", members: "member", "first-timer": "first_timer", "first timer": "first_timer", first_timer: "first_timer", firsttimer: "first_timer",
    "first time": "first_timer", new: "first_timer", visitor: "visitor", guest: "visitor"};
  const ROLES = [["name", "Name"], ["first", "First name"], ["last", "Last name"], ["phone", "Phone"], ["email", "Email"], ["address", "Address"], ["type", "Type"], ["age", "Age group"],
    ["gender", "Gender"], ["team", "Team / ministry"], ["status", "Status"], ["group", "Group"], ["joined", "Date joined"], ["", "Leave out"]];
  // dates as people write them: 2024-03-17, 17/03/2024, 17-3-24, 17 Mar 2024 (day first, as in New Zealand)
  const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const isoDate = raw => { const x = String(raw || "").trim(); let m, y, mo, d;
    if ((m = x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [, y, mo, d] = m;
    else if ((m = x.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) [, d, mo, y] = m;
    else if ((m = x.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i)) && MON.includes(m[2].toLowerCase())) { d = m[1]; mo = MON.indexOf(m[2].toLowerCase()) + 1; y = m[3]; }
    else return "";
    y = +y < 100 ? 2000 + +y : +y; const t = new Date(y, +mo - 1, +d);
    return t.getMonth() === +mo - 1 && y > 1900 && t <= new Date() ? `${y}-${pad(+mo)}-${pad(+d)}` : ""; };
  // Tidying: names in capitals or all small letters get proper capitals, list numbers and stray marks go,
  // and a phone number that lost its first 0 (as spreadsheets do) gets it back.
  const cap = w => w.replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const tidyName = raw => { let x = String(raw || "").replace(/^\s*\d+\s*[.)\-:]\s+/, "").replace(/[*_"]+/g, "").replace(/\s+/g, " ").trim();
    x = x.split(" ").map(w => w.length > 1 && (w === w.toUpperCase() || w === w.toLowerCase()) ? cap(w.toLowerCase()) : w).join(" "); return x.slice(0, 80); };  // each word on its own: "ama MENSAH" → "Ama Mensah"
  const tidyPhone = raw => { let x = String(raw || "").replace(/[^0-9+]/g, "");
    if (/^[2-9]\d{7,9}$/.test(x)) x = "0" + x;  // 21 555 0101 → 021 555 0101
    if (/^0\d{8,10}$/.test(x)) x = `${x.slice(0, 3)} ${x.slice(3, 6)} ${x.slice(6)}`;
    return x; };
  const isPhone = v => (v.replace(/\D/g, "").length >= 7) && /^[\d\s+()\-.]+$/.test(v);
  const guess = (head, samples) => {
    const h = norm(head).replace(/[\s_]+/g, " ").replace(/[^a-z /]/g, "").trim(), s = samples.map(norm).filter(Boolean), share = f => s.length ? s.filter(f).length / s.length : 0;
    if (/^(full |member |members |person |attendee |)names?$|^member$|^person$|^attendee$/.test(h)) return "name";
    if (/^(first|given|fore|christian)/.test(h)) return "first";
    if (/^(last|sur|family)/.test(h)) return "last";
    if (/phone|mobile|cell|tel\b|number|whatsapp/.test(h)) return "phone";
    if (/mail/.test(h)) return "email";
    if (/address|street|suburb|location|residence/.test(h)) return "address";
    if (/gender|sex/.test(h)) return "gender";
    if (/^age|adult|child|kids?$/.test(h)) return "age";
    if (/ministry|role|team|department|service unit/.test(h)) return "team";
    if (/joined|member since|date/.test(h)) return "joined";
    if (/type|category/.test(h)) return "type";
    if (/status/.test(h)) return "status";
    if (/group|cell|fellowship/.test(h)) return "group";
    if (share(isPhone) > .6) return "phone";
    if (share(v => /^(m|f|male|female)$/.test(v)) > .6) return "gender";
    if (share(v => /^(child|kid|kids|adult|children|adults)$/.test(v)) > .6) return "age";
    if (share(v => TYPES[v]) > .6) return "type";
    if (share(v => /^\p{L}[\p{L}'. -]*$/u.test(v)) > .6) return "name";
    return "";
  };
  let rows = [], map = null, sig = "", fromFile = false;
  const own = {};  // changes made to one person in the list (age group, type), kept while the list is edited
  const read = () => {
    const lines = $("bk-text").value.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.replace(/[,;\t\s]/g, ""));
    const table = lines.map(cells), n = Math.max(0, ...table.slice(0, 50).map(r => r.length));
    // A heading row: words like Name or Phone, and no phone numbers in it
    const headWords = /name|phone|mobile|first|last|surname|type|age|gender|sex|email|contact|address|ministry|role|status|group|joined/i;
    const hasHead = table.length > 1 && table[0].some(c => headWords.test(c)) && !table[0].some(isPhone);
    const body = hasHead ? table.slice(1) : table;
    const key = `${n}|${hasHead ? table[0].join("|") : ""}`;
    if (key !== sig) {  // a new layout: guess each column again
      sig = key;
      map = Array.from({length: n}, (_, j) => guess(hasHead ? table[0][j] || "" : "", body.slice(0, 30).map(r => r[j] || "")));
      if (!hasHead && n > 1 && !map.includes("name")) map[0] = "name";
      if (n === 1) map = ["name"];
      const firstName = map.indexOf("name"); map = map.map((r, j) => r === "name" && j !== firstName && !map.includes("first") ? "" : r);  // one name column
    }
    // Match your columns: shown when the list has more than one column
    $("bk-map").innerHTML = n > 1 && (fromFile || hasHead) ? `<div class="bk-map"><b>Match your columns</b><p class="note" style="margin:2px 0 8px">Say what's in each column. We guessed from ${hasHead ? "the headings and " : ""}what's in them.</p>
      ${map.map((r, j) => `<div class="bk-map-row"><div><b>${esc(hasHead ? table[0][j] || `Column ${j + 1}` : `Column ${j + 1}`)}</b>
        <small>${esc(body.slice(0, 3).map(x => x[j]).filter(Boolean).join(" · ") || "(empty)")}</small></div>
        <select class="in sm" data-map="${j}" aria-label="What column ${j + 1} is">${ROLES.map(([v, t]) => `<option value="${v}" ${r === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>`).join("")}</div>` : "";
    $("bk-map").querySelectorAll("[data-map]").forEach(s => s.onchange = () => { map[+s.dataset.map] = s.value; read(); });
    const col = k => map.indexOf(k), get = (c, k) => col(k) >= 0 ? c[col(k)] || "" : "";
    const have = new Set(S.members.filter(m => churchOf(m) === S.church).map(m => norm(m.full_name))), seen = new Set();
    let fixedNames = 0, fixedPhones = 0;
    rows = body.map(c => {
      const rawName0 = col("name") >= 0 ? get(c, "name") : [get(c, "first"), get(c, "last")].filter(Boolean).join(" ");
      const sp = splitNamePhone(rawName0), rawName = sp ? sp[0] : rawName0;  // "Ama Mensah 0211234567" on one line: the number goes to Phone
      const name = tidyName(rawName); if (name && name !== rawName.replace(/\s+/g, " ").trim()) fixedNames++;
      // the phone: its own column, or (a plain list) anything after the name that looks like one
      const rawPhone = (col("phone") >= 0 ? get(c, "phone") : n > 1 && !hasHead ? c.slice(1).find(isPhone) || "" : "") || sp?.[1] || "";
      const phone = rawPhone ? tidyPhone(rawPhone) : ""; if (rawPhone && phone.replace(/\s/g, "") !== rawPhone.replace(/[\s()\-.]/g, "")) fixedPhones++;
      const words = hasHead ? [] : c.slice(1).map(norm);  // a plain list: "Ama Mensah, child" or "Kofi, 021 555 0101, first-timer"
      const ageTxt = norm(get(c, "age") || words.find(x => /^(child|kid|kids|adult)$/.test(x)) || "");
      const t = TYPES[norm(get(c, "type"))] || TYPES[words.find(x => TYPES[x]) || ""] || "";
      const age = /child|kid/.test(ageTxt) ? "Child" : /adult/.test(ageTxt) ? "Adult" : "";
      const gt = norm(get(c, "gender")), g = /^f/.test(gt) ? "Female" : /^m/.test(gt) ? "Male" : "";
      const email = get(c, "email").trim().toLowerCase(), more = {email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
        address: get(c, "address").replace(/\s+/g, " ").trim().slice(0, 200), team: get(c, "team").replace(/\s*[\/;|]\s*/g, ", ").replace(/\s+/g, " ").trim(),
        status: /^(active|member|yes|)$/i.test(get(c, "status").trim()) ? "" : cap(get(c, "status").trim().toLowerCase()), group: get(c, "group").trim(), joined: isoDate(get(c, "joined"))};
      const why = !name || /^\d+$/.test(name) || /^total/i.test(name) ? "no name" : have.has(norm(name)) ? "already on the list" : seen.has(norm(name)) ? "twice in this list" : phoneProblem(phone, false) ? "phone number looks wrong" : "";
      seen.add(norm(name)); const o = own[norm(name)] || {}; return {name, phone, type: o.type || t, age: o.age || age, gender: g, why, ...more};
    }).filter(r => r.name || r.phone);
    const ok = rows.filter(r => !r.why), skip = rows.filter(r => r.why);
    const tidied = [fixedNames && `${fixedNames} ${fixedNames === 1 ? "name" : "names"} tidied`, fixedPhones && `${fixedPhones} phone ${fixedPhones === 1 ? "number" : "numbers"} tidied`].filter(Boolean);
    $("bk-prev").innerHTML = rows.length ? `<div class="bk-prev"><b>${ok.length} to add</b>${skip.length ? ` · ${skip.length} skipped` : ""}${tidied.length ? ` · <span class="bk-tidy">${tidied.join(", ")}</span>` : ""}
      <div class="bk-scroll"><div class="bk-cols" aria-hidden="true"><span>Name</span><span>Phone</span><span>Age group</span><span>Type</span></div>
      <ul>${rows.slice(0, 200).map((r, i) => r.why ? `<li class="skip"><span>${esc(r.name || "(no name)")}</span><small>${esc(r.why)}</small></li>`
        : `<li><span class="bk-name">${esc(r.name)}${[r.email, r.address, r.team].some(Boolean) ? `<small>${esc([r.email, r.address, r.team].filter(Boolean).join(" · "))}</small>` : ""}</span><span class="bk-phone">${esc(r.phone) || "–"}</span>
          <select class="in sm" data-own-age="${i}" aria-label="Age group for ${esc(r.name)}">${["Adult", "Child"].map(a => `<option ${(r.age || $("bk-age").value) === a ? "selected" : ""}>${a}</option>`).join("")}</select>
          <select class="in sm" data-own-type="${i}" aria-label="Type for ${esc(r.name)}">${typeOpts.map(([v, t]) => `<option value="${v}" ${(r.type || $("bk-type").value) === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></li>`).join("")}</ul></div>
      ${rows.length > 200 ? `<p class="note">…and ${rows.length - 200} more.</p>` : ""}</div>` : "";
    $("bk-prev").querySelectorAll("[data-own-age],[data-own-type]").forEach(s => s.onchange = () => {
      const r = rows[+(s.dataset.ownAge ?? s.dataset.ownType)], k = norm(r.name), o = own[k] ??= {};
      if (s.dataset.ownAge !== undefined) o.age = s.value; else o.type = s.value; read(); });
    $("bk-go").disabled = !ok.length; $("bk-go").textContent = ok.length ? `Import ${ok.length} ${ok.length === 1 ? "person" : "people"}` : "Import people";
  };
  $("bk-text").oninput = read; $("bk-age").onchange = $("bk-type").onchange = read;
  const drop = $("bk-drop");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); }; drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) $("bk-file").onchange({target: {files: [f]}}); };
  $("bk-file").onchange = async e => { const f = e.target.files[0]; if (!f) return; const err = $("bk-err");
    if (/\.(xlsx?|numbers|ods)$/i.test(f.name)) { err.textContent = "That's a spreadsheet file. Open it, choose File → Save as (or Download) → CSV, then import the CSV."; err.hidden = false; return; }
    if (f.size > 2e6) { err.textContent = "That file is too big: keep it under 2 MB."; err.hidden = false; return; }
    drop.querySelector(".bk-drop-btn span").textContent = f.name;
    $("bk-text").value = await f.text(); fromFile = true; err.hidden = true; read(); };
  $("bk-text").focus();
  $("bk-old")?.addEventListener("click", oldRegister);
  d.querySelector("form").onsubmit = async e => {
    e.preventDefault();
    const ok = rows.filter(r => !r.why), go = $("bk-go"), err = $("bk-err"); if (!ok.length) return;
    const type0 = $("bk-type").value, age0 = $("bk-age").value, at = isoLocal(), day = today();
    const list = ok.map(r => { const type = r.type || type0;
      return {id: newId(), full_name: r.name, phone: r.phone, type, status: r.status || "", age_group: r.age || age0, ...(r.gender ? {gender: r.gender} : {}),
              ...(r.email ? {email: r.email} : {}), ...(r.address ? {address: r.address} : {}), ...(r.team ? {role: r.team} : {}), ...(r.group ? {group_name: r.group} : {}),
              church: S.church, created_at: at, [type === "member" ? "date_joined" : "first_visit"]: r.joined || day}; });
    go.disabled = true; err.hidden = true; go.textContent = "Importing…";
    try {
      for (let i = 0; i < list.length; i += 200) {  // 200 at a time; each lot is on the list as soon as it's saved
        await api("members", {method: "POST", prefer: "return=minimal", body: list.slice(i, i + 200)}); S.members.push(...list.slice(i, i + 200)); }
      log("edit", "", "done", `added ${list.length} people at once`);
      close(); toast(`${list.length} ${list.length === 1 ? "person is" : "people are"} added to ${S.church}'s list.`); render();
    } catch (x) { err.textContent = "Not added: " + (/address/.test(x.message) ? "addresses need the latest setup SQL in Supabase. Run it once, or set the Address column to Leave out." : x.message); err.hidden = false; go.disabled = false; read(); }
  };
}
function people(el) {
  const everyone = S.members.filter(m => churchOf(m) === S.church).sort(byName);
  const counts = {};  // each role with how many people have it, however the capitals were typed
  for (const m of everyone) for (const r of new Set(rolesOf(m).map(norm))) (counts[r] ??= {label: rolesOf(m).find(x => norm(x) === r), n: 0}).n++;
  const roleKeys = Object.keys(counts).sort();
  if (S.roleF && !counts[S.roleF]) S.roleF = "";
  const q = norm(S.findQ), inRole = S.roleF ? everyone.filter(m => rolesOf(m).some(r => norm(r) === S.roleF)) : everyone;
  const SHOW = {all: ["Everyone", () => true], member: ["Members", m => typeKey(m) === "member"],
    first: ["First-timers", m => m.type === "first_timer"], visitor: ["Visitors", m => m.type === "visitor"], nopastor: ["No pastor yet", m => !pastorsOf(m).length],
    female: ["Females", m => genderOf(m) === "Female"], male: ["Males", m => genderOf(m) === "Male"], adult: ["Adults", m => !isKid(m)], child: ["Children", m => isKid(m)]};
  const last = {}; for (const t of S.ticks) if (!last[t.member_id] || t.service_date > last[t.member_id]) last[t.member_id] = t.service_date;
  const lastOf = m => last[m.id] || S.seen?.[m.id] || "";
  const SORT = {name: ["Name A to Z", (a, b) => byName(a, b)], namez: ["Name Z to A", (a, b) => byName(b, a)],
    pastor: ["Pastor", (a, b) => (!pastorsOf(a).length - !pastorsOf(b).length) || (pastorsOf(a)[0] || "").localeCompare(pastorsOf(b)[0] || "")],
    gender: ["Gender", (a, b) => ({Female: 0, Male: 1}[genderOf(a)] ?? 2) - ({Female: 0, Male: 1}[genderOf(b)] ?? 2)],
    age: ["Age group", (a, b) => isKid(a) - isKid(b)], type: ["Attendance type", (a, b) => typeOpts.findIndex(t => t[0] === typeKey(a)) - typeOpts.findIndex(t => t[0] === typeKey(b))],
    status: ["Status", (a, b) => (a.status || "").localeCompare(b.status || "")], seen: ["Last attended", (a, b) => lastOf(b).localeCompare(lastOf(a))]};
  if (!SHOW[S.showF]) S.showF = "all"; if (!SORT[S.sortBy]) S.sortBy = "name";
  S.sel = new Set([...(S.sel || [])].filter(id => everyone.some(m => m.id === id)));  // ticks stay while you search; only this church's people
  if (!S.sel.size) S.selOnly = false;
  const mine = S.selOnly ? everyone.filter(m => S.sel.has(m.id)).sort((a, b) => SORT[S.sortBy][1](a, b) || byName(a, b)) : (q ? inRole.filter(m => [m.full_name, m.phone, m.role, m.pastor, m.status].some(x => norm(x).includes(q))) : inRole)
    .filter(SHOW[S.showF][1]).sort((a, b) => SORT[S.sortBy][1](a, b) || byName(a, b));
  const plist = S.pastorList[S.church] || [], admin = S.me.role === "admin";
  const edit = S.me.role !== "team", statuses = ["", ...Object.keys(statusRules())];
  const roleNames = roleKeys.map(k => counts[k].label);
  const picked = everyone.filter(m => S.sel.has(m.id)), shownPicked = mine.filter(m => S.sel.has(m.id)).length;
  const typeOf = typeName, ageOf = m => isKid(m) ? "Child" : "Adult";
  // Laid out like Admin → Sign-ins: numbers on top, pills to filter, tools on the right, 20 people per page
  const PER = 20, pages = Math.max(1, Math.ceil(mine.length / PER)); S.pPage = Math.min(Math.max(1, S.pPage || 1), pages);
  const shown = mine.slice((S.pPage - 1) * PER, S.pPage * PER);
  const nums = [...new Set([1, S.pPage - 1, S.pPage, S.pPage + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  const TYPECLS = {member: "r-team", first_timer: "r-pastor", visitor: "r-bishop"};
  const DOT = {member: "r-team", first: "r-pastor", visitor: "r-bishop", nopastor: "r-admin", female: "r-lead", male: "r-lead", adult: "", child: ""};
  const mixed = ["admin", "lead"].includes(S.me.role) ? everyone.filter(m => splitNamePhone(m.full_name)) : [];  // phone numbers that went into the name
  el.innerHTML = head("Congregation", esc(S.church), `${["admin", "lead", "team"].includes(S.me.role) ? `<button class="pill-btn primary" id="bulk-add">${svg("upload")}Import people</button>` : ""}<button class="pill-btn" id="dl">Download</button>`) + `
    <div class="tiles">${[["Total people", everyone.length, "In " + S.church], ["Members", everyone.filter(SHOW.member[1]).length, "Regular members"],
        ["First-timers & visitors", everyone.filter(m => m.type === "first_timer" || m.type === "visitor").length, "Still getting to know us"],
        ["No pastor yet", everyone.filter(SHOW.nopastor[1]).length, "Need a pastor assigned"]]
      .map(([t, n, sub]) => `<div class="card tile"><div class="label">${t}</div><div class="num">${String(n).padStart(2, "0")}</div><div class="note" style="margin:4px 0 0">${esc(sub)}</div></div>`).join("")}</div>
    ${mixed.length ? `<div class="msg np-fix"><span><b>${mixed.length} ${mixed.length === 1 ? "name has" : "names have"} a phone number in ${mixed.length === 1 ? "it" : "them"}.</b> Move each number to Phone and keep just the name.</span>
      <button type="button" class="pill-btn primary sm" id="np-fix">Fix ${mixed.length === 1 ? "it" : "all " + mixed.length}</button></div>` : ""}
    <div class="card">
      <div class="find-row"><label class="find-bar">${svg("search")}<input id="find" type="search" placeholder="Search by name, phone or pastor" value="${esc(S.findQ || "")}" aria-label="Search people" autocomplete="off"></label>
        <div class="u-tools">${roleKeys.length ? `<select class="in" id="teamF" aria-label="Team"><option value="">All teams</option>${roleKeys.map(k => `<option value="${esc(k)}" ${S.roleF === k ? "selected" : ""}>${esc(counts[k].label)} · ${counts[k].n}</option>`).join("")}</select>` : ""}
          <select class="in" id="sort" aria-label="Sort by">${Object.entries(SORT).map(([k, [t]]) => `<option value="${k}" ${S.sortBy === k ? "selected" : ""}>${t}</option>`).join("")}</select></div></div>
      <div class="rpills u-pills" role="tablist" aria-label="Show">${(() => {  // the first six (and the one picked), then "+ n more", as on Check-in
          const all = Object.entries(SHOW), vis = S.pMore ? all : all.filter(([k], i) => i < 6 || k === S.showF), more = all.length - vis.length;
          return vis.map(([k, [t, f]]) =>
          `<button type="button" class="rpill ${DOT[k] || ""}" role="tab" data-show="${k}" aria-selected="${S.showF === k}">${k === "all" || !DOT[k] ? "" : "<i></i>"}${t} <span>${inRole.filter(f).length}</span></button>`).join("")
            + (more ? `<button type="button" class="rpill more" data-pmore>+ ${more} more</button>` : S.pMore && all.length > 6 ? `<button type="button" class="rpill more" data-pmore>Show less</button>` : ""); })()}</div>
      ${edit && picked.length ? `<div class="bulk"><b>${picked.length} selected</b><button class="pill-btn sm" id="bulk-see">${S.selOnly ? "Show all" : "View"}</button><span class="gap"></span><button class="pill-btn sm primary" id="bulk-go">${svg("edit")}Change roles</button><button class="pill-btn sm" id="bulk-pastor">Set pastor</button><button class="pill-btn sm" id="bulk-shepherd">Set shepherd</button><button class="pill-btn sm" id="bulk-set">Set details</button>${["admin", "lead"].includes(S.me.role) && !S.preview ? `<button class="pill-btn sm bulk-del" id="bulk-del">${svg("trash")}Delete</button>` : ""}<button class="pill-btn sm" id="bulk-x">Clear</button></div>` : ""}
      <div class="scroll"><table class="utable"><thead><tr>${edit ? `<th class="tick"><input type="checkbox" id="pick-all" aria-label="Select all ${mine.length} shown" title="Select all ${mine.length} shown" ${mine.length && shownPicked === mine.length ? "checked" : ""}></th>` : ""}<th>Name</th>${edit ? "<th></th>" : ""}<th>Type</th><th>Pastor assigned</th><th>Age group</th><th>Gender</th><th>Status</th><th>Roles</th></tr></thead><tbody>
      ${shown.map(m => `<tr>${edit ? `<td class="tick"><input type="checkbox" data-pick="${esc(m.id)}" aria-label="Select ${esc(m.full_name)}" ${S.sel.has(m.id) ? "checked" : ""}></td>` : ""}
        <td><div class="who-cell">${whoBtn(m)}</div>${m.phone ? `<small class="muted" style="display:block;margin:2px 0 0 40px">${esc(m.phone)}</small>` : ""}</td>
        ${edit ? `<td><button class="pill-btn sm" data-edit="${esc(m.id)}" aria-label="Edit ${esc(m.full_name)}">${svg("edit")}Edit</button></td>` : ""}
        <td><span class="rbadge ${TYPECLS[typeKey(m)] || ""}">${esc(typeOf(m))}</span></td>
        <td class="${pastorsOf(m).length ? "" : "muted"}">${pastorsOf(m).length ? pastorsOf(m).map(pastorBtn).join("<br>") : "Not assigned"}</td><td class="muted">${ageOf(m)}</td><td class="muted">${genderOf(m)}</td>
        <td>${m.status ? `<span class="badge">${esc(m.status)}</span>` : `<span class="muted">Active</span>`}</td>
        <td>${rolesOf(m).map(r => `<span class="tag">${esc(r)}</span>`).join("")}</td></tr>`).join("")}
      </tbody></table></div>${mine.length ? "" : `<p class="empty">${q ? "Nobody matches that search." : "Nobody here. Try another filter, or add people from Check-in."}</p>`}
      ${pages > 1 ? `<div class="pager"><span class="muted">Page ${S.pPage} of ${pages} · ${mine.length} people</span><span class="gap"></span>
        <button class="pg" data-ppg="${S.pPage - 1}" ${S.pPage === 1 ? "disabled" : ""} aria-label="Previous page">${svg("prev")}</button>
        ${nums.map((n, i) => (i && n - nums[i - 1] > 1 ? `<span class="muted">…</span>` : "") + `<button class="pg ${n === S.pPage ? "on" : ""}" data-ppg="${n}">${n}</button>`).join("")}
        <button class="pg" data-ppg="${S.pPage + 1}" ${S.pPage === pages ? "disabled" : ""} aria-label="Next page">${svg("next")}</button></div>` : ""}</div>`;
  el.querySelectorAll("[data-show]").forEach(b => b.onclick = () => { S.showF = b.dataset.show; S.pPage = 1; render(); });
  el.querySelector("[data-pmore]")?.addEventListener("click", () => { S.pMore = !S.pMore; render(); });
  el.querySelectorAll("[data-ppg]").forEach(b => b.onclick = () => { S.pPage = +b.dataset.ppg; render(); el.scrollIntoView?.({block: "start"}); });
  const teamF = el.querySelector("#teamF"); if (teamF) teamF.onchange = e => { S.roleF = e.target.value; S.pPage = 1; render(); };
  el.querySelector("#sort").onchange = e => { S.sortBy = e.target.value; S.pPage = 1; render(); };
  el.querySelectorAll("[data-pick]").forEach(c => c.onchange = () => { c.checked ? S.sel.add(c.dataset.pick) : S.sel.delete(c.dataset.pick); render(); });
  const all = el.querySelector("#pick-all");
  if (all) all.onchange = () => { for (const m of mine) all.checked ? S.sel.add(m.id) : S.sel.delete(m.id); render(); };  // only those on show
  const see = el.querySelector("#bulk-see"); if (see) see.onclick = () => { S.selOnly = !S.selOnly; render(); };
  // Set pastor / Set shepherd: add one to everyone selected (keeping any others, so someone can have two), make it their
  // only one, or take it off. (This is who looks after them; it doesn't put anyone on a Bacenta.)
  const setCare = K => {
    const list = K.list()[S.church] || [], word = K.word.toLowerCase();
    if (!list.length) return toast(`Add your ${K.words.toLowerCase()} on the ${K.words} page first, then come back.`);
    formDialog(`${K.words} for ${picked.length} ${picked.length === 1 ? "person" : "people"}`, [
      {k: "how", label: "What to do", type: "select", value: "add", options: [["add", `Add this ${word} (keep any others)`], ["only", `Make this their only ${word}`], ["remove", `Take this ${word} off`]],
       hint: `Someone can have more than one ${word}: add each one.`},
      {k: "name", label: K.word, type: "select", value: list[0], options: list.map(n => [n, n])},
    ], async v => {
      let done = 0, clash = 0, self = 0;
      for (const m of picked) {
        if (v.how !== "remove" && isSelf(v.name, m)) { self++; continue; }  // nobody is put under themselves
        const now = K.of(m), next = v.how === "only" ? [v.name] : v.how === "remove" ? now.filter(x => x !== v.name) : [...new Set([...now, v.name])];
        const val = next.join(", "); if (val === now.join(", ")) continue;
        const ver = Number(m.version) || 1;
        const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body: {[K.field]: val, version: ver + 1}})
          .catch(err => { throw new Error(/shepherd/.test(err.message) ? "Run the latest setup SQL in Supabase once to save this, then try again." : err.message); });
        if (!rows?.length) { clash++; continue; }
        Object.assign(m, {[K.field]: val, version: ver + 1}); done++;
        log("edit", m.id, "done", K.field);
      }
      if (clash) await load();
      S.sel = new Set();
      toast((clash ? `Changed ${done}. ${clash} were edited by someone else just now and were left alone.` : done ? `Changed ${done} ${done === 1 ? "person" : "people"}.` : "Nothing needed changing.")
        + (self ? ` ${v.name} was not made their own ${word}.` : ""));
      render();
    }, `Set ${word}`);
  };
  el.querySelector("#bulk-pastor")?.addEventListener("click", () => setCare({...CARE.pastors, field: "pastor"}));
  el.querySelector("#bulk-shepherd")?.addEventListener("click", () => setCare({...CARE.shepherds, field: "shepherd"}));
  // Set details: gender, age group, attendance type or status for everyone selected; "Leave as is" keeps what each person has
  const bs = el.querySelector("#bulk-set");
  if (bs) bs.onclick = () => {
    const keep = [["", "Leave as is"]];
    formDialog(`Details for ${picked.length} ${picked.length === 1 ? "person" : "people"}`, [
      {k: "gender", label: "Gender", type: "select", value: "", options: [...keep, ["Female", "Female"], ["Male", "Male"], ["-", "Not given"]]},
      {k: "age_group", label: "Age group", type: "select", value: "", options: [...keep, ["Adult", "Adult"], ["Child", "Child"]]},
      {k: "type", label: "Attendance Type", type: "select", value: "", options: [...keep, ...typeOpts]},
      {k: "status", label: "Status", type: "select", value: "", options: [...keep, ["-", "Active"], ...statuses.filter(Boolean).map(x => [x, x])]},
      ...(admin ? [{k: "church", label: "Move to church", type: "select", value: "", options: [...keep, ...S.churches.filter(c => c !== S.church).map(c => [c, c])],
        hint: "They go on that church's register, with their attendance."}] : []),
    ], async v => {
      const want = Object.fromEntries(Object.entries(v).filter(([, val]) => val).map(([k, val]) => [k, val === "-" ? "" : val]));
      if (!Object.keys(want).length) throw new Error("Choose at least one thing to change.");
      let done = 0, clash = 0;
      for (const m of picked) {
        const body = Object.fromEntries(Object.entries(want).filter(([k, val]) => (k === "gender" ? genderOf(m) : k === "age_group" ? ageOf(m) : k === "type" ? typeKey(m) : k === "church" ? churchOf(m) : m.status || "") !== val));
        if (!Object.keys(body).length) continue;
        const ver = Number(m.version) || 1;
        const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body: {...body, version: ver + 1}});
        if (!rows?.length) { clash++; continue; }
        Object.assign(m, body, {version: ver + 1}); done++;
        log("edit", m.id, "done", Object.keys(body).join(", "));
      }
      if (clash) await load();
      S.sel = new Set();
      toast(clash ? `Changed ${done}. ${clash} were edited by someone else just now and were left alone.` : done ? `Changed ${done} ${done === 1 ? "person" : "people"}.` : "Nothing needed changing.");
      render();
    }, "Save");
  };
  const bx = el.querySelector("#bulk-x"); if (bx) bx.onclick = () => { S.sel = new Set(); S.selOnly = false; render(); };
  // Delete the people selected (admin or church admin): typing how many is the check, as it can't be undone
  const bd = el.querySelector("#bulk-del");
  if (bd) bd.onclick = () => {
    const n = picked.length;
    formDialog(`Delete ${n} ${n === 1 ? "person" : "people"} from the register`, [
      {k: "ok", label: `Type ${n} to delete them`, value: "", hint: "They and their attendance are removed for good. This can't be undone: press Download first if you want a copy."}],
    async v => {
      if (String(v.ok).trim() !== String(n)) throw new Error(`Type ${n} to delete them, or close this to keep them.`);
      let done = 0;
      for (let i = 0; i < n; i += 100) {  // 100 at a time
        const ids = picked.slice(i, i + 100).map(m => m.id), gone = await api(`members?id=in.(${ids.map(encodeURIComponent).join(",")})`, {method: "DELETE", prefer: "return=representation"});
        const out = new Set((gone || []).map(x => x.id)); done += out.size;
        S.members = S.members.filter(x => !out.has(x.id)); S.ticks = S.ticks.filter(t => !out.has(t.member_id)); for (const id of out) S.sel.delete(id);
      }
      if (done) log("delete", "", "done", `${done} ${done === 1 ? "person" : "people"} at once · ${S.church}`);
      S.selOnly = false;
      toast(done === n ? `Deleted ${done} ${done === 1 ? "person" : "people"}.` : `Deleted ${done} of ${n}. The rest couldn't be deleted: try again.`); render();
    }, "Delete");
  };
  const bg = el.querySelector("#bulk-go");
  if (bg) bg.onclick = () => {
    const theirs = [...new Map(picked.flatMap(rolesOf).map(r => [norm(r), r])).values()].sort();
    const ADD = "__add__";
    formDialog(`Change roles for ${picked.length} ${picked.length === 1 ? "person" : "people"}`, [
      {k: "from", label: "Role to change", type: "select", value: counts[S.roleF] && theirs.find(r => norm(r) === S.roleF) || theirs[0] || ADD,
       options: [...theirs.map(r => [r, r]), [ADD, "Add a new role to them"]]},
      {k: "to", label: "Correct spelling, or the new role", value: "", suggest: roleNames,
       hint: "Leave empty to remove the role."},
    ], async v => {
      const add = v.from === ADD, to = v.to.replace(/,/g, " ").trim().replace(/\s+/g, " ");
      if (add && !to) throw new Error("Type the role to add.");
      let done = 0, clash = 0;
      for (const m of picked) {
        const now = rolesOf(m), out = [];
        for (const r of add ? [...now, to] : now.map(r => norm(r) === norm(v.from) ? to : r))
          if (r && !out.some(x => norm(x) === norm(r))) out.push(r);  // no doubles if they already had the right one
        const role = out.join(", ");
        if (role === now.join(", ")) continue;
        const ver = Number(m.version) || 1;
        const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body: {role, version: ver + 1}});
        if (!rows?.length) { clash++; continue; }
        Object.assign(m, {role, version: ver + 1}); done++;
        log("edit", m.id, "done", "role");
      }
      if (clash) await load();
      S.sel = new Set(); if (!add && S.roleF === norm(v.from)) S.roleF = to ? norm(to) : "";
      toast(clash ? `Changed ${done}. ${clash} were edited by someone else just now and were left alone.` : done ? `Changed ${done} ${done === 1 ? "person" : "people"}.` : "Nothing needed changing.");
      render();
    }, "Change roles");
  };
  el.querySelector("#find").oninput = e => {  // redraw, then put the cursor back where it was
    S.findQ = e.target.value; S.selOnly = false; S.pPage = 1; const at = e.target.selectionStart; render();
    const f = document.querySelector("#find"); if (f) { f.focus(); try { f.setSelectionRange(at, at); } catch {} }
  };
  el.querySelectorAll("[data-role]").forEach(b => b.onclick = () => { S.roleF = b.dataset.role; render(); });
  const moreB = el.querySelector(".chips [data-more]"); if (moreB) moreB.onclick = () => { S.roleMore = !S.roleMore; render(); };
  el.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editPerson(S.members.find(x => x.id === b.dataset.edit)));
  el.querySelector("#bulk-add")?.addEventListener("click", bulkAdd);
  el.querySelector("#np-fix")?.addEventListener("click", async e => {  // "Ama Mensah 0211234567" → name Ama Mensah, phone 0211234567
    e.target.disabled = true; let done = 0, kept = 0, clash = 0;
    for (const m of mixed) {
      const [name, ph] = splitNamePhone(m.full_name), had = String(m.phone || "").replace(/[^\d+]/g, "");
      if (had && had !== ph) { kept++; continue; }  // a different number is already in Phone: left for a person to check
      const ver = Number(m.version) || 1, body = {full_name: name, ...(had ? {} : {phone: ph}), version: ver + 1};
      const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body}).catch(() => null);
      if (!rows?.length) { clash++; continue; }
      Object.assign(m, body); done++;
    }
    if (done) log("edit", "", "done", `moved ${done} phone ${done === 1 ? "number" : "numbers"} out of names`);
    if (clash) await load();
    toast(`Fixed ${done}.` + (kept ? ` ${kept} already had a different phone number: check ${kept === 1 ? "it" : "them"} with Edit.` : "") + (clash ? ` ${clash} couldn't be saved just now: try again.` : ""));
    render();
  });
  el.querySelector("#dl").onclick = () => download(`people_${S.church}_${today()}.csv`, [["Church", "Name", "Pastor assigned", "Type", "Age group", "Gender", "Status", "Phone", "Roles"],
    ...mine.map(m => [S.church, m.full_name, pastorsOf(m).join(", "), typeOf(m), ageOf(m), genderOf(m), m.status || "Active", m.phone || "", rolesOf(m).join(", ")])]);
}

// The Edit popup for one person; used on Congregation and on the Pastors page.
function editPerson(m) {
    if (!m) return;
    const plist = S.pastorList[churchOf(m)] || [], admin = S.me.role === "admin", statuses = ["", ...Object.keys(statusRules(churchOf(m)))];
    const ageOf = m => isKid(m) ? "Child" : "Adult";
    const roleNames = [...new Map(S.members.filter(x => churchOf(x) === churchOf(m)).flatMap(rolesOf).map(r => [norm(r), r])).values()].sort();
    const cur = pastorsOf(m), slist = (S.shepherdList || {})[churchOf(m)] || [], scur = shepherdsOf(m);
    const sheps = [...slist, ...scur.filter(c => !slist.includes(c))].filter(n => !isSelf(n, m)).map(n => [n, n]);
    const pastors = [...plist, ...cur.filter(c => !plist.includes(c))].filter(n => !isSelf(n, m)).map(n => [n, shortTitle(n)]);
    formDialog(`Edit ${m.full_name}`, [
      {k: "full_name", label: "Full name", value: m.full_name, required: true},
      {k: "phone", label: "Phone", value: m.phone || "", type: "tel"},
      {k: "email", label: "Email", value: m.email || "", type: "email"},
      {k: "address", label: "Address", value: m.address || ""},
      ...("birthday" in m ? [{k: "birthday", label: "Birthday", value: m.birthday || "", type: "date"}] : []),
      {k: "role", label: "Roles", value: rolesOf(m).join(", "), suggest: roleNames, many: true, hint: "Separate several with commas."},
      {k: "type", label: "Attendance Type", value: typeKey(m), type: "select", options: typeOpts},
      {k: "age_group", label: "Age group", value: ageOf(m), type: "select", options: [["Adult", "Adult"], ["Child", "Child"]]},
      {k: "gender", label: "Gender", value: genderOf(m), type: "select", options: [["", "Not given"], ["Female", "Female"], ["Male", "Male"]]},
      {k: "status", label: "Status", value: statuses.find(x => norm(x) === norm(m.status)) ?? m.status, type: "select",
       options: [...statuses.map(x => [x, x || "Active"]), ...(m.status && !statuses.some(x => norm(x) === norm(m.status)) ? [[m.status, m.status]] : [])]},
      pastors.length ? {k: "pastor", label: "Pastors", value: cur, type: "multi", options: pastors, hint: "Tick one or more."}
                     : {k: "pastor", label: "Pastors", value: "", hint: "Add pastors on the Pastors page to choose from a list."},
      ...("shepherd" in m ? [sheps.length ? {k: "shepherd", label: "Shepherds", value: scur, type: "multi", options: sheps, hint: "Tick one or more, or none."}
                               : {k: "shepherd", label: "Shepherds", value: scur.join(", "), hint: "Add shepherds on the Shepherds page to choose from a list."}] : []),
      ...(admin ? [{k: "church", label: "Church", value: churchOf(m), type: "select", options: S.churches.map(c => [c, c])}] : []),
    ], async v => {
      if (!v.full_name) throw new Error("Type their name.");
      const badPhone = phoneProblem(v.phone, false); if (badPhone) throw new Error(badPhone);
      if (v.pastor.split(",").some(n => isSelf(n.trim(), m))) throw new Error("Someone can't be their own pastor. Choose a different pastor.");
      v.role = v.role.split(",").map(x => x.trim()).filter(Boolean).join(", ");
      const changed = Object.fromEntries(Object.entries(v).filter(([k, val]) => val !== String(k === "church" ? churchOf(m) : k === "age_group" ? ageOf(m) : k === "type" ? typeKey(m) : k === "gender" ? genderOf(m) : k === "pastor" ? pastorsOf(m).join(", ") : k === "shepherd" ? shepherdsOf(m).join(", ") : (m[k] ?? "")).trim()));
      if (!Object.keys(changed).length) return;
      // only save over the version this screen loaded: if someone else edited the person meanwhile, nothing is overwritten
      const ver = Number(m.version) || 1;
      const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body: {...changed, version: ver + 1}})
        .catch(err => { throw new Error(/gender|address|shepherd|birthday/.test(err.message) ? "Run the latest setup SQL in Supabase once to save this, then try again." : err.message); });
      if (!rows?.length) { await load(); render(); throw new Error("Someone else changed this person a moment ago, so nothing was saved. The list now shows the latest details: please make your change again."); }
      Object.assign(m, changed, {version: ver + 1});
      log("edit", m.id, "done", Object.keys(changed).join(", "));
      toast("Saved."); render();
    }, "Save", ["admin", "lead"].includes(S.me.role) ? {label: "Delete from register", confirm: `Tap again to delete ${m.full_name}`, run: async () => {
      // removes the person and their ticks for good; the activity log keeps their name
      const gone = await api(`members?id=eq.${encodeURIComponent(m.id)}`, {method: "DELETE", prefer: "return=representation"});
      if (!gone?.length) throw new Error("Not deleted. Run the latest setup SQL in Supabase once, then try again.");
      S.members = S.members.filter(x => x.id !== m.id); S.ticks = S.ticks.filter(t => t.member_id !== m.id); S.sel?.delete(m.id);
      log("delete", "", "done", `${m.full_name} · ${churchOf(m)}`); toast(`${m.full_name} was deleted.`); render();
    }} : null);
}

// ---------------------------------------------------------------- all churches (numbers only) and admin
// ---------------------------------------------------------------- All churches page: widgets (numbers only, no names)
// c: rows (each church's numbers), pick (the churches being shown), series ([date, adults, kids, first-timers, visitors] per service), ...
const CDASH_DEFAULT = ["chart", "numbers", "churches", "follow"];
const CWIDGETS = {
  numbers: {name: "Service numbers", sub: c => c.when, desc: "Present, adults and kids, first-timers, and how many of the register came.", size: "full", icon: "checkin", hue: 1,
    draw(el, c) {
      if (!c.had && c.day) { el.innerHTML = `<p class="empty">No service was recorded ${S.bChurch ? "at " + esc(S.bChurch) : "at any church"} on ${esc(nice(c.day, true))}.</p>`; return; }
      el.innerHTML = `<div class="ov">${[["Present", c.nowN, 5, c.delta === null ? "at the latest service" : c.delta === 0 ? "same as last time" : `${c.delta > 0 ? "▲" : "▼"} ${Math.abs(c.delta)} ${c.delta > 0 ? "more" : "fewer"} than last time`],
        ["Adults · Kids", `${c.sum(c.pick, "adults")}<small> · ${c.sum(c.pick, "kids")}</small>`, 1, "adults and kids"], ["First-timers", c.sum(c.pick, "first_timers"), 3, "at the latest service"],
        ["Came", c.rate + "%", 2, `of ${c.reg} on the register`]].map(([t, n, h, sub]) => `<div class="ov-cell"><b>${n}</b><span>${t}</span><small><i style="background:var(--h${h})"></i>${esc(sub)}</small></div>`).join("")}</div>`;
    }},
  chart: {name: "People present", sub: "How many came to each service · tap a bar to see that day", size: "full", icon: "dashboard", hue: 1,
    draw(el, c) {
      if (!c.trend) { el.innerHTML = `<p class="empty">Run the latest setup SQL in Supabase once to see this chart.</p>`; return; }
      el.innerHTML = `<div class="chart"></div>`; chart(el.querySelector(".chart"), c.series.map(x => [x[0], x[1], x[2]]), c.pickDay, c.day || null);
    }},
  follow: {name: "Follow-up", sub: "Missing services · no names", size: "full", icon: "followup", hue: 3,
    draw(el, c) {
      if (!c.had && c.day) { el.innerHTML = `<p class="empty">No service that day.</p>`; return; }
      el.innerHTML = c.fu.map(([f, t, n]) => `<div class="b-bar"><span><i class="b-key ${f}"></i>${esc(t)}</span><span class="b-track"><i class="${f}" style="width:${n ? Math.max(4, n / c.fuMax * 100) : 0}%"></i></span><b>${n}</b></div>`).join("");
    }},
  churches: {name: "Churches side by side", sub: "Tap one to open it", desc: "Present at each church's latest service, side by side.", size: "full", icon: "bars", hue: 4,
    draw(el, c) {
      const list = c.rows.filter(c.served), top = Math.max(1, ...list.map(r => r.present));
      el.innerHTML = list.length ? `<div class="vbars named">${list.map(r => `<button type="button" class="vbar ${r.church === S.bChurch || (!S.bChurch && r.present === top) ? "on" : ""}" data-cb="${esc(r.church)}" title="${esc(r.church)}: ${r.present}">
        <b>${r.present}</b><span style="height:${Math.max(6, r.present / top * 100)}%"></span><small>${esc(r.church)}</small></button>`).join("")}</div>` : `<p class="empty">No services to compare.</p>`;
      el.querySelectorAll("[data-cb]").forEach(b => b.onclick = () => { S.bChurch = b.dataset.cb; render(); });
    }},
  split: {name: "Who came", sub: c => c.series.length ? `${nice(c.series.at(-1)[0], true)}` : "The latest service", desc: "Adults, kids, first-timers and visitors at the latest service.", size: "narrow", icon: "split", hue: 3,
    draw(el, c) {
      const x = c.series.at(-1);
      if (!x) { el.innerHTML = `<p class="empty">No services recorded yet.</p>`; return; }
      const [, ad, kd, ft, vi] = x, tot = ad + kd;
      el.innerHTML = `<div class="split-top"><b>${tot}</b> present</div>
        <div class="split-bar">${[[ad, 1], [kd, 2]].filter(([n]) => n).map(([n, h]) => `<i style="flex:${n};background:var(--h${h})"></i>`).join("") || "<i></i>"}</div>
        <div class="split-rows">${[["Adults", ad, 1], ["Kids", kd, 2]].map(([t, n, h]) => `<div><span><i style="background:var(--h${h})"></i>${t}</span><em>${n}</em></div>`).join("")}</div>
        <p class="note" style="margin:10px 2px 0">Of these, ${ft} ${ft === 1 ? "was a first-timer" : "were first-timers"} and ${vi} ${vi === 1 ? "a visitor" : "visitors"}.</p>`;
    }},
  firsts: {name: "First-timers per service", sub: "New faces at each recent service", size: "full", icon: "people", hue: 6,
    draw(el, c) {
      const rows = c.series.slice(innerWidth < 640 ? -5 : -10), top = Math.max(1, ...rows.map(x => x[3])), topDay = [...rows].reverse().find(x => x[3] === top)?.[0];
      el.innerHTML = rows.length ? `<div class="vbars">${rows.map(x => `<button type="button" class="vbar ${x[0] === topDay ? "on" : ""}" data-fd="${x[0]}" title="${esc(nice(x[0], true))}: ${x[3]} first-timers, ${x[4]} visitors">
        <b>${x[0] === topDay ? x[3] : ""}</b><span style="height:${Math.max(4, x[3] / top * 100)}%"></span><small>${esc(nice(x[0]))}</small></button>`).join("")}</div>` : `<p class="empty">No services recorded yet.</p>`;
      el.querySelectorAll("[data-fd]").forEach(b => b.onclick = () => c.pickDay(b.dataset.fd));
    }},
};
async function overview(el) {
  const sub = S.me.role === "admin" ? "Open a church to work in it" : "Numbers only";
  el.innerHTML = head("All churches", sub) + `<p class="empty">Loading…</p>`;
  let rows;
  try { rows = await api("rpc/church_numbers", {method: "POST", body: {}}); } catch (e) { el.innerHTML = head("All churches", "") + `<div class="msg bad">${esc(e.message)}</div>`; return; }
  if (S.view !== "overview") return;
  const sum = k => rows.reduce((n, r) => n + (r[k] || 0), 0), top = Math.max(1, ...rows.flatMap(r => r.trend || [])), admin = S.me.role === "admin";
  const newest = rows.map(r => r.latest).filter(Boolean).sort().pop() || today(), byDay = {[newest]: rows};
  const text = async o => {  // every church for one day; a church with no service that day says so
    const day = o.day || newest;
    if (!byDay[day]) {
      try { byDay[day] = await api("rpc/church_numbers", {method: "POST", body: {upto: day}}); }
      catch (err) { throw new Error(/church_numbers|upto|schema cache/i.test(err.message) ? "Run the latest setup SQL in Supabase once to share an earlier day." : err.message); }
    }
    const all = byDay[day], had = all.filter(r => r.latest === day), tot = k => had.reduce((n, r) => n + (r[k] || 0), 0);
    if (!had.length) return null;
    return wa([`*FCC · all churches*${S.emoji ? " ⛪" : ""}`, nice(day, true), "",
      ["✅", `Present: *${tot("present")}*`], ["🧑", `Adults: *${tot("adults")}*`], ["🧒", `Kids: *${tot("kids")}*`], ["👋", `First-timers: *${tot("first_timers")}*`],
      ...all.flatMap(r => r.latest !== day ? ["", `*${r.church}*`, "No service this day"] : ["", `*${r.church}*`, `Present ${r.present} · Adults ${r.adults} · Kids ${r.kids}`,
        `First-timers ${r.first_timers} · ${S.emoji ? `🔴 ${r.red} · 🟡 ${r.yellow}` : `Red ${r.red} · Yellow ${r.yellow}`}`])]);
  };
  return bishop(el, rows, text, newest);  // the Bishop and the admin share the list-and-dashboard view
}
// The Bishop's page: a short list of churches on one side and the chosen church's dashboard beside it (numbers only).
// On a phone the list comes first; tapping a church opens its dashboard, and Back returns to the list.
async function bishop(el, rows, text, newest) {
  const admin = S.me.role === "admin", day = S.bDay && S.bDay < today() ? S.bDay : "";  // a chosen past day, or "" for the latest
  if (day) {
    try { rows = await api("rpc/church_numbers", {method: "POST", body: {upto: day}}); }
    catch (err) { S.bDay = ""; toast(/church_numbers|upto|schema cache/i.test(err.message) ? "Run the latest setup SQL in Supabase once to look at an earlier day." : err.message); return render(); }
  }
  const [trend, days, bac] = await Promise.all([api("rpc/church_trend", {method: "POST", body: day ? {upto: day} : {}}).catch(() => null),  // null until the newer setup SQL has been run
    api("rpc/church_days", {method: "POST", body: {}}).catch(() => null),
    api("rpc/bacenta_numbers", {method: "POST", body: {upto: day || today()}}).catch(() => null)]);  // Bacentas as numbers only
  if (S.view !== "overview") return;
  if (S.bChurch && !rows.some(r => r.church === S.bChurch)) S.bChurch = "";
  const sum = (list, k) => list.reduce((n, r) => n + (r[k] || 0), 0);
  const served = r => !day || r.latest === day;  // on a chosen day, only churches that had a service that very day count
  const seriesOf = ch => {  // [date, adults, kids, first-timers, visitors] per service; every church added up for "All churches"
    const by = {};
    for (const t of trend || []) if (!ch || t.church === ch) {
      const x = by[t.service_date] ??= [t.service_date, 0, 0, 0, 0];
      x[1] += t.adults; x[2] += t.kids; x[3] += t.first_timers; x[4] += t.visitors;
    }
    return Object.values(by).sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  };
  const tops = Math.max(1, ...rows.flatMap(r => r.trend || []));
  const item = (key, label, present, when, spark) => `<button class="b-item ${S.bChurch === key ? "on" : ""}" data-b="${esc(key)}">
      <span class="b-name"><b>${esc(label)}</b><small>${esc(when)}</small></span>
      <span class="spark" aria-hidden="true">${spark}</span><span class="b-num">${present}</span>${svg("next")}</button>`;
  const sparkOf = t => (t || []).slice(-8).map(n => `<i style="height:${Math.max(2, Math.round(22 * n / tops))}px"></i>`).join("");
  const allTrend = seriesOf("").map(x => x[1] + x[2]), on = rows.filter(served);
  const list = item("", "All churches", sum(on, "present"), day ? `${on.length} of ${rows.length} had a service` : `${rows.length} churches`,
      sparkOf(allTrend.map(n => n * tops / Math.max(1, ...allTrend)))) +
    rows.map(r => served(r) ? item(r.church, r.church, r.present, r.latest ? nice(r.latest) : "No services yet", sparkOf(r.trend))
      : item(r.church, r.church, "–", "No service this day", sparkOf(r.trend))).join("");
  const pick = (S.bChurch ? rows.filter(r => r.church === S.bChurch) : rows).filter(served), one = S.bChurch ? pick[0] : null, had = pick.length > 0;
  const series = seriesOf(S.bChurch), last = series[series.length - 1], prev = series[series.length - 2];
  const nowN = sum(pick, "present"), prevN = prev ? prev[1] + prev[2] : null;
  const delta = had && last && prevN !== null && (!day || last[0] === day) && (!one || one.latest === last[0]) ? (last[1] + last[2]) - prevN : null;
  const reg = sum(pick, "register"), rate = reg ? Math.round(nowN / reg * 100) : 0;
  const latest = day || (one ? one.latest : newest);
  const fu = [["red", `Missed ${RED_AT}+ in a row`, sum(pick, "red")], ["yellow", `Missed ${YELLOW_AT}–${RED_AT - 1} in a row`, sum(pick, "yellow")],
              ["blue", day ? "Missed that service" : "Missed the latest service", sum(pick, "missed_this")]];
  const fuMax = Math.max(1, ...fu.map(f => f[2]));
  const when = !latest ? "No services yet" : day && !had ? nice(day, true) : `${S.names?.[latest] || svcName(latest)} · ${nice(latest, true)}`;
  el.innerHTML = head(admin ? "Churches" : "All churches", admin ? "Every church's numbers; open one to work in it, or manage the list at the bottom" : "Numbers only", `${admin ? `<button class="pill-btn" id="go-manage">${svg("edit")}Manage churches</button>` : ""}<button class="pill-btn" id="addcw">${svg("plus")}Add widget</button><button class="pill-btn" id="wa">Summary for WhatsApp</button><button class="pill-btn" id="dl">Download</button>`) + `
    <div class="bish">
      <div class="card b-cal" id="b-cal"></div>
      <div class="b-swipe"><span><b>${rows.length} ${rows.length === 1 ? "church" : "churches"}</b> · swipe or tap the arrows</span><button type="button" class="icon-btn sm" data-bs="-1" aria-label="Previous churches">${svg("prev")}</button><button type="button" class="icon-btn sm" data-bs="1" aria-label="More churches">${svg("next")}</button></div>
      <nav class="card b-list" aria-label="Churches">${list}</nav>
      <section class="b-detail">
        <div class="b-title"><h2>${esc(S.bChurch || "All churches")}</h2><span class="muted">${esc(when)}</span>
          ${admin && S.bChurch ? `<span class="gap" style="flex:1"></span><button class="pill-btn primary sm" data-open="${esc(S.bChurch)}">Open ${esc(S.bChurch)}</button>` : ""}</div>
        <div class="wgrid c2" id="cgrid"></div>
      </section></div>
    ${bac ? bacentaNumbers(bac, S.bChurch, day) : ""}
    ${admin ? `<div class="card ch-manage" id="ch-manage"></div>` : ""}`;
  const wireBac = () => el.querySelector("#b-bac")?.addEventListener("click", e => {  // sort the Bacentas table in place
    const h = e.target.closest("[data-bsort]"); if (!h) return; const k = h.dataset.bsort, was = S.bacSort || {k: "came", up: false};
    S.bacSort = {k, up: was.k === k ? !was.up : k === "church"};  // a new column: highest first (names A to Z)
    el.querySelector("#b-bac").outerHTML = bacentaNumbers(bac, S.bChurch, day); wireBac(); el.querySelector(`#b-bac [data-bsort="${k}"]`)?.focus(); });
  wireBac();
  if (admin) { manageChurches(el.querySelector("#ch-manage"), rows);
    el.querySelector("#go-manage").onclick = () => el.querySelector("#ch-manage")?.scrollIntoView({behavior: "smooth", block: "start"}); }
  // the month calendar: days with a service show how many came (for the chosen church, or all churches added up)
  const counts = {}; for (const d of days || []) if (!S.bChurch || d.church === S.bChurch) counts[d.service_date] = (counts[d.service_date] || 0) + d.present;
  const chosen = day || newest; S.bCal ||= chosen.slice(0, 7);
  const drawCal = () => {
    const [y, m] = S.bCal.split("-").map(Number), first = new Date(y, m - 1, 1), n = new Date(y, m, 0).getDate(), now = today();
    let cells = "<span></span>".repeat(first.getDay());
    for (let d = 1; d <= n; d++) {
      const iso = `${S.bCal}-${pad(d)}`, c = counts[iso] || 0, future = iso > now;
      cells += `<button class="day ${c ? "has" : ""} ${iso === chosen ? "sel" : ""} ${iso === now ? "today" : ""}" data-bd="${iso}" ${future ? "disabled" : ""}
        aria-label="${esc(nice(iso, true))}${c ? `, ${c} present` : ", no service recorded"}">${d}${c ? `<small>${c}</small>` : ""}</button>`;
    }
    const cal = el.querySelector("#b-cal");
    cal.innerHTML = `<div class="card-head"><h2>${first.toLocaleDateString("en-NZ", {month: "long", year: "numeric"})}</h2><span class="gap"></span>
        <button class="icon-btn sm" data-m="-1" aria-label="Previous month">${svg("prev")}</button><button class="icon-btn sm" data-m="1" aria-label="Next month">${svg("next")}</button></div>
      <div class="cal"><b>Sun</b><b>Mon</b><b>Tue</b><b>Wed</b><b>Thu</b><b>Fri</b><b>Sat</b>${cells}</div>
      <div class="b-cal-foot"><span class="note">${day ? `Showing ${esc(nice(day, true))}` : "Showing the latest services"}${days ? "" : " · run the latest setup SQL to mark service days"}</span>
        ${day ? `<button class="pill-btn sm" id="b-latest">Back to latest</button>` : ""}</div>`;
    cal.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { const d = new Date(y, m - 1 + Number(b.dataset.m), 1); S.bCal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; drawCal(); });
    cal.querySelectorAll("[data-bd]").forEach(b => b.onclick = () => pickDay(b.dataset.bd));
    const lat = cal.querySelector("#b-latest"); if (lat) lat.onclick = () => { S.bDay = ""; S.bCal = newest.slice(0, 7); render(); };
  };
  const narrow = () => matchMedia("(max-width: 900px)").matches;  // on phones the dashboard sits above the calendar
  const pickDay = d => { S.bDay = d >= newest ? "" : d; S.bCal = d.slice(0, 7); S.bJump = narrow(); render(); };
  drawCal();
  await loadPrefs();
  if (S.view !== "overview") return;
  drawBoard(el.querySelector("#cgrid"), "church", {rows, pick, one, had, day, served, sum, series, trend, delta, nowN, reg, rate, fu, fuMax, when, pickDay});
  el.querySelector("#addcw").onclick = () => addWidget("church");
  el.querySelectorAll("[data-b]").forEach(b => b.onclick = () => { S.bChurch = b.dataset.b; S.bJump = narrow(); render(); });
  if (narrow()) { const on = el.querySelector(".b-item.on"), row = el.querySelector(".b-list"); if (on && row) row.scrollLeft = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2; }  // keep the chosen church in view in the row
  { const row = el.querySelector(".b-list");  // phones: soft fades at the row's edges while there's more to swipe to
    const f = () => { const l = row.scrollLeft > 4, r = row.scrollLeft + row.clientWidth < row.scrollWidth - 4;
      row.style.setProperty("--fl", l ? "44px" : "0px"); row.style.setProperty("--fr", r ? "44px" : "0px");
      const [pb, nb] = el.querySelectorAll("[data-bs]"); if (pb) { pb.disabled = !l; nb.disabled = !r; el.querySelector(".b-swipe").hidden = !l && !r; } };
    if (row) { row.onscroll = f; f();
      // the arrows: a row of churches at a time; and once on each phone, a little nudge so it's clear the row moves
      el.querySelectorAll("[data-bs]").forEach(b => b.onclick = () => row.scrollBy({left: b.dataset.bs * row.clientWidth * .7, behavior: stillMotion() ? "auto" : "smooth"}));
      let shown = true; try { shown = !!localStorage.getItem("fcc-bswipe"); localStorage.setItem("fcc-bswipe", "1"); } catch {}
      if (!shown && narrow() && !stillMotion() && row.scrollWidth > row.clientWidth + 4) {
        setTimeout(() => row.scrollBy({left: 90, behavior: "smooth"}), 700); setTimeout(() => row.scrollBy({left: -90, behavior: "smooth"}), 1500); } } }
  if (S.bJump) { S.bJump = false; el.querySelector(".b-list")?.scrollIntoView({behavior: "smooth", block: "start"}); }  // church row and dashboard in view
  el.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { S.church = b.dataset.open; S.view = "dashboard"; render(); });  // admin: work in that church
  el.querySelector("#wa").onclick = () => waDialog("All churches for WhatsApp", text, {day: latest || newest});
  el.querySelector("#dl").onclick = () => download(`all_churches_${day || today()}.csv`, [["Church", "Service", "Present", "Adults", "Kids", "First-timers", "On the register", "Needs a call (red)", "Check in (amber)", "Missed this service"],
    ...rows.map(r => served(r) ? [r.church, r.latest || "", r.present, r.adults, r.kids, r.first_timers, r.register, r.red, r.yellow, r.missed_this]
      : [r.church, `No service on ${day}`, "", "", "", "", r.register, "", "", ""])]);
}
// Bacentas on the All churches page, numbers only (no names): for each church, its Bacentas, how many people came last
// week (Monday to Sunday), the last 8 weeks as little bars, and how many Bacentas didn't fill in last week.
// Tap a heading to sort by it (highest first; tap again for lowest first).
const BAC_COLS = [["church", "Church"], ["bacentas", "Bacentas"], ["came", "Came last week"], ["total", "Last 8 weeks"], ["behind", "Didn't fill in last week"]];
function bacentaNumbers(rows, only, day) {
  const srt = S.bacSort || {k: "came", up: false}, val = (r, k) => k === "total" ? (r.weeks || []).reduce((a, b) => a + b, 0) : r[k];
  const list = (only ? rows.filter(r => r.church === only) : rows).slice().sort((a, b) => {
    const x = val(a, srt.k), y = val(b, srt.k), c = srt.k === "church" ? String(x).localeCompare(String(y)) : (x || 0) - (y || 0);
    return (srt.up ? c : -c) || String(a.church).localeCompare(String(b.church)); });
  const tot = k => list.reduce((n, r) => n + (r[k] || 0), 0);
  const top = Math.max(1, ...list.flatMap(r => r.weeks || []));
  const bars = w => (w || []).map(n => `<i style="height:${Math.max(2, Math.round(22 * n / top))}px" title="${n}"></i>`).join("");
  return `<div class="card" id="b-bac" style="margin-top:14px"><div class="card-head"><h2>Bacentas</h2><span class="gap"></span><span class="muted" style="font-size:13px">Numbers only · last week is Monday to Sunday${day ? ", before " + esc(nice(day)) : ""}</span></div>
    ${tot("bacentas") || list.some(r => (r.weeks || []).some(Boolean)) ? `<div class="scroll"><table><thead><tr>${BAC_COLS.map(([k, t]) => `<th aria-sort="${srt.k === k ? (srt.up ? "ascending" : "descending") : "none"}"><button type="button" data-bsort="${k}" style="all:unset;cursor:pointer;white-space:nowrap" title="Sort by ${esc(t.toLowerCase())}">${esc(t)}${srt.k === k ? (srt.up ? " ▲" : " ▼") : ""}</button></th>`).join("")}</tr></thead><tbody>
      ${list.map(r => `<tr><td>${esc(r.church)}</td><td>${r.bacentas}</td><td>${r.came}</td><td><span class="spark" aria-label="People each week: ${(r.weeks || []).join(", ")}">${bars(r.weeks)}</span></td>
        <td>${r.behind ? `<span class="badge yellow">${r.behind} of ${r.bacentas}</span>` : r.bacentas ? `<span class="badge ok">All filled in</span>` : `<span class="muted">No Bacentas</span>`}</td></tr>`).join("")}
      ${list.length > 1 ? `<tr><td><b>All churches</b></td><td><b>${tot("bacentas")}</b></td><td><b>${tot("came")}</b></td><td></td><td>${tot("behind") ? `<b>${tot("behind")}</b>` : ""}</td></tr>` : ""}
      </tbody></table></div>` : `<p class="empty">No Bacentas yet${only ? " in " + esc(only) : ""}.</p>`}</div>`;
}
// Churches page (admin): every church in one list, with Rename and Delete, and a box to add a new one.
// A church can only be deleted when nobody is on its register and nobody signs in to it; the home church can't be deleted.
async function manageChurches(box, rows) {
  const signins = await api("app_users?select=church").catch(() => []);
  const people = Object.fromEntries((rows || []).map(r => [r.church, r.register || 0])), logins = {};
  for (const u of signins) if (u.church) logins[u.church] = (logins[u.church] || 0) + 1;
  let armed = "";
  const refresh = async () => { S.churches = (await api("churches?select=name&order=name")).map(c => c.name); await load(); render(); };
  const draw = () => {
    box.innerHTML = `<div class="card-head"><h2>Manage churches</h2><span class="gap"></span><span class="muted" style="font-size:13px">${S.churches.length} churches</span></div>
      <div class="ch-list">${S.churches.map(c => { const n = people[c] || 0, l = logins[c] || 0, home = c === S.me.home;
        return `<div class="ch-row"><div class="ch-name"><b>${esc(c)}</b><small>${home ? "Home church · " : ""}${n} on the register · ${l} ${l === 1 ? "sign-in" : "sign-ins"}</small></div>
          <button class="pill-btn sm" data-chren="${esc(c)}">${svg("edit")}Rename</button>
          ${home ? "" : `<button class="pill-btn sm ci-remove" data-chdel="${esc(c)}">${armed === c ? "Tap again to delete" : "Delete"}</button>`}</div>`; }).join("")}</div>
      <form class="row ch-add" id="ch-add"><div><label class="f" for="ch-new">Add a church</label><input class="in" id="ch-new" placeholder="e.g. Melbourne" required autocomplete="off"></div>
        <div style="flex:0 0 auto"><button class="pill-btn primary">${svg("plus")}Add church</button></div></form>
      <p class="note">A church can be deleted once nobody is on its register or signs in to it.</p>`;
    box.querySelectorAll("[data-chren]").forEach(b => b.onclick = () => formDialog(`Rename ${b.dataset.chren}`, [
      {k: "name", label: "New name", value: b.dataset.chren, required: true}], async v => {
        if (!v.name || v.name === b.dataset.chren) return;
        let name;
        try { name = await api("rpc/app_rename_church", {method: "POST", body: {old_name: b.dataset.chren, new_name: v.name}}); }
        catch (err) { throw new Error(/app_rename_church/.test(err.message) ? "Run the latest setup SQL in Supabase once, then try again." : err.message.replace(/^./, c => c.toUpperCase()) + "."); }
        if (S.church === b.dataset.chren) S.church = name;
        if (S.bChurch === b.dataset.chren) S.bChurch = name;
        toast(`Renamed to ${name}.`); await refresh();
      }, "Rename"));
    box.querySelectorAll("[data-chdel]").forEach(b => b.onclick = async () => {
      const c = b.dataset.chdel, n = people[c] || 0, l = logins[c] || 0;
      if (n || l) return toast(`${c} still has ${n ? `${n} ${n === 1 ? "person" : "people"} on its register` : ""}${n && l ? " and " : ""}${l ? `${l} ${l === 1 ? "sign-in" : "sign-ins"}` : ""}. Move or remove them first.`);
      if (armed !== c) { armed = c; draw(); setTimeout(() => { if (armed === c) { armed = ""; if (box.isConnected) draw(); } }, 4000); return; }
      armed = "";
      if (S.preview) return toast("Not deleted: " + viewOnly());
      try {
        await api(`churches?name=eq.${encodeURIComponent(c)}`, {method: "DELETE", prefer: "return=minimal"});
        log("delete", "", "done", `church: ${c}`);
        if (S.church === c) S.church = S.me.home; if (S.bChurch === c) S.bChurch = "";
        toast(`${c} was deleted.`); await refresh();
      } catch (err) { toast(/foreign key|violates|referenced/i.test(err.message) ? `${c} still has people, sign-ins or services linked to it, so it can't be deleted.` : "Not deleted: " + err.message); draw(); }
    });
    box.querySelector("#ch-add").onsubmit = async e => { e.preventDefault(); const name = box.querySelector("#ch-new").value.trim().replace(/\s+/g, " "); if (!name) return;
      if (S.churches.some(c => c.toLowerCase() === name.toLowerCase())) return toast(`${name} is already on the list.`);
      try { await api("churches", {method: "POST", prefer: "return=minimal", body: {name}}); toast(`${name} added.`); await refresh(); } catch (err) { toast("Not added: " + err.message); } };
  };
  draw();
}
async function admin(el) {
  el.innerHTML = head("Admin", "Sign-ins, messages and space") + `<p class="empty">Loading…</p>`;
  const users = await api("app_users?select=email,role,church,name,pastor,title,role3&order=email").catch(() => api("app_users?select=email,role,church,name,pastor,title&order=email")).catch(() => api("app_users?select=email,role,church,name,pastor&order=email")).catch(() => api("app_users?select=email,role,church,name&order=email")).catch(() => []);
  const pnames = [...new Set(Object.values(S.pastorList).flat())].sort();  // names on every church's pastor list
  const snames = [...new Set(Object.values(S.shepherdList || {}).flat())].sort();  // and shepherd list
  const space = await api("rpc/app_db_size", {method: "POST", body: {}}).catch(() => null);  // null until the newer setup SQL has been run
  const inbox = await api("help_messages?select=*&order=created_at.desc&limit=50").catch(() => null);  // messages sent from Help
  if (S.view !== "admin") return;
  const LIMIT = 500 * 1024 * 1024, mb = b => b >= 1024 * 1024 ? `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`;
  const LABEL = {activity_log: "Activity log", attendance: "Ticks", members: "People", registrations: "Sign-ups", email_log: "Emails sent", services: "Services", settings: "Settings", app_users: "Sign-ins", churches: "Churches", help_messages: "Help messages"};
  const pct = space ? Math.min(100, space.total / LIMIT * 100) : 0;
  // Backups: a Google Sheet copies everything each night (the free plan has no backups to restore from)
  const bkStatus = await api("rpc/app_backup_status", {method: "POST", body: {}}).catch(e => /app_backup_status|function/i.test(e.message) ? "sql" : null);
  const ago = t => t ? new Date(t).toLocaleString(undefined, {day: "numeric", month: "short", hour: "numeric", minute: "2-digit"}) : "";
  const backupCard = `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Google Sheet backup</h2><span class="gap"></span>
      ${bkStatus && bkStatus !== "sql" ? `<span class="badge ${bkStatus.last_used && Date.now() - new Date(bkStatus.last_used) < 2 * 864e5 ? "" : "warn"}">${bkStatus.last_used ? "Last copied " + esc(ago(bkStatus.last_used)) : "Not run yet"}</span>` : ""}</div>
    ${bkStatus === "sql" ? `<p class="note" style="margin:0">Run the latest setup SQL in Supabase once to set this up.</p>` : `
    <p class="note" style="margin:0 2px 12px">Every night a Google Sheet in your Google Drive copies everything: a tab for each church: everyone on its register, how many Sundays they've missed this year, and every Sunday of the year in colour, then the services, the Pastors and Shepherds lists and the sign-ins. It runs on Google, so no computer needs to be on. The free Supabase plan keeps no backups of its own.
      Google keeps the sheet's earlier days too (File → Version history).</p>
    ${bkStatus ? `<p class="note" style="margin:0 2px 12px">Key made ${esc(ago(bkStatus.made_at))}${bkStatus.made_by ? " by " + esc(bkStatus.made_by) : ""}. Making a new one stops the old sheet copying.</p>` : ""}
    <button type="button" class="pill-btn primary" id="bk-make">${bkStatus ? "Set up again (new key)" : "Set up the Google Sheet"}</button>`}</div>`;
  const spaceCard = `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Database space</h2><span class="gap"></span>
      ${space ? `<span style="color:var(--ink-3);font-size:13px">${mb(LIMIT - space.total)} left</span>` : ""}</div>
    ${space ? `<div class="meter ${pct >= 90 ? "bad" : pct >= 70 ? "warn" : ""}" role="meter" aria-valuemin="0" aria-valuemax="500" aria-valuenow="${(space.total / 1048576).toFixed(1)}" aria-label="Database space used"><i style="width:${Math.max(pct, 1).toFixed(1)}%"></i></div>
      <p class="note" style="margin:8px 2px 0">${mb(space.total)} of 500 MB used (${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%) on the free plan.
        Biggest: ${(space.tables || []).slice(0, 3).map(t => `${esc(LABEL[t.name] || t.name)} ${mb(t.bytes)}`).join(" · ")}</p>`
      : `<p class="note" style="margin:0">Run the latest setup SQL in Supabase once to see this.</p>`}</div>`;
  if (S.view !== "admin") return;
  const fresh = (inbox || []).filter(m => !m.done), shown = S.inboxAll ? inbox || [] : fresh;
  const when = t => { const d = new Date(t); return d.toLocaleDateString(undefined, {day: "numeric", month: "short"}) + ", " + d.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"}); };
  const inboxCard = `<div class="card" style="margin-bottom:14px" id="inbox"><div class="card-head"><h2>Messages${fresh.length ? ` <span class="badge red">${fresh.length} new</span>` : ""}</h2><span class="gap"></span>
      ${inbox?.length ? `<button class="link" style="margin:0" id="inbox-all">${S.inboxAll ? "Hide done" : "Show done too"}</button>` : ""}</div>
    ${inbox === null ? `<p class="note" style="margin:0">Run the latest setup SQL in Supabase to see Help messages here.</p>`
      : !shown.length ? `<p class="empty" style="margin:0">No ${inbox.length ? "new " : ""}messages. Messages from the Help page show here and are emailed to you.</p>`
      : shown.map(m => `<div class="inbox-item ${m.done ? "done" : ""}">
        <div class="ib-top"><b>${esc(m.name || m.email)}</b><small class="muted">${esc(when(m.created_at))}</small></div>
        <small class="muted">${esc([m.name ? m.email : "", ROLE[m.role] || m.role, m.church, m.topic].filter(Boolean).join(" · "))}</small>
        <div class="msg-body">${esc(m.message)}</div>
        <div class="ib-acts"><a class="pill-btn sm" href="mailto:${esc(m.email)}?subject=${encodeURIComponent("Re: " + (m.topic || "your message"))}">${svg("mail")}Reply</a>
          <button class="pill-btn sm" data-done="${m.id}" data-v="${!m.done}">${m.done ? "Mark as new" : "Mark done"}</button>
          <button class="x" data-mdel="${m.id}">Delete</button></div></div>`).join("")}</div>`;
  // Tabs: one area at a time. Opens on Messages when there are new ones, otherwise on Sign-ins; then remembers the choice.
  const TABS = [["messages", "Messages", fresh.length], ["names", "Sign-ins", users.length], ["backup", "Backups", 0], ["space", "Space", 0]];  // churches are managed on the Churches page
  if (!TABS.some(t => t[0] === S.adminTab)) S.adminTab = fresh.length ? "messages" : "names";
  const tab = k => `data-at="${k}" ${S.adminTab === k ? "" : "hidden"}`;
  el.innerHTML = head("Admin", "Who can sign in, messages from Help, and database space") + `<div class="atabs" role="tablist" aria-label="Admin">${TABS.map(([k, name, n]) =>
      `<button role="tab" data-atab="${k}" aria-selected="${S.adminTab === k}">${name}${k === "messages" && n ? ` <span class="anum new">${n}</span>` : ""}</button>`).join("")}</div>
    <section ${tab("messages")}>${inboxCard}</section><section ${tab("backup")}>${backupCard}</section><section ${tab("space")}>${spaceCard}</section>
    <section ${tab("names")}>
    <div class="tiles">${[["Total sign-ins", users.length, "Across all churches"], ["Church admins", users.filter(u => u.role === "lead").length, "Run a church"],
        ["Team", users.filter(u => u.role === "team").length, "Ushers ticking people in"], ["Pastors", users.filter(u => u.role === "pastor" || u.pastor).length, "Including admins who pastor"]]
        .map(([t, n, sub]) => `<div class="card tile"><div class="label">${t}</div><div class="num">${String(n).padStart(2, "0")}</div><div class="note" style="margin:4px 0 0">${sub}</div></div>`).join("")}</div>
    <div class="card"><div class="card-head"><h2>People who can sign in</h2><span class="gap"></span><button type="button" class="pill-btn primary sm" id="u-add-tg">+ Add person</button></div>
      <div class="u-bar"><div class="rpills" role="tablist" aria-label="Filter by role">${(() => {  // every role as it is shown, the first few, then + more
          const all = [["", "All"], ...UKINDS], shown = S.uMore || all.findIndex(x => x[0] === (S.uRole || "")) >= 5 ? all.length : 5;
          return all.map(([k, t], i) => `<button type="button" class="rpill ${k ? "r-" + k : ""}" role="tab" data-ur="${k}" aria-selected="${(S.uRole || "") === k}" ${i >= shown ? "hidden" : ""}>${k ? "<i></i>" : ""}${t} <span>${k ? users.filter(u => inKind(u, k)).length : users.length}</span></button>`).join("")
            + (shown < all.length ? `<button type="button" class="rpill more" data-umore>+ ${all.length - shown} more</button>` : "");
        })()}</div>
        <div class="u-tools"><select class="in" id="u-ch" aria-label="Church"><option value="">All churches</option>${S.churches.map(c => `<option ${S.uCh === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
          <input class="in" id="u-q" type="search" placeholder="Search by name or email" value="${esc(S.uQ || "")}"></div></div>
      <div id="u-list"></div>
      </div></section>`;
  el.querySelector("#bk-make")?.addEventListener("click", async e => {
    e.target.disabled = true; let key;
    try { key = await api("rpc/app_backup_key", {method: "POST", body: {}}); } catch (err) { e.target.disabled = false; return toast("Not made: " + err.message); }
    const code = BACKUP_SCRIPT.replace("__URL__", S.cfg.url).replace("__PUBLIC__", S.cfg.key).replace("__KEY__", key);
    document.querySelectorAll(".modal").forEach(m => m.remove());
    const d = document.createElement("div"); d.className = "modal";
    d.innerHTML = `<div class="sheet narrow" role="dialog" aria-modal="true" aria-label="Set up the Google Sheet backup">
      <div class="card-head"><h2>Set up the Google Sheet backup</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
      <ol class="bk-steps">
        <li>Make a new Google Sheet (sheets.new) in the Google account that should keep the backup. Name it e.g. <b>FCC backup</b>.</li>
        <li>In the sheet: <b>Extensions → Apps Script</b>. Delete what's there and paste the script below (Copy script).</li>
        <li>Press <b>Save</b>, pick <b>setup</b> next to Run, and press <b>Run</b>. Allow it when Google asks (Advanced → Go to… if it warns).</li>
        <li>It now backs up every night by itself.</li></ol>
      <p class="note" style="margin:0 2px 8px">Keep the sheet private: the script holds the backup key, shown only now.</p>
      <textarea class="in bk-code" readonly rows="8" aria-label="The script">${esc(code)}</textarea>
      <div class="modal-foot"><button type="button" class="pill-btn" data-x>Done</button><button type="button" class="pill-btn primary" id="bk-copy">Copy script</button></div></div>`;
    document.body.append(d);
    d.onclick = ev => { if (ev.target === d || ev.target.closest("[data-x]")) { d.remove(); render(); } };
    d.querySelector("#bk-copy").onclick = ev => navigator.clipboard?.writeText(code).then(() => { ev.target.textContent = "Copied"; toast("Script copied."); })
      .catch(() => { d.querySelector(".bk-code").select(); toast("Couldn't copy: select the script and copy it."); });
  });
  el.querySelectorAll("[data-atab]").forEach(b => b.onclick = () => {
    S.adminTab = b.dataset.atab;
    el.querySelectorAll("[data-atab]").forEach(x => x.setAttribute("aria-selected", x === b));
    el.querySelectorAll("section[data-at]").forEach(x => x.hidden = x.dataset.at !== S.adminTab);
  });
  const again = async fn => { try { await fn(); } catch (err) { toast("Not saved: " + err.message); } S.churches = (await api("churches?select=name&order=name")).map(c => c.name); render(); };
  el.querySelectorAll("[data-rename]").forEach(b => b.onclick = () => formDialog(`Rename ${b.dataset.rename}`, [
    {k: "name", label: "New name", value: b.dataset.rename, required: true, hint: "If this church has passwords on the Streamlit site, rename it in the Streamlit Secrets too."}],
    async v => {
      if (!v.name || v.name === b.dataset.rename) return;
      let name;
      try { name = await api("rpc/app_rename_church", {method: "POST", body: {old_name: b.dataset.rename, new_name: v.name}}); }
      catch (err) { throw new Error(/app_rename_church/.test(err.message) ? "Run the latest setup SQL in Supabase once, then try again." : err.message.replace(/^./, c => c.toUpperCase()) + "."); }
      if (S.church === b.dataset.rename) S.church = name;
      S.churches = (await api("churches?select=name&order=name")).map(c => c.name); await load();
      toast(`Renamed to ${name}.`); render();
    }, "Rename"));
  const addCh = el.querySelector("#add-church"); if (addCh) addCh.onsubmit = e => { e.preventDefault(); const name = el.querySelector("#c-name").value.trim().replace(/\s+/g, " ");
    again(() => api("churches", {method: "POST", prefer: "return=minimal", body: {name}})); };
  // Sign-ins: role pills, church picker, search and 10 per page
  const PER = 10, roleCls = r => "r-" + r;
  const drawUsers = () => {
    const q = norm(S.uQ || ""), list = users.filter(u => (!S.uRole || inKind(u, S.uRole)) && (!S.uCh || u.church === S.uCh)
      && (!q || norm(u.name).includes(q) || norm(u.email).includes(q) || norm(u.pastor).includes(q)))
      .sort((a, b) => norm(a.name || a.email).localeCompare(norm(b.name || b.email)));
    const pages = Math.max(1, Math.ceil(list.length / PER)); S.uPage = Math.min(Math.max(1, S.uPage || 1), pages);
    const shown = list.slice((S.uPage - 1) * PER, S.uPage * PER);
    const nums = [...new Set([1, S.uPage - 1, S.uPage, S.uPage + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
    el.querySelector("#u-list").innerHTML = !list.length ? `<p class="empty">Nobody matches. Try another role, church or name.</p>` : `
      <div class="scroll"><table class="utable"><thead><tr><th>Name</th><th>Role</th><th>Church</th><th class="hide-sm">Pastor name</th><th></th></tr></thead><tbody>
      ${shown.map(u => `<tr><td><div class="who-cell"><span class="ava" ${avaStyle(u.name || u.email)}>${esc(initials(u.name || u.email))}</span><span><b>${esc(u.name || u.email.split("@")[0])}</b><small>${esc(u.email)}</small></span></div></td>
        <td><span class="rbadge ${roleCls(ukind(u))}">${esc(roleName(u))}</span>${second(u) ? ` <span class="rbadge r-${second(u)}">+ ${second(u) === "reverend" ? "Reverend" : "Pastor"}</span>` : ""}</td>
        <td class="muted">${esc(u.church || "All churches")}</td><td class="muted hide-sm">${esc(shortTitle(u.pastor) || (u.role === "pastor" ? "Not set yet" : ""))}</td>
        <td style="white-space:nowrap;text-align:right">${u.email === S.me.email ? (u.role === "admin" && !S.preview  // your own row: only switch between Admin and Tech admin (same rights), never lose admin by mistake
            ? `<span class="muted">You</span> <button class="pill-btn sm" data-me-title="${u.title === "Tech admin" ? "" : "Tech admin"}" title="Same rights either way: this only changes how you're named">${svg("edit")}Show me as ${u.title === "Tech admin" ? "Admin" : "Tech admin"}</button>`
            : `<span class="muted">You</span>`) : `<button class="pill-btn sm" data-chg="${esc(u.email)}">${svg("edit")}Change</button> <button class="x" data-del="${esc(u.email)}">Remove</button>`}</td></tr>`).join("")}</tbody></table></div>
      ${pages > 1 ? `<div class="pager"><span class="muted">Page ${S.uPage} of ${pages} · ${list.length} people</span><span class="gap"></span>
        <button class="pg" data-pg="${S.uPage - 1}" ${S.uPage === 1 ? "disabled" : ""} aria-label="Previous page">${svg("prev")}</button>
        ${nums.map((n, i) => (i && n - nums[i - 1] > 1 ? `<span class="muted">…</span>` : "") + `<button class="pg ${n === S.uPage ? "on" : ""}" data-pg="${n}">${n}</button>`).join("")}
        <button class="pg" data-pg="${S.uPage + 1}" ${S.uPage === pages ? "disabled" : ""} aria-label="Next page">${svg("next")}</button></div>` : ""}`;
    el.querySelectorAll("#u-list [data-pg]").forEach(b => b.onclick = () => { S.uPage = +b.dataset.pg; drawUsers(); });
    el.querySelectorAll("#u-list [data-chg]").forEach(b => b.onclick = () => change(b.dataset.chg));
    el.querySelectorAll("#u-list [data-me-title]").forEach(b => b.onclick = async () => {
      const t = b.dataset.meTitle || null; b.disabled = true;
      try {
        const rows = await api(`app_users?email=eq.${encodeURIComponent(S.me.email)}`, {method: "PATCH", prefer: "return=representation", body: {title: t}});
        if (!rows?.length) throw new Error("Not saved. Check you are still signed in as an admin.");
        S.me.title = t; log("role_change", "", "done", `${S.me.email}: ${t || "Admin"}`);
        toast(`Saved. You're now shown as ${t || "Admin"}, with the same rights.`); render();
      } catch (err) { b.disabled = false; toast(/title|column/i.test(err.message) ? "Run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
    });
    el.querySelectorAll("#u-list [data-del]").forEach(b => { let armed = false; b.onclick = () => {
      if (!armed) { armed = true; b.textContent = "Tap again to remove"; setTimeout(() => { armed = false; b.textContent = "Remove"; }, 4000); return; }
      again(() => api(`app_users?email=eq.${encodeURIComponent(b.dataset.del)}`, {method: "DELETE", prefer: "return=minimal"})); }; });
  };
  el.querySelector("[data-umore]")?.addEventListener("click", e => { S.uMore = true; el.querySelectorAll("[data-ur][hidden]").forEach(x => x.hidden = false); e.target.closest("button").remove(); });
  el.querySelectorAll("[data-ur]").forEach(b => b.onclick = () => { S.uRole = b.dataset.ur; S.uPage = 1;
    el.querySelectorAll("[data-ur]").forEach(x => x.setAttribute("aria-selected", x === b)); drawUsers(); });
  el.querySelector("#u-ch").onchange = e => { S.uCh = e.target.value; S.uPage = 1; drawUsers(); };
  el.querySelector("#u-q").oninput = e => { S.uQ = e.target.value; S.uPage = 1; drawUsers(); };
  el.querySelector("#u-add-tg").onclick = () => userDialog(null);
  const change = email => userDialog(users.find(x => x.email === email));
  // One popup to add someone or change them: main role, an optional second role (Pastor), and the pastor name when needed.
  function userDialog(u) {
    document.querySelectorAll(".modal").forEach(m => m.remove());
    const two = r => ["admin", "lead", "tech_admin"].includes(r), noChurch = r => ["admin", "bishop", "tech_admin"].includes(r);
    const role0 = roleName(u) === "Lead pastor" ? "lead_pastor" : roleName(u) === "Tech admin" ? "tech_admin" : roleName(u) === "Shepherd" ? "shepherd" : roleName(u) === "Reverend" ? "reverend" : u?.role || "team", second0 = u && two(u.role) && u.pastor && role0 !== "lead_pastor" ? (u.role3 === "Reverend" ? "reverend" : "pastor") : "";
    const d = document.createElement("div"); d.className = "modal";
    d.innerHTML = `<form class="sheet narrow" role="dialog" aria-modal="true" aria-label="${u ? "Change sign-in" : "Add a person"}">
      <div class="card-head"><h2>${u ? `Change ${esc(u.name || u.email)}` : "Add a person"}</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
      <div class="fields">
        <div><label class="f" for="ud-email">Email</label><input class="in" id="ud-email" type="email" value="${esc(u?.email || "")}" ${u ? "readonly" : "required"} autocomplete="off" placeholder="name@example.com"></div>
        <div><label class="f" for="ud-name">Name</label><input class="in" id="ud-name" maxlength="80" value="${esc(u?.name || "")}" autocomplete="off" placeholder="e.g. Grace Mensah"></div>
        <div><label class="f" for="ud-role">Role 1 (main role)</label><select class="in" id="ud-role">${ROLE_OPTS.map(([v, t]) => `<option value="${v}" ${v === role0 ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
        <div id="ud-2-wrap"><label class="f" for="ud-2">Role 2</label><select class="in" id="ud-2"><option value="">None</option><option value="pastor" ${second0 === "pastor" ? "selected" : ""}>Pastor (can switch to Pastor view)</option><option value="reverend" ${second0 === "reverend" ? "selected" : ""}>Reverend (can switch to Reverend view)</option></select></div>
        <div id="ud-p-wrap"><label class="f" for="ud-p" id="ud-p-lab">Their name on the Pastors list</label><input class="in" id="ud-p" list="ud-p-list" autocomplete="off" value="${esc(u?.pastor || "")}" placeholder="e.g. Pastor Grace Mensah or Shepherd Kofi Asante">
          <datalist id="ud-p-list">${pnames.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
          <p class="note" style="margin:6px 2px 0" id="ud-p-note">Must match the Pastors list exactly: it decides whose people they see.</p></div>
        <div id="ud-c-wrap"><label class="f" for="ud-c">Church</label><select class="in" id="ud-c">${S.churches.map(c => `<option ${c === (u?.church || S.church) ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
      </div>
      <div class="msg bad" id="ud-err" hidden></div>
      <div class="modal-foot"><button type="button" class="pill-btn" data-x>Cancel</button><button class="pill-btn primary" id="ud-go">${u ? "Save" : "Add person"}</button></div></form>`;
    document.body.append(d);
    const $ = id => d.querySelector("#" + id), close = () => { d.remove(); document.removeEventListener("keydown", onKey); }, onKey = e => { if (e.key === "Escape") close(); };
    d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
    document.addEventListener("keydown", onKey);
    const sync = () => {
      const r = $("ud-role").value, needP = r === "pastor" || r === "reverend" || r === "shepherd" || r === "lead_pastor" || (two(r) && !!$("ud-2").value);
      const shep = r === "shepherd";  // a shepherd goes by the Name above (no separate box) and is added to the Shepherds list on saving
      $("ud-2-wrap").hidden = !two(r); $("ud-p-wrap").hidden = !needP || shep; $("ud-p").required = needP && !shep; $("ud-c-wrap").hidden = noChurch(r);
      $("ud-name").required = shep;
      // the names to pick from: the chosen church's Pastors list only (every church's for a role with no church)
      const ch = noChurch(r) ? "" : $("ud-c").value, from = ch ? (S.pastorList?.[ch] || []) : pnames;
      $("ud-p-list").innerHTML = from.map(n => `<option value="${esc(n)}">`).join("");
      $("ud-p-note").textContent = ch ? (from.length ? `Pick from ${ch}'s Pastors list: it decides whose people they see.` : `${ch} has no Pastors list yet. Add them on the Pastors page first, or type their name exactly.`)
        : "Must match a Pastors list exactly: it decides whose people they see.";
    };
    $("ud-role").onchange = $("ud-2").onchange = $("ud-c").onchange = sync; sync();
    (u ? $("ud-name") : $("ud-email")).focus();
    d.querySelector("form").onsubmit = async e => {
      e.preventDefault();
      const go = $("ud-go"), err = $("ud-err"), pick = $("ud-role").value, r = pick === "lead_pastor" ? "lead" : pick === "tech_admin" ? "admin" : pick === "shepherd" || pick === "reverend" ? "pastor" : pick, needP = pick === "pastor" || pick === "reverend" || pick === "shepherd" || pick === "lead_pastor" || (two(pick) && !!$("ud-2").value);
      const title = pick === "lead_pastor" ? "Lead pastor" : pick === "tech_admin" ? "Tech admin" : pick === "shepherd" ? "Shepherd" : pick === "reverend" ? "Reverend" : null;
      const r3 = two(pick) && $("ud-2").value === "reverend" ? "Reverend" : null;  // Role 2 as a Reverend
      const more = {...(title || u?.title ? {title} : {}), ...(r3 || u?.role3 ? {role3: r3} : {})};  // only sent when used, so it works before the new setup SQL
      const email = $("ud-email").value.trim().toLowerCase(), name = $("ud-name").value.trim().replace(/\s+/g, " ").slice(0, 80);
      const keep = pick === "shepherd" && u?.title === "Shepherd" && u.pastor;  // an existing shepherd keeps the name their people are given under
      const pastor = !needP ? "" : (pick === "shepherd" ? (keep || name) : fullTitle($("ud-p").value)).replace(/\s+/g, " ").replace(/,/g, " ").trim(), church = noChurch(r) ? null : $("ud-c").value;
      const fail = t => { err.textContent = t; err.hidden = false; go.disabled = false; };
      if (!u) { const wrong = emailProblem(email); if (wrong) return fail(wrong); if (users.some(x => x.email === email)) return fail("That email can already sign in. Use Change on their row instead."); }
      if (needP && !pastor) return fail(pick === "shepherd" ? "Type their name." : "Type their name as it is on the Pastors list.");
      { const plist = church ? (S.pastorList?.[church] || []) : [];  // a pastor name from another church's list would show the wrong people
        if (needP && pick !== "shepherd" && plist.length && !plist.some(n => norm(n) === norm(pastor)))
          return fail(`${pastor} isn't on ${church}'s Pastors list. Pick a name from the list, or add them on the Pastors page first.`); }
      go.disabled = true; err.hidden = true;
      try {
        if (u) {
          const rows = await api(`app_users?email=eq.${encodeURIComponent(u.email)}`, {method: "PATCH", prefer: "return=representation", body: {name: name || null, role: r, church, pastor: pastor || null, ...more}});
          if (!rows?.length) throw new Error("Not saved. Check you are still signed in as an admin.");
          log("role_change", "", "done", `${u.email}: ${name ? name + " · " : ""}${title || r}${pastor && r !== "pastor" && !title ? (r3 ? " + Reverend" : " + pastor") : ""}${church ? " · " + church : ""}`);
          toast("Saved. They will see the change next time they open the app.");
        } else {
          await api("app_users", {method: "POST", prefer: "return=minimal", body: {email, name: name || null, role: r, church, ...(pastor ? {pastor} : {}), ...more}});
          toast(`Added. ${name || email} can now sign in with ${email}.`);
        }
        if (pick === "shepherd" && church) {  // put them on that church's Shepherds list if they aren't on it yet
          const have = (S.shepherdList ??= {})[church] || [];
          if (!have.some(n => norm(n) === norm(pastor))) {
            const next = [...have, pastor];
            await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key: "shepherds:" + church, value: next.join("\n")}})
              .then(() => { S.shepherdList[church] = next; }).catch(() => toast(`Saved, but ${pastor} couldn't be added to the Shepherds list. Add them on the Shepherds page.`));
          }
        }
        close(); render();
      } catch (ex) { fail(/duplicate|already exists|23505/i.test(ex.message) ? "That email can already sign in." : /title|column/i.test(ex.message) ? `${title || (r3 ? "Reverend" : "This role")} needs the latest setup SQL: run it in Supabase once, then try again.` : ex.message); }
    };
  }
  drawUsers();
  const ib = el.querySelector("#inbox-all"); if (ib) ib.onclick = () => { S.inboxAll = !S.inboxAll; render(); };
  el.querySelectorAll("[data-done]").forEach(b => b.onclick = async () => {
    try { await api(`help_messages?id=eq.${b.dataset.done}`, {method: "PATCH", prefer: "return=minimal", body: {done: b.dataset.v === "true"}}); render(); }
    catch (err) { toast("Not saved: " + err.message); } });
  el.querySelectorAll("[data-mdel]").forEach(b => { let armed = false; b.onclick = async () => {
    if (!armed) { armed = true; b.textContent = "Tap again to delete"; setTimeout(() => { armed = false; b.textContent = "Delete"; }, 4000); return; }
    try { await api(`help_messages?id=eq.${b.dataset.mdel}`, {method: "DELETE", prefer: "return=minimal"}); toast("Deleted."); render(); }
    catch (err) { toast("Not deleted: " + err.message); } }; });
}

// ---------------------------------------------------------------- a pastor's home: only their own people
function mine(el) {
  const hasBac = (S.bacList || []).some(b => b.active && b.church === S.church && bacMine(b));  // their people's Bacenta column
  const p = picture(), me = S.me.pastor || "", list = p.people.filter(x => !me || careOf(x).some(n => norm(n) === norm(me))).sort(byName);
  const came = list.filter(x => p.here[x.id]), need = list.filter(x => x.level !== "ok");
  const message = (o = {}) => {
    if (o.day && !p.dates.includes(o.day)) return null;
    const q = o.day && o.day !== p.last ? picture(o.day) : p, l = q.people.filter(x => list.some(y => y.id === x.id)).sort(byName);
    const c = l.filter(x => q.here[x.id]), not = l.filter(x => !q.here[x.id]), n = l.filter(x => x.level !== "ok");
    const out = [`*${me || "My people"}*`, q.last ? nice(q.last, true) : "", "", ["✅", `Came: *${c.length} of ${l.length}*`]];
    if (c.length) out.push(c.map(x => x.full_name).join(", "));
    if (not.length) out.push("", ["🙏", "Not there:"], not.map(x => x.full_name).join(", "));
    if (n.length) out.push("", ["📞", "Please call:"], ...n.map(x => `- ${x.full_name} (${x.missed} missed${x.phone ? ", " + x.phone : ""})`));
    return wa(out);
  };
  el.innerHTML = head("", p.last ? `${esc(svcName(p.last))} · ${esc(nice(p.last, true))}` : "No services recorded yet",
    `<button class="pill-btn" id="wa">Message for WhatsApp</button><button class="pill-btn primary" data-go="checkin">${svg("checkin")}Check people in</button>`) + `
    <div id="bac-home"></div>
    <div class="tiles"><div class="card tile"><div class="label">Your people</div><div class="num">${list.length}</div></div>
      <div class="card tile"><div class="label">Came</div><div class="num">${came.length}</div></div>
      <div class="card tile"><div class="label">Not there</div><div class="num">${list.length - came.length}</div></div>
      <div class="card tile"><div class="label">Need a call</div><div class="num">${need.length}</div></div></div>
    <div class="card"><div class="card-head"><h2>Your people</h2></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Came</th><th>Sunday</th><th>Missed in a row</th>${hasBac ? "<th>Bacenta</th>" : ""}<th>Phone</th></tr></thead><tbody>
      ${list.slice().sort((a, b) => (b.level !== "ok") - (a.level !== "ok") || b.missed - a.missed || byName(a, b)).map(x => `<tr><td>${whoBtn(x)}</td><td>${p.here[x.id] ? "Yes" : `<span class="muted">No</span>`}</td><td>${badge(x.flag)}</td><td>${x.missed}</td>${hasBac ? `<td data-bacst="${esc(x.id)}"><span class="muted">…</span></td>` : ""}
        <td>${x.phone ? `<a href="tel:${esc(x.phone.replace(/[^0-9+]/g, ""))}">${esc(x.phone)}</a>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="empty">${me ? `Nobody is assigned to ${esc(me)} yet. Ask your church admin.` : "Your sign-in isn't linked to a pastor name yet. Ask your church admin."}</p>`}</div>`;
  el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { S.view = b.dataset.go; render(); });
  el.querySelector("#wa").onclick = () => waDialog("Message for WhatsApp", message, {day: p.last || today()});
  bacHome(el.querySelector("#bac-home"), el);  // their Bacenta first, and their people's Bacenta follow-up
}
// Home for a shepherd or pastor: a card for each Bacenta they're on, above the Sunday numbers. When it meets, how the last
// meeting went, weeks not filled in, who needs a call, and Take attendance.
async function bacHome(box, page) {
  const mineBs = (S.bacList || []).filter(b => b.active && b.church === S.church && bacMine(b));
  if (!box || !mineBs.length) return;
  const since = dayShift(today(), -91), ids = mineBs.map(b => b.id).join(",");
  const [ticks, gticks, skips, guests] = await Promise.all([
    all(`bacenta_ticks?select=bacenta,meeting_date,member_id&bacenta=in.(${ids})&meeting_date=gte.${since}`).catch(() => []),
    all(`bacenta_guest_ticks?select=bacenta,meeting_date,guest&bacenta=in.(${ids})&meeting_date=gte.${since}`).catch(() => []),
    all(`bacenta_skips?select=bacenta,meeting_date&bacenta=in.(${ids})&meeting_date=gte.${since}`).catch(() => []),
    all(`bacenta_guests?select=id,bacenta&bacenta=in.(${ids})&member_id=is.null`).catch(() => [])]);
  if (!box.isConnected) return;
  const open = new Set(guests.map(g => g.id)), all_ = [...ticks, ...gticks.filter(t => open.has(t.guest)).map(t => ({...t, member_id: "g:" + t.guest}))];
  const monday = d => dayShift(d, -((new Date(d + "T12:00:00").getDay() + 6) % 7)), thisMon = monday(today()), dow = new Date().getDay();
  box.innerHTML = mineBs.map(b => {
    const t = all_.filter(x => x.bacenta === b.id), held = [...new Set(t.map(x => x.meeting_date))].sort(), last = held[held.length - 1];
    const from = String(b.created_at || "").slice(0, 10);
    const missing = b.meet_day == null ? 0 : [1, 2, 3, 4, 5, 6, 7, 8].filter(i => { const mon = dayShift(thisMon, -7 * i), sun = dayShift(mon, 6);
      return !(from && sun < from) && mon >= since && !t.some(x => x.meeting_date >= mon && x.meeting_date <= sun) && !skips.some(x => x.bacenta === b.id && x.meeting_date >= mon && x.meeting_date <= sun); }).length;
    // its people: who came in the last 3 months, and its Bacenta-only people; 3 missed in a row needs a call
    const ppl = new Set([...t.map(x => x.member_id), ...guests.filter(g => g.bacenta === b.id).map(g => "g:" + g.id)]);
    const call = [...ppl].filter(id => { const lastCame = t.filter(x => x.member_id === id).map(x => x.meeting_date).sort().pop() || ""; return held.filter(d => d > lastCame).length >= 3; }).length;
    const tonight = b.meet_day === dow, doneToday = t.some(x => x.meeting_date === today());
    const when = b.meet_day == null ? "" : tonight ? (doneToday ? "Met today" : "Meets today") : `Meets ${DAYS[b.meet_day]}s`;
    return `<div class="card" style="margin-bottom:14px${tonight && !doneToday ? ";border:1px solid var(--accent)" : ""}"><div class="card-head"><span class="hico" style="width:34px;height:34px;--wc:var(--h3);--wb:var(--h3b)">${svg("bacentas")}</span><h2>${esc(b.name)}</h2><span class="gap"></span>
        <button type="button" class="pill-btn ${tonight && !doneToday ? "primary" : ""} sm" data-bctake="${esc(b.id)}">${svg("checkin")}Take attendance</button></div>
      <p class="note" style="margin:0 2px 10px">${[when, last ? `Last met ${esc(nice(last))}: ${new Set(t.filter(x => x.meeting_date === last).map(x => x.member_id)).size} came` : "No meetings yet", `${ppl.size} ${ppl.size === 1 ? "person" : "people"}`].filter(Boolean).join(" · ")}</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${missing ? `<span class="badge yellow">${missing} ${missing === 1 ? "week" : "weeks"} not filled in</span>` : b.meet_day != null ? `<span class="badge ok">Attendance up to date</span>` : ""}
        ${call ? `<span class="badge red">${call} ${call === 1 ? "needs" : "need"} a call</span>` : ppl.size ? `<span class="badge ok">Nobody to call</span>` : ""}
        <button type="button" class="pill-btn sm" data-bcpage="${esc(b.id)}">Follow-up and details</button></div></div>`;
  }).join("");
  // their assigned people's Bacenta follow-up, in the Bacenta column (separate from Sunday): came last time, missed in a row, or never
  page?.querySelectorAll("[data-bacst]").forEach(td => {
    const id = td.dataset.bacst, at = mineBs.map(b => { const t = all_.filter(x => x.bacenta === b.id), mineT = t.filter(x => x.member_id === id).map(x => x.meeting_date).sort();
      if (!mineT.length) return null; const held = [...new Set(t.map(x => x.meeting_date))]; return held.filter(d => d > mineT[mineT.length - 1]).length; }).filter(n => n !== null);
    const n = at.length ? Math.min(...at) : null;
    td.innerHTML = n === null ? `<span class="muted" title="Not been to your Bacenta in the last 3 months">Not coming</span>` : n === 0 ? `<span class="badge ok">Came last time</span>`
      : n >= 3 ? `<span class="badge red">Missed ${n}</span>` : n === 2 ? `<span class="badge yellow">Missed 2</span>` : `<span class="badge blue">Missed 1</span>`;
  });
  box.querySelectorAll("[data-bctake]").forEach(x => x.onclick = () => { const b = mineBs.find(y => y.id === x.dataset.bctake); takeBacenta(b.id, b.meet_day === dow ? today() : bacLastDay(b) || today()); });
  box.querySelectorAll("[data-bcpage]").forEach(x => x.onclick = () => { S.bacenta = x.dataset.bcpage; S.view = "bacentas"; render(); });
}

// ---------------------------------------------------------------- pastors: each pastor's people
function careGroups(el, K) {  // the Pastors and Shepherds pages: each one's people, who came, who needs a call, and the list of names
  const NONE = "Not assigned yet", p = picture(), p0 = p, groups = {};
  for (const x of p.people) for (const n of K.of(x).length ? K.of(x) : [NONE]) (groups[n] ??= []).push(x);
  const plist = K.list()[S.church] || [], canEdit = S.me.role !== "team";
  // pastor names written another way (Rev., Pst., LP...) in any church: an admin can tidy them all at once
  const untidy = K.key === "pastors:" && S.me.role === "admin" && !S.preview ? new Set([...Object.values(S.pastorList || {}).flat(), ...S.members.flatMap(pastorsOf)].filter(n => fullTitle(n) !== n)).size : 0;
  for (const n of plist) groups[n] ??= [];  // names on the list show even before anyone is assigned to them
  const names = Object.keys(groups).sort((a, b) => (a === NONE) - (b === NONE) || a.localeCompare(b));
  if (!names.includes(S[K.sel])) S[K.sel] = names[0] || "";
  const list = (groups[S[K.sel]] || []).slice().sort(byName), came = list.filter(x => p.here[x.id]), need = list.filter(x => x.level !== "ok");
  const message = (o = {}) => {
    if (o.day && !p0.dates.includes(o.day)) return null;
    const p = o.day && o.day !== p0.last ? picture(o.day) : p0;
    const list = p.people.filter(x => S[K.sel] === NONE ? !K.of(x).length : K.of(x).includes(S[K.sel])).sort(byName), came = list.filter(x => p.here[x.id]), need = list.filter(x => x.level !== "ok");
    const out = [`*${S[K.sel]} · your people*${S.emoji ? " ⛪" : ""}`, p.last ? nice(p.last, true) : "", "", ["✅", `Came: *${came.length} of ${list.length}*`]];
    if (came.length) out.push(came.map(x => x.full_name).join(", "));
    const not = list.filter(x => !p.here[x.id]);
    if (not.length) out.push("", ["🙏", "Not there:"], not.map(x => x.full_name).join(", "));
    if (need.length) out.push("", ["📞", "Please call:"], ...need.map(x => `- ${x.full_name} (${x.missed} missed${x.phone ? ", " + x.phone : ""})`));
    return wa(out);
  };
  el.innerHTML = head(K.words, esc(S.church),
    S[K.sel] && S[K.sel] !== NONE ? `<button class="pill-btn" id="wa">Message for WhatsApp</button>` : "") + `
    ${names.length ? `<div class="card" style="margin-bottom:14px"><div class="scroll"><table><thead><tr><th>${K.word}</th><th>People</th><th>Came${p.last ? " · " + esc(nice(p.last)) : ""}</th><th>Need a call</th></tr></thead><tbody>
      ${names.map(n => { const g = groups[n]; return `<tr><td><button class="who ${n === S[K.sel] ? "sel" : ""}" data-pastor="${esc(n)}"><span>${esc(initials(n))}</span>${esc(shortTitle(n))}</button></td>
        <td>${g.length}</td><td>${g.filter(x => p.here[x.id]).length}</td><td>${g.filter(x => x.level !== "ok").length}</td></tr>`; }).join("")}</tbody></table></div></div>
    <div class="card" id="pastor-people" style="scroll-margin-top:12px"><div class="card-head"><h2>${esc(shortTitle(S[K.sel]))}</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${list.length} ${list.length === 1 ? "person" : "people"}</span></div>
      <div class="scroll"><table><thead><tr><th>Name</th>${canEdit ? "<th></th>" : ""}<th>Came</th><th>Status</th><th>Missed in a row</th><th>Phone</th></tr></thead><tbody>
      ${list.map(x => `<tr><td>${whoBtn(x)}</td>${canEdit ? `<td><button class="pill-btn sm" data-edit="${esc(x.id)}" aria-label="Edit ${esc(x.full_name)}">${svg("edit")}Edit</button></td>` : ""}<td>${p.here[x.id] ? "Yes" : `<span class="muted">No</span>`}</td><td>${badge(x.flag)}</td><td>${x.missed}</td><td class="muted">${esc(x.phone || "")}</td></tr>`).join("")}
      </tbody></table></div>
      ${list.length ? "" : `<p class="empty">Nobody is assigned to ${esc(S[K.sel])} yet.</p>`}
      </div>`
      : `<p class="empty">Nobody on this register yet.</p>`}
    ${canEdit ? `<div class="card plist" id="plist"><div class="pl-head"><span class="pl-ico">${svg(K.view)}</span><div><h2>${K.word} list</h2><p>${esc(S.church)} · ${plist.length} ${plist.length === 1 ? "name" : "names"}</p></div><span class="gap"></span>
        <button type="button" class="pill-btn sm primary" id="pl-add">${svg("plus")}Add ${K.word.toLowerCase()}</button></div>
      ${untidy ? `<div class="msg np-fix"><span><b>${untidy} pastor ${untidy === 1 ? "name is" : "names are"} written a different way</b> (Rev. or Pst. instead of Reverend or Pastor).</span>
        <button type="button" class="pill-btn primary sm" id="pl-tidy">Tidy titles</button></div>` : ""}
      <label class="find-bar pl-find">${svg("search")}<input id="pl-q" type="search" placeholder="Search ${K.words.toLowerCase()} by name" value="${esc(S[K.sel + "Q"] || "")}" autocomplete="off" aria-label="Search ${K.words.toLowerCase()}"></label>
      <div class="pl-chips" id="pl-chips"></div><div id="pl-rows"></div></div>` : ""}`;
  // The list of names: search, title chips (Bishop, Reverend, Lady Pastor...), and a row for each name with how many people they have.
  const listBox = el.querySelector("#plist");
  el.querySelector("#pl-tidy")?.addEventListener("click", async e => {
    e.target.disabled = true;
    try { const r = await api("rpc/app_tidy_titles", {method: "POST", body: {}}); await load();
      toast(`Tidied: ${r.lists} ${r.lists === 1 ? "list" : "lists"}, ${r.people} ${r.people === 1 ? "person" : "people"}, ${r.signins} ${r.signins === 1 ? "sign-in" : "sign-ins"}.`); render(); }
    catch (err) { e.target.disabled = false; toast(/app_tidy_titles|function/i.test(err.message) ? "Run the latest setup SQL in Supabase once, then try again." : "Not tidied: " + err.message); }
  });
  if (listBox) {
    const TITLES_ = ["Lady Pastor", "Bishop", "Reverend", "Apostle", "Prophet", "Evangelist", "Elder", "Deacon", "Pastor"];
    const titleOf = n => TITLES_.find(t => norm(n).startsWith(norm(t) + " ")) || "Other";
    const titles = [...new Set(plist.map(titleOf))].sort((a, b) => TITLES_.indexOf(a) - TITLES_.indexOf(b));
    if (S[K.sel + "T"] && !titles.includes(S[K.sel + "T"])) S[K.sel + "T"] = "";
    const save = async out => {
      try { await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key: K.key + S.church, value: out.join("\n")}}); }
      catch (err) { throw new Error(/settings|policy|permission/i.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
      K.list()[S.church] = out; render();
    };
    const clean = x => fullTitle(x.replace(/,/g, " ")).slice(0, 80);  // "Rev. Ama Mensah" is saved as "Reverend Ama Mensah"
    const drawList = () => {
      const q = norm(S[K.sel + "Q"] || ""), rows = plist.filter(n => (!S[K.sel + "T"] || titleOf(n) === S[K.sel + "T"]) && (!q || norm(n).includes(q)));
      el.querySelector("#pl-chips").innerHTML = titles.length > 1 ? [["", "All"], ...titles.map(t => [t, t === "Other" ? "Other" : t])].map(([v, t]) =>
        `<button type="button" class="pl-chip ${(S[K.sel + "T"] || "") === v ? "on" : ""}" data-plt="${esc(v)}">${esc(t)}${v ? ` <span>${plist.filter(n => titleOf(n) === v).length}</span>` : ""}</button>`).join("") : "";
      el.querySelector("#pl-rows").innerHTML = rows.length ? rows.map(n => { const g = groups[n] || [], h = hueOf(n);
        return `<div class="pl-row ${n === S[K.sel] ? "sel" : ""}"><button type="button" class="pl-main" data-pl="${esc(n)}" title="See ${esc(n)}'s people">
          <span class="pl-ava" style="background:var(--h${h}b);color:var(--h${h}t)">${esc(initials(n))}</span>
          <span class="pl-txt"><b>${esc(shortTitle(n))}</b><small><span>${svg("people")}${g.length} ${g.length === 1 ? "person" : "people"}</span><span>${svg("checkin")}${g.filter(x => p.here[x.id]).length} came</span>${g.filter(x => x.level !== "ok").length ? `<span class="warn">${svg("followup")}${g.filter(x => x.level !== "ok").length} need a call</span>` : ""}</small></span></button>
          <button type="button" class="icon-btn sm" data-pledit="${esc(n)}" aria-label="Rename or remove ${esc(n)}">${svg("edit")}</button>${svg("next")}</div>`; }).join("")
        : `<p class="empty">${plist.length ? `No ${K.word.toLowerCase()} matches that.` : `No ${K.words.toLowerCase()} on the list yet. Tap Add ${K.word.toLowerCase()}.`}</p>`;
    };
    listBox.onclick = e => {
      const c = e.target.closest("[data-plt]"); if (c) { S[K.sel + "T"] = c.dataset.plt; drawList(); return; }
      const ed = e.target.closest("[data-pledit]");
      if (ed) { const old = ed.dataset.pledit; return formDialog(`Change ${old}`, [{k: "name", label: `Name on the ${K.words} list`, value: old, required: true, hint: "Renaming here changes the list only. People assigned under the old name keep it until you change them."}],
        async v => { const n = clean(v.name); if (!n || n === old) return; if (plist.some(x => x !== old && norm(x) === norm(n))) throw new Error(`${n} is already on the list.`);
          await save(plist.map(x => x === old ? n : x)); toast("Saved."); }, "Save",
        {label: "Remove from list", confirm: "Tap again to remove", run: async () => { await save(plist.filter(x => x !== old)); toast(`${old} removed from the list.`); }}); }
      const r = e.target.closest("[data-pl]"); if (r) { S[K.sel] = r.dataset.pl; S.pastorJump = true; render(); }
    };
    el.querySelector("#pl-q").oninput = e => { S[K.sel + "Q"] = e.target.value; drawList(); };
    el.querySelector("#pl-add").onclick = () => formDialog(`Add a ${K.word.toLowerCase()}`, [{k: "name", label: "Full name with title", value: "", required: true, hint: K.eg}],
      async v => { const n = clean(v.name); if (!n) return; if (plist.some(x => norm(x) === norm(n))) throw new Error(`${n} is already on the list.`);
        await save([...plist, n]); toast(`${n} added.`); }, "Add");
    drawList();
  }
  el.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editPerson(S.members.find(m => m.id === b.dataset.edit)));
  el.querySelectorAll("[data-pastor]").forEach(b => b.onclick = () => { S[K.sel] = b.dataset.pastor; S.pastorJump = true; render(); });
  if (S.pastorJump) { S.pastorJump = false; requestAnimationFrame(() => el.querySelector("#pastor-people")?.scrollIntoView({behavior: "smooth", block: "start"})); }  // straight to their people
  const btn = el.querySelector("#wa"); if (btn) btn.onclick = () => waDialog(`Message for ${S[K.sel]}`, message, {day: p.last || today()});
}

const CARE = {
  pastors: {view: "pastors", sel: "pastor", word: "Pastor", words: "Pastors", key: "pastors:", of: m => pastorsOf(m), list: () => S.pastorList,
            eg: "e.g. Pastor Grace Mensah, Lady Pastor Rita Kpodonu or Reverend Theodore Kpodonu"},
  shepherds: {view: "shepherds", sel: "shepherd", word: "Shepherd", words: "Shepherds", key: "shepherds:", of: m => shepherdsOf(m), list: () => (S.shepherdList ??= {}),
              eg: "e.g. Shepherd Kofi Asante"}};
const pastors = el => careGroups(el, CARE.pastors), shepherds = el => careGroups(el, CARE.shepherds);
// ---------------------------------------------------------------- Bacentas: cell groups that meet during the week
// Each Bacenta belongs to a church, has the name its shepherd picked, a shepherd from the Shepherds list and a pastor
// overseeing it. Its attendance is kept apart from services (bacenta_ticks), so it never changes Sunday numbers, follow-up
// or reports. Attendance is taken on Check-in (Service | Bacenta switch); the Bacentas page (under People) is for adding
// and editing them, follow-up, people's details and past meetings.
const bacentaSetup = e => /bacenta|relation|schema cache|function/i.test(e?.message || "") ? "Bacentas need the latest setup SQL: run it in Supabase once, then tap Refresh." : e?.message || "Something went wrong.";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayShift = (d, k) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + k); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const bacLastDay = x => { if (x.meet_day == null) return ""; const t = today(); return dayShift(t, -((new Date(t + "T12:00:00").getDay() - x.meet_day + 7) % 7)); };
// a Bacenta they shepherd, oversee, or were put on as leading or assisting
const bacMine = b => [b.shepherd, b.pastor].some(n => n && norm(n) === norm(S.me.pastor)) || (S.bacHelp || []).some(h => h.bacenta === b.id && h.email === S.me.email);
const bacAll = () => ["admin", "lead"].includes(S.me.base);  // admins and church admins see every Bacenta (of their church); everyone else only theirs
// the Bacentas this sign-in takes attendance for: admins and church admins, all of the church's; anyone else, only the ones they're on
const bacTickable = () => (S.bacList || []).filter(b => b.active && b.church === S.church && (bacAll() || bacMine(b)));
// Check-in opens on Bacenta on their Bacenta's usual day for someone on it (shepherd, pastor, leading or assisting); otherwise on Service
function ciDefaultMode() {
  const todays = !bacAll() && !S.preview ? bacTickable().find(b => b.meet_day === new Date().getDay()) : null;
  if (todays) { S.ciMode = "bacenta"; S.bacenta = todays.id; S.bcDate = today(); S.bcDateFor = todays.id; } else S.ciMode = "service";
}
// the switch at the top of Check-in (only when there's a Bacenta to take)
const ciSwitch = () => bacTickable().length ? `<div class="seg ci-seg ci-mode" role="group" aria-label="What are you checking in?" style="margin-bottom:14px">
    <button type="button" data-cimode="service" aria-pressed="${S.ciMode !== "bacenta"}">${svg("checkin")}Service</button>
    <button type="button" data-cimode="bacenta" aria-pressed="${S.ciMode === "bacenta"}">${svg("bacentas")}Bacenta</button></div>` : "";
const wireSwitch = el => el.querySelectorAll("[data-cimode]").forEach(b => b.onclick = () => { if (S.ciMode === b.dataset.cimode) return; S.ciMode = b.dataset.cimode; S.bcQ = ""; render(); });
// From the Bacentas page: open Check-in on Bacenta for this one, on this day
function takeBacenta(id, d) { S.ciMode = "bacenta"; S.ciModeKeep = true; S.bacenta = id; S.bcDate = d; S.bcDateFor = id; S.bcQ = ""; S.view = "checkin"; render(); scrollTo(0, 0); }

async function bacentas(el, mode = "manage") {
  const take = mode === "take", page = take ? "checkin" : "bacentas", title = take ? "Check-in" : "Bacentas";
  const canEdit = !take && ["admin", "lead"].includes(S.me.role) && !S.preview, shep = S.me.base === "pastor", lim = !bacAll();  // shep: a pastor or shepherd sign-in; lim: only their own Bacentas
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10), recent = new Date(Date.now() - 91 * 864e5).toISOString().slice(0, 10);
  el.innerHTML = head(title, esc(S.church)) + (take ? ciSwitch() : "") + `<p class="empty">Loading…</p>`;
  if (take) wireSwitch(el);
  let list, ticks, skips, people, guests, gticks, helpers, signins;
  try {
    [list, ticks, skips, people, guests, gticks, helpers, signins] = await Promise.all([
      all(`bacentas?select=id,church,name,shepherd,pastor,meet_day,active,created_at&church=eq.${encodeURIComponent(S.church)}&order=name`),
      all(`bacenta_ticks?select=bacenta,meeting_date,member_id&meeting_date=gte.${since}&order=meeting_date`),
      all(`bacenta_skips?select=bacenta,meeting_date,reason&meeting_date=gte.${since}`),
      // a shepherd or pastor gets only names (and type) for their church, plus details for their Bacentas' own people;
      // everyone else already has the church's people loaded
      shep ? api("rpc/app_bacenta_people", {method: "POST", body: {}}) : Promise.resolve(S.members.filter(m => churchOf(m) === S.church && ruleOf(m) !== "gone")),
      // Bacenta-only people: on a Bacenta's list but not on the church's register (yet)
      all("bacenta_guests?select=id,bacenta,full_name,phone,birthday,address,member_id,status,added_by&order=full_name").catch(() => []),
      all(`bacenta_guest_ticks?select=bacenta,meeting_date,guest&meeting_date=gte.${since}`).catch(() => []),
      api("rpc/app_bacenta_helpers", {method: "POST", body: {}}).catch(() => all("bacenta_helpers?select=bacenta,email,role")).catch(() => []),  // with names
      // who can be put on a Bacenta as leading or assisting: the church's sign-ins (admins and church admins see all anyway)
      canEdit ? api("rpc/app_church_signins", {method: "POST", body: {ch: S.church}}).catch(() => []) : Promise.resolve([])]);
  S.bacHelp = helpers;
  } catch (e) { if (S.view === page) el.innerHTML = head(title, esc(S.church)) + `<div class="msg bad">${esc(bacentaSetup(e))}</div>`; return; }
  if (S.view !== page || (take && S.ciMode !== "bacenta")) return;  // moved on while loading
  people = people || [];
  // Bacenta-only people sit beside the register's people (ids start "g:"), and their ticks beside the others, so every
  // list and count below includes them; only saving a tick goes to their own table
  const register = people.slice(), linked = guests.filter(g => g.member_id), open = new Set(guests.filter(g => !g.member_id).map(g => g.id));
  gticks = gticks.filter(t => open.has(t.guest));  // once linked, their check-ins are on the register entry
  people = [...people, ...guests.filter(g => !g.member_id).map(g => ({id: "g:" + g.id, gid: g.id, bacenta: g.bacenta, full_name: g.full_name, phone: g.phone, birthday: g.birthday, address: g.address, guest: true, pending: g.status === "pending", added_by: g.added_by}))];
  ticks = [...ticks, ...gticks.map(t => ({bacenta: t.bacenta, meeting_date: t.meeting_date, member_id: "g:" + t.guest}))];
  S.bacList = [...(S.bacList || []).filter(x => x.church !== S.church), ...list];  // keep the switch's list fresh
  // anyone but an admin or church admin only sees the Bacentas they're on (the database gives them no others anyway)
  if (lim) list = list.filter(bacMine);
  const shown = list.filter(b => b.active || S.bcHidden), hidden = list.filter(b => !b.active).length;
  const ids = new Set(list.map(b => b.id)); ticks = ticks.filter(t => ids.has(t.bacenta));
  const of = id => ticks.filter(t => t.bacenta === id), byId = Object.fromEntries(people.map(m => [m.id, m]));
  const skipOf = (id, d) => skips.find(s => s.bacenta === id && s.meeting_date === d);
  const meetings = id => { const o = {}; for (const t of of(id)) o[t.meeting_date] = (o[t.meeting_date] || 0) + 1; return Object.entries(o).sort((a, b) => b[0].localeCompare(a[0])); };
  // Bacentas meet every week, usually on their day, unless marked "Didn't meet". The day isn't fixed: a leader can move a
  // week's meeting to any day that week. So a week (Monday to Sunday) counts as filled in when it has ticks or a "Didn't meet"
  // on any of its days. A week is only called missing once it's over. The last 8 weeks are checked.
  const monday = d => dayShift(d, -((new Date(d + "T12:00:00").getDay() + 6) % 7));
  const inWeek = (d, mon) => d >= mon && d <= dayShift(mon, 6);
  const weeks = x => { if (x.meet_day == null || !x.active) return [];
    const from = String(x.created_at || "").slice(0, 10), out = [], thisMon = monday(today());
    for (let i = 1; i <= 8; i++) { const mon = dayShift(thisMon, -7 * i), d = dayShift(mon, (x.meet_day + 6) % 7);  // its usual day that week
      if (from && dayShift(mon, 6) < from) break;
      const skip = skips.find(s => s.bacenta === x.id && inWeek(s.meeting_date, mon));
      out.push({d, state: of(x.id).some(t => inWeek(t.meeting_date, mon)) ? "met" : skip ? "none" : "missing", reason: skip?.reason || ""}); }
    return out; };
  const missing = x => weeks(x).filter(w => w.state === "missing");
  // a Bacenta's people: whoever came to it in the last 3 months, and its Bacenta-only people. Being assigned to its shepherd
  // (Congregation) doesn't put someone on it: the Bacenta list is who comes.
  const membersOf = x => new Set([...of(x.id).filter(t => t.meeting_date >= recent).map(t => t.member_id),
    ...people.filter(m => m.guest && m.bacenta === x.id).map(m => m.id)]);
  const mine = list.filter(x => x.active && (!lim || bacMine(x)));  // the ones this sign-in can take
  // which Bacenta is open: on Check-in, one they can take (today's first); on the Bacentas page, any shown
  const pickFrom = take ? mine : shown;
  if (!pickFrom.some(x => x.id === S.bacenta)) S.bacenta = (pickFrom.find(x => x.meet_day === new Date().getDay()) || (lim && shown.find(bacMine)) || pickFrom[0])?.id || "";
  const b = list.find(x => x.id === S.bacenta), canTick = take && !!b && b.active && !S.preview && (!lim || bacMine(b));
  if (b && S.bcDateFor !== b.id) { S.bcDate = bacLastDay(b) || today(); S.bcDateFor = b.id; }  // opens on its latest usual day
  S.bcDate ||= today();
  const pastorOpts = () => { const names = [...new Set([...(S.pastorList?.[S.church] || []), ...list.map(x => x.pastor).filter(Boolean)])].sort();
    return [["", "Not set yet"], ...names.map(n => [n, shortTitle(n)])]; };
  const shepherdOpts = () => { const names = [...new Set([...(S.shepherdList?.[S.church] || []), ...list.map(x => x.shepherd).filter(Boolean)])].sort();
    return [["", "Not set yet"], ...names.map(n => [n, n])]; };
  const dayOpts = [["", "Not set yet"], ...DAYS.map((d, i) => [String(i), d])];
  // sign-ins to put on a Bacenta: the team and pastors of this church (admins and church admins already see every Bacenta)
  const helpOpts = signins.filter(u => !["admin", "lead"].includes(u.role)).map(u => [u.email, `${u.name || u.email} · ${roleName(u)}`]);
  const helpFields = x => helpOpts.length ? [
    {k: "leading", label: "Leading (besides the shepherd)", type: "multi", value: x ? helpOf(x, "leading").map(h => h.email) : [], options: helpOpts},
    {k: "assisting", label: "Assisting", type: "multi", value: x ? helpOf(x, "assisting").map(h => h.email) : [], options: helpOpts,
     hint: "Only the people ticked here (and its shepherd and pastor) see this Bacenta. Ushers who aren't on it see nothing of it."}] : [];
  const clean = v => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const short = d => nice(d);
  const nameOf = em => signins.find(u => u.email === em)?.name || helpers.find(h => h.email === em)?.name || em, helpOf = (x, r) => helpers.filter(h => h.bacenta === x.id && h.role === r);
  const helpLine = x => ["leading", "assisting"].map(r => { const hs = helpOf(x, r); return hs.length ? `${r === "leading" ? "Leading" : "Assisting"}: ${hs.map(h => h.email === S.me.email ? "you" : esc(nameOf(h.email))).join(", ")}` : ""; });
  const who = x => [x.meet_day != null ? "Meets " + DAYS[x.meet_day] + "s" : "", x.shepherd ? esc(shortTitle(x.shepherd)) : "No shepherd set", x.pastor ? esc(shortTitle(x.pastor)) : "", ...helpLine(x)].filter(Boolean).join(" · ");
  if (take) {  // ---- Check-in → Bacenta: pick the Bacenta and the day, then tick
    el.innerHTML = head("Check-in", esc(S.church)) + ciSwitch() + (b ? `
      <div class="card" id="bc-take" style="margin-bottom:14px">
        <div class="row">${mine.length > 1 ? `<div style="flex:1 1 260px;min-width:0"><label class="f" for="bc-pick">Bacenta</label><select class="in" id="bc-pick">${mine.map(x => `<option value="${esc(x.id)}" ${x.id === b.id ? "selected" : ""}>${esc(x.name)}${x.meet_day != null ? " · " + DAYS[x.meet_day] + "s" : ""}</option>`).join("")}</select></div>`
          : `<div><label class="f">Bacenta</label><div style="font-weight:600;padding:10px 2px">${esc(b.name)}</div></div>`}
          <div style="flex:0 0 170px"><label class="f" for="bc-d">Meeting date</label><input class="in" id="bc-d" type="date" value="${esc(S.bcDate)}" max="${today()}"></div>
          <div class="card tile" style="flex:0 0 140px;margin:0"><div class="label">Came</div><div class="num" id="bc-n">0</div></div></div>
        <p class="note" style="margin:8px 2px 0">${who(b)}</p>
        <div id="bc-miss" style="margin-top:12px"></div>
        <div id="bc-skip"></div>
        ${canTick ? "" : `<p class="note" style="margin:10px 2px">${S.preview ? esc(viewOnly()) : "Only this Bacenta's shepherd, its pastor and the church's leaders can take its attendance."}</p>`}
        <label class="find-bar" style="margin-top:12px">${svg("search")}<input id="bc-q" type="search" placeholder="Search ${esc(S.church)} by name to add someone" value="${esc(S.bcQ || "")}" autocomplete="off" aria-label="Search by name"></label>
        <div id="bc-names"></div>
        ${canTick ? `<div style="margin-top:12px"><button type="button" class="pill-btn sm" id="bc-new">${svg("plus")}Add someone new</button></div>` : ""}</div>
      <p class="note" style="margin:0 2px">Follow-up, people's details and past meetings are on the <button type="button" class="linkish" id="bc-manage" style="all:unset;cursor:pointer;color:var(--accent);font-weight:600">Bacentas page</button>.</p>`
      : `<p class="empty">No Bacentas to take here yet.</p>`);
    wireSwitch(el);
    el.querySelector("#bc-manage")?.addEventListener("click", () => { S.view = "bacentas"; render(); });
    el.querySelector("#bc-pick")?.addEventListener("change", e => { S.bacenta = e.target.value; S.bcQ = ""; S.bcDateFor = ""; render(); });
  } else {  // ---- the Bacentas page: the list, then the chosen one's follow-up, people and past meetings
    el.innerHTML = head("Bacentas", esc(S.church), canEdit ? `<button class="pill-btn primary" id="bc-add">${svg("plus")}Add a Bacenta</button>` : "") + `
    ${canEdit ? `<div id="bc-approve"></div>` : ""}
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>${esc(S.church)} Bacentas</h2><span class="gap"></span>
      ${hidden ? `<label class="check" style="font-size:13px"><input type="checkbox" id="bc-hid" ${S.bcHidden ? "checked" : ""}> Show hidden (${hidden})</label>` : ""}</div>
      ${shown.length ? `<div class="scroll"><table><thead><tr><th>Bacenta</th><th>Meets</th><th>Shepherd</th><th>Pastor</th><th>Last met</th><th>Came</th><th>People</th><th>Not filled in</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>
        ${shown.map(x => { const ms = meetings(x.id), last = ms[0], ppl = membersOf(x).size, miss = missing(x).length;
          return `<tr><td><button class="who ${x.id === S.bacenta ? "sel" : ""}" data-bc="${esc(x.id)}"><span>${esc(initials(x.name))}</span>${esc(x.name)}</button>${x.active ? "" : ` <small class="muted">Hidden</small>`}</td>
            <td>${x.meet_day != null ? esc(DAYS[x.meet_day] + "s") : `<span class="muted">Not set</span>`}</td>
            <td>${x.shepherd ? esc(shortTitle(x.shepherd)) : `<span class="muted">Not set</span>`}</td><td>${x.pastor ? esc(shortTitle(x.pastor)) : `<span class="muted">Not set</span>`}</td><td>${last ? esc(short(last[0])) : `<span class="muted">Not yet</span>`}</td><td>${last ? last[1] : ""}</td><td>${ppl}</td>
            <td>${x.meet_day == null ? `<span class="muted">Set its day</span>` : miss ? `<span class="badge yellow" title="Weeks in the last 8 (Monday to Sunday) with no attendance on any day and not marked Didn't meet">${miss} ${miss === 1 ? "week" : "weeks"}</span>` : `<span class="badge ok">Up to date</span>`}</td>
            ${canEdit ? `<td><button class="pill-btn sm" data-bcedit="${esc(x.id)}" aria-label="Edit ${esc(x.name)}">${svg("edit")}Edit</button></td>` : ""}</tr>`; }).join("")}</tbody></table></div>`
        : `<p class="empty">${list.length ? "All this church's Bacentas are hidden." : `No Bacentas in ${esc(S.church)} yet.${canEdit ? " Tap Add a Bacenta." : ""}`}</p>`}</div>
    ${b ? `<div class="card" id="bc-take" style="margin-bottom:14px;scroll-margin-top:12px"><div class="card-head"><h2>${esc(b.name)}</h2><span class="gap"></span>
        ${b.active && !S.preview && (!lim || bacMine(b)) ? `<button type="button" class="pill-btn primary sm" id="bc-go">${svg("checkin")}Take attendance</button>` : ""}</div>
      <p class="note" style="margin:0 2px 10px">${who(b)}</p><div id="bc-miss"></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Follow-up</h2><span class="gap"></span><span class="muted" style="font-size:13px">Missed the last meetings in a row</span></div><div id="bc-follow"></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>People in ${esc(b.name)}</h2><span class="gap"></span><span class="muted" style="font-size:13px">Came in the last 3 months, and its Bacenta-only people</span></div><div id="bc-people"></div></div>
    <div class="card"><div class="card-head"><h2>Past meetings</h2></div><div id="bc-past"></div></div>` : ""}`;
    // add, rename, set the shepherd, pastor and day, hide or show again
    const saveB = async (id, body) => {
      const help = body.help; delete body.help;
      const name = clean(body.name);
      if (body.name !== undefined && !name) throw new Error("Type the Bacenta's name.");
      if (name && list.some(x => x.id !== id && norm(x.name) === norm(name))) throw new Error(`${name} is already a Bacenta in ${S.church}.`);
      try {
        if (id) await api(`bacentas?id=eq.${id}`, {method: "PATCH", prefer: "return=minimal", body: {...body, ...(body.name !== undefined ? {name} : {})}});
        else { const nid = crypto.randomUUID(); await api("bacentas", {method: "POST", prefer: "return=minimal", body: {id: nid, church: S.church, name, shepherd: body.shepherd || null, pastor: body.pastor || null, meet_day: body.meet_day ?? null, active: true, created_at: new Date().toISOString()}}); S.bacenta = nid; S.bcQ = ""; id = nid; }
        if (help) {  // who's leading and assisting: replaced with what was ticked (leading wins if someone is ticked in both)
          const rows = [...help.leading.map(email => ({bacenta: id, email, role: "leading"})), ...help.assisting.filter(e => !help.leading.includes(e)).map(email => ({bacenta: id, email, role: "assisting"}))];
          await api(`bacenta_helpers?bacenta=eq.${id}`, {method: "DELETE", prefer: "return=minimal"});
          if (rows.length) await api("bacenta_helpers", {method: "POST", prefer: "return=minimal", body: rows});
        }
      } catch (e) { throw new Error(/duplicate|unique/i.test(e.message) ? `${name} is already a Bacenta in ${S.church}.` : bacentaSetup(e)); }
      S.bcDateFor = ""; render();
    };
    const dayOf = v => v === "" ? null : Number(v);
    const splitHelp = v => ({leading: (v.leading || "").split(",").map(x => x.trim()).filter(Boolean), assisting: (v.assisting || "").split(",").map(x => x.trim()).filter(Boolean)});
    el.querySelector("#bc-add")?.addEventListener("click", () => formDialog("Add a Bacenta", [
      {k: "name", label: "Bacenta name", value: "", required: true, hint: "The name its shepherd picked, e.g. Saved - City Bacenta"},
      {k: "meet_day", label: "Usually meets on", type: "select", value: "", options: dayOpts, hint: "Its usual day. A week's meeting can still be moved to any other day that week."},
      {k: "shepherd", label: "Shepherd", type: "select", value: "", options: shepherdOpts(), hint: "Names come from the Shepherds list. Add a new shepherd there first."},
      {k: "pastor", label: "Pastor overseeing it", type: "select", value: "", options: pastorOpts(), hint: "Names come from the Pastors list. One pastor can oversee several Bacentas."}, ...helpFields(null)],
      async v => { await saveB(null, {name: v.name, meet_day: dayOf(v.meet_day), shepherd: v.shepherd || null, pastor: v.pastor || null, help: helpOpts.length ? splitHelp(v) : null}); toast(`${clean(v.name)} added.`); }, "Add"));
    el.querySelectorAll("[data-bcedit]").forEach(btn => btn.onclick = () => { const x = list.find(y => y.id === btn.dataset.bcedit);
      formDialog(`Change ${x.name}`, [{k: "name", label: "Bacenta name", value: x.name, required: true},
        {k: "meet_day", label: "Usually meets on", type: "select", value: x.meet_day == null ? "" : String(x.meet_day), options: dayOpts},
        {k: "shepherd", label: "Shepherd", type: "select", value: x.shepherd || "", options: shepherdOpts()},
        {k: "pastor", label: "Pastor overseeing it", type: "select", value: x.pastor || "", options: pastorOpts()}, ...helpFields(x)],
        async v => { await saveB(x.id, {name: v.name, meet_day: dayOf(v.meet_day), shepherd: v.shepherd || null, pastor: v.pastor || null, help: helpOpts.length ? splitHelp(v) : null}); toast("Saved."); }, "Save",
        x.active ? {label: "Hide Bacenta", confirm: "Tap again to hide", run: async () => { await saveB(x.id, {active: false}); toast(`${x.name} is hidden. Its past attendance is kept.`); }}
          : {label: "Show again", confirm: "Tap again to show", run: async () => { await saveB(x.id, {active: true}); toast(`${x.name} is back.`); }}); });
    el.querySelector("#bc-hid")?.addEventListener("change", e => { S.bcHidden = e.target.checked; render(); });
    el.querySelectorAll("[data-bc]").forEach(btn => btn.onclick = () => { S.bacenta = btn.dataset.bc; S.bcQ = ""; render();
      requestAnimationFrame(() => document.getElementById("bc-take")?.scrollIntoView({behavior: "smooth", block: "start"})); });
    el.querySelector("#bc-go")?.addEventListener("click", () => takeBacenta(b.id, bacLastDay(b) || today()));
    // names added at a Bacenta by a shepherd, pastor or helper, waiting for a church admin to add them to the Congregation list
    const waiting = guests.filter(g => g.status === "pending" && !g.member_id && list.some(x => x.id === g.bacenta));
    S.bacPending = waiting.length;
    const ab = el.querySelector("#bc-approve");
    if (ab && waiting.length) {
      ab.innerHTML = `<div class="card" style="margin-bottom:14px;border:1px solid var(--h3)"><div class="card-head"><h2>Waiting to join the Congregation list</h2><span class="gap"></span><span class="muted" style="font-size:13px">${waiting.length} ${waiting.length === 1 ? "name" : "names"} added at a Bacenta</span></div>
        <div class="scroll"><table><thead><tr><th>Name</th><th>Bacenta</th><th>Phone</th><th>Added by</th><th></th></tr></thead><tbody>${waiting.map(g => `<tr>
          <td><b>${esc(g.full_name)}</b></td><td>${esc(list.find(x => x.id === g.bacenta)?.name || "")}</td><td>${g.phone ? esc(g.phone) : `<span class="muted">Not given</span>`}</td><td class="muted">${esc(g.added_by || "")}</td>
          <td style="white-space:nowrap"><button class="pill-btn sm primary" data-bcok="${esc(g.id)}">Add to Congregation</button> <button class="pill-btn sm" data-bclink="${esc(g.id)}" title="They're already on the Congregation list under their name">Already on it</button> <button class="pill-btn sm" data-bcno="${esc(g.id)}">Keep as Bacenta only</button></td></tr>`).join("")}</tbody></table></div>
        <p class="note" style="margin:10px 2px 0">They're already on their Bacenta's list either way. <b>Add to Congregation</b> puts them on the church's list with their Bacenta attendance. <b>Already on it</b> links them to their name there. <b>Keep as Bacenta only</b> leaves them off the church's list.</p></div>`;
      const done = msg => { S.bacPending = Math.max(0, waiting.length - 1); toast(msg); };  // the menu count, straight away
      ab.querySelectorAll("[data-bcok]").forEach(x => x.onclick = () => { const g = waiting.find(y => y.id === x.dataset.bcok);
        formDialog(`Add ${g.full_name} to the Congregation list`, [{k: "typ", label: "Attendance Type", type: "select", value: "visitor", options: typeOpts,
            hint: "Visitors are never flagged for missing Sundays. Change it later on Congregation when they start coming."}],
          async v => { try { await api("rpc/app_bacenta_review", {method: "POST", body: {g: g.id, ok: true, at_txt: isoLocal(), typ: v.typ}}); } catch (err) { throw new Error(bacentaSetup(err)); }
            await load(); done(`${g.full_name} is on the Congregation list now, with their Bacenta attendance.`); render(); }, "Add to Congregation"); });
      ab.querySelectorAll("[data-bcno]").forEach(x => x.onclick = async () => { const g = waiting.find(y => y.id === x.dataset.bcno); x.disabled = true;
        try { await api("rpc/app_bacenta_review", {method: "POST", body: {g: g.id, ok: false, at_txt: isoLocal()}}); } catch (err) { x.disabled = false; return toast("Not saved: " + bacentaSetup(err)); }
        done(`${g.full_name} stays on ${list.find(y => y.id === g.bacenta)?.name || "the Bacenta"} only.`); render(); });
    }
  }
  if (!b) return;
  const $ = s => el.querySelector(s);
  const pool = people.filter(m => !m.guest || m.bacenta === b.id);  // the church's people, and this Bacenta's own Bacenta-only people
  const onlyTag = m => m.pending ? `<small class="badge yellow" style="margin-left:6px" title="On this Bacenta's list; a church admin will approve adding them to the Congregation list">Waiting to join Congregation</small>`
    : m.guest ? `<small class="badge blue" style="margin-left:6px" title="Comes to this Bacenta; not on the church register yet">Bacenta only</small>` : "";
  const regular = membersOf(b);
  const here = () => new Set(of(b.id).filter(t => t.meeting_date === S.bcDate).map(t => t.member_id));
  const bday = v => { const d = new Date(String(v).slice(0, 10) + "T12:00:00"); return isNaN(d) ? String(v) : d.toLocaleDateString("en-NZ", {day: "numeric", month: "short"}); };
  const tel = m => m.phone ? `<a href="tel:${esc(String(m.phone).replace(/[^0-9+]/g, ""))}">${esc(m.phone)}</a>` : `<span class="muted">Not given</span>`;
  // a week to fill in or a past meeting: on Check-in it opens that day; on the Bacentas page it goes to Check-in for it
  const goDay = d => { if (!take) return takeBacenta(b.id, d); S.bcDate = d; $("#bc-d").value = d; S.bcQ = ""; $("#bc-q").value = ""; draw(); };
  const draw = () => {
    const now = here(), q = norm(S.bcQ || ""), skip = skipOf(b.id, S.bcDate);
    // weeks with nothing taken, each one tap away
    const miss = missing(b);
    $("#bc-miss").innerHTML = miss.length ? `<div class="msg" style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center"><b style="margin-right:4px">No attendance taken for the week of</b>${miss.map(w =>
      `<button type="button" class="pill-btn sm" data-bcday="${w.d}" title="Opens its usual day. If it met on another day that week, change the date.">${esc(short(w.d))}</button>`).join("")}</div>` : "";
    if (take) {
      // a week it didn't meet (holiday, combined service…): marked, so it isn't counted as missing
      $("#bc-skip").innerHTML = skip ? `<div class="msg" style="margin-top:12px;display:flex;align-items:center;gap:10px"><span><b>Didn't meet</b> on ${esc(nice(S.bcDate, true))}${skip.reason ? ": " + esc(skip.reason) : ""}</span><span class="gap" style="flex:1"></span>${canTick ? `<button type="button" class="pill-btn sm" id="bc-unskip">Undo</button>` : ""}</div>`
        : canTick && !now.size ? `<div style="margin-top:12px"><button type="button" class="pill-btn sm" id="bc-skipbtn">Didn't meet this week</button><p class="note" style="margin:8px 2px 0">Met on a different day this week? Change the date above, then tick people.</p></div>` : "";
      const names = q ? pool.filter(m => norm(m.full_name).includes(q)).slice(0, 40)
        : pool.filter(m => regular.has(m.id) || now.has(m.id));
      names.sort((x, y) => (now.has(y.id) - now.has(x.id)) || norm(x.full_name).localeCompare(norm(y.full_name)));
      $("#bc-n").textContent = now.size;
      $("#bc-names").innerHTML = skip && !now.size ? "" : names.length ? `<div class="names" style="margin-top:12px">${names.map(m => `<label class="name ${now.has(m.id) ? "on" : ""}"><input type="checkbox" data-bt="${esc(m.id)}" ${now.has(m.id) ? "checked" : ""} ${canTick ? "" : "disabled"}>
          <span class="nava" ${avaStyle(m.full_name)}>${esc(initials(m.full_name))}</span><span class="nn">${esc(m.full_name)}</span><small>${m.pending ? "Waiting to join Congregation" : m.guest ? "Bacenta only" : [m.type === "first_timer" ? "first-timer" : m.type === "visitor" ? "visitor" : "", isKid(m) ? "child" : ""].filter(Boolean).join(" · ")}</small></label>`).join("")}</div>`
        : `<p class="empty">${q ? "Nobody in " + esc(S.church) + " matches that. If they're new, tap Add someone new." : "Nobody yet. Search for a name above, or tap Add someone new."}</p>`;
      $("#bc-skipbtn")?.addEventListener("click", () => formDialog(`Didn't meet on ${nice(S.bcDate, true)}`, [
        {k: "reason", label: "Why (optional)", value: "", hint: "e.g. School holidays, or joined the Sunday service"}], async v => {
          const d = S.bcDate, reason = v.reason.slice(0, 120) || null;
          try { await api("bacenta_skips?on_conflict=bacenta,meeting_date", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {bacenta: b.id, meeting_date: d, reason}}); }
          catch (err) { throw new Error(bacentaSetup(err)); }
          skips = skips.filter(s => !(s.bacenta === b.id && s.meeting_date === d)).concat({bacenta: b.id, meeting_date: d, reason}); draw(); toast("Marked as didn't meet."); }, "Save"));
      $("#bc-unskip")?.addEventListener("click", async e => { e.target.disabled = true; const d = S.bcDate;
        try { await api(`bacenta_skips?bacenta=eq.${b.id}&meeting_date=eq.${d}`, {method: "DELETE", prefer: "return=minimal"});
          skips = skips.filter(s => !(s.bacenta === b.id && s.meeting_date === d)); draw(); }
        catch (err) { e.target.disabled = false; toast("Not saved: " + bacentaSetup(err)); } });
    } else {
      // follow-up: the Bacenta's people who missed its last meetings in a row (only weeks it met count)
      const held = meetings(b.id).map(([d]) => d), own = pool.filter(m => regular.has(m.id)).sort(byName);
      const fu = own.map(m => { const lastCame = of(b.id).filter(t => t.member_id === m.id).map(t => t.meeting_date).sort().pop() || "";
        return {...m, lastCame, row: held.filter(d => d > lastCame).length}; }).filter(m => m.row > 0).sort((x, y) => y.row - x.row || byName(x, y));
      const flag = n => n >= 3 ? `<span class="badge red">Needs a call</span>` : n === 2 ? `<span class="badge yellow">Check in</span>` : `<span class="badge blue">Missed the last one</span>`;
      $("#bc-follow").innerHTML = fu.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th></th><th>Missed in a row</th><th>Last came</th><th>Phone</th></tr></thead><tbody>${fu.map(m =>
        `<tr><td><span class="who"><span ${avaStyle(m.full_name)}>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</span>${onlyTag(m)}</td><td>${flag(m.row)}</td><td>${m.row}</td><td>${esc(short(m.lastCame))}</td><td>${tel(m)}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">${own.length ? "Everyone came to the last meeting." : "Nobody to follow up yet."}</p>`;
      // the Bacenta's own people with their phone, birthday and address
      const canLink = b.active && !S.preview && (!lim || bacMine(b));
      $("#bc-people").innerHTML = own.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Phone</th><th>Birthday</th><th>Address</th>${canLink && own.some(m => m.guest) ? "<th></th>" : ""}</tr></thead><tbody>${own.map(m =>
        `<tr><td><span class="who"><span ${avaStyle(m.full_name)}>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</span>${onlyTag(m)}${(() => { const g = linked.find(x => x.bacenta === b.id && x.member_id === m.id);
            return g ? ` <small class="muted">Linked from ${esc(g.full_name)}</small>${canLink ? ` <button class="pill-btn sm" data-bcunlink="${esc(g.id)}" style="white-space:nowrap" title="Picked the wrong name? Undo the link">Undo link</button>` : ""}` : ""; })()}</td><td>${tel(m)}</td>
          <td>${m.birthday ? esc(bday(m.birthday)) : `<span class="muted">Not given</span>`}</td><td>${m.address ? esc(m.address) : `<span class="muted">Not given</span>`}</td>
          ${canLink && own.some(x => x.guest) ? `<td>${m.guest ? `<button class="pill-btn sm" data-bclink="${esc(m.gid)}" style="white-space:nowrap" title="They're on the church register now: link them">Link to register</button>` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>
        ${own.some(m => m.guest) ? `<p class="note" style="margin:10px 2px 0"><b>Bacenta only</b> means they come to ${esc(b.name)} but aren't on the church register. When they start coming on Sundays and are added on Check-in, tap <b>Link to register</b> so their Bacenta attendance moves with them.</p>` : ""}`
        : `<p class="empty">Nobody has come to ${esc(b.name)} in the last 3 months yet.</p>`;
      // past meetings, and the weeks it didn't meet
      const can = b.active && !S.preview && (!lim || bacMine(b));
      const rows = [...meetings(b.id).map(([d, n]) => [d, String(n)]), ...skips.filter(s => s.bacenta === b.id).map(s => [s.meeting_date, "Didn't meet" + (s.reason ? ": " + s.reason : "")])]
        .sort((x, y) => y[0].localeCompare(x[0]));
      $("#bc-past").innerHTML = rows.length ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Came</th>${can ? "<th></th>" : ""}</tr></thead><tbody>${rows.slice(0, 26).map(([d, n]) =>
        `<tr><td>${esc(nice(d, true))}</td><td>${/^\d+$/.test(n) ? n : `<span class="muted">${esc(n)}</span>`}</td>${can ? `<td><button class="pill-btn sm" data-bcday="${d}" style="white-space:nowrap" title="Open this meeting in Check-in" aria-label="Open ${esc(nice(d, true))} in Check-in">Open</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">No meetings recorded yet.</p>`;
    }
    el.querySelectorAll("[data-bcday]").forEach(x => x.onclick = () => goDay(x.dataset.bcday));
    // Link to register: pick who they are on the church's register (likely matches first: a shared name or the same phone)
    el.querySelectorAll("[data-bclink]").forEach(x => x.onclick = () => {
      const g = people.find(m => m.gid === x.dataset.bclink), words = norm(g.full_name).split(/\s+/), ph = String(g.phone || "").replace(/\D/g, "");
      const score = m => (ph && String(m.phone || "").replace(/\D/g, "") === ph ? 10 : 0) + norm(m.full_name).split(/\s+/).filter(w => words.includes(w)).length;
      const opts = register.slice().sort((a, c) => score(c) - score(a) || byName(a, c));
      formDialog(`Link ${g.full_name} to the register`, [{k: "mid", label: "Who are they on the church register?", type: "select", value: "",
          options: [["", "Choose a name"], ...opts.map(m => [m.id, m.full_name + (score(m) ? " · likely" : "")])],
          hint: "Not on the register yet? Add them on Check-in (Service) when they come on a Sunday, then come back here."}],
        async v => { if (!v.mid) throw new Error("Choose who they are.");
          try { await api("rpc/app_bacenta_link", {method: "POST", body: {g: g.gid, mid: v.mid}}); }
          catch (err) { throw new Error(/already linked/i.test(err.message) ? "They're already linked." : /register/i.test(err.message) ? "That person isn't on this church's register." : bacentaSetup(err)); }
          log("bacenta_link", v.mid, "done", `${g.full_name} (Bacenta only) → ${register.find(m => m.id === v.mid)?.full_name || v.mid} · ${b.name}`);
          toast(`${g.full_name} is linked. Their Bacenta attendance moved with them.`); render(); }, "Link");
    });
    // Undo link: picked the wrong name. The copied check-ins come off that register entry; they're Bacenta only again.
    el.querySelectorAll("[data-bcunlink]").forEach(x => x.onclick = () => {
      const g = linked.find(y => y.id === x.dataset.bcunlink), to = register.find(m => m.id === g.member_id)?.full_name || "that person";
      formDialog(`Undo linking ${g.full_name}?`, [], async () => {
        try { await api("rpc/app_bacenta_unlink", {method: "POST", body: {g: g.id}}); } catch (err) { throw new Error(bacentaSetup(err)); }
        log("bacenta_unlink", g.member_id, "done", `${g.full_name} unlinked from ${to} · ${b.name}`);
        toast(`${g.full_name} is Bacenta only again. Their Bacenta attendance came off ${to}.`); render(); }, "Undo link");
      document.querySelector(".modal .fields").innerHTML = `<p style="margin:0">${esc(g.full_name)}'s Bacenta attendance will come off <b>${esc(to)}</b>, and they'll be <b>Bacenta only</b> again. Then you can link them to the right name.</p>`;
    });
  };
  if (take) {
    $("#bc-d").onchange = e => { S.bcDate = e.target.value > today() ? today() : e.target.value || today(); draw(); };
    $("#bc-q").oninput = e => { S.bcQ = e.target.value; draw(); };
    $("#bc-names").onchange = async e => {
      const box = e.target.closest("[data-bt]"); if (!box || !canTick) return;
      const id = box.dataset.bt, on = box.checked, d = S.bcDate; box.disabled = true;
      try {
        if (id.startsWith("g:")) {  // a Bacenta-only person: their own table
          const g = id.slice(2);
          if (on) await api("bacenta_guest_ticks?on_conflict=bacenta,meeting_date,guest", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {bacenta: b.id, meeting_date: d, guest: g, checked_at: isoLocal()}});
          else await api(`bacenta_guest_ticks?bacenta=eq.${b.id}&meeting_date=eq.${d}&guest=eq.${g}`, {method: "DELETE", prefer: "return=minimal"});
          if (on) { ticks.push({bacenta: b.id, meeting_date: d, member_id: id}); regular.add(id); } else ticks = ticks.filter(t => !(t.bacenta === b.id && t.meeting_date === d && t.member_id === id));
        } else if (on) { await api("bacenta_ticks?on_conflict=bacenta,meeting_date,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {bacenta: b.id, meeting_date: d, member_id: id, checked_at: isoLocal()}});
          ticks.push({bacenta: b.id, meeting_date: d, member_id: id}); regular.add(id); }
        else { await api(`bacenta_ticks?bacenta=eq.${b.id}&meeting_date=eq.${d}&member_id=eq.${encodeURIComponent(id)}`, {method: "DELETE", prefer: "return=minimal"});
          ticks = ticks.filter(t => !(t.bacenta === b.id && t.meeting_date === d && t.member_id === id)); }
      } catch (err) { box.checked = !on; toast("Not saved: " + bacentaSetup(err)); }
      box.disabled = false;
      const y = scrollY; draw(); scrollTo(0, y);
      if (on && S.bcQ) toast(`${byId[id]?.full_name || "Ticked"} is in.`);
    };
    // someone new who isn't on the church's register: they go on this Bacenta's list only, and are ticked in
    $("#bc-new")?.addEventListener("click", () => formDialog(`Add someone new to ${b.name}`, [
      {k: "full_name", label: "Full name", value: S.bcQ || "", required: true, hint: bacAll() ? "They go on this Bacenta's list only, not the church register. When they start coming on Sundays, link them on the Bacentas page."
        : "They go on this Bacenta's list now. A church admin will approve adding them to the church's Congregation list."},
      {k: "phone", label: "Phone (optional)", value: "", type: "tel"}, {k: "birthday", label: "Birthday (optional)", value: "", type: "date"}, {k: "address", label: "Address (optional)", value: ""}],
      async v => {
        const name = v.full_name.slice(0, 80); if (!name) throw new Error("Type their name.");
        const bad = phoneProblem(v.phone, false); if (bad) throw new Error(bad);
        const same = pool.find(m => norm(m.full_name) === norm(name));
        if (same) throw new Error(same.guest ? `${same.full_name} is already on this Bacenta's list: search for them and tick.` : `${same.full_name} is already on the church's list: search for them and tick.`);
        const gid = crypto.randomUUID(), d = S.bcDate;
        try {
          await api("bacenta_guests", {method: "POST", prefer: "return=minimal", body: {id: gid, bacenta: b.id, full_name: name, phone: v.phone || null, birthday: v.birthday || null, address: v.address.slice(0, 200) || null, added_by: S.me.name || S.me.email}});
          await api("bacenta_guest_ticks", {method: "POST", prefer: "return=minimal", body: {bacenta: b.id, meeting_date: d, guest: gid, checked_at: isoLocal()}});
        } catch (err) { throw new Error(bacentaSetup(err)); }
        const m = {id: "g:" + gid, gid, bacenta: b.id, full_name: name, phone: v.phone, birthday: v.birthday, address: v.address, guest: true, pending: !bacAll()};
        people.push(m); pool.push(m); byId[m.id] = m; ticks.push({bacenta: b.id, meeting_date: d, member_id: m.id}); regular.add(m.id);
        S.bcQ = ""; $("#bc-q").value = ""; draw(); toast(bacAll() ? `${name} added to ${b.name} and ticked in.` : `${name} is on ${b.name}'s list and ticked in. A church admin will approve adding them to the Congregation list.`);
      }, "Add & tick"));
  }
  draw();
}
// ---------------------------------------------------------------- one person: every day they came
async function person(el) {
  const p = picture(), mine = p.mine.slice().sort(byName), m = mine.find(x => x.id === S.person);
  // Opened by tapping a name on any list, so there's no search box here (finding people is on Congregation)
  const canEdit = ["admin", "lead"].includes(S.me.role) && !S.preview;  // the same people who can edit on Congregation
  const top = head(m ? esc(m.full_name) : "Person", esc(S.church), m ? `${canEdit ? `<button class="pill-btn" id="pe-edit">${svg("edit")}Edit</button>` : ""}<button class="pill-btn" id="dl">Download</button>` : "");
  const bind = () => { const b = el.querySelector("#pe-edit"); if (b) b.onclick = () => editPerson(m); };
  if (!m) { el.innerHTML = top + `<div class="card"><p class="empty" style="margin:0 0 12px">Tap a name on any list to see their attendance.</p><button class="pill-btn" data-go-people>Open Congregation</button></div>`;
    el.querySelector("[data-go-people]").onclick = () => { S.view = "people"; render(); }; return; }
  el.innerHTML = top + `<p class="empty">Loading…</p>`; bind();
  let rows, bac, youthSvc, youthParts, myParts;
  const mid = encodeURIComponent(m.id);
  try {
    [rows, bac, youthSvc, youthParts, myParts] = await Promise.all([
      all(`attendance?select=service_date&member_id=eq.${mid}&order=service_date.desc`),
      // their Bacenta attendance (only Bacentas this sign-in may see come back)
      all(`bacenta_ticks?select=bacenta,meeting_date&member_id=eq.${mid}&order=meeting_date.desc`).catch(() => []),
      // youth: services named Youth…, or a Youth service on a day split into services
      all("services?select=service_date,name&name=ilike.*youth*").catch(() => []),
      all(`service_parts?select=service_date,part,name&church=eq.${encodeURIComponent(S.church)}&name=ilike.*youth*`).catch(() => []),
      all(`service_ticks?select=service_date,part&member_id=eq.${mid}`).catch(() => [])]);
  } catch (e) { el.innerHTML = top + `<div class="msg bad">${esc(e.message)}</div>`; bind(); return; }
  if (S.view !== "person" || S.person !== m.id) return;
  const came = rows.map(r => r.service_date).filter(d => d <= today()), set = new Set(came);
  const st = p.people.find(x => x.id === m.id), years = {};
  for (const d of came) (years[d.slice(0, 4)] ??= []).push(d);
  const state = st ? badge(st.flag) : p.archived.some(x => x.id === m.id) ? `<span class="badge">Archived</span>` : `<span class="badge">${esc(m.status || "Not active")}</span>`;
  const recent = p.dates.slice(-12);
  // Bacenta: which ones they come to, how often, and when
  const bacName = id => (S.bacList || []).find(b => b.id === id)?.name || "A Bacenta";
  const bacs = [...new Set(bac.map(t => t.bacenta))].map(id => ({id, name: bacName(id), dates: bac.filter(t => t.bacenta === id).map(t => t.meeting_date)}));
  const since3 = dayShift(today(), -91), hasBacentas = (S.bacList || []).some(b => b.church === S.church);
  // youth: days the church held a youth service (a whole day named Youth…, or one of the day's services), and which they came to
  const youthDay = new Set(youthSvc.map(x => x.service_date).filter(d => !partsOf(d).length));
  const youthPart = youthParts.map(x => x.service_date + ":" + x.part), myPart = new Set(myParts.map(x => x.service_date + ":" + x.part));
  const youthHeld = [...new Set([...youthDay, ...youthParts.map(x => x.service_date)])].filter(d => d <= today()).sort().reverse();
  const youthCame = youthHeld.filter(d => youthDay.has(d) ? set.has(d) : youthPart.some(k => k.startsWith(d + ":") && myPart.has(k)));
  const pnames = [...new Set([...(S.pastorList[S.church] || []), ...p.people.flatMap(pastorsOf)])], asPastor = pnames.find(n => isSelf(n, m)) || "";
  const flock = asPastor ? p.people.filter(x => x.id !== m.id && pastorsOf(x).some(n => isSelf(n, m))).sort(byName) : [];  // if they are a pastor: who is under them
  el.innerHTML = top + `
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div class="who big"><span>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</div><span class="gap"></span>${state}</div>
      <p class="facts">${[typeName(m), isKid(m) ? "Child" : "Adult", m.phone || ""].filter(Boolean).map(esc).join(" · ")}${pastorsOf(m).length ? `<br>Pastor: ${pastorsOf(m).map(pastorBtn).join(", ")}` : ""}${shepherdsOf(m).length ? `<br>Shepherd: ${shepherdsOf(m).map(esc).join(", ")}` : ""}</p></div>
    ${flock.length || asPastor ? `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Their people</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${flock.length} ${flock.length === 1 ? "person" : "people"}</span>
        ${asPastor ? `<button class="pill-btn sm" data-to-pastor="${esc(asPastor)}">Open in Pastors</button>` : ""}</div>
      ${flock.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Came${p.last ? " · " + esc(nice(p.last)) : ""}</th><th>Status</th><th>Missed in a row</th><th>Phone</th></tr></thead><tbody>
        ${flock.map(x => `<tr><td>${whoBtn(x)}</td><td>${p.here[x.id] ? "Yes" : `<span class="muted">No</span>`}</td><td>${badge(x.flag)}</td><td>${x.missed}</td><td class="muted">${esc(x.phone || "")}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">Nobody is assigned to them yet.</p>`}</div>` : ""}
    <div class="tiles three"><div class="card tile"><div class="label">Attendance History</div><div class="num">${came.length}</div></div>
      <div class="card tile"><div class="label">Last Attended</div><div class="num sm">${esc(full(came[0]))}</div></div>
      <div class="card tile"><div class="label">Missed in a row</div><div class="num">${st ? st.missed : "–"}</div></div></div>
    ${recent.length ? `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>The last ${recent.length} services</h2><span class="gap"></span>
        <div class="legend"><span><i class="dot on"></i>Came</span><span><i class="dot"></i>Missed</span></div></div>
      <div class="dots">${recent.map(d => `<div><i class="dot ${set.has(d) ? "on" : ""}" title="${set.has(d) ? "Came" : "Missed"}"></i><small>${esc(nice(d))}</small></div>`).join("")}</div></div>` : ""}
    ${bacs.length || hasBacentas ? `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Bacenta</h2></div>
      ${bacs.length ? bacs.map(x => `<h3 class="year">${esc(x.name)} · ${x.dates.filter(d => d >= since3).length} in the last 3 months · last came ${esc(full(x.dates[0]))}</h3>
        <div class="chips">${x.dates.slice(0, 16).map(d => `<span class="chip">${esc(nice(d))}</span>`).join("")}${x.dates.length > 16 ? `<span class="chip muted">+${x.dates.length - 16} more</span>` : ""}</div>`).join("")
        : `<p class="empty">${esc(m.full_name)} hasn't been to a Bacenta${S.me.base === "pastor" || S.me.role === "team" ? " you look after" : ""}.</p>`}</div>` : ""}
    ${youthHeld.length ? `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Youth</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${youthCame.length} of the last ${youthHeld.length} youth ${youthHeld.length === 1 ? "service" : "services"}</span></div>
      ${youthCame.length ? `<div class="chips">${youthCame.slice(0, 16).map(d => `<span class="chip">${esc(nice(d))}</span>`).join("")}</div>`
        : `<p class="empty">${esc(m.full_name)} hasn't been to a youth service yet.</p>`}
      <p class="note" style="margin:10px 2px 0">Youth services are services named "Youth…" on Check-in.</p></div>` : ""}
    <div class="card"><div class="card-head"><h2>History</h2></div>
      ${came.length ? Object.keys(years).sort().reverse().map(y => `<h3 class="year">${y} · ${years[y].length} ${years[y].length === 1 ? "service" : "services"}</h3>
        <div class="chips">${years[y].map(d => `<span class="chip">${esc(nice(d))}</span>`).join("")}</div>`).join("") : `<p class="empty">No services recorded for ${esc(m.full_name)} yet.</p>`}</div>`;
  bind();
  el.querySelector("#dl").onclick = () => download(`${norm(m.full_name).replace(/[^a-z0-9]+/g, "_")}_history_${today()}.csv`, [["Name", "Church", "Date", "What"],
    ...[...came.map(d => [m.full_name, S.church, d, youthCame.includes(d) ? "Youth service" : svcName(d)]), ...bac.map(t => [m.full_name, S.church, t.meeting_date, bacName(t.bacenta)])].sort((a, b) => b[2].localeCompare(a[2]))]);
}

// ---------------------------------------------------------------- sign-ups from the welcome form
// The Sign-ups badge counts only sign-ups that came in since this person last opened Sign-ups; the page itself lists everyone waiting
const signSeenKey = () => "fcc-signups-seen:" + (S.me?.email || "");
const newSignups = rows => { let seen = 0; try { seen = +localStorage.getItem(signSeenKey()) || 0; } catch {} return rows.filter(r => Date.parse(r.created_at) > seen).length; };
async function signups(el) {
  const sub = "From the welcome form, waiting for approval";
  el.innerHTML = head("Sign-ups", sub) + `<p class="empty">Loading…</p>`;
  let regs;
  try { regs = await api("registrations?select=id,full_name,phone,email,invited_by,first_visit,notes,wants_contact,created_at&status=eq.pending&order=created_at"); }
  catch (e) { el.innerHTML = head("Sign-ups", sub) + `<div class="msg bad">Sign-ups can't load. Run the latest setup SQL in Supabase, then reopen this page. (${esc(e.message)})</div>`; return; }
  if (S.view !== "signups") return;
  S.pending = 0; try { localStorage.setItem(signSeenKey(), String(Date.now())); } catch {}  // seen: the badge clears
  document.querySelectorAll('[data-view="signups"] .count').forEach(x => x.remove());
  const home = Object.fromEntries(S.members.filter(m => churchOf(m) === S.me.home).map(m => [norm(m.full_name).replace(/\s+/g, " "), m]));
  el.innerHTML = head("Sign-ups", sub) + (regs.length ? regs.map(r => {
    const match = home[norm(r.full_name).replace(/\s+/g, " ")];
    const info = [["Phone", r.phone], ["Email", r.email], ["Invited by / heard via", r.invited_by], ["First visit", r.first_visit && full(r.first_visit)]].filter(x => x[1]);
    return `<div class="card signup" data-reg="${esc(r.id)}" data-match="${esc(match?.id || "")}" style="margin-bottom:14px">
      <div class="card-head"><h2>${esc(r.full_name)}</h2>${r.wants_contact === false ? `<span class="badge yellow">Prefers no contact</span>` : ""}<span class="gap"></span>
        <span style="color:var(--ink-3);font-size:13px">Sent ${esc(when(r.created_at))}</span></div>
      <p class="facts">${info.length ? info.map(([k, v]) => `${k}: ${esc(v)}`).join("<br>") : "No contact details given."}</p>
      ${r.notes ? `<div class="msg" style="margin-top:10px">${esc(r.notes)}</div>` : ""}
      ${match ? `<p class="note">Already on the register as <b>${esc(match.full_name)}</b> (${typeName(match).toLowerCase()}). Approving updates that person and adds nobody new.</p>` : ""}
      <div class="row" style="margin-top:14px"><label class="check"><input type="checkbox" data-tick checked> Mark present on ${esc(r.first_visit ? full(r.first_visit) : "today")}</label>
        <div style="flex:0 0 auto;display:flex;gap:8px"><button class="pill-btn primary" data-ok>Approve</button><button class="pill-btn" data-no>Reject</button></div></div></div>`;
  }).join("") : `<div class="card"><p class="empty">No sign-ups waiting.</p></div>`) + ``;
  el.querySelectorAll(".signup").forEach(card => {
    const id = card.dataset.reg, name = card.querySelector("h2").textContent, lock = on => card.querySelectorAll("button").forEach(b => b.disabled = on);
    card.querySelector("[data-ok]").onclick = async () => {
      lock(true);
      try {
        await api("rpc/app_approve_signup", {method: "POST", body: {reg: id, match_id: card.dataset.match || null, check_in: card.querySelector("[data-tick]").checked, at_txt: isoLocal()}});
        toast(`${name} is on the register.`); await load();
      } catch (err) { toast(/already handled/.test(err.message) ? `${name} was already handled by someone else, so nothing was added twice.` : "Not saved: " + err.message); }
      render();
    };
    card.querySelector("[data-no]").onclick = async e => {
      if (!e.target.dataset.sure) { e.target.dataset.sure = 1; e.target.textContent = "Tap again to reject"; setTimeout(() => { delete e.target.dataset.sure; e.target.textContent = "Reject"; }, 4000); return; }
      lock(true);
      try { const done = await api("rpc/app_reject_signup", {method: "POST", body: {reg: id, at_txt: isoLocal()}}); toast(done ? `Sign-up from ${name} rejected.` : `${name} was already handled by someone else.`); }
      catch (err) { toast("Not saved: " + err.message); }
      render();
    };
  });
  const count = document.querySelector('.nav[data-view="signups"] .count'); if (count) regs.length ? count.textContent = regs.length : count.remove();
}

// ---------------------------------------------------------------- team forms: a branch sends in who should sign in
// An admin or church admin makes a link for a church and sends it to the branch leader. The leader opens it without
// signing in and lists their people with a role. Nobody can sign in until an admin or that church's admin approves.
const TEAM_ROLES = [["team", "Team", "Ushers: tick people in at services"], ["pastor", "Pastor", "Sees and ticks only their own people"],
                    ["shepherd", "Shepherd", "Like a Pastor: sees and ticks only the people assigned to them"],
                    ["lead", "Church admin", "The whole church: people, follow-up, reports"]];
const teamLink = tok => `${location.origin}/app/index.html?${window.FCC_DEMO ? "demo&" : ""}team=${encodeURIComponent(tok)}`;
// The form a branch leader fills in. With a church name instead of a link (preview), it opens in a popup for the admin
// to see exactly what the leader will see; it can be filled in to try it, but nothing is sent.
async function teamForm(tok, preview) {
  let brand = `<div class="brand" style="padding:0"><span class="brand-mark">✝</span>Favourite Child Church</div>`, box;
  if (preview) {
    const d = document.createElement("div"); d.className = "modal";
    d.innerHTML = `<div class="login tf" role="dialog" aria-modal="true" aria-label="Preview of the form"></div>`;
    const onKey = e => { if (e.key === "Escape") close(); }, close = () => { d.remove(); document.removeEventListener("keydown", onKey); };
    d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
    document.addEventListener("keydown", onKey); document.body.append(d); box = d.firstElementChild;
    brand = `<div class="tf-prev"><span>${svg("eye")}Preview: what the leader sees. Nothing is sent from here.</span><button type="button" class="icon-btn" data-x aria-label="Close preview">${svg("close")}</button></div>` + brand;
  } else {
    root.innerHTML = `<div class="center"><div class="login tf">${brand}<p class="empty">Loading…</p></div></div>`;
    box = root.querySelector(".tf");
  }
  let info = preview ? {church: preview, by: S.me?.name || S.me?.email} : null;
  if (!preview) try { info = await api("rpc/app_team_form", {method: "POST", body: {tok}}); } catch {}
  if (!info) { box.innerHTML = brand + `<h1>This link isn't working</h1><p>It may have expired (links last 14 days). Ask for a new one.</p>`; return; }
  const row = () => `<div class="tf-row"><div class="tf-fields">
      <input class="in" data-k="name" maxlength="80" autocomplete="off" placeholder="Full name" aria-label="Full name">
      <input class="in" data-k="email" type="email" inputmode="email" autocapitalize="none" autocomplete="off" maxlength="120" placeholder="Email they will sign in with" aria-label="Email">
      <select class="in" data-k="role" aria-label="Role">${TEAM_ROLES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></div>
    <button type="button" class="icon-btn" data-rm aria-label="Remove this person" title="Remove">${svg("close")}</button></div>`;
  const draw = () => {
    box.innerHTML = brand + `<h1>Who will look after ${esc(info.church)}?</h1>
      <p>${esc(info.by || "Your admin")} asked you to list who will use the app for ${esc(info.church)}. An admin approves the list before anyone can sign in.</p>
      <form id="tf-form" novalidate>
        <label class="f" for="tf-me">Your name</label><input class="in" id="tf-me" maxlength="80" autocomplete="name" required>
        <div class="tf-roles">${TEAM_ROLES.map(([, t, d]) => `<div><b>${t}</b><span>${d}</span></div>`).join("")}</div>
        <div id="tf-rows">${row()}</div>
        <button type="button" class="pill-btn sm" id="tf-more">${svg("plus")}Add another person</button>
        <div class="msg bad" id="tf-err" hidden></div>
        <button class="pill-btn primary block" id="tf-go" style="margin-top:16px">Send the list</button>
      </form>`;
    const rows = box.querySelector("#tf-rows"), err = box.querySelector("#tf-err"), go = box.querySelector("#tf-go");
    const tidy = () => rows.querySelectorAll("[data-rm]").forEach(b => b.hidden = rows.children.length < 2);
    rows.onclick = e => { const b = e.target.closest("[data-rm]"); if (b) { b.closest(".tf-row").remove(); tidy(); } };
    box.querySelector("#tf-more").onclick = () => {
      if (rows.children.length >= 50) { err.textContent = "Send at most 50 people at a time. Send this list, then the rest."; err.hidden = false; return; }
      rows.insertAdjacentHTML("beforeend", row()); tidy(); rows.lastElementChild.querySelector("input").focus();
    };
    tidy();
    box.querySelector("#tf-form").onsubmit = async e => {
      e.preventDefault(); err.hidden = true;
      const fail = (t, el) => { err.textContent = t; err.hidden = false; el?.focus(); };
      err.classList.add("bad");
      const me = box.querySelector("#tf-me"), who = me.value.trim().replace(/\s+/g, " ");
      if (who.length < 2) return fail("Type your own name at the top.", me);
      const people = [], seen = new Set();
      for (const r of rows.querySelectorAll(".tf-row")) {
        const f = k => r.querySelector(`[data-k="${k}"]`), name = f("name").value.trim().replace(/\s+/g, " "), email = f("email").value.trim().toLowerCase();
        if (!name && !email) continue;  // an empty row is left out
        if (name.length < 2) return fail("Every person needs their full name.", f("name"));
        const wrong = emailProblem(email); if (wrong) return fail(`${name}: ${wrong}`, f("email"));
        if (seen.has(email)) return fail(`${email} is on the list twice.`, f("email"));
        seen.add(email); people.push({name, email, role: f("role").value});
      }
      if (!people.length) return fail("Add at least one person.", rows.querySelector("input"));
      if (preview) { err.classList.remove("bad"); return fail(`That would send ${people.length} ${people.length === 1 ? "person" : "people"} for ${info.church}. This is only a preview, so nothing was sent.`); }
      go.disabled = true; go.textContent = "Sending…";
      try {
        const n = await api("rpc/app_team_submit", {method: "POST", body: {tok, from_name: who, people}});
        box.innerHTML = brand + `<h1>Thank you, ${esc(who)}</h1>
          <p>${n} ${n === 1 ? "person" : "people"} sent for ${esc(info.church)}. Once an admin approves them, they sign in at <b>${esc(location.host)}/app</b> with the email you gave.</p>
          <button class="pill-btn block" id="tf-again">Send more people</button>`;
        box.querySelector("#tf-again").onclick = draw;
      } catch (ex) { go.disabled = false; go.textContent = "Send the list"; fail(ex.message); }
    };
  };
  draw();
}
// The page for admins and church admins: make a link, then approve or turn down what comes in.
async function teamforms(el) {
  const sub = "Ask a branch who should sign in, then approve them";
  el.innerHTML = head("Team forms", sub) + `<p class="empty">Loading…</p>`;
  let reqs, links;
  try {
    [reqs, links] = await Promise.all([
      api("team_requests?select=id,church,sent_by,name,email,role,pastor,created_at&status=eq.pending&order=created_at"),
      api(`team_links?select=token,church,made_by_name,expires_at&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=created_at.desc&limit=8`)]);
  } catch (e) { el.innerHTML = head("Team forms", sub) + `<div class="msg bad">Team forms can't load. Run the latest setup SQL in Supabase, then reopen this page. (${esc(e.message)})</div>`; return; }
  if (S.view !== "teamforms") return;
  S.teamPending = reqs.length;
  const signed = S.me.role === "admin" ? new Set((await api("app_users?select=email").catch(() => [])).map(u => u.email)) : new Set();
  if (S.view !== "teamforms") return;
  // name suggestions per church: a row only offers its own church's Pastors and Shepherds
  const tfChurches = [...new Set(reqs.map(r => r.church))], tfList = c => "tf-pn-" + tfChurches.indexOf(c);
  const namesOf = c => [...new Set([...(S.pastorList?.[c] || []), ...(S.shepherdList?.[c] || [])])].sort();
  const day = t => new Date(t).toLocaleDateString(undefined, {day: "numeric", month: "short"});
  const groups = {};
  for (const r of reqs) (groups[`${r.church}\n${r.sent_by}`] ??= []).push(r);
  const roleSel = r => `<select class="in sm" data-role aria-label="Role for ${esc(r.name)}">${TEAM_ROLES.map(([v, t]) => `<option value="${v}" ${v === r.role ? "selected" : ""}>${t}</option>`).join("")}</select>`;
  el.innerHTML = head("Team forms", sub) + `
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Send a form</h2></div>
      <p class="note" style="margin:0 2px 12px">Send a church leader a link to list their people. Approve the list here.</p>
      <div class="row"><div style="flex:1 1 200px"><label class="f" for="tf-ch">Church</label>
        <select class="in" id="tf-ch">${S.churches.map(c => `<option ${c === S.church ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
        <div style="flex:0 0 auto;align-self:flex-end;display:flex;gap:8px"><button class="pill-btn" id="tf-prev">${svg("eye")}Preview</button><button class="pill-btn primary" id="tf-make">Make link</button></div></div>
      <div id="tf-out"></div>
      ${links.length ? `<p class="f" style="margin:16px 2px 6px">Links still open</p><div class="tf-links">${links.map(l => `<div><span><b>${esc(l.church)}</b><small class="muted">${esc(l.made_by_name || "")} · until ${esc(day(l.expires_at))}</small></span>
        <button class="pill-btn sm" data-copy="${esc(l.token)}">Copy link</button></div>`).join("")}</div>` : ""}</div>
    ${reqs.length ? Object.entries(groups).map(([k, list]) => { const [church, from] = k.split("\n"); return `
      <div class="card tf-group" style="margin-bottom:14px"><div class="card-head"><h2>${esc(church)}</h2><span class="gap"></span>
        <span style="color:var(--ink-3);font-size:13px">From ${esc(from)} · ${esc(day(list[list.length - 1].created_at))}</span></div>
        <div class="scroll"><table class="utable"><thead><tr><th><input type="checkbox" data-all checked aria-label="Tick all"></th><th>Name</th><th>Role</th><th>Pastor name (for a Pastor)</th></tr></thead><tbody>
        ${list.map(r => `<tr data-id="${esc(r.id)}"><td><input type="checkbox" data-pick checked aria-label="Include ${esc(r.name)}"></td>
          <td><b>${esc(r.name)}</b><small class="muted" style="display:block">${esc(r.email)}</small>${signed.has(r.email) ? `<span class="badge yellow">Can already sign in</span>` : ""}</td>
          <td>${roleSel(r)}</td><td><input class="in sm" data-pastor ${["pastor", "shepherd"].includes(r.role) ? "" : "hidden"} list="${tfList(r.church)}" value="${esc(r.pastor || "")}" placeholder="As on the Pastors or Shepherds list" aria-label="Pastor name for ${esc(r.name)}"></td></tr>`).join("")}
        </tbody></table></div>
        <p class="note" style="margin:8px 2px 0">A Pastor's name must match the Pastors list.</p>
        <div class="tf-acts"><button class="pill-btn" data-no>Turn down ticked</button><button class="pill-btn primary" data-ok>Approve ticked</button></div></div>`; }).join("")
      : `<div class="card"><p class="empty">Nothing waiting. Lists sent in from a form show here.</p></div>`}
    ${tfChurches.map(c => `<datalist id="${tfList(c)}">${namesOf(c).map(n => `<option value="${esc(n)}">`).join("")}</datalist>`).join("")}`;
  const share = (tok, church) => {
    if (!tok) throw new Error("no link came back. Please try again.");
    const url = teamLink(tok), msg = `Hi, please list who will use the FCC Attendance app for ${church} (name, email and role): ${url}`;
    el.querySelector("#tf-out").innerHTML = `<div class="tf-made"><input class="in" readonly value="${esc(url)}" aria-label="Form link">
      <div class="tf-acts" style="margin-top:8px"><button class="pill-btn sm" data-c>Copy</button>
        <a class="pill-btn sm" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">WhatsApp</a>
        <a class="pill-btn sm" href="mailto:?subject=${encodeURIComponent("FCC Attendance: who will sign in for " + church)}&body=${encodeURIComponent(msg)}">Email</a>
        ${onPhone() && navigator.share ? `<button class="pill-btn sm" data-s>More…</button>` : ""}</div>
      <p class="note" style="margin:6px 2px 0">One link works for everyone, for 14 days.</p></div>`;
    const out = el.querySelector("#tf-out");
    out.querySelector("[data-c]").onclick = e => navigator.clipboard?.writeText(url).then(() => { e.target.textContent = "Copied"; toast("Link copied."); }).catch(() => toast("Couldn't copy: press and hold the link instead."));
    const s = out.querySelector("[data-s]"); if (s) s.onclick = () => navigator.share({text: msg}).catch(() => {});
  };
  el.querySelector("#tf-prev").onclick = () => teamForm(null, el.querySelector("#tf-ch").value);
  el.querySelector("#tf-make").onclick = async e => {
    const church = el.querySelector("#tf-ch").value; e.target.disabled = true;
    try { share(await api("rpc/app_team_link", {method: "POST", body: {ch: church}}), church); }
    catch (err) { toast("No link made: " + err.message); }
    e.target.disabled = false;
  };
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => navigator.clipboard?.writeText(teamLink(b.dataset.copy))
    .then(() => { b.textContent = "Copied"; toast("Link copied."); setTimeout(() => b.textContent = "Copy link", 2500); }).catch(() => {}));
  el.querySelectorAll(".tf-group").forEach(card => {
    const picks = () => [...card.querySelectorAll("tbody tr")].filter(tr => tr.querySelector("[data-pick]").checked);
    const lock = on => card.querySelectorAll("button").forEach(b => b.disabled = on);
    card.querySelectorAll("[data-role]").forEach(s => s.onchange = () => { const i = s.closest("tr").querySelector("[data-pastor]"); i.hidden = !["pastor", "shepherd"].includes(s.value); if (!i.hidden && !i.value) i.focus(); });
    card.querySelector("[data-all]").onchange = e => card.querySelectorAll("[data-pick]").forEach(c => c.checked = e.target.checked);
    card.querySelector("[data-ok]").onclick = async () => {
      const rows = picks(); if (!rows.length) return toast("Tick at least one person.");
      const items = rows.map(tr => { const role = tr.querySelector("[data-role]").value; return {id: tr.dataset.id, role, pastor: ["pastor", "shepherd"].includes(role) ? tr.querySelector("[data-pastor]").value.trim() : ""}; });
      const gap = rows.find(tr => ["pastor", "shepherd"].includes(tr.querySelector("[data-role]").value) && !tr.querySelector("[data-pastor]").value.trim());
      if (gap) { gap.querySelector("[data-pastor]").focus(); return toast("A Pastor needs their name as it is on the Pastors list."); }
      lock(true);
      try {
        const r = await api("rpc/app_team_approve", {method: "POST", body: {items, at_txt: isoLocal()}});
        toast(`${r.added ? `${r.added} can now sign in.` : "Nobody new added."}${r.had ? ` ${r.had} could already sign in, so they were left as they are.` : ""}`);
      } catch (err) { toast(/already handled/.test(err.message) ? "Someone else already handled some of these, so nothing was changed. Here's the latest." : "Not saved: " + err.message); }
      render();
    };
    card.querySelector("[data-no]").onclick = async e => {
      const rows = picks(); if (!rows.length) return toast("Tick at least one person.");
      if (!e.target.dataset.sure) { e.target.dataset.sure = 1; e.target.textContent = `Tap again to turn down ${rows.length}`; setTimeout(() => { delete e.target.dataset.sure; e.target.textContent = "Turn down ticked"; }, 4000); return; }
      lock(true);
      try { const n = await api("rpc/app_team_reject", {method: "POST", body: {ids: rows.map(tr => tr.dataset.id)}}); toast(`${n} turned down.`); }
      catch (err) { toast("Not saved: " + err.message); }
      render();
    };
  });
}

// ---------------------------------------------------------------- archive: not seen for two years
function archive(el) {
  const p = picture(), list = p.archived.slice().sort(byName);
  el.innerHTML = head("Archive", `${esc(S.church)} · not seen for two years`, list.length ? `<button class="pill-btn" id="dl">Download</button>` : "") + `
    ${S.seen ? "" : `<div class="msg" style="margin:0 0 14px">Run the latest setup SQL in Supabase to see further back than a year.</div>`}
    <div class="card">${list.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Last seen</th><th>Type</th><th>Age group</th><th>Phone</th></tr></thead><tbody>
      ${list.map(m => `<tr><td>${whoBtn(m)}</td><td class="muted">${esc(full(m.seen))}</td><td class="muted">${typeName(m)}</td><td class="muted">${m.kid ? "Child" : "Adult"}</td><td class="muted">${esc(m.phone || "")}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="empty">Nobody is in the archive.</p>`}
      <p class="note">They come back when ticked in again.</p></div>`;
  const dl = el.querySelector("#dl");
  if (dl) dl.onclick = () => download(`archive_${S.church}_${today()}.csv`, [["Church", "Name", "Last seen", "Type", "Age group", "Phone"],
    ...list.map(m => [S.church, m.full_name, m.seen || "", typeName(m), m.kid ? "Child" : "Adult", m.phone || ""])]);
}

// ---------------------------------------------------------------- activity: who did what, and when
const KIND = {lock: "Locked a service", unlock: "Unlocked a service", delete: "Deleted from register", rename_church: "Renamed a church", role_change: "Changed a sign-in", tick: "Ticked in", untick: "Unticked", clear_service: "Unticked everyone", edit: "Edited", add_person: "Added",
              signup_approved: "Approved sign-up", signup_rejected: "Rejected sign-up", bacenta_approved: "Added a Bacenta name to Congregation", bacenta_rejected: "Kept a Bacenta name as Bacenta only",
              bacenta_link: "Linked a Bacenta-only person", bacenta_unlink: "Undid a Bacenta link"};
const RESULT = {done: "Done", already: "No change (already done)", changed: "Blocked: someone else changed it first"};
async function activity(el) {
  const sub = `${esc(S.church)} · every tick, untick, edit and approval.`;
  const shows = {all: "Everything", ticks: "Check-ins", edits: "Edits & sign-ups", blocked: "Blocked only"};
  const frame = body => head("Activity log", sub) + `<div class="card" style="margin-bottom:14px"><div class="row">
      <div style="flex:0 0 170px"><label class="f" for="a-day">Day</label><input class="in" id="a-day" type="date" value="${S.actDay}"></div>
      <div class="chips" style="margin:0">${Object.entries(shows).map(([k, t]) => `<button class="chip ${S.actShow === k ? "on" : ""}" data-show="${k}">${t}</button>`).join("")}</div></div></div>${body}`;
  const bind = () => {
    calPick(el.querySelector("#a-day"), new Set());
    el.querySelector("#a-day").onchange = e => { S.actDay = e.target.value || today(); render(); };
    el.querySelectorAll("[data-show]").forEach(b => b.onclick = () => { S.actShow = b.dataset.show; render(); });
  };
  el.innerHTML = frame(`<p class="empty">Loading…</p>`); bind();
  let rows;
  try { rows = await all(`activity_log?select=at,kind,service_date,member_id,detail,by_name,result&or=(service_date.eq.${S.actDay},at.like.${S.actDay}*)&order=at.desc`); }
  catch (e) { el.innerHTML = frame(`<div class="msg bad">${esc(e.message)}</div>`); bind(); return; }
  if (S.view !== "activity") return;
  const names = Object.fromEntries(S.members.map(m => [m.id, m])), tick = r => r.kind === "tick" || r.kind === "untick";
  rows = rows.filter(r => r.member_id ? names[r.member_id] && churchOf(names[r.member_id]) === S.church : S.church === S.me.home)  // this church only
             .filter({all: () => true, ticks: tick, edits: r => !tick(r), blocked: r => r.result === "changed"}[S.actShow]);
  el.innerHTML = frame(`<div class="card">${rows.length ? `<div class="scroll"><table><thead><tr><th>Time</th><th>What</th><th>Person</th><th>Details</th><th>By</th><th>Result</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td class="muted">${esc(String(r.at).slice(11, 19))}</td><td>${esc(KIND[r.kind] || r.kind)}</td>
      <td>${r.member_id ? (names[r.member_id] ? whoBtn(names[r.member_id]) : "(removed)") : ""}</td><td class="muted">${esc(r.detail || "")}</td><td class="muted">${esc(r.by_name || "")}</td>
      <td>${r.result === "changed" ? `<span class="badge yellow">Blocked</span>` : `<span class="muted">${esc(RESULT[r.result] || r.result || "")}</span>`}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="empty">Nothing recorded on ${esc(full(S.actDay))}${S.actShow === "all" ? "" : " for this filter"}.</p>`}
    </div>`);
  bind();
}

// ---------------------------------------------------------------- reports: the WhatsApp summary, the emailed report and downloads, as tabs
function reports(el) {
  const boss = ["admin", "lead"].includes(S.me.role);
  const tabs = [["summary", "Summary"], ...(boss ? [["email", "Email reports"], ["downloads", "Downloads"]] : [])];
  if (!tabs.some(t => t[0] === S.repTab)) S.repTab = "summary";
  el.innerHTML = head("Reports", boss ? "Share the service's numbers: as a message, by email, or as lists to download" : "The service summary")
    + `<div class="rep-tabs" role="tablist" aria-label="Reports">${tabs.map(([k, t]) => `<button role="tab" data-rt="${k}" aria-selected="${S.repTab === k}">${t}</button>`).join("")}</div>
    <div class="rep-body" data-tab="${S.repTab}"></div>`;
  el.querySelectorAll("[data-rt]").forEach(b => b.onclick = () => { S.repTab = b.dataset.rt; render(); });
  const body = el.querySelector(".rep-body");
  return S.repTab === "summary" ? summaryPage(body) : emailReports(body);
}
async function emailReports(el) {
  const sub = esc(S.church);
  const isHome = S.church === S.me.home, key = isHome ? "report_recipients" : `report_recipients:${S.church}`;
  el.innerHTML = head("Reports", sub) + `<p class="empty">Loading…</p>`;
  let setting, sent;
  try {
    [setting, sent] = await Promise.all([api(`settings?select=value&key=eq.${encodeURIComponent(key)}`),
      api(`email_log?select=kind,report_date,sent_at,recipients,ok,detail&kind=in.(${isHome ? '"manual","daily"' : `"manual:${S.church.replace(/"/g, "")}"`})&order=sent_at.desc&limit=15`)]);
  } catch (e) { el.innerHTML = head("Reports", sub) + `<div class="msg bad">Reports can't load. Run the latest setup SQL in Supabase, then reopen this page. (${esc(e.message)})</div>`; return; }
  if (S.view !== "reports") return;
  const list = (setting[0]?.value || "").split(/[,\s;]+/).filter(Boolean), p = picture();
  el.innerHTML = head("Reports", sub) + `
    <div class="rep-split"><form class="card" id="to"><div class="card-head"><h2>Who gets the email</h2><span class="gap"></span><span class="muted" style="font-size:13px">${list.length} ${list.length === 1 ? "person" : "people"}</span></div>
      <div class="rcpts">${list.length ? list.map(m => `<span class="rcpt"><span class="ava" ${avaStyle(m)}>${esc(initials(m))}</span><span class="rcpt-mail">${esc(m)}</span>
          <button type="button" class="rcpt-x" data-unmail="${esc(m)}" aria-label="Take ${esc(m)} off the list" title="Take off the list">${svg("close")}</button></span>`).join("")
        : `<p class="empty" style="margin:0">Nobody gets the report yet. Add the leaders' email addresses below.</p>`}</div>
      <div class="add-mail"><input class="in" id="newmail" type="text" inputmode="email" autocomplete="off" placeholder="Add an email, e.g. fcc@gmail.com" aria-label="Email address to add">
        <button class="pill-btn">${svg("plus")}Add</button><button type="button" class="pill-btn primary" id="send" ${list.length && p.last ? "" : "disabled"}>${svg("reports")}Send report now</button></div>
      <p class="note" style="margin:10px 2px 0">Tap × to take someone off. Changes save straight away.</p></form>
    <aside class="rep-prev" id="rep-prev" aria-label="Email preview"></aside></div>
    <div class="card" id="sent" style="margin-bottom:14px"><div class="card-head"><h2>Emails sent</h2></div>
      ${sent.length ? `<div class="scroll"><table><thead><tr><th>Sent</th><th>Report for</th><th>Type</th><th>To</th><th>Result</th></tr></thead><tbody>
        ${sent.map(r => `<tr><td class="muted">${esc(when(r.sent_at))}</td><td>${esc(full(r.report_date))}</td><td class="muted">${r.kind === "daily" ? "Automatic (old schedule)" : "Sent by the admin"}</td>
          <td class="muted">${esc(r.recipients || "")}</td><td>${r.ok ? "Sent" : `<span class="badge red" title="${esc(r.detail || "")}">Failed</span>`}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">No emails have been sent yet.</p>`}
      </div>
    <div class="card" id="dls"><div class="card-head"><h2>Lists to download</h2></div>
      <div class="chips" style="margin:0"><button class="pill-btn" data-dl="in">Checked in${p.last ? " · " + esc(nice(p.last)) : ""}</button>
        <button class="pill-btn" data-dl="call">Needs a follow-up call</button><button class="pill-btn" data-dl="all">Whole register</button></div>
      </div>`;
  const saveList = async (next, done) => {
    const value = [...new Set(next.map(x => x.toLowerCase()))].join(", ");  // an empty list is fine: nobody gets the report
    try { await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key, value}}); toast(done); render(); }
    catch (err) { toast("Not saved: " + err.message); }
  };
  el.querySelector("#to").onsubmit = e => {
    e.preventDefault();
    const items = el.querySelector("#newmail").value.split(/[,\s;]+/).filter(Boolean), bad = items.map(emailProblem).filter(Boolean);
    if (!items.length) return el.querySelector("#newmail").focus();
    if (bad.length) return toast("Not added: " + bad[0]);
    const fresh = items.filter(x => !list.includes(x.toLowerCase()));
    if (!fresh.length) return toast("That email is already on the list.");
    saveList([...list, ...fresh], fresh.length === 1 ? `Added ${fresh[0].toLowerCase()}.` : `Added ${fresh.length} emails.`);
  };
  el.querySelectorAll("[data-unmail]").forEach(b => b.onclick = () => { const m = b.dataset.unmail, left = list.filter(x => x !== m);
    saveList(left, left.length ? `${m} won't get the report any more.` : "List cleared. Nobody will get the report until you add an address."); });
  const type = typeName, age = m => isKid(m) ? "Child" : "Adult";
  const files = {
    in: () => [`checked_in_${S.church}_${p.last || today()}.csv`, [["Church", "Service", "Name", "Type", "Age group", "Phone"], ...p.present.slice().sort(byName).map(m => [S.church, p.last, m.full_name, type(m), age(m), m.phone || ""])]],
    call: () => [`follow_up_${S.church}_${today()}.csv`, [["Church", "Name", "Status", "Missed in a row", "Last seen", "Phone", "Pastor"], ...p.people.filter(x => x.level !== "ok").map(x => [S.church, x.full_name, FLAG[x.flag], x.missed, x.seen || "", x.phone || "", x.pastor || ""])]],
    all: () => [`register_${S.church}_${today()}.csv`, [["Church", "Name", "Type", "Age group", "Status", "Pastor", "Phone"], ...p.mine.slice().sort(byName).map(m => [S.church, m.full_name, type(m), age(m), m.status || "Active", m.pastor || "", m.phone || ""])]],
  };
  el.querySelectorAll("[data-dl]").forEach(b => b.onclick = () => download(...files[b.dataset.dl]()));
  // The email as it will be sent, on the side: with names or numbers only
  const prevBox = el.querySelector("#rep-prev");
  const drawPrev = () => {
    const was = S.emoji; S.emoji = false; let text = "";
    try { text = p.last ? summary(p, {names: S.repNames !== false}) : ""; } finally { S.emoji = was; }
    prevBox.innerHTML = `<div class="wa-prev-head"><b>Email preview</b><div class="pv-seg" role="group" aria-label="Names in the email"><button type="button" data-rn="1" aria-pressed="${S.repNames !== false}">With names</button><button type="button" data-rn="0" aria-pressed="${S.repNames === false}">Numbers only</button></div></div>
      <div class="wa-paper">${text ? `<div class="preview nice">${prettyMsg(text)}</div>` : `<p class="empty" style="margin:0">No service recorded yet.</p>`}</div>
      <p class="wa-paper-note">${list.length ? `This goes to ${list.length} ${list.length === 1 ? "person" : "people"} when you tap Send report now.` : "Add an email address to send it."}</p>`;
    prevBox.querySelectorAll("[data-rn]").forEach(b => b.onclick = () => { S.repNames = b.dataset.rn === "1"; drawPrev(); });
  };
  if (prevBox) drawPrev();
  const csv = rows => rows.map(r => r.map(v => /[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? "")).join(",")).join("\r\n");
  el.querySelector("#send").onclick = () => formDialog(`Send ${S.church}'s report`, [
    {k: "names", label: "Include names of first-timers and people to follow up", type: "select", value: S.repNames === false ? "no" : "yes", options: [["yes", "Yes, with names"], ["no", "No, numbers only"]],
     hint: `Goes to ${list.join(", ")} for ${p.last ? nice(p.last, true) : "the latest service"}. The check-in and follow-up lists are attached when names are included.`},
  ], async v => {
    const was = S.emoji; S.emoji = false;
    let text; try { text = summary(p, {names: v.names === "yes"}); } finally { S.emoji = was; }
    if (S.preview) throw new Error("Not sent: " + viewOnly());
    if (S.session && S.session.expires_at - Date.now() < 60000) await refresh();
    const r = await fetch("/app-send", {method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer " + S.session.access_token},
      body: JSON.stringify({church: S.church, date: p.last, at: isoLocal(), text,
        files: v.names === "yes" ? ["in", "call"].map(k => files[k]()).map(([name, rows]) => ({name: name.replace(/[^\w .()-]/g, "_"), text: csv(rows)})) : []})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { render(); throw new Error(j.message || "The email was not sent."); }
    toast(`Sent to ${j.sent} ${j.sent === 1 ? "person" : "people"}.`); render();
  }, "Send now");
}

// ---------------------------------------------------------------- help: questions by topic, and a message to the admin
function helpTopics() {
  const r = S.me.role, ticks = r !== "bishop", adds = ["admin", "lead", "team"].includes(r), edits = ["admin", "lead"].includes(r);
  const t = [
    ["start", "Getting started", [
      ["How do I put the app on my phone?", "iPhone: open the app in Safari, tap Share, then Add to Home Screen.\nAndroid: open it in Chrome, tap the ⋮ menu, then Add to Home screen or Install app.\nIt then opens like any other app."],
      ["What can I see in the app?", {admin: "As the main admin you see every church, and you can change who can sign in on the Admin page.",
        bishop: "You see the numbers for every church on the Churches page: pick a day on the calendar and a church to see its dashboard.",
        lead: "You see everything for your own church: check-in, the congregation list, reports and follow-up.",
        team: "You can tick people in on Check-in and look up people in your church.",
        pastor: "You see only the people assigned to you: how many came, who wasn't there and who needs a call."}[r] || "Ask the admin below if you need to see more."],
      ["The app looks old or out of date", "Pull the page down to refresh. If it still looks old, close the app fully (swipe it away) and open it again. It updates itself after that."],
    ]],
    ...(ticks ? [["checkin", "Check-in", [
      ["I can't see a person on the list", "Check the church name at the top is the right one, then use the search box." + (adds ? " If they are new, add them at the bottom of Check-in." : " If they are new, ask an usher or church admin to add them.")],
      ["I ticked the wrong person", "Tap their name again to untick them. Nothing else is changed."],
      ...(adds ? [["Someone new came but I don't have their number", "That's fine: the phone number is optional on Check-in. Add it later with Edit on the Congregation page."]] : []),
      ["It says the service is locked", "Tap Unlock at the top of Check-in, make your change, then tap Save & lock again so the ticks stay safe."],
    ]]] : []),
    ["people", "People and follow-up", [
      ["What do red and amber mean?", `Amber, "Check in": missed ${YELLOW_AT}–${RED_AT - 1} services in a row. Red, "Needs a call": missed ${RED_AT} or more. These are the people to call. Blue, "Missed this one": missed only this service. Visitors are never flagged. On a computer, rest the mouse on a label to see this again.`],
      ["A name, phone number or role is wrong", edits ? "Open Congregation, find the person and tap Edit." : "Ask your church admin to fix it, or send a message to the admin below."],
      ["How do I share the numbers on WhatsApp?", "On a phone, tap the WhatsApp button on your home page. It writes the message for you to send. On a computer you can copy the text instead."],
    ]],
    ["account", "Sign-in and account", [
      ["The sign-in email didn't arrive", "Wait a minute and check Spam or Junk. If you typed the email wrong, fix it and tap Email me a code again. You can also tap Resend code after 25 seconds."],
      ["How do I sign in faster?", "Set a password: you'll be offered one after signing in with a code, or tap your name or picture at the top of the app to open Your account and set one there. Next time choose Password."],
      ["How do I change my password?", "Tap your name or picture at the top of the app to open Your account, then type a new password twice and tap Save password. You don't need to sign out."],
      ["I forgot my password", "If you're still signed in, just change it in Your account (tap your name or picture at the top). If you're signed out, choose Email code on the sign-in page, then set a new password in Your account."],
      ["I need to see more than I can", "Send a message to the admin below and say what you need."],
    ]],
  ];
  return t;
}

async function help(el) {
  const topics = helpTopics();
  if (!topics.some(t => t[0] === S.helpTopic)) S.helpTopic = topics[0][0];
  const topic = topics.find(t => t[0] === S.helpTopic);
  el.innerHTML = `<div class="help">
    <div class="help-side"><div class="head"><div><h1>Help</h1></div></div>
      <p class="lede">Common questions, and a way to reach the admin.</p>
      <button type="button" class="pill-btn sm" id="tour-again" style="margin:0 0 12px">${svg("eye")}Show the welcome tour again</button>
      <div class="help-chips" role="tablist" aria-label="Topics">${topics.map(([k, name]) =>
        `<button class="hchip" role="tab" data-ht="${k}" aria-selected="${k === S.helpTopic}">${esc(name)}</button>`).join("")}</div></div>
    <div class="help-main">
      <div class="acc">${topic[2].map(([q, a], i) => `<div class="acc-item${i === 0 ? " open" : ""}">
        <button class="acc-q" aria-expanded="${i === 0}" aria-controls="acc-${i}"><span>${esc(q)}</span><i class="acc-ico" aria-hidden="true"></i></button>
        <div class="acc-a" id="acc-${i}" ${i === 0 ? "" : "hidden"}>${esc(a).replace(/\n/g, "<br>")}</div></div>`).join("")}</div>
      <div class="card still"><h2>Still have questions?</h2>
        <p>Send a message to the admin and they'll get back to you.</p>
        <button class="pill-btn primary" id="contact">${svg("mail")}Contact the admin</button></div>
    </div></div>`;
  el.querySelectorAll("[data-ht]").forEach(b => b.onclick = () => { S.helpTopic = b.dataset.ht; help(el); });
  el.querySelectorAll(".acc-q").forEach(b => b.onclick = () => {
    const item = b.closest(".acc-item"), open = !item.classList.contains("open");
    el.querySelectorAll(".acc-item.open").forEach(x => { x.classList.remove("open"); x.querySelector(".acc-q").setAttribute("aria-expanded", false); x.querySelector(".acc-a").hidden = true; });
    if (open) { item.classList.add("open"); b.setAttribute("aria-expanded", true); item.querySelector(".acc-a").hidden = false; }
  });
  el.querySelector("#contact").onclick = () => contactDialog(topic[1]);
  el.querySelector("#tour-again").onclick = tour;
}

// The message form: it goes to the main admin by email and into the Messages inbox on the Admin page.
function contactDialog(topicName) {
  document.querySelectorAll(".modal").forEach(m => m.remove());
  const topics = helpTopics().map(t => t[1]).concat("Something else");
  const d = document.createElement("div"); d.className = "modal";
  d.innerHTML = `<form class="sheet narrow" role="dialog" aria-modal="true" aria-label="Contact the admin">
    <div class="card-head"><h2>Contact the admin</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
    <div class="fields">
      <div><label class="f">From</label><p style="margin:2px 2px 0">${esc(S.me.name || S.me.email)}${S.me.name ? ` <span class="muted">· ${esc(S.me.email)}</span>` : ""}</p></div>
      <div><label class="f" for="ct-topic">About</label><select class="in" id="ct-topic">${topics.map(t => `<option ${t === topicName ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
      <div><label class="f" for="ct-msg">Message</label><textarea class="in" id="ct-msg" rows="5" maxlength="2000" required placeholder="What do you need help with?"></textarea>
        <p class="note" style="margin:6px 2px 0">The admin replies to your email address.</p></div></div>
    <div class="msg bad" id="ct-err" hidden></div>
    <div class="modal-foot"><button type="button" class="pill-btn" data-x>Cancel</button><button class="pill-btn primary" id="ct-go">Send message</button></div></form>`;
  document.body.append(d);
  const close = () => { d.remove(); document.removeEventListener("keydown", onKey); }, onKey = e => { if (e.key === "Escape") close(); };
  d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
  document.addEventListener("keydown", onKey);
  d.querySelector("#ct-msg").focus();
  d.querySelector("form").onsubmit = async e => {
    e.preventDefault();
    const go = d.querySelector("#ct-go"), err = d.querySelector("#ct-err"), message = d.querySelector("#ct-msg").value.trim();
    if (!message) return;
    go.disabled = true; go.textContent = "Sending…"; err.hidden = true;
    try {
      if (S.preview) throw new Error("Not sent: " + viewOnly());
      if (S.session.expires_at - Date.now() < 60000) await refresh();
      const r = await fetch("/app-help", {method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer " + S.session.access_token},
        body: JSON.stringify({topic: d.querySelector("#ct-topic").value, message})});
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || "The message was not sent. Please try again.");
      close(); toast("Message sent. The admin will get back to you.");
    } catch (ex) { err.textContent = ex.message; err.hidden = false; go.disabled = false; go.textContent = "Send message"; }
  };
}

// ---------------------------------------------------------------- ask: ready-made questions, answered by SQL in Supabase
// Each question is a saved query inside the database (app_ask in supabase/app_setup.sql). The app sends the question's id and
// the church, plus a date, month, name or number when the question needs one. Nobody types SQL, and the database's own rules
// decide what each sign-in may see (the Bishop is refused, a pastor only gets their own people).
// Extra boxes a question needs: d = a service, m = a month, t = words to look for, n = a number.
const ASK_FIRST = "A first-timer here is anyone with a first-visit date.", ASK_MISSED = "Only Sunday services count as missed, and visitors are never listed.";
const ASK = [
  ["Services", [
    ["svc_latest", "How many came to the last service?"],
    ["svc_day", "How many came to a service?", [["d"]]],
    ["svc_name", "Find services by name (for example Fathers Day)", [["t", "Part of the name", "Fathers Day"]]],
    ["svc_who_came", "Who came to a service?", [["d"]]],
    ["svc_who_missed", "Who did not come to a service?", [["d"]], "Shows people on the register who were not ticked in. Visitors are left out."],
    ["svc_first_timers", "Who were the first-timers at a service?", [["d"]]],
    ["svc_gender", "How many males and females came to a service?", [["d"]]],
    ["svc_biggest", "Which were the 10 biggest services?"],
    ["svc_smallest", "Which were the 10 smallest services this year?"],
    ["svc_avg", "What is the average attendance on a Sunday?"],
    ["svc_last12", "How did the last 12 Sundays go?"],
    ["svc_by_name", "How do the different kinds of service compare?"],
    ["svc_month", "How many came each month this past year?"],
    ["svc_compare", "How does a month compare with the month before?", [["m"]]],
    ["svc_special", "Which special services have we held?", [], "Any service with its own name, such as Fathers Day or a Prayer Meeting."],
  ]],
  ["First-timers", [
    ["ft_month_count", "How many first-timers in a month?", [["m"]], ASK_FIRST],
    ["ft_month_names", "Who were the first-timers in a month?", [["m"]], ASK_FIRST],
    ["ft_by_month", "First-timers each month, and how many came back", [], ASK_FIRST + " \"Came again\" means they were ticked in at a later service."],
    ["ft_came_back", "Which first-timers have come back? (past year)", [], ASK_FIRST],
    ["ft_not_back", "Which first-timers have not come back yet? (past 6 months)", [], ASK_FIRST + " These are good people to call."],
    ["ft_recent", "Who first visited in the last few days?", [["n", "Days", 30]], ASK_FIRST],
    ["new_people", "Who was added to the register in the last few days?", [["n", "Days", 30]]],
    ["a_new_attenders", "Who came for the very first time in a month?", [["m"]], "Based on the first time someone was ticked in."],
  ]],
  ["People", [
    ["p_total", "How many people do we have?"],
    ["p_females", "How many females?"],
    ["p_males", "How many males?"],
    ["p_kids", "How many kids?"],
    ["p_adults", "How many adults?"],
    ["p_gender_age", "Females, males, adults and kids together"],
    ["p_gender_missing", "Who has no gender filled in?"],
    ["p_by_church", "How many people are in each church?"],
    ["p_by_pastor", "How many people does each pastor have?"],
    ["p_no_pastor", "Who has no pastor?"],
    ["p_no_phone", "Who has no phone number?"],
    ["p_by_role", "How many people are in each team?"],
    ["p_role_who", "Who is in a team?", [["t", "Team or role", "Ushers"]]],
    ["p_status", "How many people are Active, Away or Moved?"],
    ["p_archive", "Who has not been seen for two years?"],
    ["p_search", "Look up a person", [["t", "Name", "Grace"]]],
    ["p_visitors", "Who are our visitors?"],
  ]],
  ["Attendance", [
    ["a_red", "Who missed 5 or more Sundays? (red)", [], ASK_MISSED],
    ["a_yellow", "Who missed 3 or 4 Sundays? (yellow)", [], ASK_MISSED],
    ["a_blue", "Who missed only the last Sunday or two? (blue)", [], ASK_MISSED],
    ["a_missed_n", "Who missed a number of Sundays in a row or more?", [["n", "Sundays missed", 3]], ASK_MISSED],
    ["a_away_weeks", "Who has not been seen for some weeks?", [["n", "Weeks", 4]]],
    ["a_faithful", "Who came the most in the last 12 Sundays?"],
    ["a_perfect", "Who came to every Sunday lately?", [["n", "Last Sundays", 4]]],
    ["a_person", "When did a person come?", [["t", "Name", "Grace"]]],
    ["a_gender_trend", "Females, males and kids over the last 8 Sundays"],
    ["a_pastor_last", "How did each pastor's people do at the last service?"],
  ]],
];
function ask(el) {
  const all = ASK.flatMap(([g, qs]) => qs.map(([id, title, params = [], note = ""]) => ({id, g, title, params, note})));
  const st = S.ask = S.ask || {g: ASK[0][0], q: all[0].id, v: {}, find: ""};
  const dates = () => Object.keys(S.names || {}).filter(d => d <= today()).sort().reverse().slice(0, 150);
  const shown = () => st.find ? all.filter(q => norm(q.title).includes(norm(st.find))) : all.filter(q => q.g === st.g);
  const cur = () => all.find(q => q.id === st.q) || all[0];
  el.innerHTML = head("Ask a question", `${esc(S.church)} · pick a question and the answer comes from your records`) + `
    <div class="card" style="margin-bottom:14px">
      <div class="chips" role="tablist" aria-label="Kinds of question">${ASK.map(([g]) => `<button class="chip ${!st.find && st.g === g ? "on" : ""}" role="tab" data-g="${g}">${g}</button>`).join("")}</div>
      <label class="f" for="ask-find">Search the questions</label>
      <input class="in" id="ask-find" type="search" maxlength="60" autocomplete="off" placeholder="e.g. first-timers, kids, Fathers Day" value="${esc(st.find)}">
      <label class="f" for="ask-q" style="margin-top:12px">Question</label>
      <select class="in" id="ask-q"></select>
      <div class="row" id="ask-params" style="margin-top:12px"></div>
      <p class="note" id="ask-note" style="margin:10px 2px 0" hidden></p>
      <div style="margin-top:14px"><button class="pill-btn primary" id="ask-go">Show the answer</button></div></div>
    <div id="ask-out" aria-live="polite"></div>`;
  const sel = el.querySelector("#ask-q"), box = el.querySelector("#ask-params"), note = el.querySelector("#ask-note"), out = el.querySelector("#ask-out");
  const drawParams = () => {
    const q = cur(); st.v[q.id] = st.v[q.id] || {};
    const v = st.v[q.id], ds = dates();
    box.innerHTML = q.params.map(([k, label, hint]) => k === "d"
      ? `<div><label class="f" for="ask-d">Service</label><select class="in" id="ask-d">${ds.length ? ds.map(d => `<option value="${d}" ${(v.d || ds[0]) === d ? "selected" : ""}>${esc(full(d))} · ${esc(S.names[d] || "Service")}</option>`).join("") : "<option value=''>No services yet</option>"}</select></div>`
      : k === "m" ? `<div><label class="f" for="ask-m">Month</label><input class="in" id="ask-m" type="month" value="${v.m || today().slice(0, 7)}"></div>`
      : k === "t" ? `<div><label class="f" for="ask-t">${esc(label)}</label><input class="in" id="ask-t" maxlength="60" autocomplete="off" placeholder="e.g. ${esc(hint)}" value="${esc(v.t || "")}"></div>`
      : `<div><label class="f" for="ask-n">${esc(label)}</label><input class="in" id="ask-n" type="number" inputmode="numeric" min="1" max="365" value="${v.n || hint}"></div>`).join("");
    box.hidden = !q.params.length; note.textContent = q.note; note.hidden = !q.note;
    box.querySelectorAll("[id^=ask-]").forEach(i => i.oninput = i.onchange = () => { v[i.id.slice(4)] = i.value; });
  };
  const drawList = () => {
    const list = shown(); if (!list.some(q => q.id === st.q) && list.length) st.q = list[0].id;
    sel.innerHTML = list.length ? list.map(q => `<option value="${q.id}" ${q.id === st.q ? "selected" : ""}>${esc(q.title)}</option>`).join("") : "<option value=''>No question matches. Try another word.</option>";
    drawParams();
  };
  drawList();
  el.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { st.g = b.dataset.g; st.find = ""; ask(el); });
  el.querySelector("#ask-find").oninput = e => { st.find = e.target.value; drawList(); };
  sel.onchange = () => { st.q = sel.value; drawParams(); };
  el.querySelector("#ask-go").onclick = async () => {
    const q = cur(), v = st.v[q.id] || {}, body = {q: q.id, ch: S.church};
    if (!sel.value) return;
    for (const [k] of q.params) {
      const x = String(el.querySelector("#ask-" + k)?.value ?? "").trim();
      if (k === "t" && !x) { toast("Please type a word or name to look for."); el.querySelector("#ask-t").focus(); return; }
      if (k === "d") { if (!x) { toast("There are no services yet."); return; } body.d = x; v.d = x; }
      if (k === "m") { body.m = (x || today().slice(0, 7)) + "-01"; v.m = x; }
      if (k === "t") { body.t = x; v.t = x; }
      if (k === "n") { body.n = Math.min(365, Math.max(1, parseInt(x, 10) || 1)); v.n = String(body.n); }
    }
    const go = el.querySelector("#ask-go"); go.disabled = true; go.textContent = "Looking…";
    out.innerHTML = `<div class="card"><p class="empty" style="margin:0">Looking it up…</p></div>`;
    try {
      const rows = (await api("rpc/app_ask", {method: "POST", body})) || [], cols = rows.length ? Object.keys(rows[0]) : [];
      const asked = q.params.map(([k]) => k === "d" ? full(body.d) : k === "m" ? new Date(body.m + "T12:00:00").toLocaleDateString("en-NZ", {month: "long", year: "numeric"}) : k === "t" ? `“${body.t}”` : k === "n" ? body.n : "").filter(Boolean).join(" · ");
      out.innerHTML = `<div class="card"><div class="card-head"><h2>${esc(q.title)}</h2><span class="gap"></span>${rows.length ? `<button class="pill-btn" id="ask-dl">Download</button>` : ""}</div>
        <p class="note" style="margin:0 2px 10px">${esc(S.church)}${asked ? " · " + esc(asked) : ""} · ${rows.length} ${rows.length === 1 ? "row" : "rows"}</p>
        ${rows.length ? `<div class="scroll"><table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map((c, i) => `<td class="${i ? "muted" : ""}">${esc(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
          : `<p class="empty">Nothing found for that question.</p>`}</div>`;
      const dl = out.querySelector("#ask-dl");
      if (dl) dl.onclick = () => download(`${q.id}_${S.church}_${today()}.csv`, [cols, ...rows.map(r => cols.map(c => r[c]))]);
    } catch (ex) {
      out.innerHTML = `<div class="msg bad">${esc(/app_ask/.test(ex.message) ? "Ask isn't set up yet: run the latest setup SQL in Supabase once." : /not allowed/.test(ex.message) ? "This sign-in can't use Ask." : ex.message)}</div>`;
    }
    go.disabled = false; go.textContent = "Show the answer";
  };
}

// ---------------------------------------------------------------- your own account
function account(el) {
  el.innerHTML = head("Your account", "") + `<div class="acct-page">
    <form class="card" id="me"><label class="f" for="my-name">Your name</label>
      <input class="in" id="my-name" maxlength="80" autocomplete="name" value="${esc(S.me.name || "")}" placeholder="e.g. Grace Mensah">
      <p class="facts" style="margin-top:14px">Email: ${esc(S.me.email)}<br>Role: ${roleName(S.me)}${S.me.church ? "<br>Church: " + esc(S.me.church) : ""}${S.me.role === "pastor" && S.me.pastor ? "<br>Your people: those assigned to " + esc(S.me.pastor) : ""}</p>
      
      <div style="margin-top:14px"><button class="pill-btn primary">Save name</button></div></form>
    <div id="look"></div>
    <form class="card" id="setpw"><div class="card-head"><h2>Password</h2></div>
      <p class="note" style="margin-top:0">Set a password to skip the email code.</p>
      <input type="email" autocomplete="username" value="${esc(S.me.email)}" readonly hidden>
      <label class="f" for="pw1">New password</label><input class="in" id="pw1" type="password" autocomplete="new-password" maxlength="72" required>
      <label class="f" for="pw2" style="margin-top:12px">Type it again</label><input class="in" id="pw2" type="password" autocomplete="new-password" maxlength="72" required>
      <ul class="pw-rules" id="pw-rules" aria-live="polite"></ul>
      <div style="margin-top:14px"><button class="pill-btn primary" id="pw-go">Save password</button></div></form>
    ${S.canSwitch ? `<div class="card"><div class="card-head"><h2>Your views</h2></div>
      <p class="note" style="margin-top:0">You're ${baseName() === "Admin" ? "an" : "a"} ${baseName()} and also a ${pview() === "Reverend" ? "Reverend" : "pastor"} (${esc(S.me.pastor)}). Switch any time.</p>
      <button class="pill-btn primary" data-switch>${svg("pastors")}${switchLabel()}</button></div>` : ""}
    <div class="card"><button class="pill-btn" data-bye>${svg("out")}Log out</button></div></div>`;
  el.querySelector("#me").onsubmit = async e => {
    e.preventDefault();
    try { S.me.name = await api("rpc/app_set_my_name", {method: "POST", body: {new_name: el.querySelector("#my-name").value}}); toast("Saved."); render(); }
    catch (err) { toast(/app_set_my_name/.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
  };
  const pwGo = el.querySelector("#pw-go"), redraw = pwChecks(el.querySelector("#pw-rules"), el.querySelector("#pw1"), el.querySelector("#pw2"), pwGo);
  el.querySelector("#setpw").onsubmit = async e => {
    e.preventDefault(); pwGo.disabled = true;
    try {
      await savePassword(el.querySelector("#pw1").value, el.querySelector("#pw2").value);
      e.target.reset(); toast("Password saved. Next time, sign in with your email and this password.");
    } catch (err) { toast("Not saved: " + err.message); }
    redraw();
  };
  el.querySelector("[data-bye]").onclick = signOut;
  settings(el.querySelector("#look"));
  el.querySelectorAll("[data-switch]").forEach(b => b.onclick = () => switchView(S.me.role === "pastor" ? S.me.base : "pastor"));
}

// Settings: how the app looks and behaves for this person. Nothing here changes what anyone else sees.
function settings(box) {
  const v = look(), saved = (() => { try { return localStorage.getItem("fcc-mode"); } catch { return null; } })();
  const theme = v.theme || saved || "system", acc = v.accent || ACCENTS[0][0], own = !ACCENTS.some(a => a[0] === acc);
  const row = (t, d, ctl) => `<div class="set-row"><div><b>${t}</b><small>${d}</small></div><div class="set-ctl">${ctl}</div></div>`;
  const flip = (id, t, d, on) => `<label class="switch flat"><span><b>${t}</b><small>${d}</small></span><input type="checkbox" id="${id}" ${on ? "checked" : ""}><i></i></label>`;
  const mk = c => `<span class="mk ${c}"><i></i><em><u></u><u></u></em></span>`;
  const starts = pages().flatMap(g => g[1]).filter(([k]) => !["ask", "help"].includes(k));
  box.innerHTML = `<div class="card set-card"><div class="card-head"><h2>Appearance</h2></div>
      <p class="note">These only change the app for you, on this phone or laptop.</p>
      ${row("Accent colour", "Buttons, the menu and highlights.", `<div class="swatches" role="group" aria-label="Accent colour">${ACCENTS.map(([c, n]) =>
        `<button type="button" class="sw" data-accent="${c}" style="--sw:${c}" title="${n}" aria-label="${n}" aria-pressed="${acc === c}"></button>`).join("")}
        <label class="sw own" title="Pick your own colour" ${own ? `style="--sw:${acc}" aria-current="true"` : ""}><input type="color" id="acc-own" value="${acc}" aria-label="Pick your own colour"></label></div>`)}
      ${row("Theme", "System matches your phone or laptop and switches with it.", `<div class="themes" role="group" aria-label="Theme">${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([k, t]) =>
        `<button type="button" data-theme-pick="${k}" aria-pressed="${theme === k}"><span class="mock">${k === "system" ? mk("light") + mk("dark half") : mk(k)}</span>${t}</button>`).join("")}</div>`)}</div>
    <div class="card set-card"><div class="card-head"><h2>Accessibility</h2></div>
      ${row("Text size", "Makes the pages and pop-ups bigger.", `<div class="seg" role="group" aria-label="Text size">${[["normal", "Normal"], ["large", "Large"], ["larger", "Larger"]].map(([k, t]) =>
        `<button type="button" data-text-pick="${k}" aria-pressed="${v.text === k}" style="font-size:${{normal: 13.5, large: 15, larger: 16.5}[k]}px">${t}</button>`).join("")}</div>`)}
      ${flip("set-muted", "Fewer colours", "Grey icons, cards and name badges for a calmer page. Your accent colour stays.", v.muted)}
      ${flip("set-contrast", "Stronger contrast", "Darker grey text and clearer lines.", v.contrast)}
      ${flip("set-motion", "Reduce motion", "Turns off sliding and fading.", v.motion)}</div>
    <div class="card set-card"><div class="card-head"><h2>Home-screen icon</h2></div>
      ${row("Opens", "Full screen hides the browser, like an app. It takes effect when you add the app to your home screen: already added? Remove the icon and add it again (Share → Add to Home Screen).",
        `<div class="seg" role="group" aria-label="Home-screen icon opens">${[["", "In the browser"], ["app", "Full screen"]].map(([k, t]) => `<button type="button" data-home-pick="${k}" aria-pressed="${(v.home || "") === k}">${t}</button>`).join("")}</div>`)}</div>
    <div class="card set-card"><div class="card-head"><h2>Menu and start page</h2></div>
      ${row("Start page", "The page you land on when you open the app.", `<select class="in" id="set-start" aria-label="Start page"><option value="">Default</option>${starts.map(([k, t]) =>
        `<option value="${k}" ${v.start === k ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`)}
      <div class="set-wide">${flip("set-mini", "Icons-only menu", "On laptops, show the side menu as icons only.", S.mini)}</div>
      ${flip("set-emoji", "Emojis in shared messages", "Adds emojis to the WhatsApp summaries you copy.", S.emoji)}
      <div class="set-wide pg-head"><b>Pages you see</b><small>Hide pages you don't use. Only on this device.</small></div>
      ${pages().flatMap(g => g[1]).filter(([k], i) => i && k !== "help").map(([k, t]) => flip("set-pg-" + k, t, "", !(v.hide || []).includes(k))).join("")}
      <div class="set-row"><span class="gap" style="flex:1"></span><button type="button" class="pill-btn" data-look-reset>Reset to default</button></div></div>
    <div class="card set-card"><div class="card-head"><h2>Sharing summaries</h2></div>
      ${row("Send to", "Extra places to send a summary, next to WhatsApp and Copy.", `<div class="chips" role="group" aria-label="Send to">${SHARE.map(([k, t]) =>
        `<button type="button" class="chip" data-share-pick="${k}" aria-pressed="${shareTo().includes(k)}">${t}</button>`).join("")}</div>`)}
      ${["admin", "lead"].includes(S.me.role) ? flip("set-livefill", "Fill in livestream numbers", "In the service summary, fill YouTube, Facebook and Zoom from the livestream's peaks for today.", !!v.liveFill) : ""}</div>`;
  // Statuses: what each one does at this church, set by anyone who ticks people in (admins, church admins, ushers, pastors, shepherds)
  const canStatus = ["admin", "lead", "team", "pastor"].includes(S.me.role) && !S.preview;
  if (canStatus) box.insertAdjacentHTML("beforeend", `<div class="card set-card"><div class="card-head"><h2>Statuses</h2></div>
    <p class="note" style="margin:0 2px 6px">What each status does at ${esc(S.church)}.</p>
    ${Object.entries(statusRules()).map(([k, v]) => row(esc(k), "", `<select class="in" data-st="${esc(k)}" aria-label="${esc(k)}">${[["in", "Stays on the lists"], ["out", "Off the lists (back if ticked)"], ["gone", "Off for good"]]
      .map(([a, t]) => `<option value="${a}" ${v === a ? "selected" : ""}>${t}</option>`).join("")}</select>${STATUS0[k] ? "" : `<button type="button" class="pill-btn sm" data-st-del="${esc(k)}">Remove</button>`}`)).join("")}
    <div class="set-row st-add" style="display:flex;gap:8px;align-items:center"><input class="in" id="st-new" style="flex:1;min-width:0" maxlength="30" placeholder="Add a status, e.g. Studying abroad" aria-label="New status"><button type="button" class="pill-btn" id="st-add">Add</button></div></div>`);
  const redo = () => settings(box), $ = q => box.querySelector(q);
  if (canStatus) {
    const saveSt = async rules => { try { await api("rpc/app_set_status_rules", {method: "POST", body: {ch: S.church, rules}}); (S.statusRules ??= {})[S.church] = rules; toast("Saved."); redo(); }
      catch (e) { toast(/app_set_status_rules|function/i.test(e.message) ? "Run the latest setup SQL in Supabase once, then try again." : "Not saved: " + e.message); } };
    box.querySelectorAll("[data-st]").forEach(x => x.onchange = () => saveSt({...statusRules(), [x.dataset.st]: x.value}));
    box.querySelectorAll("[data-st-del]").forEach(b => b.onclick = () => { const r = {...statusRules()}; delete r[b.dataset.stDel]; saveSt(r); });
    $("#st-add").onclick = () => { const n = $("#st-new").value.trim().replace(/\s+/g, " ").slice(0, 30); if (!n) return;
      if (norm(n) === "active" || Object.keys(statusRules()).some(k => norm(k) === norm(n))) return toast("That status is already there.");
      saveSt({...statusRules(), [n.charAt(0).toUpperCase() + n.slice(1)]: "in"}); };
  }
  box.querySelectorAll("[data-accent]").forEach(b => b.onclick = () => { saveLook({accent: b.dataset.accent === ACCENTS[0][0] ? "" : b.dataset.accent}); redo(); });
  $("#acc-own").onchange = e => { saveLook({accent: e.target.value}); redo(); };
  $("#acc-own").oninput = e => applyLook({...look(), accent: e.target.value});  // see it while picking
  box.querySelectorAll("[data-theme-pick]").forEach(b => b.onclick = () => {
    const t = b.dataset.themePick; saveLook({theme: t}); try { t === "system" ? localStorage.removeItem("fcc-mode") : localStorage.setItem("fcc-mode", t); } catch {} redo(); });
  box.querySelectorAll("[data-text-pick]").forEach(b => b.onclick = () => { saveLook({text: b.dataset.textPick}); redo(); });
  $("#set-muted").onchange = e => saveLook({muted: e.target.checked});
  $("#set-contrast").onchange = e => saveLook({contrast: e.target.checked});
  $("#set-motion").onchange = e => saveLook({motion: e.target.checked});
  box.querySelectorAll("[data-home-pick]").forEach(b => b.onclick = () => { saveLook({home: b.dataset.homePick}); redo();
    toast(b.dataset.homePick ? "Saved. Add the app to your home screen again to open it full screen." : "Saved. Add the app to your home screen again to open it in the browser."); });
  box.querySelectorAll("[data-share-pick]").forEach(b => b.onclick = () => { const k = b.dataset.sharePick, now = shareTo();
    saveLook({share: now.includes(k) ? now.filter(x => x !== k) : [...now, k]}); redo(); });
  $("#set-livefill")?.addEventListener("change", e => saveLook({liveFill: e.target.checked}));
  $("#set-start").onchange = e => { saveLook({start: e.target.value}); toast("Saved. You'll start there next time."); };
  $("#set-mini").onchange = e => { S.mini = e.target.checked; try { localStorage.setItem("fcc-mini", S.mini ? "1" : "0"); } catch {}
    document.querySelector(".shell")?.classList.toggle("mini", S.mini); };
  box.querySelectorAll('[id^="set-pg-"]').forEach(c => c.onchange = () => {  // a page on or off in the menu
    const k = c.id.slice(7), now = new Set(look().hide || []); c.checked ? now.delete(k) : now.add(k);
    saveLook({hide: [...now]}); const y = scrollY; render(); scrollTo(0, y); });
  $("#set-emoji").onchange = e => { S.emoji = e.target.checked; try { localStorage.setItem("fcc-emoji", S.emoji ? "on" : "off"); } catch {} };
  $("[data-look-reset]").onclick = () => { saveLook(null); S.mini = false; S.emoji = true;
    try { localStorage.removeItem("fcc-mini"); localStorage.removeItem("fcc-emoji"); } catch {} render(); toast("Back to the default settings."); };
}

// ---------------------------------------------------------------- go
let saved = null; try { saved = localStorage.getItem("fcc-mode"); } catch {}
setMode(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
try { S.emoji = localStorage.getItem("fcc-emoji") !== "off"; } catch {}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js").catch(() => {});

// Phones (iPhones especially) can keep running an old copy of the app for days. Each time the app is opened or
// brought back to the front, compare the copy we have with the one on the server; if a newer one exists, reload.
let lastCheck = 0;
// Loads the newer version and opens it on the same page, day and place (instead of starting again on the Dashboard)
function reloadApp() {
  try { sessionStorage.setItem("fcc-back", JSON.stringify({view: S.view, date: S.date, church: S.church, repTab: S.repTab, y: scrollY})); history.scrollRestoration = "manual"; } catch {}
  location.reload();
}
// The server says which version it has (app-config); the phone remembers which one it started with. Different: a newer one is out.
async function freshCheck(force = false) {
  if (!force && Date.now() - lastCheck < 60000) return !!S.newVersion;
  lastCheck = Date.now();
  if (S.cfg?.version) {
    try {
      const live = (await fetch("/app-config", {cache: "no-store"}).then(r => r.json())).version || "";
      if (!live || live === S.cfg.version) return false;
      S.newVersion = true; document.querySelectorAll("[data-refresh]").forEach(b => { b.classList.add("new"); b.title = "A newer version of the app is ready: tap to load it"; });
      return true;
    } catch { return false; }
  }
  try {  // a server without the version yet: compare the stored copy of app.js with the server's
    const tag = r => r.headers.get("etag") || r.headers.get("last-modified") || "";
    const have = tag(await fetch("/app/app.js", {cache: "force-cache"}));
    const live = tag(await fetch("/app/app.js", {cache: "reload"}));   // also refreshes the phone's stored copy
    await fetch("/app/index.html", {cache: "reload"});
    if (!have || !live || have === live) return;
    const key = "fcc-updated:" + live;                            // never loop: reload at most once per version
    if (sessionStorage.getItem(key)) return;
    // Only reload by itself on a fresh, untouched page; otherwise the Refresh button gets a dot and loads the new version when
    // tapped, so the page never jumps while someone is reading or working on it
    // Never reload by itself (that made the page jump): the Refresh button gets a dot and loads the new version when tapped,
    // and the next time the app is opened it starts on the new version anyway
    S.newVersion = true; document.querySelectorAll("[data-refresh]").forEach(b => { b.classList.add("new"); b.title = "A newer version of the app is ready: tap to load it"; });
  } catch {}
}
// Back to the app after 10 minutes or more away (phone unlocked, app reopened): a newer version loads straight away, on the
// same page, as nobody is in the middle of anything. Back sooner: Refresh gets a dot instead, so nothing jumps.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") { hiddenAt = Date.now(); return; }
  const long = hiddenAt && Date.now() - hiddenAt > 600000; hiddenAt = 0;
  freshCheck(long).then(n => { if (n && long && !document.querySelector(".modal")) reloadApp(); });
  S.onShow?.();
});
setTimeout(freshCheck, 3000);
start().catch(e => fatal(e.message));
