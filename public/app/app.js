// FCC Attendance app. Plain JavaScript, no build step: it talks to Supabase's REST and Auth APIs directly.
// What a signed-in person may load is decided by the database (Row Level Security, see supabase/app_setup.sql),
// not by this file: hiding a menu item here is for tidiness, the database is what keeps churches apart.

const RED_AT = 5, YELLOW_AT = 3, ARCHIVE_DAYS = 730;
const AWAY = new Set(["inactive", "moved", "left", "deceased", "transferred", "away"]);
const ROLE = {admin: "Admin", bishop: "Bishop", lead: "Church admin", team: "Team"};
const FLAG = {red: "Red", yellow: "Yellow", blue: "Blue", ok: "On track"};
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
const rolesOf = m => String(m.role || "").split(",").map(x => x.trim().replace(/\s+/g, " ")).filter(Boolean);  // "Tech Team, Worship Team" is two roles
const byName = (a, b) => norm(a.full_name).localeCompare(norm(b.full_name));
const canApprove = () => S.me.role === "admin" || (S.me.role === "lead" && S.me.church === S.me.home);
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
function formDialog(title, fields, save, button = "Save", danger = null) {
  document.querySelectorAll(".modal").forEach(m => m.remove());
  const d = document.createElement("div");
  d.className = "modal";
  d.innerHTML = `<form class="sheet narrow" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="card-head"><h2>${esc(title)}</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
    <div class="fields">${fields.map(f => `<div><label class="f" for="fd-${f.k}">${esc(f.label)}</label>${f.type === "select"
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
    const go = d.querySelector("#fd-go"), err = d.querySelector("#fd-err"), values = Object.fromEntries(fields.map(f => [f.k, d.querySelector("#fd-" + f.k).value.trim().replace(/\s+/g, " ")]));
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

// A popup for a WhatsApp message: options on the left, a live preview on the right, then Copy.
// build({names, link}) returns the text; opts says which options this message offers.
function waDialog(title, build, opts = {}) {
  document.querySelectorAll(".modal").forEach(m => m.remove());
  const st = {names: false, link: "", follow: false, day: opts.day || ""}, d = document.createElement("div");
  const memo = () => `fcc-wa:${S.church}:${st.day}`, recall = () => { try { return JSON.parse(localStorage.getItem(memo()) || "{}"); } catch { return {}; } };
  if (opts.fields) Object.assign(st, recall());
  const toggle = (id, label, hint, on) => `<label class="switch"><span><b>${label}</b><small>${hint}</small></span><input type="checkbox" id="${id}" ${on ? "checked" : ""}><i></i></label>`;
  d.className = "modal";
  d.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="card-head"><h2>${esc(title)}</h2><span class="gap"></span><button class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
    <div class="modal-grid"><div class="opts">
        ${opts.day ? `<div class="opt"><label class="f" for="m-day">Service date</label><input class="in" id="m-day" type="date" value="${opts.day}" max="${today()}"></div>` : ""}
        ${opts.fields ? `<div class="opt fields-grid">${opts.fields.map(([k, label, kind]) => `<div class="${kind === "num" ? "" : "wide"}"><label class="f" for="m-${k}">${label}</label>
          <input class="in" id="m-${k}" data-field="${k}" ${kind === "num" ? `type="number" inputmode="numeric" min="0" placeholder="0"` : `maxlength="80"`} value="${esc(st[k] ?? "")}"></div>`).join("")}</div>` : ""}
        ${opts.noEmoji ? "" : toggle("m-emoji", "Emojis", "Turn off for a plain-text message", S.emoji)}
        ${opts.names ? toggle("m-names", "Include names", opts.fields ? "First-timers' names" : "Leave off for big group chats", false) : ""}
        ${opts.follow ? toggle("m-follow", "Include follow-up", "Who missed services, with numbers and names", false) : ""}
        ${opts.link ? `<div class="opt"><label class="f" for="m-link">Livestream link (optional)</label><input class="in" id="m-link" type="url" inputmode="url" placeholder="https://…"></div>` : ""}
      </div>
      <div class="opt"><span class="f">Preview</span><pre class="preview" id="m-text" tabindex="0"></pre></div></div>
    <div class="modal-foot"><button class="pill-btn" data-x>Close</button><button class="pill-btn" id="m-copy">Copy</button><button class="pill-btn primary" id="m-send">Open in WhatsApp</button></div></div>`;
  document.body.append(d);
  const text = d.querySelector("#m-text");
  let turn = 0;
  const draw = async () => {  // build may load numbers for the chosen day; null means there is nothing for that day
    const mine = ++turn, send = d.querySelector("#m-send"), copy = d.querySelector("#m-copy");
    let out; try { out = await build(st); } catch (err) { out = null; text.dataset.why = err.message; }
    if (mine !== turn) return;
    const none = out == null;
    text.textContent = none ? (text.dataset.why || `No summary for ${st.day ? nice(st.day, true) : "this day"}. No service was recorded.`) : out;
    delete text.dataset.why; text.classList.toggle("muted", none); send.disabled = copy.disabled = none;
  };
  const close = () => { d.remove(); document.removeEventListener("keydown", esc2); }, esc2 = e => { if (e.key === "Escape") close(); };
  d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
  document.addEventListener("keydown", esc2);
  d.querySelectorAll("[data-field]").forEach(i => i.oninput = () => { st[i.dataset.field] = i.value.trim();
    try { localStorage.setItem(memo(), JSON.stringify(Object.fromEntries((opts.fields || []).map(([k]) => [k, st[k] || ""])))); } catch {} draw(); });
  const fol = d.querySelector("#m-follow"); if (fol) fol.onchange = e => { st.follow = e.target.checked; draw(); };
  const emo = d.querySelector("#m-emoji"); if (emo) emo.onchange = e => { S.emoji = e.target.checked; try { localStorage.setItem("fcc-emoji", S.emoji ? "on" : "off"); } catch {} draw(); };
  const names = d.querySelector("#m-names"), link = d.querySelector("#m-link"), day = d.querySelector("#m-day");
  if (day) day.onchange = e => { st.day = e.target.value || opts.day; if (!e.target.value) e.target.value = opts.day;
    if (opts.fields) { const r = recall(); for (const [k] of opts.fields) { st[k] = r[k] || ""; const i = d.querySelector("#m-" + k); if (i) i.value = st[k]; } }  // each day keeps its own online numbers
    draw(); };
  if (names) names.onchange = e => { st.names = e.target.checked; draw(); };
  if (link) link.oninput = e => { st.link = e.target.value.trim(); draw(); };
  // opens WhatsApp with exactly what the preview shows (emojis, names and link as chosen); the person picks the chat and sends
  d.querySelector("#m-send").onclick = () => { window.open("https://wa.me/?text=" + encodeURIComponent(text.textContent), "_blank", "noopener"); };
  d.querySelector("#m-copy").onclick = async e => {
    try { await navigator.clipboard.writeText(text.textContent); e.target.textContent = "Copied"; toast("Copied."); setTimeout(() => { e.target.textContent = "Copy"; }, 2500); }
    catch {  // no clipboard access here: select the text so it can be copied by hand
      const r = document.createRange(); r.selectNodeContents(text); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      toast("The message is selected. Press and hold it, then choose Copy.");
    }
  };
  draw(); d.querySelector("#m-copy").focus();
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
    <label class="f" for="email">Email</label><input class="in" id="email" type="email" inputmode="email" autocapitalize="none" autocomplete="email" required>
    <div id="pw" hidden><label class="f" for="password">Password</label><input class="in" id="password" type="password" autocomplete="current-password"></div>
    <div id="code" hidden><label class="f" for="token">Code from the email</label><input class="in" id="token" inputmode="numeric" autocomplete="one-time-code"></div>
    <button class="pill-btn primary block" id="go">Email me a sign-in link</button>
    <button type="button" class="link" id="use-pw">Use a password instead</button>
    ${message ? `<div class="msg ${bad ? "bad" : ""}">${esc(message)}</div>` : ""}
    <p class="note" style="margin-top:14px">No email? Check Spam. No access? Ask your church admin.</p>
  </form></div>`;
  const f = root.querySelector("#login"), pw = f.querySelector("#pw"), code = f.querySelector("#code"), go = f.querySelector("#go");
  let had = ""; try { had = localStorage.getItem("fcc-pw") || ""; } catch {}
  if (had) setTimeout(() => { f.querySelector("#email").value ||= had; if (pw.hidden) f.querySelector("#use-pw").click(); }, 0);
  f.querySelector("#use-pw").onclick = e => {
    pw.hidden = !pw.hidden; code.hidden = true;
    go.textContent = pw.hidden ? "Email me a sign-in link" : "Sign in";
    e.target.textContent = pw.hidden ? "Use a password instead" : "Email me a link instead";
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const email = f.querySelector("#email").value.trim().toLowerCase(), wrong = emailProblem(email);
    if (wrong) { f.querySelectorAll(".msg").forEach(m => m.remove()); f.insertAdjacentHTML("beforeend", `<div class="msg bad">${esc(wrong)}</div>`); return; }
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
    S.pending = canApprove() ? await api("registrations?select=id&status=eq.pending").then(r => r.length).catch(() => 0) : 0;
  }
  render();
}
function fatal(text) { root.innerHTML = `<div class="center"><div class="login"><h1>Something went wrong</h1><p>${esc(text)}</p><button class="pill-btn block" onclick="location.reload()">Try again</button></div></div>`; }
async function signOut() { try { await auth("logout", {}, S.session?.access_token); } catch {} store.set(null); S.me = null; loginView(); }

// ---------------------------------------------------------------- data for the church being looked at
async function load() {
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const [members, ticks, services, seen, lists] = await Promise.all([
    all("members?select=id,full_name,phone,type,status,age_group,pastor,church,role,date_joined,first_visit,created_at,version&order=full_name"),
    all(`attendance?select=service_date,member_id,checked_at&service_date=gte.${since}&order=service_date`),
    all(`services?select=service_date,name&service_date=gte.${since}`),
    api("rpc/app_last_seen", {method: "POST", body: {}}).catch(() => null),  // null until the newer setup SQL has been run
    api("settings?select=key,value&key=like.pastors:*").catch(() => [])]);  // each church's list of pastors to choose from
  S.pastorList = Object.fromEntries(lists.map(r => [r.key.slice(8), (r.value || "").split("\n").map(x => x.trim()).filter(Boolean)]));
  S.seen = seen && Object.fromEntries(seen.map(r => [r.member_id, r.last_seen]));
  S.members = members; S.ticks = ticks; S.names = Object.fromEntries(services.map(s => [s.service_date, s.name]));
}
const isSunday = d => new Date(d + "T12:00:00").getDay() === 0;
function picture(upTo = today()) {  // everything the pages show, as things stood on upTo (today unless a past service is asked for)
  const mine = S.members.filter(m => churchOf(m) === S.church);
  const ids = new Set(mine.map(m => m.id)), byDate = {};
  for (const t of S.ticks) if (ids.has(t.member_id) && t.service_date <= upTo) (byDate[t.service_date] ??= {})[t.member_id] = t.checked_at;
  const dates = Object.keys(byDate).sort(), cutoff = new Date(Date.now() - ARCHIVE_DAYS * 864e5).toISOString().slice(0, 10);
  const people = [], archived = [];
  for (const m of mine) {
    if (AWAY.has(norm(m.status))) continue;
    const start = [m.date_joined, m.first_visit].filter(Boolean).sort()[0] || "0000";
    let missed = 0, seen = null;
    // only Sunday services count as missed; coming to any service (midweek too) counts as being seen
    for (let i = dates.length - 1; i >= 0 && dates[i] >= start; i--) { if (byDate[dates[i]][m.id]) { seen = dates[i]; break; } if (isSunday(dates[i])) missed++; }
    if (!seen) seen = [...dates].reverse().find(d => byDate[d][m.id]) || S.seen?.[m.id] || null;
    const sign = seen || (start !== "0000" ? start : (m.created_at || "").slice(0, 10));
    if (sign && sign < cutoff) { archived.push({...m, seen, kid: isKid(m)}); continue; }  // not seen for two years
    const level = missed >= RED_AT ? "red" : missed >= YELLOW_AT ? "yellow" : "ok";
    people.push({...m, missed, seen, level, flag: level !== "ok" ? level : missed ? "blue" : "ok", kid: isKid(m)});
  }
  const last = dates[dates.length - 1], here = last ? byDate[last] : {};
  const present = mine.filter(m => here[m.id]);
  const order = {red: 0, yellow: 1, blue: 2, ok: 3};
  people.sort((a, b) => order[a.flag] - order[b.flag] || b.missed - a.missed || norm(a.full_name).localeCompare(norm(b.full_name)));
  return {mine, people, archived, dates, byDate, last, here, present, kids: present.filter(isKid).length,
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
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  pastors: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a7 7 0 0 1 4 6.5"/>',
  person: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  signups: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h5"/>',
  archive: '<rect x="3" y="5" width="18" height="4" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  reports: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 8l9 6 9-6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><path d="M12 17h.01"/>',
  out: '<path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
function pages() {  // the menu, in groups; what each role can actually load is decided by the database
  const r = S.me.role;
  if (r === "bishop") return [["", [["overview", "All churches"], ["help", "Help"]]]];
  return [["ATTENDANCE", [["dashboard", "Dashboard"], ["checkin", "Check-in"], ["followup", "Follow-up"], ["pastors", "Pastors"]]],
          ["PEOPLE", [["people", "Congregation"], ...(canApprove() ? [["signups", "Sign-ups"]] : []), ["archive", "Archive"]]],
          ...(r === "team" ? [] : [["RECORDS", [["activity", "Activity"], ["reports", "Reports"],
            ...(r === "admin" ? [["overview", "Churches"], ["admin", "Admin"]] : [])]]]),
          ["", [["help", "Help"]]]];
}
function setMode(mode, remember) {
  document.documentElement.dataset.theme = mode;
  if (remember) { try { localStorage.setItem("fcc-mode", mode); } catch {} }
  document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === mode));
}
function render() {
  clearInterval(S.poll);
  if (S.shown && S.shown !== S.view && !S.goingBack) {  // moved to another page: remember where from
    S.hist = [...(S.hist || []), S.shown].slice(-30);
    try { history.pushState({fcc: S.hist.length}, ""); } catch {}
  }
  S.goingBack = false; S.shown = S.view;
  const groups = pages(), who = S.me.name || S.me.email, allowed = [...groups.flatMap(g => g[1].map(x => x[0])), "account", ...(S.me.role === "bishop" ? [] : ["person"])];
  if (!allowed.includes(S.view)) S.view = allowed[0];
  const short = {dashboard: "Home", overview: "Churches", people: "Congregation"};  // the bottom bar on phones: the four most-used pages, then More
  const dock = groups.flatMap(g => g[1]).filter(x => ["dashboard", "checkin", "followup", "people", "overview"].includes(x[0])).slice(0, 4).map(([k, t]) => [k, short[k] || t]);
  const go = to => { S.view = to; render(); };
  const where = S.me.role === "bishop" ? "All churches" : S.church;
  root.innerHTML = `<div class="shell">
    <div class="scrim" data-close></div>
    <aside class="side" id="menu"><div class="brand"><span class="brand-mark">✝</span>Favourite Child Church</div>
      ${groups.map(([h, items]) => (h ? `<h6>${h}</h6>` : "") + items.map(([k, t]) => `<button class="nav ${S.view === k ? "on" : ""}" data-view="${k}">${svg(k)}${t}${
        k === "signups" && S.pending ? `<span class="count">${S.pending}</span>` : ""}</button>`).join("")).join("")}
      ${S.me.role === "admin" ? `<h6>CHURCH</h6><button class="church on" data-view="overview" title="See every church and switch to another one"><i></i><span>${esc(S.church)}</span><em>Change</em></button>` : ""}
      <div class="side-foot"><button class="nav out" data-out>${svg("out")}Log out</button></div></aside>
    <main class="main"><div class="top">${S.hist?.length ? `<button class="back" data-back>${svg("back")}Back</button>` : ""}<span class="gap"></span>
        <div class="mode" role="group" aria-label="Colour mode"><button data-mode="light">Light</button><button data-mode="dark">Dark</button></div>
        <button class="acct" data-view="account" title="Your account" aria-label="Your account"><span class="acct-pic">${esc(initials(who))}</span><span><b>${esc(who)}</b><small>${ROLE[S.me.role]} · ${esc(where)}</small></span></button>
        <button class="icon-btn" data-out aria-label="Log out" title="Log out">${svg("out")}</button></div>
      <div class="body" id="view"></div></main>
    <nav class="dock" aria-label="Main">${dock.map(([k, t]) => `<button class="${S.view === k ? "on" : ""} ${t.length > 9 ? "long" : ""}" data-view="${k}" aria-label="${t}">${svg(k)}<span>${t}</span></button>`).join("")}
      <button class="${dock.some(x => x[0] === S.view) ? "" : "on"}" data-menu aria-label="More" aria-controls="menu" aria-expanded="false">${svg("more")}<span>More</span></button></nav></div>`;
  const shell = root.querySelector(".shell"), menuBtn = root.querySelector("[data-menu]");
  const menu = open => { shell.classList.toggle("open", open); menuBtn.setAttribute("aria-expanded", open); };
  menuBtn.onclick = () => menu(!shell.classList.contains("open"));
  root.querySelector("[data-close]").onclick = () => menu(false);
  document.onkeydown = e => { if (e.key === "Escape") menu(false); };
  setMode(document.documentElement.dataset.theme);
  root.querySelectorAll("[data-view]").forEach(b => b.onclick = () => go(b.dataset.view));
  root.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => setMode(b.dataset.mode, true));
  root.querySelectorAll("[data-out]").forEach(b => b.onclick = signOut);
  const view = document.getElementById("view");
  view.onclick = e => { const b = e.target.closest("[data-person]"); if (b) { S.person = b.dataset.person; go("person"); } };
  root.querySelectorAll("[data-back]").forEach(b => b.onclick = () => history.back());  // same as the phone's back gesture
  ({dashboard, checkin, followup, pastors, people, person, signups, archive, activity, reports, overview, admin, account, help}[S.view] || dashboard)(view);
}
// The phone's back gesture (and the Back button, which uses it) returns to the page you came from.
addEventListener("popstate", () => {
  if (!S.me || !S.hist?.length) return;
  S.view = S.hist.pop(); S.goingBack = true; document.querySelectorAll(".modal").forEach(m => m.remove()); render();
});
const TITLE = {dashboard: "Dashboard", checkin: "Check-in", followup: "Follow-up", pastors: "Pastors", people: "Congregation", person: "Person", account: "Your account", help: "Help", signups: "Sign-ups", archive: "Archive",
               activity: "Activity", reports: "Reports", overview: "All churches", admin: "Admin"};
const head = (title, sub, buttons = "") => `<div class="head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><span class="gap" style="flex:1"></span>${buttons}</div>`;
const badge = f => `<span class="badge ${f}">${FLAG[f]}</span>`;

// ---------------------------------------------------------------- dashboard
// The church's standard attendance message. No emojis. Online numbers, preacher and sermon are typed in the popup;
// adults and children "Attending" come from the ticks. Follow-up is added only when asked for.
const dmy = d => d.split("-").reverse().join("/");
function report(p, o = {}) {
  const day = p.last, kidsIn = p.kids, adultsIn = p.present.length - kidsIn, n = k => Math.max(0, parseInt(o[k], 10) || 0);
  const adults = adultsIn + n("zoomA") + n("yt") + n("fb"), kids = kidsIn + n("zoomK");
  const firsts = p.present.filter(m => m.type === "first_timer");
  const out = [`${svcName(day).toUpperCase()} ATTENDANCE`, "", `DAY - ${new Date(day + "T12:00:00").toLocaleDateString("en-NZ", {weekday: "long"}).toUpperCase()}`, "",
    `DATE - ${dmy(day)}`, "", `PREACHER NAME - ${o.preacher || ""}`, "", `SERMON TITLE: ${o.sermon || ""}`, "", `BRANCH/MISSION - ${S.church}`, "",
    `*ADULTS - ${adults}`, `[Attending: Adults - ${adultsIn}]`, `[Zoom: Adults - ${n("zoomA")}]`, `[Youtube -  ${n("yt")}]`, `[Facebook -  ${n("fb")}]`, "",
    `*CHILDREN - ${kids}`, `[Attending - ${kidsIn}]`, `[Zoom - ${n("zoomK")}]`, "",
    `First timers - ${firsts.length}`, ...(o.names && firsts.length ? [firsts.map(m => m.full_name).join(", ")] : []), "",
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
    ["✅", `Present: *${p.present.length}*`], ["🧑", `Adults: *${p.present.length - p.kids}*`], ["🧒", `Kids: *${p.kids}*`],
    ["👋", `First-timers: *${p.first}*`], ...who(p.present.filter(m => m.type === "first_timer")), "", "*Follow-up*",
    ["🔴", `Missed ${RED_AT}+ in a row: *${p.count("red")}*`], ...who(flagged("red")),
    ["🟡", `Missed ${YELLOW_AT}–${RED_AT - 1} in a row: *${p.count("yellow")}*`], ...who(flagged("yellow")),
    ...(o.link ? ["", ["📺", `Livestream: ${o.link}`]] : [])]);
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
    g.onclick = g.onkeydown = e => { if (e.type === "keydown" && e.key !== "Enter") return; S.date = rows[g.dataset.i][0]; S.view = "checkin"; render(); };
  });
}
const whoBtn = m => `<button class="who" data-person="${esc(m.id)}" title="See their attendance history"><span>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</button>`;
function donut(el, parts) {  // parts: [flag, label, count]; a ring with a gap between segments and the total in the middle
  const total = parts.reduce((n, x) => n + x[2], 0), R = 54, C = 2 * Math.PI * R, gap = total && parts.filter(x => x[2]).length > 1 ? 3 : 0;
  let at = 0, s = `<svg viewBox="0 0 140 140" role="img" aria-label="Where everyone stands: ${parts.map(x => `${x[2]} ${x[1]}`).join(", ")}">
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
function dashboard(el) {
  const p = picture(), kidIds = new Set(p.mine.filter(isKid).map(m => m.id));
  const series = p.dates.map(d => { const ids = Object.keys(p.byDate[d]), k = ids.filter(i => kidIds.has(i)).length; return [d, ids.length - k, k]; });
  const need = p.people.filter(x => x.level !== "ok");
  const stands = [["ok", "came this service"], ["blue", "missed this service"], ["yellow", `missed ${YELLOW_AT}–${RED_AT - 1} in a row`], ["red", `missed ${RED_AT} or more`]].map(([f, t]) => [f, t, p.count(f)]);
  el.innerHTML = head("Dashboard", p.last ? `${esc(S.names[p.last] || "Service")} · ${esc(nice(p.last, true))}` : "No services recorded yet",
    `<button class="pill-btn" id="wa">Summary for WhatsApp</button><button class="pill-btn primary" data-go="checkin">${svg("checkin")}Check people in</button>`) + `
    <div class="tiles">
      <div class="card tile"><div class="label">This service</div><div class="num">${p.present.length}<small>present</small></div></div>
      <div class="card tile"><div class="label">Adults</div><div class="num">${p.present.length - p.kids}</div></div>
      <div class="card tile"><div class="label">Kids</div><div class="num">${p.kids}</div></div>
      <div class="card tile"><div class="label">First-timers</div><div class="num">${p.first}</div></div></div>
    <div class="grid-2"><div class="card"><div class="card-head"><h2>People present</h2><span class="gap"></span>
        <div class="legend"><span><i style="background:var(--adults)"></i>Adults</span><span><i style="background:var(--kids)"></i>Kids</span></div></div>
        <div class="chart" id="chart"></div></div>
      <div class="card" id="cal"></div></div>
    <div class="grid-2"><div class="card"><div class="card-head"><h2>Needs a follow-up call</h2><span class="gap"></span><button class="pill-btn" data-go="followup">See all ${need.length}</button></div>
      ${need.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Missed in a row</th><th class="hide-sm">Last seen</th><th>Phone</th></tr></thead>
        <tbody>${rowsHtml(need.slice(0, 6))}</tbody></table></div>` : `<p class="empty">Nobody has missed ${YELLOW_AT} or more services in a row.</p>`}</div>
      <div class="card"><div class="card-head"><h2>Where everyone stands</h2></div>
        <div class="stand"><div class="donut" id="donut"></div><div class="stand-rows">
        ${stands.map(([f, t, n]) => `<div class="status-row">${badge(f)}<span class="txt"><small>${t}</small></span><b>${n}</b></div>`).join("")}</div></div></div></div>`;
  donut(el.querySelector("#donut"), stands);
  calendar(el.querySelector("#cal"), p);
  chart(el.querySelector("#chart"), series);
  el.querySelector("#wa").onclick = () => waDialog("Summary for WhatsApp", o => !p.dates.includes(o.day) ? null : report(o.day !== p.last ? picture(o.day) : p, o), {names: true, link: true, follow: true, noEmoji: true, day: p.last || today(),
    fields: [["preacher", "Preacher name"], ["sermon", "Sermon title"], ["zoomA", "Zoom: adults", "num"], ["zoomK", "Zoom: children", "num"], ["yt", "YouTube", "num"], ["fb", "Facebook", "num"], ["converts", "New converts", "num"]]});
  el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { S.view = b.dataset.go; render(); });
  el.querySelectorAll(".tiles .tile").forEach(t => { t.classList.add("link"); t.tabIndex = 0; t.title = "Open Check-in for this service";
    t.onclick = t.onkeydown = e => { if (e.type === "keydown" && e.key !== "Enter") return; S.date = p.last || today(); S.view = "checkin"; render(); }; });
}

// ---------------------------------------------------------------- check-in
async function log(kind, member_id, result = "done", detail = "") {
  try { await api("activity_log", {method: "POST", prefer: "return=minimal", body: {id: newId() + newId(), at: isoLocal(), kind, service_date: S.date,
    member_id, detail, by_name: `${S.me.name || S.me.email} (${ROLE[S.me.role]})`, result}}); } catch {}
}
// Which team pills to show: the biggest few (plus the one in use) until "more" is tapped, then all A to Z.
const FEW = 5;
function fewKeys(keys, counts, picked, open) {
  if (open || keys.length <= FEW + 1) return {show: keys, more: 0};
  const top = [...keys].sort((a, b) => counts[b].n - counts[a].n || a.localeCompare(b)).slice(0, FEW);
  if (picked && !top.includes(picked)) top[FEW - 1] = picked;
  return {show: keys.filter(k => top.includes(k)), more: keys.length - FEW};
}
const moreChip = (more, open, total) => more ? `<button type="button" class="chip sm ghost" data-more>+${more} more</button>` : open && total > FEW + 1 ? `<button type="button" class="chip sm ghost" data-more>Show less</button>` : "";
// A service's title. Until someone types one, Sunday and Wednesday get the usual names.
const svcName = d => S.names[d] || (S.titles?.[d]) || ({0: "Sunday Service", 3: "Midweek Service"})[new Date(d + "T12:00:00").getDay()] || "Service";
async function setPresent(id, on, seen, at = isoLocal()) {
  if (on) {
    // the service row only needs saving once per date; doing it on every tick doubled the wait
    if (!S.names[S.date] && !(S.svcSaved ??= {})[S.date]) {
      await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, name: svcName(S.date)}});
      S.svcSaved[S.date] = true;
    }
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
  el.innerHTML = head("Check-in", esc(S.church)) + `
    <div class="card" style="margin-bottom:14px"><div class="row">
      <div style="flex:0 0 170px"><label class="f" for="d">Service date</label><input class="in" id="d" type="date" value="${S.date}"></div>
      <div><label class="f" for="svc">Service</label><input class="in" id="svc" list="svc-list" maxlength="60" autocomplete="off" value="${esc(svcName(S.date))}">
        <datalist id="svc-list">${[...new Set(["Sunday Service", "Midweek Service", "Prayer Meeting", "Special Service", ...Object.values(S.names)])].map(n => `<option value="${esc(n)}">`).join("")}</datalist></div>
      <div><label class="f" for="q">Search</label><div style="display:flex;gap:8px;align-items:center"><input class="in" id="q" type="search" placeholder="Name or team" value="${esc(S.q)}" style="flex:1;min-width:0">
        <button type="button" class="pill-btn sm" id="ci-tg" hidden aria-controls="ci-roles">Teams</button></div></div></div>
      <div class="chips" id="ci-roles" style="margin:12px 0 0"></div></div>
    <div class="tiles"><div class="card tile"><div class="label">Checked in</div><div class="num" id="n-in">0</div></div>
      <div class="card tile"><div class="label">Adults</div><div class="num" id="n-ad">0</div></div>
      <div class="card tile"><div class="label">Kids</div><div class="num" id="n-kid">0</div></div>
      <div class="card tile"><div class="label">Not yet</div><div class="num" id="n-not">0</div></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2 id="ci-title">Names A to Z</h2><span class="gap"></span><span id="shown" style="color:var(--ink-3);font-size:13px"></span><button type="button" class="pill-btn sm" id="ci-lock">${svg("lock")}Save &amp; lock</button></div>
      <div class="bulk" id="ci-bulk" hidden style="position:static;box-shadow:none"><b id="ci-count"></b><span class="gap"></span><button type="button" class="pill-btn sm primary" id="ci-all">Tick all</button><button type="button" class="pill-btn sm" id="ci-none">Untick all</button></div>
      <div class="msg locked" id="ci-locked" hidden></div>
      <div class="names" id="names"></div>
      <div style="margin-top:12px;text-align:right" id="ci-clear-wrap" hidden><button type="button" class="pill-btn sm" id="ci-clear">Untick everyone</button></div></div>
    <form class="card" id="add"><div class="card-head"><h2>Add someone new</h2></div><div class="row">
      <div><label class="f" for="a-name">Full name</label><input class="in" id="a-name" required></div>
      <div><label class="f" for="a-phone">Phone <span class="req" id="a-phone-req">*</span></label><input class="in" id="a-phone" type="tel" inputmode="tel" maxlength="20" autocomplete="off"></div>
      <div><label class="f" for="a-type">Attendance Type</label><select class="in" id="a-type"><option value="first_timer">First-timer</option><option value="member">Member</option></select></div>
      <div><label class="f" for="a-age">Age group</label><select class="in" id="a-age"><option>Adult</option><option>Child</option></select></div>
      <div style="flex:0 0 auto;display:flex;gap:8px;flex-wrap:wrap"><button class="pill-btn primary">Add &amp; check in</button><button class="pill-btn" data-only>Add only</button></div></div>
      </form>`;
  const box = el.querySelector("#names");
  const teams = {};  // each role in this church with how many people have it
  for (const m of mine) for (const r of new Set(rolesOf(m).map(norm))) (teams[r] ??= {label: rolesOf(m).find(x => norm(x) === r), n: 0}).n++;
  if (S.ciRole && !teams[S.ciRole]) S.ciRole = "";
  const chips = el.querySelector("#ci-roles"), teamKeys = Object.keys(teams).sort();
  let teamsOn = true; try { teamsOn = localStorage.getItem("fcc-teams") !== "off"; } catch {}
  const tg = el.querySelector("#ci-tg"); tg.hidden = !teamKeys.length;
  tg.onclick = () => {  // hide or bring back the team pills; hiding also goes back to everyone so no filter is left on unseen
    teamsOn = !teamsOn; try { localStorage.setItem("fcc-teams", teamsOn ? "on" : "off"); } catch {}
    if (!teamsOn) S.ciRole = ""; armed = false; drawChips(); draw();
  };
  const drawChips = () => { tg.setAttribute("aria-expanded", teamsOn); tg.classList.toggle("primary", teamsOn); chips.hidden = !teamsOn;
    const few = fewKeys(teamKeys, teams, S.ciRole, S.ciMore);
    chips.innerHTML = teamKeys.length ? `<button type="button" class="chip sm ${S.ciRole ? "" : "on"}" data-team="">Everyone</button>` +
    few.show.map(k => `<button type="button" class="chip sm ${S.ciRole === k ? "on" : ""}" data-team="${esc(k)}">${esc(teams[k].label)} · ${teams[k].n}</button>`).join("") + moreChip(few.more, S.ciMore, teamKeys.length) : ""; };
  chips.onclick = e => { if (e.target.closest("[data-more]")) { S.ciMore = !S.ciMore; drawChips(); return; }
    const b = e.target.closest("[data-team]"); if (!b) return; S.ciRole = b.dataset.team; armed = false; drawChips(); draw(); };
  let armed = false, armedAll = false, busy = false;
  const showing = () => { const q = norm(S.q);
    return mine.filter(m => (!S.ciRole || rolesOf(m).some(r => norm(r) === S.ciRole)) && (!q || norm(m.full_name).includes(q) || rolesOf(m).some(r => norm(r).includes(q)))); };
  const draw = () => {
    const shown = showing(), narrowed = !!(S.ciRole || norm(S.q)), ticked = shown.filter(m => here[m.id]).length;
    box.innerHTML = shown.map(m => `<label class="name ${here[m.id] ? "on" : ""}"><input type="checkbox" data-id="${esc(m.id)}" ${here[m.id] ? "checked" : ""} ${lock ? "disabled" : ""}>
      <span>${esc(m.full_name)}</span><small>${[narrowed ? rolesOf(m).join(", ") : "", m.type === "first_timer" ? "first-timer" : "", isKid(m) ? "child" : ""].filter(Boolean).map(esc).join(" · ")}</small></label>`).join("") || `<p class="empty">Nobody matches.</p>`;
    el.querySelector("#shown").textContent = `showing ${shown.length} of ${mine.length}`;
    el.querySelector("#ci-title").textContent = S.ciRole ? teams[S.ciRole].label : "Names A to Z";
    // ticking a whole group is only offered once the list is narrowed to a team or a search, never for the whole church
    const bar = el.querySelector("#ci-bulk"); bar.hidden = !narrowed || !shown.length;
    el.querySelector("#ci-count").textContent = `${ticked} of ${shown.length} here`;
    const all = el.querySelector("#ci-all"), none = el.querySelector("#ci-none");
    all.textContent = `Tick all ${shown.length}`; all.disabled = busy || ticked === shown.length;
    none.textContent = armed ? `Tap again to untick ${ticked}` : "Untick all"; none.disabled = busy || !ticked || !!lock; all.disabled = all.disabled || !!lock;
    // clearing the whole service is for admins and church admins, and only from the full list
    const total = mine.filter(m => here[m.id]).length, wrap = el.querySelector("#ci-clear-wrap"), clear = el.querySelector("#ci-clear");
    wrap.hidden = narrowed || !total || S.me.role === "team";
    clear.textContent = armedAll ? `Tap again to untick all ${total}` : "Untick everyone"; clear.disabled = busy || !!lock;
    const ids = mine.filter(m => here[m.id]), kids = ids.filter(isKid).length;
    el.querySelector("#n-in").textContent = ids.length; el.querySelector("#n-ad").textContent = ids.length - kids;
    el.querySelector("#n-kid").textContent = kids; el.querySelector("#n-not").textContent = mine.length - ids.length;
  };
  const pull = async () => {
    const rows = await api(`attendance?select=member_id,checked_at&service_date=eq.${S.date}`).catch(() => null);
    readLock();
    if (!rows || S.view !== "checkin") return;
    here = Object.fromEntries(rows.map(r => [r.member_id, r.checked_at]));
    for (const [id, v] of pending) { if (v) here[id] ??= v; else delete here[id]; }  // taps still saving win over an older copy from the server
    S.ticks = S.ticks.filter(t => t.service_date !== S.date).concat(rows.map(r => ({...r, service_date: S.date})));
    if (document.activeElement?.type !== "checkbox") draw();
  };
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
      const result = await setPresent(id, on, seen, at);
      if (result === "changed") toast("That tick was changed on another phone, so it was left as it is.");
    } catch (err) {
      if (seen) here[id] = seen; else delete here[id];
      toast("Not saved: " + err.message);
    }
    pending.delete(id); draw(); pull();
  };
  el.querySelector("#q").oninput = e => { S.q = e.target.value; armed = false; draw(); };
  el.querySelector("#ci-all").onclick = async () => {
    const todo = showing().filter(m => !here[m.id]); if (!todo.length || busy) return;
    busy = true; armed = false; draw();
    try {
      await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: {service_date: S.date, name: svcName(S.date)}});
      const at = isoLocal();  // one request for the whole group; anyone already ticked on another phone is left as they are
      await api("attendance?on_conflict=service_date,member_id", {method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: todo.map(m => ({service_date: S.date, member_id: m.id, checked_at: at}))});
      for (const m of todo) { here[m.id] = at; log("tick", m.id, "done", S.ciRole ? `with ${teams[S.ciRole].label}` : "with a group"); }
      toast(`Ticked ${todo.length} ${todo.length === 1 ? "person" : "people"}. Untick anyone who isn't here.`);
    } catch (err) { toast("Not saved: " + err.message); }
    busy = false; draw(); pull();
  };
  el.querySelector("#ci-none").onclick = async () => {
    const todo = showing().filter(m => here[m.id]); if (!todo.length || busy) return;
    if (!armed) { armed = true; draw(); setTimeout(() => { if (armed) { armed = false; if (S.view === "checkin") draw(); } }, 4000); return; }
    busy = true; armed = false; draw();
    let n = 0;
    try { for (const m of todo) { if (await setPresent(m.id, false, here[m.id]) === "done") { delete here[m.id]; n++; } } toast(`Unticked ${n} ${n === 1 ? "person" : "people"}.`); }
    catch (err) { toast("Not saved: " + err.message); }
    busy = false; draw(); pull();
  };
  el.querySelector("#ci-clear").onclick = async () => {
    const todo = mine.filter(m => here[m.id]); if (!todo.length || busy) return;
    if (!armedAll) { armedAll = true; draw(); setTimeout(() => { if (armedAll) { armedAll = false; if (S.view === "checkin") draw(); } }, 4000); return; }
    busy = true; armedAll = false; draw();
    try {
      let n = 0;
      for (let i = 0; i < todo.length; i += 80) {
        const gone = await api(`attendance?service_date=eq.${S.date}&member_id=in.(${todo.slice(i, i + 80).map(m => `"${m.id}"`).join(",")})`, {method: "DELETE", prefer: "return=representation"});
        n += gone?.length || 0;
      }
      here = {}; log("clear_service", "", "done", `${n} unticked · ${S.church}`);
      toast(`Unticked ${n} ${n === 1 ? "person" : "people"}.`);
    } catch (err) { toast("Not saved: " + err.message); }
    busy = false; draw(); pull();
  };
  drawChips();
  const svc = el.querySelector("#svc");
  el.querySelector("#d").onchange = e => { S.date = e.target.value || today(); svc.value = svcName(S.date); here = {}; lock = null; draw(); showLock(); pull(); };
  svc.onchange = async () => {
    const name = svc.value.trim().replace(/\s+/g, " "), was = svcName(S.date);
    if (!name) { svc.value = was; return; }
    if (name === was) return;
    (S.titles ??= {})[S.date] = name;  // used when the first person is ticked, if the service isn't saved yet
    try {
      await api("services?on_conflict=service_date", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {service_date: S.date, name}});
      S.names[S.date] = name; log("edit", "", "done", `service title: ${name}`); toast("Saved.");
    } catch (err) {
      if (S.names[S.date]) { delete S.titles[S.date]; svc.value = was; toast(/row-level|policy|permission/i.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
      else toast("Saved.");  // nothing ticked yet: the title goes in with the first tick
    }
  };
  el.querySelector("#a-phone").oninput = digitsOnly;
  const reqMark = () => { el.querySelector("#a-phone-req").hidden = el.querySelector("#a-type").value !== "first_timer"; };
  el.querySelector("#a-type").onchange = reqMark; reqMark();
  el.querySelector("#add").onsubmit = async e => {
    e.preventDefault();
    const name = el.querySelector("#a-name").value.trim().replace(/\s+/g, " "), type = el.querySelector("#a-type").value;
    if (!name) return;
    const phone = el.querySelector("#a-phone").value.trim(), bad = phoneProblem(phone, type === "first_timer");
    if (bad) { toast(bad); el.querySelector("#a-phone").focus(); return; }
    const known = S.members.find(m => churchOf(m) === S.church && norm(m.full_name) === norm(name));
    const id = known?.id || newId(), only = e.submitter?.hasAttribute("data-only");
    try {
      if (!known) {
        const m = {id, full_name: name, phone: el.querySelector("#a-phone").value.trim(), type, status: "", age_group: el.querySelector("#a-age").value,
                   church: S.church, created_at: isoLocal(), [type === "first_timer" ? "first_visit" : "date_joined"]: S.date};
        await api("members", {method: "POST", prefer: "return=minimal", body: m});
        S.members.push(m); mine.push(m); mine.sort((a, b) => norm(a.full_name).localeCompare(norm(b.full_name)));
      }
      if (only) { e.target.reset(); toast(known ? `${name} is already on the list.` : `${name} is added to the register.`); draw(); return; }
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
  el.innerHTML = head("Follow-up", esc(S.church),
    `<button class="pill-btn" id="dl">Download this list</button>`) + `
    <div class="chips">${Object.entries(tabs).map(([k, t]) => `<button class="chip ${S.filter === k ? "on" : ""}" data-f="${k}">${t}</button>`).join("")}</div>
    <div class="card"><div class="card-head"><h2>${tabs[S.filter]}</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${list.length} people</span></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Missed in a row</th><th class="hide-sm">Last seen</th><th class="hide-sm">Pastor</th><th>Phone</th></tr></thead>
      <tbody>${rowsHtml(list, true)}</tbody></table></div>` : `<p class="empty">Nobody in this list.</p>`}</div>`;
  el.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.filter = b.dataset.f; render(); });
  el.querySelector("#dl").onclick = () => download(`${norm(tabs[S.filter]).replace(/ /g, "_")}_${S.church}_${today()}.csv`,
    [["Church", "Name", "Status", "Missed in a row", "Last seen", "Phone", "Pastor", "Age group"],
     ...list.map(x => [S.church, x.full_name, FLAG[x.flag], x.missed, x.seen || "", x.phone || "", x.pastor || "", x.kid ? "Child" : "Adult"])]);
}
function people(el) {
  const everyone = S.members.filter(m => churchOf(m) === S.church).sort(byName);
  const counts = {};  // each role with how many people have it, however the capitals were typed
  for (const m of everyone) for (const r of new Set(rolesOf(m).map(norm))) (counts[r] ??= {label: rolesOf(m).find(x => norm(x) === r), n: 0}).n++;
  const roleKeys = Object.keys(counts).sort();
  if (S.roleF && !counts[S.roleF]) S.roleF = "";
  const q = norm(S.findQ), inRole = S.roleF ? everyone.filter(m => rolesOf(m).some(r => norm(r) === S.roleF)) : everyone;
  const mine = q ? inRole.filter(m => [m.full_name, m.phone, m.role, m.pastor, m.status].some(x => norm(x).includes(q))) : inRole;
  const plist = S.pastorList[S.church] || [], admin = S.me.role === "admin";
  const edit = S.me.role !== "team", statuses = ["", "Away", "Inactive", "Moved", "Left", "Transferred", "Deceased"];
  const roleNames = roleKeys.map(k => counts[k].label);
  const ids = new Set(mine.map(m => m.id));
  S.sel = new Set([...(S.sel || [])].filter(id => ids.has(id)));  // ticks only count for people on show
  const picked = mine.filter(m => S.sel.has(m.id));
  const typeOf = m => m.type === "first_timer" ? "First-timer" : "Member", ageOf = m => isKid(m) ? "Child" : "Adult";
  el.innerHTML = head("Congregation", `${esc(S.church)} · ${everyone.length} people`, `<button class="pill-btn" id="dl">Download</button>`) + `
    <input class="in" id="find" type="search" placeholder="Search" value="${esc(S.findQ || "")}" aria-label="Search people" autocomplete="off" style="margin-bottom:12px">
    ${roleKeys.length ? `<div class="chips"><button class="chip ${S.roleF ? "" : "on"}" data-role="">Everyone · ${everyone.length}</button>${fewKeys(roleKeys, counts, S.roleF, S.roleMore).show.map(k =>
      `<button class="chip ${S.roleF === k ? "on" : ""}" data-role="${esc(k)}">${esc(counts[k].label)} · ${counts[k].n}</button>`).join("")}${moreChip(fewKeys(roleKeys, counts, S.roleF, S.roleMore).more, S.roleMore, roleKeys.length).replace("chip sm ghost", "chip ghost")}</div>` : ""}
    ${edit && picked.length ? `<div class="bulk"><b>${picked.length} selected</b><span class="gap"></span><button class="pill-btn sm primary" id="bulk-go">${svg("edit")}Change roles</button><button class="pill-btn sm" id="bulk-pastor">Set pastor</button><button class="pill-btn sm" id="bulk-x">Clear</button></div>` : ""}
    <div class="card"><div class="scroll"><table><thead><tr>${edit ? `<th class="tick"><input type="checkbox" id="pick-all" aria-label="Select everyone shown" ${mine.length && picked.length === mine.length ? "checked" : ""}></th>` : ""}<th>Name</th>${edit ? "<th></th>" : ""}<th>Roles</th><th>Type</th><th>Age group</th><th>Status</th><th>Pastor</th><th>Phone</th></tr></thead><tbody>
    ${mine.map(m => `<tr>${edit ? `<td class="tick"><input type="checkbox" data-pick="${esc(m.id)}" aria-label="Select ${esc(m.full_name)}" ${S.sel.has(m.id) ? "checked" : ""}></td>` : ""}<td>${whoBtn(m)}</td>${edit ? `<td><button class="pill-btn sm" data-edit="${esc(m.id)}" aria-label="Edit ${esc(m.full_name)}">${svg("edit")}Edit</button></td>` : ""}<td>${rolesOf(m).map(r => `<span class="tag">${esc(r)}</span>`).join("")}</td><td class="muted">${typeOf(m)}</td><td class="muted">${ageOf(m)}</td>
      <td>${m.status ? `<span class="badge">${esc(m.status)}</span>` : `<span class="muted">Active</span>`}</td>
      <td class="${m.pastor ? "" : "muted"}">${esc(m.pastor || "Not assigned")}</td><td class="muted">${esc(m.phone || "")}</td></tr>`).join("")}
    </tbody></table></div>${mine.length ? "" : `<p class="empty">${q ? "Nobody matches that search." : "Nobody yet. Add people from Check-in."}</p>`}
    ${edit ? `` : ""}</div>`;
  el.querySelectorAll("[data-pick]").forEach(c => c.onchange = () => { c.checked ? S.sel.add(c.dataset.pick) : S.sel.delete(c.dataset.pick); render(); });
  const all = el.querySelector("#pick-all");
  if (all) all.onchange = () => { S.sel = new Set(all.checked ? mine.map(m => m.id) : []); render(); };
  const bp = el.querySelector("#bulk-pastor");
  if (bp) bp.onclick = () => {
    if (!plist.length) return toast("Add your pastors on the Pastors page first, then come back.");
    formDialog(`Set the pastor for ${picked.length} ${picked.length === 1 ? "person" : "people"}`, [
      {k: "pastor", label: "Pastor", type: "select", value: plist[0], options: [...plist.map(n => [n, n]), ["", "Not assigned"]]},
    ], async v => {
      let done = 0, clash = 0;
      for (const m of picked) {
        if ((m.pastor || "").trim() === v.pastor) continue;
        const ver = Number(m.version) || 1;
        const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body: {pastor: v.pastor, version: ver + 1}});
        if (!rows?.length) { clash++; continue; }
        Object.assign(m, {pastor: v.pastor, version: ver + 1}); done++;
        log("edit", m.id, "done", "pastor");
      }
      if (clash) await load();
      S.sel = new Set();
      toast(clash ? `Changed ${done}. ${clash} were edited by someone else just now and were left alone.` : done ? `Changed ${done} ${done === 1 ? "person" : "people"}.` : "Nothing needed changing.");
      render();
    }, "Set pastor");
  };
  const bx = el.querySelector("#bulk-x"); if (bx) bx.onclick = () => { S.sel = new Set(); render(); };
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
    S.findQ = e.target.value; const at = e.target.selectionStart; render();
    const f = document.querySelector("#find"); if (f) { f.focus(); try { f.setSelectionRange(at, at); } catch {} }
  };
  el.querySelectorAll("[data-role]").forEach(b => b.onclick = () => { S.roleF = b.dataset.role; render(); });
  const moreB = el.querySelector(".chips [data-more]"); if (moreB) moreB.onclick = () => { S.roleMore = !S.roleMore; render(); };
  el.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    const m = S.members.find(x => x.id === b.dataset.edit), cur = (m.pastor || "").trim();
    const pastors = [["", "Not assigned"], ...[...plist, ...(cur && !plist.includes(cur) ? [cur] : [])].map(n => [n, n])];
    formDialog(`Edit ${m.full_name}`, [
      {k: "full_name", label: "Full name", value: m.full_name, required: true},
      {k: "phone", label: "Phone", value: m.phone || "", type: "tel"},
      {k: "role", label: "Roles", value: rolesOf(m).join(", "), suggest: roleNames, many: true, hint: "Separate several with commas."},
      {k: "type", label: "Attendance Type", value: m.type === "first_timer" ? "first_timer" : "member", type: "select", options: [["member", "Member"], ["first_timer", "First-timer"]]},
      {k: "age_group", label: "Age group", value: ageOf(m), type: "select", options: [["Adult", "Adult"], ["Child", "Child"]]},
      {k: "status", label: "Status", value: statuses.find(x => norm(x) === norm(m.status)) ?? m.status, type: "select",
       options: [...statuses.map(x => [x, x || "Active"]), ...(m.status && !statuses.some(x => norm(x) === norm(m.status)) ? [[m.status, m.status]] : [])]},
      plist.length || !cur ? {k: "pastor", label: "Pastor", value: cur, type: "select", options: pastors, hint: plist.length ? "" : "Add pastors on the Pastors page to choose one here."}
                           : {k: "pastor", label: "Pastor", value: cur},
      ...(admin ? [{k: "church", label: "Church", value: churchOf(m), type: "select", options: S.churches.map(c => [c, c])}] : []),
    ], async v => {
      if (!v.full_name) throw new Error("Type their name.");
      const badPhone = phoneProblem(v.phone, false); if (badPhone) throw new Error(badPhone);
      v.role = v.role.split(",").map(x => x.trim()).filter(Boolean).join(", ");
      const changed = Object.fromEntries(Object.entries(v).filter(([k, val]) => val !== String(k === "church" ? churchOf(m) : k === "age_group" ? ageOf(m) : k === "type" ? (m.type === "first_timer" ? "first_timer" : "member") : (m[k] ?? "")).trim()));
      if (!Object.keys(changed).length) return;
      // only save over the version this screen loaded: if someone else edited the person meanwhile, nothing is overwritten
      const ver = Number(m.version) || 1;
      const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body: {...changed, version: ver + 1}});
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
  });
  el.querySelector("#dl").onclick = () => download(`people_${S.church}_${today()}.csv`, [["Church", "Name", "Roles", "Type", "Age group", "Status", "Pastor", "Phone"],
    ...mine.map(m => [S.church, m.full_name, rolesOf(m).join(", "), typeOf(m), ageOf(m), m.status || "Active", m.pastor || "", m.phone || ""])]);
}

// ---------------------------------------------------------------- all churches (numbers only) and admin
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
  el.innerHTML = head("All churches", sub, `<button class="pill-btn" id="wa">Summary for WhatsApp</button><button class="pill-btn" id="dl">Download</button>`) + `
    <div class="tiles"><div class="card tile"><div class="label">Churches</div><div class="num">${rows.length}</div></div>
      <div class="card tile"><div class="label">Present · latest services</div><div class="num">${sum("present")}</div></div>
      <div class="card tile"><div class="label">Adults and kids</div><div class="num">${sum("adults")}<small>+ ${sum("kids")} kids</small></div></div>
      <div class="card tile"><div class="label">Need a follow-up call</div><div class="num">${sum("red") + sum("yellow")}</div></div></div>
    <div class="branches">${rows.map(r => {
      const pastors = S.pastorList[r.church] || [], here = admin && r.church === S.church;
      return `<div class="card branch ${here ? "here" : ""}"><div class="card-head"><h2>${esc(r.church)}</h2>${here ? `<span class="badge blue">Viewing</span>` : ""}<span class="gap"></span>
          <span class="spark" title="Recent services: ${(r.trend || []).join(", ")}">${(r.trend || []).map(n => `<i style="height:${Math.max(2, Math.round(22 * n / top))}px"></i>`).join("")}</span></div>
        <p class="facts">${pastors.length ? `${pastors.length === 1 ? "Pastor" : "Pastors"}: ${esc(pastors.slice(0, 3).join(", "))}${pastors.length > 3 ? ` +${pastors.length - 3} more` : ""}` : (admin ? "No pastor list yet" : "")}</p>
        <div class="branch-main"><div class="num">${r.present}<small>present</small></div><span class="muted">${r.latest ? esc(nice(r.latest, true)) : "No services yet"}</span></div>
        <dl class="stats"><div><dt>Adults</dt><dd>${r.adults}</dd></div><div><dt>Kids</dt><dd>${r.kids}</dd></div><div><dt>First-timers</dt><dd>${r.first_timers}</dd></div>
          <div><dt>Register</dt><dd>${r.register}</dd></div><div><dt>Red</dt><dd>${r.red}</dd></div><div><dt>Yellow</dt><dd>${r.yellow}</dd></div></dl>
        ${admin ? `<button class="pill-btn ${here ? "" : "primary"} block" data-open="${esc(r.church)}">${here ? "Open dashboard" : `Open ${esc(r.church)}`}</button>` : ""}</div>`; }).join("")}</div>
    ${rows.length ? "" : `<p class="empty">No churches yet.</p>`}
    ${admin ? `` : ""}`;
  el.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { S.church = b.dataset.open; S.view = "dashboard"; render(); });
  el.querySelector("#wa").onclick = () => waDialog("All churches for WhatsApp", text, {day: newest});
  el.querySelector("#dl").onclick = () => download(`all_churches_${today()}.csv`, [["Church", "Latest service", "Present", "Adults", "Kids", "First-timers", "On the register", "Red", "Yellow", "Missed this service"],
    ...rows.map(r => [r.church, r.latest || "", r.present, r.adults, r.kids, r.first_timers, r.register, r.red, r.yellow, r.missed_this])]);
}
async function admin(el) {
  el.innerHTML = head("Admin", "") + `<p class="empty">Loading…</p>`;
  const users = await api("app_users?select=email,role,church,name&order=email").catch(() => []);
  if (S.view !== "admin") return;
  el.innerHTML = head("Admin", "") + `
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Churches</h2></div>
      <div class="chips">${S.churches.map(c => c === S.me.home ? `<span class="chip">${esc(c)} · home church</span>`
        : `<button class="chip" data-rename="${esc(c)}" title="Rename ${esc(c)}">${esc(c)}${svg("edit")}</button>`).join("")}</div>
      <p class="note" style="margin:-4px 2px 14px">Tap a church to rename it.</p>
      <form class="row" id="add-church"><div><label class="f" for="c-name">New church</label><input class="in" id="c-name" placeholder="e.g. Melbourne" required></div>
        <div style="flex:0 0 auto"><button class="pill-btn primary">Add church</button></div></form></div>
    <div class="card"><div class="card-head"><h2>People who can sign in</h2></div>
      <div class="scroll"><table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Church</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td>${esc(u.email)}</td><td class="muted">${esc(u.name || "")}</td><td>${ROLE[u.role]}</td><td class="muted">${esc(u.church || "All churches")}</td>
        <td style="white-space:nowrap">${u.email === S.me.email ? `<span class="muted">You</span>` : `<button class="pill-btn sm" data-chg="${esc(u.email)}">${svg("edit")}Change</button> <button class="x" data-del="${esc(u.email)}">Remove</button>`}</td></tr>`).join("")}</tbody></table></div>
      
      <form class="row" id="add-user" style="margin-top:14px"><div><label class="f" for="u-email">Email</label><input class="in" id="u-email" type="email" required></div>
        <div><label class="f" for="u-name">Name</label><input class="in" id="u-name"></div>
        <div><label class="f" for="u-role">Role</label><select class="in" id="u-role"><option value="team">Team (ushers)</option><option value="lead">Church admin (pastor, follow-up)</option><option value="bishop">Bishop (numbers only)</option><option value="admin">Admin (everything)</option></select></div>
        <div><label class="f" for="u-church">Church</label><select class="in" id="u-church">${S.churches.map(c => `<option>${esc(c)}</option>`).join("")}</select></div>
        <div style="flex:0 0 auto"><button class="pill-btn primary">Add person</button></div></form>
      </div>`;
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
  el.querySelector("#add-church").onsubmit = e => { e.preventDefault(); const name = el.querySelector("#c-name").value.trim().replace(/\s+/g, " ");
    again(() => api("churches", {method: "POST", prefer: "return=minimal", body: {name}})); };
  el.querySelector("#add-user").onsubmit = e => { e.preventDefault(); const role = el.querySelector("#u-role").value;
    const wrong = emailProblem(el.querySelector("#u-email").value); if (wrong) return toast("Not added: " + wrong);
    again(() => api("app_users?on_conflict=email", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {email: el.querySelector("#u-email").value.trim().toLowerCase(),
      name: el.querySelector("#u-name").value.trim(), role, church: ["admin", "bishop"].includes(role) ? null : el.querySelector("#u-church").value}})); };
  el.querySelectorAll("[data-chg]").forEach(b => b.onclick = () => {
    const u = users.find(x => x.email === b.dataset.chg);
    formDialog(`Change ${u.name || u.email}`, [
      {k: "role", label: "Role", value: u.role, type: "select", options: [["team", "Team (ushers)"], ["lead", "Church admin (pastor, follow-up)"], ["bishop", "Bishop (numbers only, all churches)"], ["admin", "Admin (everything, all churches)"]]},
      {k: "church", label: "Church", value: u.church || S.churches[0], type: "select", options: S.churches.map(c => [c, c]), hint: "Not used for Admin or Bishop."},
    ], async v => {
      const church = ["admin", "bishop"].includes(v.role) ? null : v.church;
      const rows = await api(`app_users?email=eq.${encodeURIComponent(u.email)}`, {method: "PATCH", prefer: "return=representation", body: {role: v.role, church}});
      if (!rows?.length) throw new Error("Not saved. Check you are still signed in as an admin.");
      log("role_change", "", "done", `${u.email}: ${v.role}${church ? " · " + church : ""}`);
      toast("Saved. They will see the change next time they open the app."); render();
    });
  });
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = () => again(() => api(`app_users?email=eq.${encodeURIComponent(b.dataset.del)}`, {method: "DELETE", prefer: "return=minimal"})));
}

// ---------------------------------------------------------------- pastors: each pastor's people
function pastors(el) {
  const NONE = "Not assigned yet", p = picture(), p0 = p, groups = {};
  for (const x of p.people) (groups[(x.pastor || "").trim() || NONE] ??= []).push(x);
  const plist = S.pastorList[S.church] || [], canEdit = S.me.role !== "team";
  for (const n of plist) groups[n] ??= [];  // pastors on the list show even before anyone is assigned to them
  const names = Object.keys(groups).sort((a, b) => (a === NONE) - (b === NONE) || a.localeCompare(b));
  if (!names.includes(S.pastor)) S.pastor = names[0] || "";
  const list = (groups[S.pastor] || []).slice().sort(byName), came = list.filter(x => p.here[x.id]), need = list.filter(x => x.level !== "ok");
  const message = (o = {}) => {
    if (o.day && !p0.dates.includes(o.day)) return null;
    const p = o.day && o.day !== p0.last ? picture(o.day) : p0;
    const list = p.people.filter(x => ((x.pastor || "").trim() || NONE) === S.pastor).sort(byName), came = list.filter(x => p.here[x.id]), need = list.filter(x => x.level !== "ok");
    const out = [`*${S.pastor} · your people*${S.emoji ? " ⛪" : ""}`, p.last ? nice(p.last, true) : "", "", ["✅", `Came: *${came.length} of ${list.length}*`]];
    if (came.length) out.push(came.map(x => x.full_name).join(", "));
    const not = list.filter(x => !p.here[x.id]);
    if (not.length) out.push("", ["🙏", "Not there:"], not.map(x => x.full_name).join(", "));
    if (need.length) out.push("", ["📞", "Please call:"], ...need.map(x => `- ${x.full_name} (${x.missed} missed${x.phone ? ", " + x.phone : ""})`));
    return wa(out);
  };
  el.innerHTML = head("Pastors", esc(S.church),
    S.pastor && S.pastor !== NONE ? `<button class="pill-btn" id="wa">Message for WhatsApp</button>` : "") + `
    ${names.length ? `<div class="card" style="margin-bottom:14px"><div class="scroll"><table><thead><tr><th>Pastor</th><th>People</th><th>Came${p.last ? " · " + esc(nice(p.last)) : ""}</th><th>Need a call</th></tr></thead><tbody>
      ${names.map(n => { const g = groups[n]; return `<tr><td><button class="who ${n === S.pastor ? "sel" : ""}" data-pastor="${esc(n)}"><span>${esc(initials(n))}</span>${esc(n)}</button></td>
        <td>${g.length}</td><td>${g.filter(x => p.here[x.id]).length}</td><td>${g.filter(x => x.level !== "ok").length}</td></tr>`; }).join("")}</tbody></table></div></div>
    <div class="card"><div class="card-head"><h2>${esc(S.pastor)}</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${list.length} ${list.length === 1 ? "person" : "people"}</span></div>
      <div class="scroll"><table><thead><tr><th>Name</th><th>Came</th><th>Status</th><th>Missed in a row</th><th>Phone</th></tr></thead><tbody>
      ${list.map(x => `<tr><td>${whoBtn(x)}</td><td>${p.here[x.id] ? "Yes" : `<span class="muted">No</span>`}</td><td>${badge(x.flag)}</td><td>${x.missed}</td><td class="muted">${esc(x.phone || "")}</td></tr>`).join("")}
      </tbody></table></div>
      ${list.length ? "" : `<p class="empty">Nobody is assigned to ${esc(S.pastor)} yet.</p>`}
      </div>`
      : `<p class="empty">Nobody on this register yet.</p>`}
    ${canEdit ? `<form class="card" id="plist" style="margin-top:14px"><div class="card-head"><h2>Pastor list for ${esc(S.church)}</h2></div>
      <label class="f" for="pnames">Names, one per line</label>
      <textarea class="in" id="pnames" rows="${Math.max(4, plist.length + 1)}" placeholder="e.g. Pastor Grace Mensah">${esc(plist.join("\n"))}</textarea>
      <div class="row" style="margin-top:12px"><p class="note" style="margin:0">One name per line.</p>
        <div style="flex:0 0 auto"><button class="pill-btn primary">Save list</button></div></div></form>` : ""}`;
  const form = el.querySelector("#plist");
  if (form) form.onsubmit = async e => {
    e.preventDefault();
    const seen = new Set(), out = el.querySelector("#pnames").value.split("\n").map(x => x.trim().replace(/\s+/g, " ").slice(0, 80)).filter(x => x && !seen.has(norm(x)) && seen.add(norm(x)));
    try {
      await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key: "pastors:" + S.church, value: out.join("\n")}});
      S.pastorList[S.church] = out; toast("Pastor list saved."); render();
    } catch (err) { toast(/settings|policy|permission/i.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
  };
  el.querySelectorAll("[data-pastor]").forEach(b => b.onclick = () => { S.pastor = b.dataset.pastor; render(); });
  const btn = el.querySelector("#wa"); if (btn) btn.onclick = () => waDialog(`Message for ${S.pastor}`, message, {day: p.last || today()});
}

// ---------------------------------------------------------------- one person: every day they came
async function person(el) {
  const p = picture(), mine = p.mine.slice().sort(byName), m = mine.find(x => x.id === S.person);
  const top = head(m ? esc(m.full_name) : "Person", esc(S.church), m ? `<button class="pill-btn" id="dl">Download</button>` : "") + `
    <div class="card" style="margin-bottom:14px"><label class="f" for="who">Search for a person</label>
      <input class="in" id="who" type="search" autocomplete="off" placeholder="Type a name…" value="${esc(S.pq)}"><div class="found" id="found"></div></div>`;
  const bind = () => {
    const box = el.querySelector("#who"), found = el.querySelector("#found");
    const draw = () => {
      const q = norm(S.pq), hits = q ? mine.filter(x => norm(x.full_name).includes(q)) : [];
      found.innerHTML = !q ? "" : hits.length ? hits.slice(0, 8).map(x => `<button class="who" data-person="${esc(x.id)}"><span>${esc(initials(x.full_name))}</span>${esc(x.full_name)}</button>`).join("")
        + (hits.length > 8 ? `<p class="note" style="margin:6px 2px 0">${hits.length - 8} more. Keep typing to narrow it down.</p>` : "") : `<p class="empty" style="padding:8px 2px 0">Nobody matches “${esc(S.pq)}”.</p>`;
    };
    box.oninput = () => { S.pq = box.value; draw(); };
    found.onclick = e => { if (e.target.closest("[data-person]")) S.pq = ""; };  // the page-wide handler then opens that person
    draw();
  };
  if (!m) { el.innerHTML = top + `<p class="empty">Search for someone, or tap a name on any list.</p>`; bind(); return; }
  el.innerHTML = top + `<p class="empty">Loading…</p>`; bind();
  let rows;
  try { rows = await all(`attendance?select=service_date&member_id=eq.${encodeURIComponent(m.id)}&order=service_date.desc`); }
  catch (e) { el.innerHTML = top + `<div class="msg bad">${esc(e.message)}</div>`; bind(); return; }
  if (S.view !== "person" || S.person !== m.id) return;
  const came = rows.map(r => r.service_date).filter(d => d <= today()), set = new Set(came);
  const st = p.people.find(x => x.id === m.id), years = {};
  for (const d of came) (years[d.slice(0, 4)] ??= []).push(d);
  const state = st ? badge(st.flag) : p.archived.some(x => x.id === m.id) ? `<span class="badge">Archived</span>` : `<span class="badge">${esc(m.status || "Not active")}</span>`;
  const recent = p.dates.slice(-12);
  el.innerHTML = top + `
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div class="who big"><span>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</div><span class="gap"></span>${state}</div>
      <p class="facts">${[m.type === "first_timer" ? "First-timer" : "Member", isKid(m) ? "Child" : "Adult", m.pastor ? "Pastor: " + m.pastor : "", m.phone || ""].filter(Boolean).map(esc).join(" · ")}</p></div>
    <div class="tiles"><div class="card tile"><div class="label">Attendance History</div><div class="num">${came.length}</div></div>
      <div class="card tile"><div class="label">Last Attended</div><div class="num sm">${esc(full(came[0]))}</div></div>
      <div class="card tile"><div class="label">First Attended</div><div class="num sm">${esc(full(came[came.length - 1]))}</div></div>
      <div class="card tile"><div class="label">Missed in a row</div><div class="num">${st ? st.missed : "–"}</div></div></div>
    ${recent.length ? `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>The last ${recent.length} services</h2><span class="gap"></span>
        <div class="legend"><span><i class="dot on"></i>Came</span><span><i class="dot"></i>Missed</span></div></div>
      <div class="dots">${recent.map(d => `<div><i class="dot ${set.has(d) ? "on" : ""}" title="${set.has(d) ? "Came" : "Missed"}"></i><small>${esc(nice(d))}</small></div>`).join("")}</div></div>` : ""}
    <div class="card"><div class="card-head"><h2>History</h2></div>
      ${came.length ? Object.keys(years).sort().reverse().map(y => `<h3 class="year">${y} · ${years[y].length} ${years[y].length === 1 ? "service" : "services"}</h3>
        <div class="chips">${years[y].map(d => `<span class="chip">${esc(nice(d))}</span>`).join("")}</div>`).join("") : `<p class="empty">No services recorded for ${esc(m.full_name)} yet.</p>`}</div>`;
  bind();
  el.querySelector("#dl").onclick = () => download(`${norm(m.full_name).replace(/[^a-z0-9]+/g, "_")}_history_${today()}.csv`, [["Name", "Church", "Service date"], ...came.map(d => [m.full_name, S.church, d])]);
}

// ---------------------------------------------------------------- sign-ups from the welcome form
async function signups(el) {
  const sub = "From the welcome form, waiting for approval";
  el.innerHTML = head("Sign-ups", sub) + `<p class="empty">Loading…</p>`;
  let regs;
  try { regs = await api("registrations?select=id,full_name,phone,email,invited_by,first_visit,notes,wants_contact,created_at&status=eq.pending&order=created_at"); }
  catch (e) { el.innerHTML = head("Sign-ups", sub) + `<div class="msg bad">Sign-ups can't be loaded yet. Run the latest setup SQL in Supabase once, then open this page again. (${esc(e.message)})</div>`; return; }
  if (S.view !== "signups") return;
  S.pending = regs.length;
  const home = Object.fromEntries(S.members.filter(m => churchOf(m) === S.me.home).map(m => [norm(m.full_name).replace(/\s+/g, " "), m]));
  el.innerHTML = head("Sign-ups", sub) + (regs.length ? regs.map(r => {
    const match = home[norm(r.full_name).replace(/\s+/g, " ")];
    const info = [["Phone", r.phone], ["Email", r.email], ["Invited by / heard via", r.invited_by], ["First visit", r.first_visit && full(r.first_visit)]].filter(x => x[1]);
    return `<div class="card signup" data-reg="${esc(r.id)}" data-match="${esc(match?.id || "")}" style="margin-bottom:14px">
      <div class="card-head"><h2>${esc(r.full_name)}</h2>${r.wants_contact === false ? `<span class="badge yellow">Prefers no contact</span>` : ""}<span class="gap"></span>
        <span style="color:var(--ink-3);font-size:13px">Sent ${esc(when(r.created_at))}</span></div>
      <p class="facts">${info.length ? info.map(([k, v]) => `${k}: ${esc(v)}`).join("<br>") : "No contact details given."}</p>
      ${r.notes ? `<div class="msg" style="margin-top:10px">${esc(r.notes)}</div>` : ""}
      ${match ? `<p class="note">Already on the register as <b>${esc(match.full_name)}</b> (${match.type === "first_timer" ? "first-timer" : "member"}). Approving updates that person and adds nobody new.</p>` : ""}
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

// ---------------------------------------------------------------- archive: not seen for two years
function archive(el) {
  const p = picture(), list = p.archived.slice().sort(byName);
  el.innerHTML = head("Archive", `${esc(S.church)} · not seen for two years`, list.length ? `<button class="pill-btn" id="dl">Download</button>` : "") + `
    ${S.seen ? "" : `<div class="msg" style="margin:0 0 14px">Run the latest setup SQL in Supabase once so this list can look back further than the last year.</div>`}
    <div class="card">${list.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Last seen</th><th>Type</th><th>Age group</th><th>Phone</th></tr></thead><tbody>
      ${list.map(m => `<tr><td>${whoBtn(m)}</td><td class="muted">${esc(full(m.seen))}</td><td class="muted">${m.type === "first_timer" ? "First-timer" : "Member"}</td><td class="muted">${m.kid ? "Child" : "Adult"}</td><td class="muted">${esc(m.phone || "")}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="empty">Nobody is in the archive.</p>`}
      <p class="note">They come back when ticked in again.</p></div>`;
  const dl = el.querySelector("#dl");
  if (dl) dl.onclick = () => download(`archive_${S.church}_${today()}.csv`, [["Church", "Name", "Last seen", "Type", "Age group", "Phone"],
    ...list.map(m => [S.church, m.full_name, m.seen || "", m.type === "first_timer" ? "First-timer" : "Member", m.kid ? "Child" : "Adult", m.phone || ""])]);
}

// ---------------------------------------------------------------- activity: who did what, and when
const KIND = {lock: "Locked a service", unlock: "Unlocked a service", delete: "Deleted from register", rename_church: "Renamed a church", role_change: "Changed a sign-in", tick: "Ticked in", untick: "Unticked", clear_service: "Unticked everyone", edit: "Edited", add_person: "Added",
              signup_approved: "Approved sign-up", signup_rejected: "Rejected sign-up"};
const RESULT = {done: "Done", already: "No change (already done)", changed: "Blocked: someone else changed it first"};
async function activity(el) {
  const sub = `${esc(S.church)} · every tick, untick, edit and approval. It is only ever added to.`;
  const shows = {all: "Everything", ticks: "Check-ins", edits: "Edits & sign-ups", blocked: "Blocked only"};
  const frame = body => head("Activity", sub) + `<div class="card" style="margin-bottom:14px"><div class="row">
      <div style="flex:0 0 170px"><label class="f" for="a-day">Day</label><input class="in" id="a-day" type="date" value="${S.actDay}"></div>
      <div class="chips" style="margin:0">${Object.entries(shows).map(([k, t]) => `<button class="chip ${S.actShow === k ? "on" : ""}" data-show="${k}">${t}</button>`).join("")}</div></div></div>${body}`;
  const bind = () => {
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

// ---------------------------------------------------------------- reports: the daily email
async function reports(el) {
  const sub = esc(S.church);
  const isHome = S.church === S.me.home, key = isHome ? "report_recipients" : `report_recipients:${S.church}`;
  el.innerHTML = head("Reports", sub) + `<p class="empty">Loading…</p>`;
  let setting, sent;
  try {
    [setting, sent] = await Promise.all([api(`settings?select=value&key=eq.${encodeURIComponent(key)}`),
      api(`email_log?select=kind,report_date,sent_at,recipients,ok,detail&kind=in.(${isHome ? '"manual","daily"' : `"manual:${S.church.replace(/"/g, "")}"`})&order=sent_at.desc&limit=15`)]);
  } catch (e) { el.innerHTML = head("Reports", sub) + `<div class="msg bad">Reports can't be loaded yet. Run the latest setup SQL in Supabase once, then open this page again. (${esc(e.message)})</div>`; return; }
  if (S.view !== "reports") return;
  const list = (setting[0]?.value || "").split(/[,\s;]+/).filter(Boolean), p = picture();
  el.innerHTML = head("Reports", sub) + `
    <form class="card" id="to" style="margin-bottom:14px"><div class="card-head"><h2>Who gets the email</h2></div>
      <label class="f" for="emails">Email addresses, one per line</label>
      <textarea class="in" id="emails" rows="${Math.max(3, list.length + 1)}" placeholder="name@example.com">${esc(list.join("\n"))}</textarea>
      <div class="row" style="margin-top:12px"><p class="note" style="margin:0">${list.length ? "" : "Add an address and press Save first."}</p>
        <div style="flex:0 0 auto;display:flex;gap:8px;flex-wrap:wrap"><button class="pill-btn">Save</button><button type="button" class="pill-btn primary" id="send" ${list.length && p.last ? "" : "disabled"}>${svg("reports")}Send report now</button></div></div></form>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Emails sent</h2></div>
      ${sent.length ? `<div class="scroll"><table><thead><tr><th>Sent</th><th>Report for</th><th>Type</th><th>To</th><th>Result</th></tr></thead><tbody>
        ${sent.map(r => `<tr><td class="muted">${esc(when(r.sent_at))}</td><td>${esc(full(r.report_date))}</td><td class="muted">${r.kind === "daily" ? "Automatic (old schedule)" : "Sent by the admin"}</td>
          <td class="muted">${esc(r.recipients || "")}</td><td>${r.ok ? "Sent" : `<span class="badge red" title="${esc(r.detail || "")}">Failed</span>`}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">No emails have been sent yet.</p>`}
      </div>
    <div class="card"><div class="card-head"><h2>Lists to download</h2></div>
      <div class="chips" style="margin:0"><button class="pill-btn" data-dl="in">Checked in${p.last ? " · " + esc(nice(p.last)) : ""}</button>
        <button class="pill-btn" data-dl="call">Needs a follow-up call</button><button class="pill-btn" data-dl="all">Whole register</button></div>
      </div>`;
  el.querySelector("#to").onsubmit = async e => {
    e.preventDefault();
    const items = el.querySelector("#emails").value.split(/[,\s;]+/).filter(Boolean), bad = items.map(emailProblem).filter(Boolean);
    if (bad.length) return toast("Not saved: " + bad[0]);
    if (!items.length) return toast("Not saved: add at least one email address.");
    const value = [...new Set(items.map(x => x.toLowerCase()))].join(", ");
    try { await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key, value}}); toast("Saved."); render(); }
    catch (err) { toast("Not saved: " + err.message); }
  };
  const type = m => m.type === "first_timer" ? "First-timer" : "Member", age = m => isKid(m) ? "Child" : "Adult";
  const files = {
    in: () => [`checked_in_${S.church}_${p.last || today()}.csv`, [["Church", "Service", "Name", "Type", "Age group", "Phone"], ...p.present.slice().sort(byName).map(m => [S.church, p.last, m.full_name, type(m), age(m), m.phone || ""])]],
    call: () => [`follow_up_${S.church}_${today()}.csv`, [["Church", "Name", "Status", "Missed in a row", "Last seen", "Phone", "Pastor"], ...p.people.filter(x => x.level !== "ok").map(x => [S.church, x.full_name, FLAG[x.flag], x.missed, x.seen || "", x.phone || "", x.pastor || ""])]],
    all: () => [`register_${S.church}_${today()}.csv`, [["Church", "Name", "Type", "Age group", "Status", "Pastor", "Phone"], ...p.mine.slice().sort(byName).map(m => [S.church, m.full_name, type(m), age(m), m.status || "Active", m.pastor || "", m.phone || ""])]],
  };
  el.querySelectorAll("[data-dl]").forEach(b => b.onclick = () => download(...files[b.dataset.dl]()));
  const csv = rows => rows.map(r => r.map(v => /[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? "")).join(",")).join("\r\n");
  el.querySelector("#send").onclick = () => formDialog(`Send ${S.church}'s report`, [
    {k: "names", label: "Include names of first-timers and people to follow up", type: "select", value: "yes", options: [["yes", "Yes, with names"], ["no", "No, numbers only"]],
     hint: `Goes to ${list.join(", ")} for ${p.last ? nice(p.last, true) : "the latest service"}. The check-in and follow-up lists are attached when names are included.`},
  ], async v => {
    const was = S.emoji; S.emoji = false;
    let text; try { text = summary(p, {names: v.names === "yes"}); } finally { S.emoji = was; }
    if (S.session && S.session.expires_at - Date.now() < 60000) await refresh();
    const r = await fetch("/app-send", {method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer " + S.session.access_token},
      body: JSON.stringify({church: S.church, date: p.last, at: isoLocal(), text,
        files: v.names === "yes" ? ["in", "call"].map(k => files[k]()).map(([name, rows]) => ({name: name.replace(/[^\w .()-]/g, "_"), text: csv(rows)})) : []})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { render(); throw new Error(j.message || "The email was not sent."); }
    toast(`Sent to ${j.sent} ${j.sent === 1 ? "person" : "people"}.`); render();
  }, "Send now");
}

// ---------------------------------------------------------------- help: quick fixes and who to contact
async function help(el) {
  const admin = S.me.role === "admin";
  el.innerHTML = head("Help", "") + `<p class="empty">Loading…</p>`;
  let contact = "";
  try { contact = (await api("settings?select=value&key=eq.help_contact"))[0]?.value || ""; } catch {}
  if (S.view !== "help") return;
  const link = t => esc(t).replace(/[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/gi, m => `<a href="mailto:${m}">${m}</a>`).replace(/\+?\d[\d ]{6,}\d/g, m => `<a href="tel:${m.replace(/ /g, "")}">${m}</a>`);
  const faq = [
    ["I can't see a person on the list", "Check the church name at the top is the right one, then use the search box. If they are new, add them at the bottom of Check-in."],
    ["I ticked the wrong person", "Tap their name again on Check-in to untick them. Nothing else is changed."],
    ["A name, phone number or role is wrong", "A church admin can fix it: Congregation, then Edit beside the name."],
    ["The numbers look out of date", "Pull the page down to refresh, or close the app and open it again."],
    ["The sign-in email didn't arrive", "Wait two minutes, check Spam or Junk, and check the email address is spelled correctly."],
    ["I need to see more than I can", "Ask the admin below to change your role."],
  ];
  el.innerHTML = head("Help", "") + `
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Contact the admin</h2></div>
      ${contact ? `<p style="white-space:pre-line;margin:0;line-height:1.6">${link(contact)}</p>` : `<p class="empty">${admin ? "Nothing is shown here yet. Add how people can reach you below." : "Ask your church admin or pastor."}</p>`}
      ${admin ? `<form id="hc" style="margin-top:14px"><label class="f" for="hc-text">What everyone sees here</label>
        <textarea class="in" id="hc-text" rows="3" maxlength="400" placeholder="Name, phone, email">${esc(contact)}</textarea>
        <div class="row" style="margin-top:12px"><p class="note" style="margin:0">Everyone signed in sees this.</p>
          <div style="flex:0 0 auto"><button class="pill-btn primary">Save</button></div></div></form>` : ""}</div>
    <div class="card"><div class="card-head"><h2>Quick fixes</h2></div>
      ${faq.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>`;
  const f = el.querySelector("#hc");
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    try { await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key: "help_contact", value: f.querySelector("#hc-text").value.trim()}}); toast("Saved."); render(); }
    catch (err) { toast(/row-level|policy/i.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
  };
}

// ---------------------------------------------------------------- your own account
function account(el) {
  el.innerHTML = head("Your account", "") + `
    <form class="card" id="me" style="max-width:560px;margin-bottom:14px"><label class="f" for="my-name">Your name</label>
      <input class="in" id="my-name" maxlength="80" autocomplete="name" value="${esc(S.me.name || "")}" placeholder="e.g. Grace Mensah">
      <p class="facts" style="margin-top:14px">Email: ${esc(S.me.email)}<br>Role: ${ROLE[S.me.role]}${S.me.church ? "<br>Church: " + esc(S.me.church) : ""}</p>
      
      <div style="margin-top:14px"><button class="pill-btn primary">Save name</button></div></form>
    <form class="card" id="setpw" style="max-width:560px;margin-bottom:14px"><div class="card-head"><h2>Sign in with a password</h2></div>
      <p class="note" style="margin-top:0">Skip the email code next time you sign in.</p>
      <input type="email" autocomplete="username" value="${esc(S.me.email)}" readonly hidden>
      <label class="f" for="pw1">New password</label><input class="in" id="pw1" type="password" autocomplete="new-password" minlength="8" maxlength="72" required>
      <label class="f" for="pw2" style="margin-top:12px">Type it again</label><input class="in" id="pw2" type="password" autocomplete="new-password" minlength="8" maxlength="72" required>
      <div style="margin-top:14px"><button class="pill-btn primary">Save password</button></div></form>
    <div class="card" style="max-width:560px"><label class="check"><input type="checkbox" id="emoji" ${S.emoji ? "checked" : ""}> Use emojis in WhatsApp messages</label>
      <div style="margin-top:16px"><button class="pill-btn" data-bye>${svg("out")}Log out</button></div></div>`;
  el.querySelector("#me").onsubmit = async e => {
    e.preventDefault();
    try { S.me.name = await api("rpc/app_set_my_name", {method: "POST", body: {new_name: el.querySelector("#my-name").value}}); toast("Saved."); render(); }
    catch (err) { toast(/app_set_my_name/.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
  };
  el.querySelector("#setpw").onsubmit = async e => {
    e.preventDefault();
    const a = el.querySelector("#pw1").value, b = el.querySelector("#pw2").value;
    if (a.length < 8) return toast("Not saved: use at least 8 characters.");
    if (a !== b) return toast("Not saved: the two passwords don't match.");
    try {
      if (S.session.expires_at - Date.now() < 60000) await refresh();
      const r = await fetch(S.cfg.url + "/auth/v1/user", {method: "PUT", body: JSON.stringify({password: a}),
        headers: {apikey: S.cfg.key, "Content-Type": "application/json", Authorization: "Bearer " + S.session.access_token}});
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.msg || j.error_description || j.message || "The password was not accepted.");
      try { localStorage.setItem("fcc-pw", S.me.email); } catch {}
      e.target.reset(); toast("Password saved. Next time, sign in with your email and this password.");
    } catch (err) { toast("Not saved: " + err.message); }
  };
  el.querySelector("#emoji").onchange = e => { S.emoji = e.target.checked; try { localStorage.setItem("fcc-emoji", S.emoji ? "on" : "off"); } catch {} toast(S.emoji ? "Emojis on." : "Emojis off."); };
  el.querySelector("[data-bye]").onclick = signOut;
}

// ---------------------------------------------------------------- go
let saved = null; try { saved = localStorage.getItem("fcc-mode"); } catch {}
setMode(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
try { S.emoji = localStorage.getItem("fcc-emoji") !== "off"; } catch {}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start().catch(e => fatal(e.message));
