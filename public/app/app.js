// FCC Attendance app. Plain JavaScript, no build step: it talks to Supabase's REST and Auth APIs directly.
// What a signed-in person may load is decided by the database (Row Level Security, see supabase/app_setup.sql),
// not by this file: hiding a menu item here is for tidiness, the database is what keeps churches apart.

const RED_AT = 5, YELLOW_AT = 3, ARCHIVE_DAYS = 730;
const AWAY = new Set(["inactive", "moved", "left", "deceased", "transferred", "away"]);
const ROLE = {admin: "Admin", bishop: "Bishop", lead: "Church admin", team: "Team"};
const FLAG = {red: "Red", yellow: "Yellow", blue: "Blue", ok: "On track"};
const root = document.getElementById("root");
const S = {cfg: null, session: null, me: null, churches: [], church: "", members: [], ticks: [], names: {}, view: "dashboard",
           filter: "need", date: today(), q: "", poll: null, numbers: null, users: null};

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
const isKid = m => ["child", "kid", "kids", "children"].includes(norm(m.age_group));
const churchOf = m => (m.church || "").trim() || S.me.home;
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
const initials = s => String(s || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
function toast(text) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = Object.assign(document.createElement("div"), {className: "toast", textContent: text});
  document.body.append(t); setTimeout(() => t.remove(), 3500);
}
function download(name, rows) {
  const csv = rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(new Blob(["﻿" + csv], {type: "text/csv"})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into WhatsApp."); }
  catch { const box = document.getElementById("wa-box"); if (box) { box.hidden = false; box.value = text; box.select(); } }
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
  try { keep(await auth("token?grant_type=refresh_token", {refresh_token: S.session.refresh_token})); return true; }
  catch { store.set(null); return false; }
}
async function api(path, {method = "GET", body, prefer, retry = true} = {}) {
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

function loginView(message, bad) {
  root.innerHTML = `<div class="center"><form class="login" id="login">
    <div class="brand" style="padding:0"><span class="brand-mark">✝</span>Favourite Child Church</div>
    <h1>Sign in</h1><p>Enter your email and we'll send you a sign-in link.</p>
    <label class="f" for="email">Email</label><input class="in" id="email" type="email" autocomplete="email" required>
    <div id="pw" hidden><label class="f" for="password">Password</label><input class="in" id="password" type="password" autocomplete="current-password"></div>
    <div id="code" hidden><label class="f" for="token">Code from the email</label><input class="in" id="token" inputmode="numeric" autocomplete="one-time-code"></div>
    <button class="pill-btn primary block" id="go">Email me a sign-in link</button>
    <button type="button" class="link" id="use-pw">Use a password instead</button>
    ${message ? `<div class="msg ${bad ? "bad" : ""}">${esc(message)}</div>` : ""}
  </form></div>`;
  const f = root.querySelector("#login"), pw = f.querySelector("#pw"), code = f.querySelector("#code"), go = f.querySelector("#go");
  f.querySelector("#use-pw").onclick = e => {
    pw.hidden = !pw.hidden; code.hidden = true;
    go.textContent = pw.hidden ? "Email me a sign-in link" : "Sign in";
    e.target.textContent = pw.hidden ? "Use a password instead" : "Email me a link instead";
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const email = f.querySelector("#email").value.trim().toLowerCase();
    go.disabled = true;
    try {
      if (!pw.hidden) keep(await auth("token?grant_type=password", {email, password: f.querySelector("#password").value}));
      else if (!code.hidden && f.querySelector("#token").value.trim()) keep(await auth("verify", {type: "email", email, token: f.querySelector("#token").value.trim()}));
      else {
        await auth("otp?redirect_to=" + encodeURIComponent(location.origin + location.pathname), {email, create_user: true});
        code.hidden = false; go.textContent = "Sign in with the code"; go.disabled = false;
        f.querySelectorAll(".msg").forEach(m => m.remove());
        f.insertAdjacentHTML("beforeend", `<div class="msg">Check ${esc(email)} for an email from us and tap the link. If the email shows a code, type it above.</div>`);
        return;
      }
      start();
    } catch (err) { go.disabled = false; loginView(err.message, true); }
  };
}

async function start() {
  clearInterval(S.poll);
  if (!S.cfg) {
    S.cfg = await fetch("/app-config").then(r => r.json()).catch(() => null);
    if (!S.cfg?.url || !S.cfg?.key) { root.innerHTML = `<div class="center"><p class="empty">The app isn't connected to the database yet.</p></div>`; return; }
  }
  const hash = new URLSearchParams(location.hash.slice(1));  // arriving from the emailed link
  if (hash.get("access_token")) { keep(Object.fromEntries(hash)); history.replaceState(null, "", location.pathname); }
  else if (hash.get("error_description")) { history.replaceState(null, "", location.pathname); return loginView(hash.get("error_description").replace(/\+/g, " "), true); }
  S.session = S.session || store.get();
  if (!S.session) return loginView();
  try { S.me = await api("rpc/app_me", {method: "POST", body: {}}); } catch (e) { return S.session ? fatal(e.message) : null; }
  if (!S.me?.role) {
    root.innerHTML = `<div class="center"><div class="login"><h1>Not set up yet</h1>
      <p>${esc(S.me?.email || "This email")} isn't on the list of people who can use the app. Ask your church admin to add it, then sign in again.</p>
      <button class="pill-btn block" id="out">Sign out</button></div></div>`;
    root.querySelector("#out").onclick = signOut; return;
  }
  S.view = S.me.role === "bishop" ? "overview" : S.view;
  if (S.me.role !== "bishop") {
    S.churches = (await api("churches?select=name,livestream&order=name")).map(c => c.name);
    S.church = S.me.role === "admin" ? (S.churches.includes(S.church) ? S.church : S.me.home) : S.me.church;
    await load();
  }
  render();
}
function fatal(text) { root.innerHTML = `<div class="center"><div class="login"><h1>Something went wrong</h1><p>${esc(text)}</p><button class="pill-btn block" onclick="location.reload()">Try again</button></div></div>`; }
async function signOut() { try { await auth("logout", {}, S.session?.access_token); } catch {} store.set(null); S.me = null; loginView(); }

// ---------------------------------------------------------------- data for the church being looked at
async function load() {
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const [members, ticks, services] = await Promise.all([
    all("members?select=id,full_name,phone,type,status,age_group,pastor,church,date_joined,first_visit,created_at&order=full_name"),
    all(`attendance?select=service_date,member_id,checked_at&service_date=gte.${since}&order=service_date`),
    all(`services?select=service_date,name&service_date=gte.${since}`)]);
  S.members = members; S.ticks = ticks; S.names = Object.fromEntries(services.map(s => [s.service_date, s.name]));
}
function picture() {  // everything the pages show, worked out the same way as the Streamlit site
  const mine = S.members.filter(m => churchOf(m) === S.church);
  const ids = new Set(mine.map(m => m.id)), byDate = {};
  for (const t of S.ticks) if (ids.has(t.member_id) && t.service_date <= today()) (byDate[t.service_date] ??= {})[t.member_id] = t.checked_at;
  const dates = Object.keys(byDate).sort(), cutoff = new Date(Date.now() - ARCHIVE_DAYS * 864e5).toISOString().slice(0, 10);
  const people = [];
  for (const m of mine) {
    if (AWAY.has(norm(m.status))) continue;
    const start = [m.date_joined, m.first_visit].filter(Boolean).sort()[0] || "0000";
    let missed = 0, seen = null;
    for (let i = dates.length - 1; i >= 0 && dates[i] >= start; i--) { if (byDate[dates[i]][m.id]) { seen = dates[i]; break; } missed++; }
    if (!seen) seen = [...dates].reverse().find(d => byDate[d][m.id]) || null;
    const sign = seen || (start !== "0000" ? start : (m.created_at || "").slice(0, 10));
    if (sign && sign < cutoff) continue;  // not seen for two years: archived
    const level = missed >= RED_AT ? "red" : missed >= YELLOW_AT ? "yellow" : "ok";
    people.push({...m, missed, seen, level, flag: level !== "ok" ? level : missed ? "blue" : "ok", kid: isKid(m)});
  }
  const last = dates[dates.length - 1], here = last ? byDate[last] : {};
  const present = mine.filter(m => here[m.id]);
  const order = {red: 0, yellow: 1, blue: 2, ok: 3};
  people.sort((a, b) => order[a.flag] - order[b.flag] || b.missed - a.missed || norm(a.full_name).localeCompare(norm(b.full_name)));
  return {mine, people, dates, byDate, last, present, kids: present.filter(isKid).length,
          first: present.filter(m => m.type === "first_timer").length,
          count: f => people.filter(p => p.flag === f).length};
}

// ---------------------------------------------------------------- page frame
const ICON = {
  dashboard: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  checkin: '<path d="M5 12l5 5 9-10"/>',
  followup: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  people: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  overview: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  out: '<path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
function pages() {
  const r = S.me.role;
  if (r === "bishop") return [["overview", "All churches"]];
  return [["dashboard", "Dashboard"], ["checkin", "Check-in"], ["followup", "Follow-up"], ["people", "People"],
          ...(r === "admin" ? [["overview", "All churches"], ["admin", "Admin"]] : [])];
}
function setMode(mode, remember) {
  document.documentElement.dataset.theme = mode;
  if (remember) { try { localStorage.setItem("fcc-mode", mode); } catch {} }
  document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === mode));
}
function render() {
  clearInterval(S.poll);
  const list = pages(), who = S.me.name || S.me.email;
  const where = S.me.role === "bishop" ? "All churches" : S.church;
  root.innerHTML = `<div class="shell">
    <div class="scrim" data-close></div>
    <aside class="side" id="menu"><div class="brand"><span class="brand-mark">✝</span>Favourite Child Church</div>
      <h6>ATTENDANCE</h6>${list.map(([k, t]) => `<button class="nav ${S.view === k ? "on" : ""}" data-view="${k}">${svg(k)}${t}</button>`).join("")}
      ${S.me.role === "admin" ? `<h6>CHURCHES</h6>${S.churches.map(c => `<button class="church ${c === S.church ? "on" : ""}" data-church="${esc(c)}"><i></i>${esc(c)}</button>`).join("")}` : ""}
      <div class="side-foot"><button class="nav out" data-out>${svg("out")}Log out</button></div></aside>
    <main class="main"><div class="top"><button class="icon-btn menu-btn" data-menu aria-label="Menu" aria-controls="menu" aria-expanded="false">${svg("menu")}</button><span class="gap"></span>
        <div class="mode" role="group" aria-label="Colour mode"><button data-mode="light">Light</button><button data-mode="dark">Dark</button></div>
        <div class="acct"><span class="acct-pic">${esc(initials(who))}</span><span><b>${esc(who)}</b><small>${ROLE[S.me.role]} · ${esc(where)}</small></span></div>
        <button class="icon-btn" data-out aria-label="Log out" title="Log out">${svg("out")}</button></div>
      <div class="body" id="view"></div></main></div>`;
  const shell = root.querySelector(".shell"), menuBtn = root.querySelector("[data-menu]");
  const menu = open => { shell.classList.toggle("open", open); menuBtn.setAttribute("aria-expanded", open); };
  menuBtn.onclick = () => menu(!shell.classList.contains("open"));
  root.querySelector("[data-close]").onclick = () => menu(false);
  document.onkeydown = e => { if (e.key === "Escape") menu(false); };
  setMode(document.documentElement.dataset.theme);
  root.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { S.view = b.dataset.view; render(); });
  root.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => setMode(b.dataset.mode, true));
  root.querySelectorAll("[data-out]").forEach(b => b.onclick = signOut);
  root.querySelectorAll("[data-church]").forEach(b => b.onclick = () => { S.church = b.dataset.church; render(); });
  ({dashboard, checkin, followup, people, overview, admin}[S.view] || dashboard)(document.getElementById("view"));
}
const head = (title, sub, buttons = "") => `<div class="head"><div><h1>${title}</h1><p>${sub}</p></div><span class="gap" style="flex:1"></span>${buttons}</div>`;
const badge = f => `<span class="badge ${f}">${FLAG[f]}</span>`;

// ---------------------------------------------------------------- dashboard
function summary(p) {
  const adults = p.present.length - p.kids;
  return [`*FCC ${S.church} · ${nice(p.last, true)}* ⛪`, `✅ Present: *${p.present.length}*`, `🧑 Adults: *${adults}* · 🧒 Kids: *${p.kids}*`,
          `👋 First-timers: *${p.first}*`, `🔴 Missed ${RED_AT}+ in a row: *${p.count("red")}*`,
          `🟡 Missed ${YELLOW_AT}–${RED_AT - 1} in a row: *${p.count("yellow")}*`].join("\n");
}
function chart(el, rows) {  // stacked bars: adults + kids per service
  const narrow = innerWidth < 640; rows = rows.slice(narrow ? -7 : -12);
  if (!rows.length) { el.innerHTML = `<p class="empty">No services recorded yet.</p>`; return; }
  const W = narrow ? 340 : 640, H = 230, L = 28, B = 26, T = 18, max = Math.max(20, Math.ceil(Math.max(...rows.map(r => r[1] + r[2])) / 20) * 20);
  const step = (W - L) / rows.length, bw = Math.min(26, step * .5), y = v => T + (H - T - B) * (1 - v / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="People present at recent services, adults and kids">`;
  for (const t of [0, .25, .5, .75, 1].map(f => Math.round(max * f))) s += `<line class="gridline" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  rows.forEach(([d, a, k], i) => {
    const cx = L + step * i + step / 2, x = cx - bw / 2, ya = y(a), yk = y(a + k), h = Math.max(ya - 2 - yk, 0);
    s += `<g class="col" tabindex="0" data-i="${i}"><rect class="hit" x="${cx - step / 2}" y="${T - 8}" width="${step}" height="${H - T - B + 8}" rx="8"/>
      <rect x="${x}" y="${ya}" width="${bw}" height="${y(0) - ya}" fill="var(--adults)"/>
      ${k ? `<path d="M${x},${ya - 2} v${-Math.max(h - 4, 0)} a4,4 0 0 1 4,-4 h${bw - 8} a4,4 0 0 1 4,4 v${Math.max(h - 4, 0)} z" fill="var(--kids)"/>` : ""}
      <text class="total" x="${cx}" y="${yk - 6}" text-anchor="middle">${a + k}</text><text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(nice(d))}</text></g>`;
  });
  el.innerHTML = `<div class="tip"></div>${s}</svg>`;
  const tip = el.querySelector(".tip");
  el.querySelectorAll("g.col").forEach(g => {
    const show = () => {
      const [d, a, k] = rows[g.dataset.i], r = g.querySelector(".hit").getBoundingClientRect(), c = el.getBoundingClientRect();
      tip.innerHTML = `<b>${esc(nice(d))}</b><br><i style="background:var(--adults)"></i>${a} adults<br><i style="background:var(--kids)"></i>${k} kids<br>${a + k} present`;
      tip.style.left = Math.max(70, Math.min(c.width - 70, r.left - c.left + r.width / 2)) + "px";
      tip.style.top = (g.querySelector(".total").getBoundingClientRect().top - c.top) + "px"; tip.style.opacity = 1;
    };
    g.onpointerenter = g.onfocus = show; g.onpointerleave = g.onblur = () => tip.style.opacity = 0;
  });
}
function rowsHtml(list, cols) {
  return list.map(p => `<tr><td><div class="who"><span>${esc(initials(p.full_name))}</span>${esc(p.full_name)}</div></td><td>${badge(p.flag)}</td><td>${p.missed}</td>
    <td class="muted hide-sm">${esc(nice(p.seen))}</td>${cols ? `<td class="muted hide-sm">${esc(p.pastor || "")}</td>` : ""}<td class="muted">${esc(p.phone || "")}</td></tr>`).join("");
}
function dashboard(el) {
  const p = picture(), kidIds = new Set(p.mine.filter(isKid).map(m => m.id));
  const series = p.dates.map(d => { const ids = Object.keys(p.byDate[d]), k = ids.filter(i => kidIds.has(i)).length; return [d, ids.length - k, k]; });
  const need = p.people.filter(x => x.level !== "ok");
  el.innerHTML = head("Dashboard", p.last ? `${esc(S.names[p.last] || "Service")} · ${esc(nice(p.last, true))}` : "No services recorded yet",
    `<button class="pill-btn hide-sm" id="wa">Summary for WhatsApp</button><button class="pill-btn primary" data-go="checkin">${svg("checkin")}Check people in</button>`) + `
    <textarea id="wa-box" class="in" rows="6" hidden style="margin-bottom:14px"></textarea>
    <div class="tiles">
      <div class="card tile"><div class="label">This service</div><div class="num">${p.present.length}<small>present</small></div></div>
      <div class="card tile"><div class="label">Adults</div><div class="num">${p.present.length - p.kids}</div></div>
      <div class="card tile"><div class="label">Kids</div><div class="num">${p.kids}</div></div>
      <div class="card tile"><div class="label">First-timers</div><div class="num">${p.first}</div></div></div>
    <div class="grid-2"><div class="card"><div class="card-head"><h2>People present</h2><span class="gap"></span>
        <div class="legend"><span><i style="background:var(--adults)"></i>Adults</span><span><i style="background:var(--kids)"></i>Kids</span></div></div>
        <div class="chart" id="chart"></div></div>
      <div class="card"><div class="card-head"><h2>Where everyone stands</h2></div>
        ${[["ok", "came this service"], ["blue", "missed this service"], ["yellow", `missed ${YELLOW_AT}–${RED_AT - 1} in a row`], ["red", `missed ${RED_AT} or more`]].map(([f, t]) =>
          `<div class="status-row">${badge(f)}<span class="txt"><small>${t}</small></span><b>${p.count(f)}</b></div>`).join("")}</div></div>
    <div class="card"><div class="card-head"><h2>Needs a follow-up call</h2><span class="gap"></span><button class="pill-btn" data-go="followup">See all ${need.length}</button></div>
      ${need.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Missed in a row</th><th class="hide-sm">Last seen</th><th>Phone</th></tr></thead>
        <tbody>${rowsHtml(need.slice(0, 6))}</tbody></table></div>` : `<p class="empty">Nobody has missed ${YELLOW_AT} or more services in a row.</p>`}</div>`;
  chart(el.querySelector("#chart"), series);
  el.querySelector("#wa").onclick = () => copy(summary(p));
  el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { S.view = b.dataset.go; render(); });
}

// ---------------------------------------------------------------- check-in
async function log(kind, member_id, result = "done", detail = "") {
  try { await api("activity_log", {method: "POST", prefer: "return=minimal", body: {id: newId() + newId(), at: isoLocal(), kind, service_date: S.date,
    member_id, detail, by_name: `${S.me.name || S.me.email} (${ROLE[S.me.role]})`, result}}); } catch {}
}
async function setPresent(id, on, seen) {
  if (on) {
    await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, name: "Sunday Service"}});
    const at = isoLocal();
    await api("attendance?on_conflict=service_date,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, member_id: id, checked_at: at}});
    log("tick", id); return "done";
  }
  // only remove the tick this phone was showing; a newer tick from another phone is left alone
  const gone = await api(`attendance?service_date=eq.${S.date}&member_id=eq.${encodeURIComponent(id)}${seen ? "&checked_at=eq." + encodeURIComponent(seen) : ""}`, {method: "DELETE", prefer: "return=representation"});
  const result = gone?.length ? "done" : "changed";
  log("untick", id, result); return result;
}
function checkin(el) {
  const mine = S.members.filter(m => churchOf(m) === S.church && !AWAY.has(norm(m.status))).sort((a, b) => norm(a.full_name).localeCompare(norm(b.full_name)));
  let here = {};
  el.innerHTML = head("Check-in", `${esc(S.church)} · tick people as they arrive`) + `
    <div class="card" style="margin-bottom:14px"><div class="row">
      <div style="flex:0 0 170px"><label class="f" for="d">Service date</label><input class="in" id="d" type="date" value="${S.date}"></div>
      <div><label class="f" for="q">Find a person</label><input class="in" id="q" placeholder="Type a name…" value="${esc(S.q)}"></div></div></div>
    <div class="tiles"><div class="card tile"><div class="label">Checked in</div><div class="num" id="n-in">0</div></div>
      <div class="card tile"><div class="label">Adults</div><div class="num" id="n-ad">0</div></div>
      <div class="card tile"><div class="label">Kids</div><div class="num" id="n-kid">0</div></div>
      <div class="card tile"><div class="label">Not yet</div><div class="num" id="n-not">0</div></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Names A to Z</h2><span class="gap"></span><span id="shown" style="color:var(--ink-3);font-size:13px"></span></div>
      <div class="names" id="names"></div></div>
    <form class="card" id="add"><div class="card-head"><h2>Add someone new and check them in</h2></div><div class="row">
      <div><label class="f" for="a-name">Full name</label><input class="in" id="a-name" required></div>
      <div><label class="f" for="a-phone">Phone</label><input class="in" id="a-phone"></div>
      <div><label class="f" for="a-type">They are a</label><select class="in" id="a-type"><option value="first_timer">First-timer</option><option value="member">Member</option></select></div>
      <div><label class="f" for="a-age">Adult or child</label><select class="in" id="a-age"><option>Adult</option><option>Child</option></select></div>
      <div style="flex:0 0 auto"><button class="pill-btn primary">Add &amp; check in</button></div></div></form>`;
  const box = el.querySelector("#names");
  const draw = () => {
    const shown = mine.filter(m => !S.q || norm(m.full_name).includes(norm(S.q)));
    box.innerHTML = shown.map(m => `<label class="name ${here[m.id] ? "on" : ""}"><input type="checkbox" data-id="${esc(m.id)}" ${here[m.id] ? "checked" : ""}>
      <span>${esc(m.full_name)}</span><small>${m.type === "first_timer" ? "first-timer" : ""}${isKid(m) ? " child" : ""}</small></label>`).join("") || `<p class="empty">Nobody matches.</p>`;
    el.querySelector("#shown").textContent = `showing ${shown.length} of ${mine.length}`;
    const ids = mine.filter(m => here[m.id]), kids = ids.filter(isKid).length;
    el.querySelector("#n-in").textContent = ids.length; el.querySelector("#n-ad").textContent = ids.length - kids;
    el.querySelector("#n-kid").textContent = kids; el.querySelector("#n-not").textContent = mine.length - ids.length;
  };
  const pull = async () => {
    const rows = await api(`attendance?select=member_id,checked_at&service_date=eq.${S.date}`).catch(() => null);
    if (!rows || S.view !== "checkin") return;
    here = Object.fromEntries(rows.map(r => [r.member_id, r.checked_at]));
    S.ticks = S.ticks.filter(t => t.service_date !== S.date).concat(rows.map(r => ({...r, service_date: S.date})));
    if (document.activeElement?.type !== "checkbox") draw();
  };
  box.onchange = async e => {
    const id = e.target.dataset.id, on = e.target.checked, seen = here[id];
    e.target.closest(".name").classList.toggle("on", on);
    try {
      const result = await setPresent(id, on, seen);
      if (result === "changed") toast("That tick was changed on another phone, so it was left as it is.");
    } catch (err) { toast("Not saved: " + err.message); }
    e.target.blur(); pull();
  };
  el.querySelector("#q").oninput = e => { S.q = e.target.value; draw(); };
  el.querySelector("#d").onchange = e => { S.date = e.target.value || today(); here = {}; draw(); pull(); };
  el.querySelector("#add").onsubmit = async e => {
    e.preventDefault();
    const name = el.querySelector("#a-name").value.trim().replace(/\s+/g, " "), type = el.querySelector("#a-type").value;
    if (!name) return;
    const known = S.members.find(m => churchOf(m) === S.church && norm(m.full_name) === norm(name));
    const id = known?.id || newId();
    try {
      if (!known) {
        const m = {id, full_name: name, phone: el.querySelector("#a-phone").value.trim(), type, status: "", age_group: el.querySelector("#a-age").value,
                   church: S.church, created_at: isoLocal(), [type === "first_timer" ? "first_visit" : "date_joined"]: S.date};
        await api("members", {method: "POST", prefer: "return=minimal", body: m});
        S.members.push(m); mine.push(m); mine.sort((a, b) => norm(a.full_name).localeCompare(norm(b.full_name)));
      }
      await setPresent(id, true);
      e.target.reset(); toast(`${name} is checked in${known ? " (already on the list)" : ""}.`); pull();
    } catch (err) { toast("Not saved: " + err.message); }
  };
  draw(); pull(); S.poll = setInterval(pull, 5000);
}

// ---------------------------------------------------------------- follow-up and people
function followup(el) {
  const p = picture(), tabs = {need: "Needs follow-up", red: "Red only", yellow: "Yellow only", blue: "Missed this service", all: "Everyone"};
  const pick = {need: x => x.level !== "ok", red: x => x.flag === "red", yellow: x => x.flag === "yellow", blue: x => x.missed >= 1, all: () => true};
  const list = p.people.filter(pick[S.filter]);
  el.innerHTML = head("Follow-up", `${esc(S.church)} · blue is a heads-up, yellow and red need a call`,
    `<button class="pill-btn" id="dl">Download this list</button>`) + `
    <div class="chips">${Object.entries(tabs).map(([k, t]) => `<button class="chip ${S.filter === k ? "on" : ""}" data-f="${k}">${t}</button>`).join("")}</div>
    <div class="card"><div class="card-head"><h2>${tabs[S.filter]}</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${list.length} people</span></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Missed in a row</th><th class="hide-sm">Last seen</th><th class="hide-sm">Pastor</th><th>Phone</th></tr></thead>
      <tbody>${rowsHtml(list, true)}</tbody></table></div>` : `<p class="empty">Nobody in this list.</p>`}</div>`;
  el.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.filter = b.dataset.f; render(); });
  el.querySelector("#dl").onclick = () => download(`${norm(tabs[S.filter]).replace(/ /g, "_")}_${S.church}_${today()}.csv`,
    [["Church", "Name", "Status", "Missed in a row", "Last seen", "Phone", "Pastor", "Adult / Child"],
     ...list.map(x => [S.church, x.full_name, FLAG[x.flag], x.missed, x.seen || "", x.phone || "", x.pastor || "", x.kid ? "Child" : "Adult"])]);
}
function people(el) {
  const mine = S.members.filter(m => churchOf(m) === S.church).sort((a, b) => norm(a.full_name).localeCompare(norm(b.full_name)));
  const edit = S.me.role !== "team", statuses = ["", "Away", "Inactive", "Moved", "Left", "Transferred", "Deceased"];
  el.innerHTML = head("People", `${esc(S.church)} · ${mine.length} on the register`, `<button class="pill-btn" id="dl">Download</button>`) + `
    <div class="card"><div class="scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Adult / Child</th><th>Status</th><th>Pastor</th><th>Phone</th>${S.me.role === "admin" ? "<th>Church</th>" : ""}</tr></thead><tbody>
    ${mine.map(m => `<tr data-id="${esc(m.id)}"><td><div class="who"><span>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</div></td>
      <td class="muted">${m.type === "first_timer" ? "First-timer" : "Member"}</td>
      <td>${edit ? `<select class="in" data-k="age_group"><option ${isKid(m) ? "" : "selected"}>Adult</option><option ${isKid(m) ? "selected" : ""}>Child</option></select>` : (isKid(m) ? "Child" : "Adult")}</td>
      <td>${edit ? `<select class="in" data-k="status">${statuses.map(s => `<option value="${s}" ${norm(m.status) === norm(s) ? "selected" : ""}>${s || "Active"}</option>`).join("")}</select>` : esc(m.status || "Active")}</td>
      <td>${edit ? `<input class="in" data-k="pastor" value="${esc(m.pastor || "")}" style="min-width:130px">` : esc(m.pastor || "")}</td>
      <td class="muted">${esc(m.phone || "")}</td>
      ${S.me.role === "admin" ? `<td><select class="in" data-k="church">${S.churches.map(c => `<option ${c === churchOf(m) ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></td>` : ""}</tr>`).join("")}
    </tbody></table></div>${mine.length ? "" : `<p class="empty">Nobody on this register yet. Add people from Check-in.</p>`}</div>`;
  el.querySelector("tbody").onchange = async e => {
    const id = e.target.closest("tr").dataset.id, k = e.target.dataset.k, v = e.target.value.trim(), m = S.members.find(x => x.id === id);
    try { await api(`members?id=eq.${encodeURIComponent(id)}`, {method: "PATCH", prefer: "return=minimal", body: {[k]: v}}); m[k] = v; toast("Saved."); if (k === "church") render(); }
    catch (err) { toast("Not saved: " + err.message); render(); }
  };
  el.querySelector("#dl").onclick = () => download(`people_${S.church}_${today()}.csv`, [["Church", "Name", "Type", "Adult / Child", "Status", "Pastor", "Phone"],
    ...mine.map(m => [S.church, m.full_name, m.type === "first_timer" ? "First-timer" : "Member", isKid(m) ? "Child" : "Adult", m.status || "Active", m.pastor || "", m.phone || ""])]);
}

// ---------------------------------------------------------------- all churches (numbers only) and admin
async function overview(el) {
  el.innerHTML = head("All churches", "Every branch side by side. Numbers only, no names.") + `<p class="empty">Loading…</p>`;
  let rows;
  try { rows = await api("rpc/church_numbers", {method: "POST", body: {}}); } catch (e) { el.innerHTML = head("All churches", "") + `<div class="msg bad">${esc(e.message)}</div>`; return; }
  if (S.view !== "overview") return;
  const sum = k => rows.reduce((n, r) => n + (r[k] || 0), 0), top = Math.max(1, ...rows.flatMap(r => r.trend || []));
  const text = [`*FCC · all churches · ${nice(today(), true)}* ⛪`, `✅ Present: *${sum("present")}* (🧑 ${sum("adults")} adults · 🧒 ${sum("kids")} kids)`, `👋 First-timers: *${sum("first_timers")}*`, "",
    ...rows.map(r => `*${r.church}*${r.latest ? ` (${nice(r.latest)})` : ""}: ${r.present} present · ${r.adults} adults · ${r.kids} kids · ${r.first_timers} first-timers · 🔴 ${r.red} 🟡 ${r.yellow}`)].join("\n");
  el.innerHTML = head("All churches", "Every branch side by side. Numbers only, no names.", `<button class="pill-btn" id="wa">Summary for WhatsApp</button><button class="pill-btn" id="dl">Download</button>`) + `
    <textarea id="wa-box" class="in" rows="6" hidden style="margin-bottom:14px"></textarea>
    <div class="tiles"><div class="card tile"><div class="label">Churches</div><div class="num">${rows.length}</div></div>
      <div class="card tile"><div class="label">Present · latest services</div><div class="num">${sum("present")}</div></div>
      <div class="card tile"><div class="label">Adults and kids</div><div class="num">${sum("adults")}<small>+ ${sum("kids")} kids</small></div></div>
      <div class="card tile"><div class="label">Need a follow-up call</div><div class="num">${sum("red") + sum("yellow")}</div></div></div>
    <div class="card"><div class="scroll"><table><thead><tr><th>Church</th><th>Latest service</th><th>Present</th><th>Adults</th><th>Kids</th><th>First-timers</th><th>On the register</th><th>Red</th><th>Yellow</th><th>Missed this service</th><th>Recent services</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><b>${esc(r.church)}</b></td><td class="muted">${r.latest ? esc(nice(r.latest)) : "None yet"}</td><td>${r.present}</td><td>${r.adults}</td><td>${r.kids}</td><td>${r.first_timers}</td><td>${r.register}</td>
      <td>${r.red}</td><td>${r.yellow}</td><td>${r.missed_this}</td><td><span class="spark" title="${(r.trend || []).join(", ")}">${(r.trend || []).map(n => `<i style="height:${Math.max(2, Math.round(22 * n / top))}px"></i>`).join("")}</span></td></tr>`).join("")}
    </tbody></table></div></div>`;
  el.querySelector("#wa").onclick = () => copy(text);
  el.querySelector("#dl").onclick = () => download(`all_churches_${today()}.csv`, [["Church", "Latest service", "Present", "Adults", "Kids", "First-timers", "On the register", "Red", "Yellow", "Missed this service"],
    ...rows.map(r => [r.church, r.latest || "", r.present, r.adults, r.kids, r.first_timers, r.register, r.red, r.yellow, r.missed_this])]);
}
async function admin(el) {
  el.innerHTML = head("Admin", "Churches, and who can sign in") + `<p class="empty">Loading…</p>`;
  const users = await api("app_users?select=email,role,church,name&order=email").catch(() => []);
  if (S.view !== "admin") return;
  el.innerHTML = head("Admin", "Churches, and who can sign in") + `
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Churches</h2></div>
      <div class="chips">${S.churches.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>
      <form class="row" id="add-church"><div><label class="f" for="c-name">New church</label><input class="in" id="c-name" placeholder="e.g. Melbourne" required></div>
        <div style="flex:0 0 auto"><button class="pill-btn primary">Add church</button></div></form></div>
    <div class="card"><div class="card-head"><h2>People who can sign in</h2></div>
      <div class="scroll"><table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Church</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td>${esc(u.email)}</td><td class="muted">${esc(u.name || "")}</td><td>${ROLE[u.role]}</td><td class="muted">${esc(u.church || "All churches")}</td>
        <td>${u.email === S.me.email ? "" : `<button class="x" data-del="${esc(u.email)}">Remove</button>`}</td></tr>`).join("")}</tbody></table></div>
      <form class="row" id="add-user" style="margin-top:14px"><div><label class="f" for="u-email">Email</label><input class="in" id="u-email" type="email" required></div>
        <div><label class="f" for="u-name">Name</label><input class="in" id="u-name"></div>
        <div><label class="f" for="u-role">Role</label><select class="in" id="u-role"><option value="team">Team (ushers)</option><option value="lead">Church admin (pastor, follow-up)</option><option value="bishop">Bishop (numbers only)</option><option value="admin">Admin (everything)</option></select></div>
        <div><label class="f" for="u-church">Church</label><select class="in" id="u-church">${S.churches.map(c => `<option>${esc(c)}</option>`).join("")}</select></div>
        <div style="flex:0 0 auto"><button class="pill-btn primary">Add person</button></div></form>
      <p class="note">They sign in with this email. Nothing is sent until they ask for a sign-in link themselves.</p></div>`;
  const again = async fn => { try { await fn(); } catch (err) { toast("Not saved: " + err.message); } S.churches = (await api("churches?select=name&order=name")).map(c => c.name); render(); };
  el.querySelector("#add-church").onsubmit = e => { e.preventDefault(); const name = el.querySelector("#c-name").value.trim().replace(/\s+/g, " ");
    again(() => api("churches", {method: "POST", prefer: "return=minimal", body: {name}})); };
  el.querySelector("#add-user").onsubmit = e => { e.preventDefault(); const role = el.querySelector("#u-role").value;
    again(() => api("app_users?on_conflict=email", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {email: el.querySelector("#u-email").value.trim().toLowerCase(),
      name: el.querySelector("#u-name").value.trim(), role, church: ["admin", "bishop"].includes(role) ? null : el.querySelector("#u-church").value}})); };
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = () => again(() => api(`app_users?email=eq.${encodeURIComponent(b.dataset.del)}`, {method: "DELETE", prefer: "return=minimal"})));
}

// ---------------------------------------------------------------- go
let saved = null; try { saved = localStorage.getItem("fcc-mode"); } catch {}
setMode(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start().catch(e => fatal(e.message));
