// FCC Attendance app. Plain JavaScript, no build step: it talks to Supabase's REST and Auth APIs directly.
// What a signed-in person may load is decided by the database (Row Level Security, see supabase/app_setup.sql),
// not by this file: hiding a menu item here is for tidiness, the database is what keeps churches apart.

const RED_AT = 5, YELLOW_AT = 3, ARCHIVE_DAYS = 730;
const AWAY = new Set(["inactive", "moved", "left", "deceased", "transferred", "away"]);
const ROLE = {admin: "Admin", bishop: "Bishop", lead: "Church admin", team: "Team", pastor: "Pastor"};
const ROLE_OPTS = [["team", "Team (ushers)"], ["pastor", "Pastor (only their own people)"], ["lead", "Church admin (whole church, follow-up)"],
  ["lead_pastor", "Lead pastor (whole church, plus their own people)"],
  ["bishop", "Bishop (numbers only, all churches)"], ["admin", "Admin (everything, all churches)"]];
// A lead pastor is a church admin with the title "Lead pastor" (they also get the Pastor view for their own people)
const roleName = u => u?.role === "lead" && u?.title === "Lead pastor" ? "Lead pastor" : ROLE[u?.role] || u?.role || "";
const baseName = () => roleName({role: S.me.base, title: S.me.title});
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
const pastorsOf = m => String(m.pastor || "").split(",").map(x => x.trim()).filter(Boolean);  // someone can have more than one pastor
// Is this pastor the person themselves? Titles are ignored, so "Lady Pastor Rita Kpodonu" matches Rita Kpodonu.
const TITLES = /^((lady|senior|assistant|associate)\s+)?(pastor|rev(erend)?\.?|bishop|apostle|prophet(ess)?|evangelist|elder|deacon(ess)?|minister|dr\.?|mr\.?|mrs\.?|ms\.?)\s+/;
const bare = n => { let x = norm(n).replace(/\s+/g, " "); for (let i = 0; i < 3 && TITLES.test(x); i++) x = x.replace(TITLES, ""); return x; };
const TYPE = {member: "Member", first_timer: "First-timer", visitor: "Visitor"};  // attendance type; visitors are never chased on Follow-up
const typeKey = m => TYPE[m.type] ? m.type : "member", typeName = m => TYPE[typeKey(m)], typeOpts = Object.entries(TYPE);
const pastorBtn = n => S.me?.role === "pastor" ? esc(n) : `<button class="plink" data-to-pastor="${esc(n)}">${esc(n)}</button>`;  // a pastor's name: tap to see their people
const isSelf = (pastor, m) => !!bare(pastor) && bare(pastor) === bare(m.full_name);
const genderOf = m => ({f: "Female", female: "Female", m: "Male", male: "Male"})[norm(m.gender)] || "";
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
    <div class="modal-foot"><button class="pill-btn" data-x>Close</button><button class="pill-btn ${onPhone() ? "" : "primary"}" id="m-copy">Copy</button>${onPhone() ? `<button class="pill-btn primary" id="m-send">Open in WhatsApp</button>` : ""}</div></div>`;
  document.body.append(d);
  const text = d.querySelector("#m-text");
  let turn = 0;
  const draw = async () => {  // build may load numbers for the chosen day; null means there is nothing for that day
    const mine = ++turn, send = d.querySelector("#m-send"), copy = d.querySelector("#m-copy");
    let out; try { out = await build(st); } catch (err) { out = null; text.dataset.why = err.message; }
    if (mine !== turn) return;
    const none = out == null;
    text.textContent = none ? (text.dataset.why || `No summary for ${st.day ? nice(st.day, true) : "this day"}. No service was recorded.`) : out;
    delete text.dataset.why; text.classList.toggle("muted", none); copy.disabled = none; if (send) send.disabled = none;
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
  const sendBtn = d.querySelector("#m-send"); if (sendBtn) sendBtn.onclick = () => { window.open("https://wa.me/?text=" + encodeURIComponent(text.textContent), "_blank", "noopener"); };
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
  box.innerHTML = `<li class="phrase" data-r="phrase"><i>${svg("checkin")}</i><span>Easiest: a phrase of 3 or more words, 16+ characters, like <b>sunday choir sings loud</b>. Then the three rules below aren't needed.</span></li>`
    + PW_RULES.map(([k, t]) => `<li data-r="${k}"><i>${svg("checkin")}</i>${esc(t)}</li>`).join("");
  const draw = () => {
    const a = p1.value, b = p2.value;
    PW_RULES.forEach(([k, , ok]) => {
      const li = box.querySelector(`[data-r="${k}"]`), good = ok(a, b), touched = k === "same" ? b.length > 0 : a.length > 0;
      li.className = good ? "ok" : touched ? "bad" : "";
    });
    const ph = box.querySelector('[data-r="phrase"]'); ph.className = "phrase" + (isPhrase(a) ? " ok" : "");
    ph.querySelector("span").innerHTML = isPhrase(a) ? "Passphrase: long enough, nothing else needed" : "Easiest: a phrase of 3 or more words, 16+ characters, like <b>sunday choir sings loud</b>. Then the three rules below aren't needed.";
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
    <p class="note" style="margin-top:0">Set a password and next time just type your email and password. No waiting for an email.</p>
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
  const hash = new URLSearchParams(location.hash.slice(1));  // arriving from the emailed link
  if (hash.get("access_token")) { keep(Object.fromEntries(hash)); history.replaceState(null, "", location.pathname); S.via = "email"; }
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
  // An admin or church admin who is also a pastor can switch to Pastor view without signing in again.
  S.me.base = S.me.role;
  S.canSwitch = !!(S.me.pastor && ["admin", "lead"].includes(S.me.role));
  try { if (S.canSwitch && localStorage.getItem("fcc-as:" + S.me.email) === "pastor") S.me.role = "pastor"; } catch {}
  // An admin can look at the app as another role (e.g. an usher at one church) without a second email: see viewAs()
  S.preview = null;
  if (S.me.base === "admin") { let as = null; try { as = JSON.parse(localStorage.getItem("fcc-preview:" + S.me.email) || "null"); } catch {}
    if (as && PREVIEW[as.role]) { S.preview = as; S.canSwitch = false; Object.assign(S.me, {role: as.role, church: as.church || null, pastor: as.role === "pastor" ? as.pastor : S.me.pastor, title: null}); } }
  S.view = S.me.role === "bishop" ? "overview" : S.view;
  if (!S.landed) { S.landed = true; const st = look().start; if (st) S.view = st; }  // the start page this person picked in Settings
  if (S.me.role !== "bishop") {
    S.churches = (await api("churches?select=name,livestream&order=name")).map(c => c.name);
    S.church = S.me.role === "admin" ? (S.churches.includes(S.church) ? S.church : S.me.home) : S.me.church || S.me.home;
    if (S.me.role === "pastor" && S.me.base === "admin" && !S.preview) S.church = await pastorChurch();
    await load();
    S.pending = canApprove() ? await api("registrations?select=id&status=eq.pending").then(r => r.length).catch(() => 0) : 0;
  }
  render();
  let seen = true; try { seen = !!localStorage.getItem("fcc-tour:" + S.me.email); } catch {}
  if (!seen && !S.preview) setTimeout(tour, 500);  // first time on this phone or laptop: a short tour of where things are
  else if (S.via === "email") setTimeout(offerPassword, 600);  // just signed in with an email code or link
  S.via = "";
}
// A short welcome tour: a few cards for this person's role on where to find things. Shown once per device; Help can show it again.
function tour() {
  const r = S.me.role, phone = matchMedia("(max-width: 1080px)").matches, Q = q => document.querySelector(q);
  // the menu item for a page: in the side menu on laptops; on phones the bottom bar, or More when it isn't there
  const nav = v => () => phone ? Q(`.dock [data-view="${v}"]`) || Q(".dock [data-menu]") : Q(`.side .nav[data-view="${v}"]`);
  const more = v => phone && !Q(`.dock [data-view="${v}"]`) ? " Tap More to find it." : "";
  const steps = [[null, "dashboard", 1, "Welcome to FCC Attendance", `Here's a quick look at where things are. It takes under a minute, and you can see it again any time from Help.`],
    ...(r === "bishop" ? [[nav("overview"), "overview", 1, "All churches", "Every church's numbers in one place. Tap a church for its own dashboard, or a day in the calendar to look back."],
                          [() => Q("#addw"), "plus", 4, "Make it yours", "Add widgets, drag them by the handle, or resize them from ⋯. Your layout is only yours."]]
      : r === "pastor" ? [[nav("mine"), "mine", 1, "Home: your people", "Everyone assigned to you, who came, and who needs a call. Tap a name for their history."],
                          [nav("checkin"), "checkin", 2, "Check-in", "Tick your people in at a service. Ushers see the ticks straight away." + more("checkin")]]
      : [[nav("dashboard"), "dashboard", 1, "Dashboard", "How the last service went, at a glance. This is where the app opens."],
         [nav("checkin"), "checkin", 2, "Check-in", "Tick people in as they arrive, or tap a team to tick a group. Press Save & lock when the service is done." + more("checkin")],
         [nav("followup"), "followup", 3, "Follow-up", "Yellow and red show who has missed Sundays in a row, so pastors know who to call." + more("followup")],
         [nav("people"), "people", 5, "Congregation", "Everyone on the register. Tap a name for their history, or edit their details." + more("people")],
         [() => Q("#addw"), "plus", 4, "Your dashboard", "Add widgets, drag them by the handle, or resize them from ⋯. Your layout is only yours."]]),
    [nav("help"), "help", 6, "Help", "Answers for your role, and Contact the admin if you're stuck." + more("help")],
    [() => Q(".acct"), "person", 1, "Your account", "Tap your name for your details, password and settings like colours and text size."]];
  let i = 0;
  const cover = document.createElement("div"), spot = document.createElement("div"), d = document.createElement("div");
  cover.className = "tour-cover"; spot.className = "tour-spot"; d.className = "tour-pop";
  const done = () => { try { localStorage.setItem("fcc-tour:" + S.me.email, "1"); } catch {} [cover, spot, d].forEach(x => x.remove());
      document.removeEventListener("keydown", onKey); removeEventListener("resize", place); },
    onKey = e => { if (e.key === "Escape") done(); else if (e.key === "ArrowRight" && i < steps.length - 1) { i++; draw(); } else if (e.key === "ArrowLeft" && i) { i--; draw(); } };
  // ring the menu item for this step and put the card beside it (or in the middle when there's nothing to point at)
  function place() {
    const el = steps[i][0]?.(), r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null, W = innerWidth, H = innerHeight;
    cover.classList.toggle("dim", !r); spot.hidden = !r; d.classList.toggle("mid", !r); d.style.cssText = "";
    if (!r) return;
    const pad = 6; Object.assign(spot.style, {left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px"});
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
    const el = at?.(); if (el) el.scrollIntoView({block: "nearest"});
    place(); d.querySelector("[data-next]").focus({preventScroll: true});
  };
  document.querySelectorAll(".modal, .tour-cover, .tour-spot, .tour-pop").forEach(m => m.remove());
  document.body.append(cover, spot, d); document.addEventListener("keydown", onKey); addEventListener("resize", place); draw();
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
  toast(to === "pastor" ? "Pastor view: just your own people." : `Back to ${baseName()} view.`);
}
// View as: the admin picks a role (and church, and pastor name for Pastor) and the whole app shows what that person would see.
// Only the screens change: the admin is still signed in as themselves, so anything saved is saved for real.
const PREVIEW = {team: "Team (usher)", lead: "Church admin", pastor: "Pastor", bishop: "Bishop"};
function viewAs() {
  const allP = [...new Set(Object.values(S.pastorList || {}).flat())];
  formDialog("View the app as another role", [
    {k: "role", label: "Role", type: "select", value: "team", options: Object.entries(PREVIEW)},
    {k: "church", label: "Church", type: "select", value: S.church, options: S.churches.map(c => [c, c]), hint: "Not used for Bishop, who sees every church."},
    {k: "pastor", label: "Pastor name (only for Pastor)", value: "", suggest: allP, hint: "As it is on the Pastors list. It decides whose people show."}],
    async v => {
      if (v.role === "pastor" && !v.pastor) throw new Error("Type a pastor's name as it is on the Pastors list.");
      if (v.role === "pastor") { const hit = Object.entries(S.pastorList || {}).find(([, l]) => l.some(n => norm(n) === norm(v.pastor))); if (hit) v.church = hit[0]; }
      try { localStorage.setItem("fcc-preview:" + S.me.email, JSON.stringify({role: v.role, church: v.role === "bishop" ? null : v.church, pastor: v.pastor || ""})); } catch {}
      S.view = v.role === "bishop" ? "overview" : v.role === "pastor" ? "mine" : "dashboard"; S.hist = []; S.shown = "";
      await start(); toast(`Now showing the app as ${PREVIEW[v.role]}. Tap Back to Admin at the top to return.`);
    }, "Show me");
}
async function endPreview() {
  try { localStorage.removeItem("fcc-preview:" + S.me.email); } catch {}
  S.view = "dashboard"; S.hist = []; S.shown = ""; await start(); toast("Back to your Admin view.");
}
const previewName = () => S.preview ? `${PREVIEW[S.preview.role]}${S.preview.role === "pastor" ? " · " + S.preview.pastor : ""}${S.preview.church ? " · " + S.preview.church : ""}` : "";
const switchLabel = () => S.me.role === "pastor" ? `Switch to ${baseName()} view` : "Switch to Pastor view";
function fatal(text) { root.innerHTML = `<div class="center"><div class="login"><h1>Something went wrong</h1><p>${esc(text)}</p><button class="pill-btn block" onclick="location.reload()">Try again</button></div></div>`; }
async function signOut() { try { await auth("logout", {}, S.session?.access_token); } catch {} store.set(null); S.me = null; loginView(); }

// ---------------------------------------------------------------- data for the church being looked at
async function load() {
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const [members, ticks, services, seen, lists] = await Promise.all([
    all("members?select=id,full_name,phone,type,status,age_group,gender,pastor,church,role,date_joined,first_visit,created_at,version&order=full_name")
      .catch(() => all("members?select=id,full_name,phone,type,status,age_group,pastor,church,role,date_joined,first_visit,created_at,version&order=full_name")),
    all(`attendance?select=service_date,member_id,checked_at&service_date=gte.${since}&order=service_date`),
    all(`services?select=service_date,name&service_date=gte.${since}`),
    api("rpc/app_last_seen", {method: "POST", body: {}}).catch(() => null),  // null until the newer setup SQL has been run
    api("settings?select=key,value&key=like.pastors:*").catch(() => [])]);  // each church's list of pastors to choose from
  S.pastorList = Object.fromEntries(lists.map(r => [r.key.slice(8), (r.value || "").split("\n").map(x => x.trim()).filter(Boolean)]));
  S.seen = seen && Object.fromEntries(seen.map(r => [r.member_id, r.last_seen]));
  S.members = S.me.role === "pastor" && S.me.base !== "pastor"  // an admin in Pastor view: only the people assigned to them
    ? members.filter(m => pastorsOf(m).some(n => norm(n) === norm(S.me.pastor))) : members;
  S.ticks = ticks; S.names = Object.fromEntries(services.map(s => [s.service_date, s.name]));
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
  dashboard: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  checkin: '<path d="M5 12l5 5 9-10"/>',
  followup: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  people: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  overview: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  mine: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
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
function pages() {  // the menu, in groups; what each role can actually load is decided by the database
  const r = S.me.role;
  if (r === "bishop") return [["", [["overview", "All churches"], ["help", "Help"]]]];
  if (r === "pastor") return [["", [["mine", "Home"], ["checkin", "Check-in"], ["ask", "Ask a question"], ["help", "Help"]]]];  // a pastor: just their own people
  return [["ATTENDANCE", [["dashboard", "Dashboard"], ["checkin", "Check-in"], ["followup", "Follow-up"], ["pastors", "Pastors"]]],
          ["PEOPLE", [["people", "Congregation"], ...(canApprove() ? [["signups", "Sign-ups"]] : []), ["archive", "Archive"]]],
          ...(r === "team" ? [] : [["RECORDS", [["activity", "Activity"], ["reports", "Reports"],
            ...(r === "admin" ? [["overview", "Churches"], ["admin", "Admin"]] : [])]]]),
          ["", [["ask", "Ask a question"], ["help", "Help"]]]];
}
// Settings each person picks for themselves: colour, theme, text size and so on. Kept on this phone or laptop, per person.
const ACCENTS = [["#1f6fe5", "Blue"], ["#0e8a7c", "Teal"], ["#6250d6", "Violet"], ["#c8417a", "Pink"], ["#dc5f26", "Orange"], ["#2b9348", "Green"], ["#b8860b", "Gold"]];
const LOOK0 = {accent: "", theme: "", text: "normal", motion: false, contrast: false, muted: false, start: ""};
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
function applyLook(v = look()) {
  const d = document.documentElement;
  setMode(v.theme === "system" ? (sysDark.matches ? "dark" : "light") : v.theme || d.dataset.theme);
  if (/^#[0-9a-f]{6}$/i.test(v.accent)) { d.style.setProperty("--accent", v.accent); d.style.setProperty("--accent-ink", inkOn(v.accent));
    d.style.setProperty("--accent-soft", `color-mix(in srgb, ${v.accent} 14%, var(--panel))`); }
  else ["--accent", "--accent-ink", "--accent-soft"].forEach(k => d.style.removeProperty(k));
  d.dataset.text = v.text; d.classList.toggle("calm", !!v.motion); d.classList.toggle("strong", !!v.contrast); d.classList.toggle("muted", !!v.muted);
}
sysDark.addEventListener?.("change", () => { if (S.me && look().theme === "system") applyLook(); });
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
  const short = {dashboard: "Home", overview: "Churches", people: "People", followup: "Follow-up"};  // the bottom bar on phones: the four most-used pages, then More
  const dock = groups.flatMap(g => g[1]).filter(x => ["mine", "dashboard", "checkin", "followup", "people", "overview"].includes(x[0])).slice(0, 4).map(([k, t]) => [k, short[k] || t]);
  const go = to => { S.view = to; render(); };
  const where = S.me.role === "bishop" ? "All churches" : S.church;
  if (S.mini === undefined) { try { S.mini = localStorage.getItem("fcc-mini") === "1"; } catch { S.mini = false; } }
  root.innerHTML = `<div class="shell ${S.mini ? "mini" : ""}">
    <div class="scrim" data-close></div>
    <aside class="side" id="menu"><div class="brand"><span class="brand-mark">✝</span><span class="brand-txt">Favourite Child Church</span>
        <button type="button" class="side-tg" data-mini aria-label="${S.mini ? "Show menu names" : "Icons only"}" title="${S.mini ? "Show menu names" : "Icons only"}" aria-pressed="${!!S.mini}">${svg("panel")}</button></div>
      ${groups.map(([h, items]) => (h ? `<h6>${h}</h6>` : "") + items.map(([k, t]) => `<button class="nav ${S.view === k ? "on" : ""}" data-view="${k}" title="${t}" style="--nc:var(--h${NAVHUE[k] || 1})">${svg(k)}<span class="nl">${t}</span>${
        k === "signups" && S.pending ? `<span class="count">${S.pending}</span>` : ""}</button>`).join("")).join("")}
      ${S.me.role === "admin" ? `<h6>CHURCH</h6><button class="church on" data-view="overview" title="See every church and switch to another one"><i></i><span>${esc(S.church)}</span><em>Change</em></button>` : ""}
      <div class="side-foot">${S.me.base === "admin" ? (S.preview ? `<button class="nav" data-unpreview title="Back to Admin">${svg("back")}<span class="nl">Back to Admin</span></button>`
          : `<button class="nav" data-viewas title="View as another role">${svg("eye")}<span class="nl">View as another role</span></button>`) : ""}${S.canSwitch ? `<button class="nav" data-switch title="${switchLabel()}">${svg("pastors")}<span class="nl">${switchLabel()}</span></button>` : ""}<button class="nav out" data-out title="Log out">${svg("out")}<span class="nl">Log out</span></button></div></aside>
    <main class="main">${S.preview ? `<div class="preview-bar">${svg("eye")}<span>Viewing as <b>${esc(previewName())}</b>. You're still signed in as you, so anything you change is saved for real.</span>
        <button class="pill-btn sm" data-unpreview>Back to Admin</button></div>` : ""}<div class="top">${S.hist?.length ? `<button class="back" data-back>${svg("back")}Back</button>` : ""}<span class="gap"></span>
        <div class="mode" role="group" aria-label="Colour mode"><button data-mode="light">Light</button><button data-mode="dark">Dark</button></div>
        <button class="acct" data-view="account" title="Your account and settings" aria-label="Your account and settings"><span class="acct-pic">${esc(initials(who))}</span><span><b>${esc(who)}</b><small>${roleName(S.me)} · ${esc(where)}</small></span></button>
        <button class="icon-btn" data-out aria-label="Log out" title="Log out">${svg("out")}</button></div>
      <div class="body" id="view"></div></main>
    <nav class="dock" aria-label="Main">${dock.map(([k, t]) => `<button class="${S.view === k ? "on" : ""} ${t.length > 9 ? "long" : ""}" data-view="${k}" aria-label="${t}">${svg(k)}<span>${t}</span></button>`).join("")}
      <button class="${dock.some(x => x[0] === S.view) ? "" : "on"}" data-menu aria-label="More" aria-controls="menu" aria-expanded="false">${svg("more")}<span>More</span></button></nav></div>`;
  const shell = root.querySelector(".shell"), menuBtn = root.querySelector("[data-menu]");
  const menu = open => { shell.classList.toggle("open", open); menuBtn.setAttribute("aria-expanded", open); };
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
  root.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { setMode(b.dataset.mode, true); if (look().theme) saveLook({theme: b.dataset.mode}); });
  root.querySelectorAll("[data-out]").forEach(b => b.onclick = signOut);
  root.querySelectorAll("[data-viewas]").forEach(b => b.onclick = () => { menu(false); viewAs(); });
  root.querySelectorAll("[data-unpreview]").forEach(b => b.onclick = endPreview);
  root.querySelectorAll("[data-switch]").forEach(b => b.onclick = () => switchView(S.me.role === "pastor" ? S.me.base : "pastor"));
  const view = document.getElementById("view");
  view.onclick = e => {
    const b = e.target.closest("[data-person]"); if (b) { S.person = b.dataset.person; go("person"); return; }
    const t = e.target.closest("[data-to-pastor]"); if (t) { S.pastor = t.dataset.toPastor; S.pastorJump = true; go("pastors"); }
  };
  root.querySelectorAll("[data-back]").forEach(b => b.onclick = () => history.back());  // same as the phone's back gesture
  ({mine, dashboard, checkin, followup, pastors, people, person, signups, archive, activity, reports, overview, admin, account, help, ask}[S.view] || dashboard)(view);
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
addEventListener("popstate", () => {
  if (!S.me || !S.hist?.length) return;
  S.view = S.hist.pop(); S.goingBack = true; document.querySelectorAll(".modal").forEach(m => m.remove()); render();
});
const TITLE = {mine: "Home", dashboard: "Dashboard", checkin: "Check-in", followup: "Follow-up", pastors: "Pastors", people: "Congregation", person: "Person", account: "Your account", help: "Help", ask: "Ask a question", signups: "Sign-ups", archive: "Archive",
               activity: "Activity", reports: "Reports", overview: "All churches", admin: "Admin"};
const NAVHUE = {dashboard: 1, mine: 1, checkin: 2, followup: 3, pastors: 4, people: 5, signups: 6, archive: 4, activity: 2, reports: 3, overview: 1, admin: 4, ask: 5, help: 6, account: 1, person: 5};
const head = (title, sub, buttons = "") => `<div class="head">${ICON[S.view] ? `<span class="hico" style="--wc:var(--h${NAVHUE[S.view] || 1});--wb:var(--h${NAVHUE[S.view] || 1}b)">${svg(S.view)}</span>` : ""}<div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><span class="gap" style="flex:1"></span>${buttons}</div>`;
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
    ["✅", `Present: *${p.present.length}*`], ["🧑", `Adults: *${p.present.length - p.kids}*`], ["🧒", `Kids: *${p.kids}*`],
    ["👋", `First-timers: *${p.first}*`], ...who(p.present.filter(m => m.type === "first_timer")),
    ...(p.visitors ? [["🤝", `Visitors: *${p.visitors}*`], ...who(p.present.filter(m => m.type === "visitor"))] : []), "", "*Follow-up*",
    ["🔴", `Missed ${RED_AT}+ in a row: *${p.count("red")}*`], ...who(flagged("red")),
    ["🟡", `Missed ${YELLOW_AT}–${RED_AT - 1} in a row: *${p.count("yellow")}*`], ...who(flagged("yellow")),
    ...(o.link ? ["", ["📺", `Livestream: ${o.link}`]] : [])]);
}
function chart(el, rows, pick) {  // stacked bars: adults + kids per service; tapping a bar opens that day's Check-in, or calls pick(day)
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
    g.onclick = g.onkeydown = e => { if (e.type === "keydown" && e.key !== "Enter") return; if (pick) return pick(rows[g.dataset.i][0]); S.date = rows[g.dataset.i][0]; S.view = "checkin"; render(); };
  });
}
// Each name gets one of six colours from its letters, so the same person always has the same colour circle.
const hueOf = s => 1 + [...norm(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;
const avaStyle = s => `style="background:var(--h${hueOf(s)}b);color:var(--h${hueOf(s)}t)"`;
const whoBtn = m => `<button class="who" data-person="${esc(m.id)}" title="See their attendance history"><span ${avaStyle(m.full_name)}>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</button>`;
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
        .map(([t, n, h, sub]) => `<button type="button" class="ov-cell" title="Open Check-in for this service"><b>${n}</b><span>${t}</span><small><i style="background:var(--h${h})"></i>${esc(sub)}</small></button>`).join("")}</div>`;
      el.querySelectorAll(".ov-cell").forEach(t => t.onclick = () => { S.date = p.last || today(); S.view = "checkin"; render(); });
    }},
  compare: {name: "Compared with last time", sub: p => { const prev = p.last && sameDayBefore(p, p.last); return prev ? `Against ${svcName(prev)} · ${nice(prev, true)}` : "The same day last week"; }, desc: "Each number against the previous service on the same day of the week, as more or fewer people.", size: "wide", icon: "compare", hue: 4,
    draw(el, p) {
      const prev = p.last && sameDayBefore(p, p.last);
      if (!prev) { el.innerHTML = `<p class="empty">Needs two services on the same day of the week first.</p>`; return; }
      const a = countsOn(p, p.last), b = countsOn(p, prev);
      el.innerHTML = `<div class="ov">${[["Present", "present", 5], ["Adults", "adults", 1], ["Kids", "kids", 2], ["First-timers", "first", 3]].map(([t, k, h]) =>
        `<div class="ov-cell"><b>${a[k]}</b><span>${t}</span><small><i style="background:var(--h${h})"></i>${b[k]} on ${esc(nice(prev))} ${delta(a[k], b[k], a[k] > b[k] ? " more" : a[k] < b[k] ? " fewer" : "")}</small></div>`).join("")}</div>`;
    }},
  people: {name: "People present", sub: "Adults and kids at each service · tap a bar to open it", size: "wide", icon: "dashboard", hue: 1,
    draw(el, p) {
      const kidIds = new Set(p.mine.filter(isKid).map(m => m.id));
      const series = p.dates.map(d => { const ids = Object.keys(p.byDate[d]), k = ids.filter(i => kidIds.has(i)).length; return [d, ids.length - k, k]; });
      el.closest(".w").querySelector(".w-tools").innerHTML = `<div class="legend"><span><i style="background:var(--adults)"></i>Adults</span><span><i style="background:var(--kids)"></i>Kids</span></div>`;
      el.innerHTML = `<div class="chart"></div>`;
      chart(el.querySelector(".chart"), series);
    }},
  calendar: {name: "Calendar", sub: "Services this month and how many came", size: "narrow", icon: "followup", hue: 2, draw(el, p) { calendar(el, p); }},
  trend: {name: "Attendance trend", sub: () => TREND[trendView()][1], desc: "Attendance over time. Switch between Sundays, every service, midweek or monthly.", size: "full", icon: "trend", hue: 1,
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
  split: {name: "Who came", sub: p => p.last ? `${svcName(p.last)} · ${nice(p.last, true)}` : "The latest service", desc: "The latest service split into adults, kids, first-timers and visitors, against the same day last week.", size: "narrow", icon: "split", hue: 3,
    draw(el, p) {
      if (!p.last) { el.innerHTML = `<p class="empty">No service recorded yet.</p>`; return; }
      const c = countsOn(p, p.last), prev = sameDayBefore(p, p.last), b = prev ? countsOn(p, prev) : null;
      const parts = [["Adults", "mAdults", 1], ["Kids", "mKids", 2], ["First-timers", "first", 3], ["Visitors", "visitors", 4]];
      el.innerHTML = `<div class="split-top"><b>${c.present}</b> present</div>
        <div class="split-bar">${parts.filter(([, k]) => c[k]).map(([t, k, h]) => `<i style="flex:${c[k]};background:var(--h${h})" title="${t}: ${c[k]}"></i>`).join("") || "<i></i>"}</div>
        <div class="split-rows">${parts.map(([t, k, h]) => `<div><span><i style="background:var(--h${h})"></i>${t} <em>(${c[k]})</em></span>${b ? `<small>${delta(c[k], b[k])} vs ${esc(nice(prev))}</small>` : ""}</div>`).join("")}</div>`;
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
        <p class="note" style="margin:8px 0 0">${pct === null ? "No first-timers in these " + (view === "month" ? "months" : "weeks") + " yet. " : ""}Target: half come back. The latest ${view === "month" ? "month is" : "few weeks are"} still counting, so ${view === "month" ? "it is" : "they are"} left out of the %.</p>`;
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
  stands: {name: "Where everyone stands", sub: "Came, missed once, or need a call", size: "narrow", icon: "people", hue: 5,
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
  return (mine || B.def()).filter(k => defs[dashKey(k)]);
}
async function saveBoard(b, list) {
  const home = b === "home" ? list : boardList("home"), church = b === "church" ? list : boardList("church");
  const raw = S.prefs = [...home, "h:", ...church.map(k => "c:" + k), "c:"];
  try { localStorage.setItem("fcc-dash:" + S.me.email, JSON.stringify(raw)); } catch {}
  if (S.dashDb !== false) try { await api("app_prefs?on_conflict=email", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {email: S.me.email, dash: raw}}); } catch { S.dashDb = false; }
}
async function dashboard(el) {
  const p = picture();
  el.innerHTML = head("Dashboard", p.last ? `${esc(svcName(p.last))} · ${esc(nice(p.last, true))}` : "No services recorded yet",
    `<button class="pill-btn" id="addw">${svg("plus")}Add widget</button><button class="pill-btn" id="wa">WhatsApp summary</button><button class="pill-btn primary" data-go="checkin">${svg("checkin")}Check people in</button>`) + `<div class="wgrid" id="wgrid"></div>`;
  el.querySelector("#wa").onclick = () => waDialog("Summary for WhatsApp", o => !p.dates.includes(o.day) ? null : report(o.day !== p.last ? picture(o.day) : p, o), {names: true, link: true, follow: true, noEmoji: true, day: p.last || today(),
    fields: [["preacher", "Preacher name"], ["sermon", "Sermon title"], ["zoomA", "Zoom: adults", "num"], ["zoomK", "Zoom: children", "num"], ["yt", "YouTube", "num"], ["fb", "Facebook", "num"], ["converts", "New converts", "num"]]});
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
  const B = BOARDS[b], defs = B.defs(), have = boardList(b), left = Object.keys(defs).filter(k => !have.some(x => dashKey(x) === k));
  const d = document.createElement("div"); d.className = "modal";
  d.innerHTML = `<div class="sheet narrow" role="dialog" aria-modal="true" aria-label="Add widget">
    <div class="card-head"><h2>Add widget</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
    ${left.length ? `<div class="wlist">${left.map(k => { const W = defs[k]; return `<div class="witem" style="--wc:var(--h${W.hue});--wb:var(--h${W.hue}b)"><div class="wico">${svg(W.icon)}</div><div class="wtxt"><b>${esc(W.name)}</b><p>${esc(W.desc || W.sub)}</p></div>
      <button class="pill-btn primary sm" data-add="${k}">Select</button></div>`; }).join("")}</div>` : `<p class="empty">Every widget is already on this ${B.where}.</p>`}
    <p class="note">Drag a widget by its handle to move it. Your layout is yours only: nobody else's view changes.</p>
    <div class="modal-foot"><button type="button" class="pill-btn" data-reset>Back to the standard layout</button></div></div>`;
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
  const pastor = S.me.role === "pastor";  // a pastor ticks their own people only (locks work as for ushers): no adding or renaming
  // Laid out like Admin → Sign-ins: numbers on top, then pills to filter, team and search on the right, a table of names, 25 a page
  el.innerHTML = head("Check-in", pastor ? "Your people" : esc(S.church)) + `
    <div class="card" style="margin-bottom:14px"><div class="row">
      <div style="flex:0 0 170px"><label class="f" for="d">Service date</label><input class="in" id="d" type="date" value="${S.date}"></div>
      <div><label class="f" for="svc">Service</label><input class="in" id="svc" list="svc-list" maxlength="60" autocomplete="off" value="${esc(svcName(S.date))}" ${pastor ? "readonly" : ""}>
        <datalist id="svc-list">${[...new Set(["Sunday Service", "Midweek Service", "Prayer Meeting", "Special Service", ...Object.values(S.names)])].map(n => `<option value="${esc(n)}">`).join("")}</datalist></div></div></div>
    <div class="tiles"><div class="card tile"><div class="label">Checked in</div><div class="num" id="n-in">0</div></div>
      <div class="card tile"><div class="label">Adults</div><div class="num" id="n-ad">0</div></div>
      <div class="card tile"><div class="label">Kids</div><div class="num" id="n-kid">0</div></div>
      <div class="card tile"><div class="label">Not yet</div><div class="num" id="n-not">0</div></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2 id="ci-title">Names A to Z</h2><span class="gap"></span><button type="button" class="pill-btn sm" id="ci-lock">${svg("lock")}Save &amp; lock</button></div>
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
    teamBox.innerHTML = `<button type="button" class="rpill tint" data-team="" aria-pressed="${!S.ciRole}">Everyone <span>${mine.length}</span></button>` + show.map(k => { const h = hueOf(teams[k].label);
      return `<button type="button" class="rpill tint" data-team="${esc(k)}" aria-pressed="${S.ciRole === k}" style="--rc:var(--h${h});--rb:var(--h${h}b);--rt:var(--h${h}t)"><i></i>${esc(teams[k].label)} <span>${teams[k].n}</span></button>`; }).join("")
      + (more ? `<button type="button" class="rpill more" data-more>+ ${more} more</button>` : S.ciMore && teamKeys.length > 5 ? `<button type="button" class="rpill more" data-more>Show less</button>` : ""); };
  teamBox.onclick = e => { if (e.target.closest("[data-more]")) { S.ciMore = !S.ciMore; drawTeams(); return; }
    const b = e.target.closest("[data-team]"); if (!b) return; S.ciRole = S.ciRole === b.dataset.team ? "" : b.dataset.team; S.ciPage = 1; armed = false; drawTeams(); draw(); };
  drawTeams();
  const PER = 60;  // three columns of 20
  let armed = false, armedAll = false, busy = false;
  const narrowedTo = () => { const q = norm(S.q);  // team and search; the pills then pick within these
    return mine.filter(m => (!S.ciRole || rolesOf(m).some(r => norm(r) === S.ciRole)) && (!q || norm(m.full_name).includes(q) || norm(m.phone).includes(q) || rolesOf(m).some(r => norm(r).includes(q)))); };
  const showing = () => narrowedTo();
  const draw = () => {
    const shown = narrowedTo(), narrowed = !!(S.ciRole || norm(S.q)), ticked = shown.filter(m => here[m.id]).length;
    const pages = Math.max(1, Math.ceil(shown.length / PER)); S.ciPage = Math.min(Math.max(1, S.ciPage || 1), pages);
    const page = shown.slice((S.ciPage - 1) * PER, S.ciPage * PER);
    const nums = [...new Set([1, S.ciPage - 1, S.ciPage, S.ciPage + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
    box.innerHTML = shown.length ? `<div class="names">${page.map(m => `<label class="name ${here[m.id] ? "on" : ""}"><input type="checkbox" data-id="${esc(m.id)}" ${here[m.id] ? "checked" : ""} ${lock ? "disabled" : ""}>
        <span class="nava" ${avaStyle(m.full_name)}>${esc(initials(m.full_name))}</span><span class="nn">${esc(m.full_name)}</span><small>${[m.type === "first_timer" ? "first-timer" : m.type === "visitor" ? "visitor" : "", isKid(m) ? "child" : ""].filter(Boolean).map(esc).join(" · ")}</small></label>`).join("")}</div>`
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
  el.querySelector("#q").oninput = e => { S.q = e.target.value; S.ciPage = 1; armed = false; draw(); };
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
  const svc = el.querySelector("#svc");
  el.querySelector("#d").onchange = e => { S.date = e.target.value || today(); svc.value = svcName(S.date); here = {}; lock = null; draw(); showLock(); pull(); };
  if (!pastor) svc.onchange = async () => {
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
  if (pastor) { draw(); pull(); S.poll = setInterval(pull, 5000); return; }  // no Add form for pastors
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
      await setPresent(id, true);
      e.target.reset(); toast(`${name} is checked in${known ? " (already on the list)" : ""}.`); pull();
    } catch (err) { toast("Not saved: " + err.message); }
  };
  draw(); pull(); S.poll = setInterval(pull, 5000);
}

// ---------------------------------------------------------------- follow-up and people
function followup(el) {
  // any service date can be looked at: the lists show how things stood after that service
  const p0 = picture(), day = S.fuDay && S.fuDay !== p0.last ? S.fuDay : p0.last, had = !!day && p0.dates.includes(day);
  const p = had && day !== p0.last ? picture(day) : p0;
  const started = x => ([x.date_joined, x.first_visit].filter(Boolean).sort()[0] || (x.created_at || "").slice(0, 10) || "0000") <= day;
  const tabs = {need: "Needs follow-up", red: "Red only", yellow: "Yellow only", blue: "Missed this service", all: "Everyone"};
  const pick = {need: x => x.level !== "ok", red: x => x.flag === "red", yellow: x => x.flag === "yellow", blue: x => !p.here[x.id] && started(x), all: () => true};
  const list = had ? p.people.filter(pick[S.filter]) : [];
  el.innerHTML = head("Follow-up", esc(S.church),
    `<button class="pill-btn" id="dl">Download this list</button>`) + `
    <div class="row sortbar"><div style="flex:0 0 200px"><label class="f" for="fu-day">Service date</label><input class="in" id="fu-day" type="date" value="${day || today()}" max="${today()}"></div>
      ${had ? `<p class="note" style="margin:0 0 4px;flex:1">${esc(S.names[day] || "Service")} · ${esc(nice(day, true))}${day !== p0.last ? ` · <button class="link" id="fu-latest" style="margin:0">Back to the latest service</button>` : ""}</p>` : ""}</div>
    <div class="chips">${Object.entries(tabs).map(([k, t]) => `<button class="chip ${S.filter === k ? "on" : ""}" data-f="${k}">${t}</button>`).join("")}</div>
    <div class="card"><div class="card-head"><h2>${tabs[S.filter]}</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${list.length} people</span></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Missed in a row</th><th class="hide-sm">Last seen</th><th class="hide-sm">Pastor</th><th>Phone</th></tr></thead>
      <tbody>${rowsHtml(list, true)}</tbody></table></div>` : `<p class="empty">${had ? "Nobody in this list." : `No service was recorded on ${esc(nice(day || today(), true))}.`}</p>`}</div>`;
  el.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.filter = b.dataset.f; render(); });
  el.querySelector("#fu-day").onchange = e => { S.fuDay = e.target.value; render(); };
  const back = el.querySelector("#fu-latest"); if (back) back.onclick = () => { S.fuDay = ""; render(); };
  el.querySelector("#dl").onclick = () => download(`${norm(tabs[S.filter]).replace(/ /g, "_")}_${S.church}_${day || today()}.csv`,
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
  const edit = S.me.role !== "team", statuses = ["", "Away", "Inactive", "Moved", "Left", "Transferred", "Deceased"];
  const roleNames = roleKeys.map(k => counts[k].label);
  const picked = everyone.filter(m => S.sel.has(m.id)), shownPicked = mine.filter(m => S.sel.has(m.id)).length;
  const typeOf = typeName, ageOf = m => isKid(m) ? "Child" : "Adult";
  // Laid out like Admin → Sign-ins: numbers on top, pills to filter, tools on the right, 20 people per page
  const PER = 20, pages = Math.max(1, Math.ceil(mine.length / PER)); S.pPage = Math.min(Math.max(1, S.pPage || 1), pages);
  const shown = mine.slice((S.pPage - 1) * PER, S.pPage * PER);
  const nums = [...new Set([1, S.pPage - 1, S.pPage, S.pPage + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  const TYPECLS = {member: "r-team", first_timer: "r-pastor", visitor: "r-bishop"};
  const DOT = {member: "r-team", first: "r-pastor", visitor: "r-bishop", nopastor: "r-admin", female: "r-lead", male: "r-lead", adult: "", child: ""};
  el.innerHTML = head("Congregation", esc(S.church), `<button class="pill-btn" id="dl">Download</button>`) + `
    <div class="tiles">${[["Total people", everyone.length, "In " + S.church], ["Members", everyone.filter(SHOW.member[1]).length, "Regular members"],
        ["First-timers & visitors", everyone.filter(m => m.type === "first_timer" || m.type === "visitor").length, "Still getting to know us"],
        ["No pastor yet", everyone.filter(SHOW.nopastor[1]).length, "Need a pastor assigned"]]
      .map(([t, n, sub]) => `<div class="card tile"><div class="label">${t}</div><div class="num">${String(n).padStart(2, "0")}</div><div class="note" style="margin:4px 0 0">${esc(sub)}</div></div>`).join("")}</div>
    <div class="card">
      <div class="u-bar"><div class="rpills" role="tablist" aria-label="Show">${Object.entries(SHOW).map(([k, [t, f]]) =>
          `<button type="button" class="rpill ${DOT[k] || ""}" role="tab" data-show="${k}" aria-selected="${S.showF === k}">${k === "all" || !DOT[k] ? "" : "<i></i>"}${t} <span>${inRole.filter(f).length}</span></button>`).join("")}</div>
        <div class="u-tools">${roleKeys.length ? `<select class="in" id="teamF" aria-label="Team"><option value="">All teams</option>${roleKeys.map(k => `<option value="${esc(k)}" ${S.roleF === k ? "selected" : ""}>${esc(counts[k].label)} · ${counts[k].n}</option>`).join("")}</select>` : ""}
          <select class="in" id="sort" aria-label="Sort by">${Object.entries(SORT).map(([k, [t]]) => `<option value="${k}" ${S.sortBy === k ? "selected" : ""}>${t}</option>`).join("")}</select>
          <input class="in" id="find" type="search" placeholder="Search by name, phone or pastor" value="${esc(S.findQ || "")}" aria-label="Search people" autocomplete="off"></div></div>
      ${edit && picked.length ? `<div class="bulk"><b>${picked.length} selected</b><button class="pill-btn sm" id="bulk-see">${S.selOnly ? "Show all" : "View"}</button><span class="gap"></span><button class="pill-btn sm primary" id="bulk-go">${svg("edit")}Change roles</button><button class="pill-btn sm" id="bulk-pastor">Set pastor</button><button class="pill-btn sm" id="bulk-set">Set details</button><button class="pill-btn sm" id="bulk-x">Clear</button></div>` : ""}
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
  el.querySelectorAll("[data-ppg]").forEach(b => b.onclick = () => { S.pPage = +b.dataset.ppg; render(); el.scrollIntoView?.({block: "start"}); });
  const teamF = el.querySelector("#teamF"); if (teamF) teamF.onchange = e => { S.roleF = e.target.value; S.pPage = 1; render(); };
  el.querySelector("#sort").onchange = e => { S.sortBy = e.target.value; S.pPage = 1; render(); };
  el.querySelectorAll("[data-pick]").forEach(c => c.onchange = () => { c.checked ? S.sel.add(c.dataset.pick) : S.sel.delete(c.dataset.pick); render(); });
  const all = el.querySelector("#pick-all");
  if (all) all.onchange = () => { for (const m of mine) all.checked ? S.sel.add(m.id) : S.sel.delete(m.id); render(); };  // only those on show
  const see = el.querySelector("#bulk-see"); if (see) see.onclick = () => { S.selOnly = !S.selOnly; render(); };
  const bp = el.querySelector("#bulk-pastor");
  if (bp) bp.onclick = () => {
    if (!plist.length) return toast("Add your pastors on the Pastors page first, then come back.");
    formDialog(`Pastors for ${picked.length} ${picked.length === 1 ? "person" : "people"}`, [
      {k: "how", label: "What to do", type: "select", value: "add", options: [["add", "Add this pastor (keep any others)"], ["only", "Make this their only pastor"], ["remove", "Take this pastor off"]]},
      {k: "pastor", label: "Pastor", type: "select", value: plist[0], options: plist.map(n => [n, n])},
    ], async v => {
      let done = 0, clash = 0, self = 0;
      for (const m of picked) {
        if (v.how !== "remove" && isSelf(v.pastor, m)) { self++; continue; }  // a pastor is never put under themselves
        const now = pastorsOf(m), next = v.how === "only" ? [v.pastor] : v.how === "remove" ? now.filter(x => x !== v.pastor) : [...new Set([...now, v.pastor])];
        const pastor = next.join(", "); if (pastor === now.join(", ")) continue;
        const ver = Number(m.version) || 1;
        const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body: {pastor, version: ver + 1}});
        if (!rows?.length) { clash++; continue; }
        Object.assign(m, {pastor, version: ver + 1}); done++;
        log("edit", m.id, "done", "pastor");
      }
      if (clash) await load();
      S.sel = new Set();
      toast((clash ? `Changed ${done}. ${clash} were edited by someone else just now and were left alone.` : done ? `Changed ${done} ${done === 1 ? "person" : "people"}.` : "Nothing needed changing.")
        + (self ? ` ${v.pastor} was not made their own pastor.` : ""));
      render();
    }, "Set pastor");
  };
  // Set details: gender, age group, attendance type or status for everyone selected; "Leave as is" keeps what each person has
  const bs = el.querySelector("#bulk-set");
  if (bs) bs.onclick = () => {
    const keep = [["", "Leave as is"]];
    formDialog(`Details for ${picked.length} ${picked.length === 1 ? "person" : "people"}`, [
      {k: "gender", label: "Gender", type: "select", value: "", options: [...keep, ["Female", "Female"], ["Male", "Male"], ["-", "Not given"]]},
      {k: "age_group", label: "Age group", type: "select", value: "", options: [...keep, ["Adult", "Adult"], ["Child", "Child"]]},
      {k: "type", label: "Attendance Type", type: "select", value: "", options: [...keep, ...typeOpts]},
      {k: "status", label: "Status", type: "select", value: "", options: [...keep, ["-", "Active"], ...statuses.filter(Boolean).map(x => [x, x])]},
    ], async v => {
      const want = Object.fromEntries(Object.entries(v).filter(([, val]) => val).map(([k, val]) => [k, val === "-" ? "" : val]));
      if (!Object.keys(want).length) throw new Error("Choose at least one thing to change.");
      let done = 0, clash = 0;
      for (const m of picked) {
        const body = Object.fromEntries(Object.entries(want).filter(([k, val]) => (k === "gender" ? genderOf(m) : k === "age_group" ? ageOf(m) : k === "type" ? typeKey(m) : m.status || "") !== val));
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
  el.querySelector("#dl").onclick = () => download(`people_${S.church}_${today()}.csv`, [["Church", "Name", "Pastor assigned", "Type", "Age group", "Gender", "Status", "Phone", "Roles"],
    ...mine.map(m => [S.church, m.full_name, pastorsOf(m).join(", "), typeOf(m), ageOf(m), genderOf(m), m.status || "Active", m.phone || "", rolesOf(m).join(", ")])]);
}

// The Edit popup for one person; used on Congregation and on the Pastors page.
function editPerson(m) {
    if (!m) return;
    const plist = S.pastorList[churchOf(m)] || [], admin = S.me.role === "admin", statuses = ["", "Away", "Inactive", "Moved", "Left", "Transferred", "Deceased"];
    const ageOf = m => isKid(m) ? "Child" : "Adult";
    const roleNames = [...new Map(S.members.filter(x => churchOf(x) === churchOf(m)).flatMap(rolesOf).map(r => [norm(r), r])).values()].sort();
    const cur = pastorsOf(m);
    const pastors = [...plist, ...cur.filter(c => !plist.includes(c))].filter(n => !isSelf(n, m)).map(n => [n, n]);
    formDialog(`Edit ${m.full_name}`, [
      {k: "full_name", label: "Full name", value: m.full_name, required: true},
      {k: "phone", label: "Phone", value: m.phone || "", type: "tel"},
      {k: "role", label: "Roles", value: rolesOf(m).join(", "), suggest: roleNames, many: true, hint: "Separate several with commas."},
      {k: "type", label: "Attendance Type", value: typeKey(m), type: "select", options: typeOpts},
      {k: "age_group", label: "Age group", value: ageOf(m), type: "select", options: [["Adult", "Adult"], ["Child", "Child"]]},
      {k: "gender", label: "Gender", value: genderOf(m), type: "select", options: [["", "Not given"], ["Female", "Female"], ["Male", "Male"]]},
      {k: "status", label: "Status", value: statuses.find(x => norm(x) === norm(m.status)) ?? m.status, type: "select",
       options: [...statuses.map(x => [x, x || "Active"]), ...(m.status && !statuses.some(x => norm(x) === norm(m.status)) ? [[m.status, m.status]] : [])]},
      pastors.length ? {k: "pastor", label: "Pastors", value: cur, type: "multi", options: pastors, hint: "Tick one or more."}
                     : {k: "pastor", label: "Pastors", value: "", hint: "Add pastors on the Pastors page to choose from a list."},
      ...(admin ? [{k: "church", label: "Church", value: churchOf(m), type: "select", options: S.churches.map(c => [c, c])}] : []),
    ], async v => {
      if (!v.full_name) throw new Error("Type their name.");
      const badPhone = phoneProblem(v.phone, false); if (badPhone) throw new Error(badPhone);
      if (v.pastor.split(",").some(n => isSelf(n.trim(), m))) throw new Error("Someone can't be their own pastor. Choose a different pastor.");
      v.role = v.role.split(",").map(x => x.trim()).filter(Boolean).join(", ");
      const changed = Object.fromEntries(Object.entries(v).filter(([k, val]) => val !== String(k === "church" ? churchOf(m) : k === "age_group" ? ageOf(m) : k === "type" ? typeKey(m) : k === "gender" ? genderOf(m) : k === "pastor" ? pastorsOf(m).join(", ") : (m[k] ?? "")).trim()));
      if (!Object.keys(changed).length) return;
      // only save over the version this screen loaded: if someone else edited the person meanwhile, nothing is overwritten
      const ver = Number(m.version) || 1;
      const rows = await api(`members?id=eq.${encodeURIComponent(m.id)}&version=eq.${ver}`, {method: "PATCH", prefer: "return=representation", body: {...changed, version: ver + 1}})
        .catch(err => { throw new Error(/gender/.test(err.message) ? "Run the latest setup SQL in Supabase once to save gender, then try again." : err.message); });
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
const CDASH_DEFAULT = ["numbers", "chart", "churches", "follow"];
const CWIDGETS = {
  numbers: {name: "Service numbers", sub: c => c.when, desc: "Present (with the change since last time), adults and kids, first-timers, and how many of the register came.", size: "full", icon: "checkin", hue: 1,
    draw(el, c) {
      if (!c.had && c.day) { el.innerHTML = `<p class="empty">No service was recorded ${S.bChurch ? "at " + esc(S.bChurch) : "at any church"} on ${esc(nice(c.day, true))}.</p>`; return; }
      el.innerHTML = `<div class="ov">${[["Present", c.nowN, 5, c.delta === null ? "at the latest service" : c.delta === 0 ? "same as last time" : `${c.delta > 0 ? "▲" : "▼"} ${Math.abs(c.delta)} ${c.delta > 0 ? "more" : "fewer"} than last time`],
        ["Adults · Kids", `${c.sum(c.pick, "adults")}<small> · ${c.sum(c.pick, "kids")}</small>`, 1, "adults and kids"], ["First-timers", c.sum(c.pick, "first_timers"), 3, "at the latest service"],
        ["Came", c.rate + "%", 2, `of ${c.reg} on the register`]].map(([t, n, h, sub]) => `<div class="ov-cell"><b>${n}</b><span>${t}</span><small><i style="background:var(--h${h})"></i>${esc(sub)}</small></div>`).join("")}</div>`;
    }},
  chart: {name: "People present", sub: "Adults and kids at each service · tap a bar to see that day", size: "full", icon: "dashboard", hue: 1,
    draw(el, c) {
      el.closest(".w").querySelector(".w-tools").innerHTML = `<div class="legend"><span><i style="background:var(--adults)"></i>Adults</span><span><i style="background:var(--kids)"></i>Kids</span></div>`;
      if (!c.trend) { el.innerHTML = `<p class="empty">Run the latest setup SQL in Supabase once to see this chart.</p>`; return; }
      el.innerHTML = `<div class="chart"></div>`; chart(el.querySelector(".chart"), c.series.map(x => [x[0], x[1], x[2]]), c.pickDay);
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
  split: {name: "Who came", sub: c => c.series.length ? `${nice(c.series.at(-1)[0], true)}` : "The latest service", desc: "Adults and kids at the latest service, and how many were first-timers or visitors.", size: "narrow", icon: "split", hue: 3,
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
      const rows = c.series.slice(innerWidth < 640 ? -7 : -12), top = Math.max(1, ...rows.map(x => x[3])), topDay = [...rows].reverse().find(x => x[3] === top)?.[0];
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
  const [trend, days] = await Promise.all([api("rpc/church_trend", {method: "POST", body: day ? {upto: day} : {}}).catch(() => null),  // null until the newer setup SQL has been run
    api("rpc/church_days", {method: "POST", body: {}}).catch(() => null)]);
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
  el.innerHTML = head("All churches", admin ? "Pick a day and a church, or open a church to work in it" : "Numbers only", `<button class="pill-btn" id="addcw">${svg("plus")}Add widget</button><button class="pill-btn" id="wa">Summary for WhatsApp</button><button class="pill-btn" id="dl">Download</button>`) + `
    <div class="bish">
      <div class="card b-cal" id="b-cal"></div>
      <nav class="card b-list" aria-label="Churches">${list}</nav>
      <section class="b-detail">
        <div class="b-title"><h2>${esc(S.bChurch || "All churches")}</h2><span class="muted">${esc(when)}</span>
          ${admin && S.bChurch ? `<span class="gap" style="flex:1"></span><button class="pill-btn primary sm" data-open="${esc(S.bChurch)}">Open ${esc(S.bChurch)}</button>` : ""}</div>
        <div class="wgrid c2" id="cgrid"></div>
      </section></div>`;
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
  if (S.bJump) { S.bJump = false; el.querySelector(".b-list")?.scrollIntoView({behavior: "smooth", block: "start"}); }  // church row and dashboard in view
  el.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { S.church = b.dataset.open; S.view = "dashboard"; render(); });  // admin: work in that church
  el.querySelector("#wa").onclick = () => waDialog("All churches for WhatsApp", text, {day: latest || newest});
  el.querySelector("#dl").onclick = () => download(`all_churches_${day || today()}.csv`, [["Church", "Service", "Present", "Adults", "Kids", "First-timers", "On the register", "Red", "Yellow", "Missed this service"],
    ...rows.map(r => served(r) ? [r.church, r.latest || "", r.present, r.adults, r.kids, r.first_timers, r.register, r.red, r.yellow, r.missed_this]
      : [r.church, `No service on ${day}`, "", "", "", "", r.register, "", "", ""])]);
}
async function admin(el) {
  el.innerHTML = head("Admin", "") + `<p class="empty">Loading…</p>`;
  const users = await api("app_users?select=email,role,church,name,pastor,title&order=email").catch(() => api("app_users?select=email,role,church,name,pastor&order=email")).catch(() => api("app_users?select=email,role,church,name&order=email")).catch(() => []);
  const pnames = [...new Set(Object.values(S.pastorList).flat())].sort();  // names on every church's pastor list
  const space = await api("rpc/app_db_size", {method: "POST", body: {}}).catch(() => null);  // null until the newer setup SQL has been run
  const inbox = await api("help_messages?select=*&order=created_at.desc&limit=50").catch(() => null);  // messages sent from Help
  if (S.view !== "admin") return;
  const LIMIT = 500 * 1024 * 1024, mb = b => b >= 1024 * 1024 ? `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`;
  const LABEL = {activity_log: "Activity log", attendance: "Ticks", members: "People", registrations: "Sign-ups", email_log: "Emails sent", services: "Services", settings: "Settings", app_users: "Sign-ins", churches: "Churches", help_messages: "Help messages"};
  const pct = space ? Math.min(100, space.total / LIMIT * 100) : 0;
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
    ${inbox === null ? `<p class="note" style="margin:0">Run the latest setup SQL in Supabase once to get messages from the Help page here.</p>`
      : !shown.length ? `<p class="empty" style="margin:0">No ${inbox.length ? "new " : ""}messages. When someone uses Contact the admin on the Help page, it shows here and is emailed to you.</p>`
      : shown.map(m => `<div class="inbox-item ${m.done ? "done" : ""}">
        <div class="ib-top"><b>${esc(m.name || m.email)}</b><small class="muted">${esc(when(m.created_at))}</small></div>
        <small class="muted">${esc([m.name ? m.email : "", ROLE[m.role] || m.role, m.church, m.topic].filter(Boolean).join(" · "))}</small>
        <div class="msg-body">${esc(m.message)}</div>
        <div class="ib-acts"><a class="pill-btn sm" href="mailto:${esc(m.email)}?subject=${encodeURIComponent("Re: " + (m.topic || "your message"))}">${svg("mail")}Reply</a>
          <button class="pill-btn sm" data-done="${m.id}" data-v="${!m.done}">${m.done ? "Mark as new" : "Mark done"}</button>
          <button class="x" data-mdel="${m.id}">Delete</button></div></div>`).join("")}</div>`;
  // Tabs: one area at a time. Opens on Messages when there are new ones, otherwise on Sign-ins; then remembers the choice.
  const TABS = [["messages", "Messages", fresh.length], ["names", "Sign-ins", users.length], ["churches", "Churches", S.churches.length], ["space", "Space", 0]];
  if (!TABS.some(t => t[0] === S.adminTab)) S.adminTab = fresh.length ? "messages" : "names";
  const tab = k => `data-at="${k}" ${S.adminTab === k ? "" : "hidden"}`;
  el.innerHTML = head("Admin", "") + `<div class="atabs" role="tablist" aria-label="Admin">${TABS.map(([k, name, n]) =>
      `<button role="tab" data-atab="${k}" aria-selected="${S.adminTab === k}">${name}${k === "messages" && n ? ` <span class="anum new">${n}</span>` : k !== "space" && k !== "messages" ? ` <span class="anum">${n}</span>` : ""}</button>`).join("")}</div>
    <section ${tab("messages")}>${inboxCard}</section><section ${tab("space")}>${spaceCard}</section>
    <section ${tab("churches")}>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Churches</h2></div>
      <div class="chips">${S.churches.map(c => c === S.me.home ? `<span class="chip">${esc(c)} · home church</span>`
        : `<button class="chip" data-rename="${esc(c)}" title="Rename ${esc(c)}">${esc(c)}${svg("edit")}</button>`).join("")}</div>
      <p class="note" style="margin:-4px 2px 14px">Tap a church to rename it.</p>
      <form class="row" id="add-church"><div><label class="f" for="c-name">New church</label><input class="in" id="c-name" placeholder="e.g. Melbourne" required></div>
        <div style="flex:0 0 auto"><button class="pill-btn primary">Add church</button></div></form></div></section>
    <section ${tab("names")}>
    <div class="tiles">${[["Total sign-ins", users.length, "Across all churches"], ["Church admins", users.filter(u => u.role === "lead").length, "Run a church"],
        ["Team", users.filter(u => u.role === "team").length, "Ushers ticking people in"], ["Pastors", users.filter(u => u.role === "pastor" || u.pastor).length, "Including admins who pastor"]]
        .map(([t, n, sub]) => `<div class="card tile"><div class="label">${t}</div><div class="num">${String(n).padStart(2, "0")}</div><div class="note" style="margin:4px 0 0">${sub}</div></div>`).join("")}</div>
    <div class="card"><div class="card-head"><h2>People who can sign in</h2><span class="gap"></span><button type="button" class="pill-btn primary sm" id="u-add-tg">+ Add person</button></div>
      <div class="u-bar"><div class="rpills" role="tablist" aria-label="Filter by role">${[["", "All"], ["admin", "Admin"], ["bishop", "Bishop"], ["lead", "Church admin"], ["team", "Team"], ["pastor", "Pastor"]]
          .map(([k, t]) => `<button type="button" class="rpill ${k ? "r-" + k : ""}" role="tab" data-ur="${k}" aria-selected="${(S.uRole || "") === k}">${k ? "<i></i>" : ""}${t} <span>${k ? users.filter(u => u.role === k).length : users.length}</span></button>`).join("")}</div>
        <div class="u-tools"><select class="in" id="u-ch" aria-label="Church"><option value="">All churches</option>${S.churches.map(c => `<option ${S.uCh === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
          <input class="in" id="u-q" type="search" placeholder="Search by name or email" value="${esc(S.uQ || "")}"></div></div>
      <div id="u-list"></div>
      </div></section>`;
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
  el.querySelector("#add-church").onsubmit = e => { e.preventDefault(); const name = el.querySelector("#c-name").value.trim().replace(/\s+/g, " ");
    again(() => api("churches", {method: "POST", prefer: "return=minimal", body: {name}})); };
  // Sign-ins: role pills, church picker, search and 10 per page
  const PER = 10, roleCls = r => "r-" + r;
  const drawUsers = () => {
    const q = norm(S.uQ || ""), list = users.filter(u => (!S.uRole || u.role === S.uRole) && (!S.uCh || u.church === S.uCh)
      && (!q || norm(u.name).includes(q) || norm(u.email).includes(q) || norm(u.pastor).includes(q)))
      .sort((a, b) => norm(a.name || a.email).localeCompare(norm(b.name || b.email)));
    const pages = Math.max(1, Math.ceil(list.length / PER)); S.uPage = Math.min(Math.max(1, S.uPage || 1), pages);
    const shown = list.slice((S.uPage - 1) * PER, S.uPage * PER);
    const nums = [...new Set([1, S.uPage - 1, S.uPage, S.uPage + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
    el.querySelector("#u-list").innerHTML = !list.length ? `<p class="empty">Nobody matches. Try another role, church or name.</p>` : `
      <div class="scroll"><table class="utable"><thead><tr><th>Name</th><th>Role</th><th>Church</th><th class="hide-sm">Pastor name</th><th></th></tr></thead><tbody>
      ${shown.map(u => `<tr><td><div class="who-cell"><span class="ava" ${avaStyle(u.name || u.email)}>${esc(initials(u.name || u.email))}</span><span><b>${esc(u.name || u.email.split("@")[0])}</b><small>${esc(u.email)}</small></span></div></td>
        <td><span class="rbadge ${roleCls(u.role)}">${esc(roleName(u))}</span>${u.pastor && u.role !== "pastor" && roleName(u) !== "Lead pastor" ? ` <span class="rbadge r-pastor">+ Pastor</span>` : ""}</td>
        <td class="muted">${esc(u.church || "All churches")}</td><td class="muted hide-sm">${esc(u.pastor || (u.role === "pastor" ? "Not set yet" : ""))}</td>
        <td style="white-space:nowrap;text-align:right">${u.email === S.me.email ? `<span class="muted">You</span>` : `<button class="pill-btn sm" data-chg="${esc(u.email)}">${svg("edit")}Change</button> <button class="x" data-del="${esc(u.email)}">Remove</button>`}</td></tr>`).join("")}</tbody></table></div>
      ${pages > 1 ? `<div class="pager"><span class="muted">Page ${S.uPage} of ${pages} · ${list.length} people</span><span class="gap"></span>
        <button class="pg" data-pg="${S.uPage - 1}" ${S.uPage === 1 ? "disabled" : ""} aria-label="Previous page">${svg("prev")}</button>
        ${nums.map((n, i) => (i && n - nums[i - 1] > 1 ? `<span class="muted">…</span>` : "") + `<button class="pg ${n === S.uPage ? "on" : ""}" data-pg="${n}">${n}</button>`).join("")}
        <button class="pg" data-pg="${S.uPage + 1}" ${S.uPage === pages ? "disabled" : ""} aria-label="Next page">${svg("next")}</button></div>` : ""}`;
    el.querySelectorAll("#u-list [data-pg]").forEach(b => b.onclick = () => { S.uPage = +b.dataset.pg; drawUsers(); });
    el.querySelectorAll("#u-list [data-chg]").forEach(b => b.onclick = () => change(b.dataset.chg));
    el.querySelectorAll("#u-list [data-del]").forEach(b => { let armed = false; b.onclick = () => {
      if (!armed) { armed = true; b.textContent = "Tap again to remove"; setTimeout(() => { armed = false; b.textContent = "Remove"; }, 4000); return; }
      again(() => api(`app_users?email=eq.${encodeURIComponent(b.dataset.del)}`, {method: "DELETE", prefer: "return=minimal"})); }; });
  };
  el.querySelectorAll("[data-ur]").forEach(b => b.onclick = () => { S.uRole = b.dataset.ur; S.uPage = 1;
    el.querySelectorAll("[data-ur]").forEach(x => x.setAttribute("aria-selected", x === b)); drawUsers(); });
  el.querySelector("#u-ch").onchange = e => { S.uCh = e.target.value; S.uPage = 1; drawUsers(); };
  el.querySelector("#u-q").oninput = e => { S.uQ = e.target.value; S.uPage = 1; drawUsers(); };
  el.querySelector("#u-add-tg").onclick = () => userDialog(null);
  const change = email => userDialog(users.find(x => x.email === email));
  // One popup to add someone or change them: main role, an optional second role (Pastor), and the pastor name when needed.
  function userDialog(u) {
    document.querySelectorAll(".modal").forEach(m => m.remove());
    const two = r => ["admin", "lead"].includes(r), noChurch = r => ["admin", "bishop"].includes(r);
    const role0 = roleName(u) === "Lead pastor" ? "lead_pastor" : u?.role || "team", second0 = u && two(u.role) && u.pastor && role0 !== "lead_pastor" ? "pastor" : "";
    const d = document.createElement("div"); d.className = "modal";
    d.innerHTML = `<form class="sheet narrow" role="dialog" aria-modal="true" aria-label="${u ? "Change sign-in" : "Add a person"}">
      <div class="card-head"><h2>${u ? `Change ${esc(u.name || u.email)}` : "Add a person"}</h2><span class="gap"></span><button type="button" class="icon-btn" data-x aria-label="Close">${svg("close")}</button></div>
      <div class="fields">
        <div><label class="f" for="ud-email">Email</label><input class="in" id="ud-email" type="email" value="${esc(u?.email || "")}" ${u ? "readonly" : "required"} autocomplete="off" placeholder="name@example.com"></div>
        <div><label class="f" for="ud-name">Name</label><input class="in" id="ud-name" maxlength="80" value="${esc(u?.name || "")}" autocomplete="off" placeholder="e.g. Grace Mensah"></div>
        <div><label class="f" for="ud-role">Role 1 (main role)</label><select class="in" id="ud-role">${ROLE_OPTS.map(([v, t]) => `<option value="${v}" ${v === role0 ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
        <div id="ud-2-wrap"><label class="f" for="ud-2">Role 2</label><select class="in" id="ud-2"><option value="">None</option><option value="pastor" ${second0 ? "selected" : ""}>Pastor (can switch to Pastor view)</option></select></div>
        <div id="ud-p-wrap"><label class="f" for="ud-p">Their name on the Pastors list</label><input class="in" id="ud-p" list="ud-p-list" autocomplete="off" value="${esc(u?.pastor || "")}" placeholder="e.g. Pastor Grace Mensah">
          <datalist id="ud-p-list">${pnames.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
          <p class="note" style="margin:6px 2px 0">Must match the Pastors list exactly: it decides whose people they see.</p></div>
        <div id="ud-c-wrap"><label class="f" for="ud-c">Church</label><select class="in" id="ud-c">${S.churches.map(c => `<option ${c === (u?.church || S.church) ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
      </div>
      <div class="msg bad" id="ud-err" hidden></div>
      <div class="modal-foot"><button type="button" class="pill-btn" data-x>Cancel</button><button class="pill-btn primary" id="ud-go">${u ? "Save" : "Add person"}</button></div></form>`;
    document.body.append(d);
    const $ = id => d.querySelector("#" + id), close = () => { d.remove(); document.removeEventListener("keydown", onKey); }, onKey = e => { if (e.key === "Escape") close(); };
    d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
    document.addEventListener("keydown", onKey);
    const sync = () => {
      const r = $("ud-role").value, needP = r === "pastor" || r === "lead_pastor" || (two(r) && $("ud-2").value === "pastor");
      $("ud-2-wrap").hidden = !two(r); $("ud-p-wrap").hidden = !needP; $("ud-p").required = needP; $("ud-c-wrap").hidden = noChurch(r);
    };
    $("ud-role").onchange = $("ud-2").onchange = sync; sync();
    (u ? $("ud-name") : $("ud-email")).focus();
    d.querySelector("form").onsubmit = async e => {
      e.preventDefault();
      const go = $("ud-go"), err = $("ud-err"), pick = $("ud-role").value, r = pick === "lead_pastor" ? "lead" : pick, needP = pick === "pastor" || pick === "lead_pastor" || (two(pick) && $("ud-2").value === "pastor");
      const title = pick === "lead_pastor" ? "Lead pastor" : null;
      const more = title || u?.title ? {title} : {};  // only sent when used, so it works before the new setup SQL
      const email = $("ud-email").value.trim().toLowerCase(), name = $("ud-name").value.trim().replace(/\s+/g, " ").slice(0, 80);
      const pastor = needP ? $("ud-p").value.trim().replace(/\s+/g, " ") : "", church = noChurch(r) ? null : $("ud-c").value;
      const fail = t => { err.textContent = t; err.hidden = false; go.disabled = false; };
      if (!u) { const wrong = emailProblem(email); if (wrong) return fail(wrong); if (users.some(x => x.email === email)) return fail("That email can already sign in. Use Change on their row instead."); }
      if (needP && !pastor) return fail("Type their name as it is on the Pastors list.");
      go.disabled = true; err.hidden = true;
      try {
        if (u) {
          const rows = await api(`app_users?email=eq.${encodeURIComponent(u.email)}`, {method: "PATCH", prefer: "return=representation", body: {name: name || null, role: r, church, pastor: pastor || null, ...more}});
          if (!rows?.length) throw new Error("Not saved. Check you are still signed in as an admin.");
          log("role_change", "", "done", `${u.email}: ${name ? name + " · " : ""}${title || r}${pastor && r !== "pastor" && !title ? " + pastor" : ""}${church ? " · " + church : ""}`);
          toast("Saved. They will see the change next time they open the app.");
        } else {
          await api("app_users", {method: "POST", prefer: "return=minimal", body: {email, name: name || null, role: r, church, ...(pastor ? {pastor} : {}), ...more}});
          toast(`Added. ${name || email} can now sign in with ${email}.`);
        }
        close(); render();
      } catch (ex) { fail(/duplicate|already exists|23505/i.test(ex.message) ? "That email can already sign in." : /title|column/i.test(ex.message) ? "Lead pastor needs the latest setup SQL: run it in Supabase once, then try again." : ex.message); }
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
  const p = picture(), me = S.me.pastor || "", list = p.people.filter(x => !me || pastorsOf(x).some(n => norm(n) === norm(me))).sort(byName);
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
  el.innerHTML = head(`Hello${S.me.name ? ", " + esc(S.me.name.split(" ")[0]) : ""}`, p.last ? `${esc(svcName(p.last))} · ${esc(nice(p.last, true))}` : "No services recorded yet",
    `<button class="pill-btn" id="wa">Message for WhatsApp</button><button class="pill-btn primary" data-go="checkin">${svg("checkin")}Check people in</button>`) + `
    <div class="tiles"><div class="card tile"><div class="label">Your people</div><div class="num">${list.length}</div></div>
      <div class="card tile"><div class="label">Came</div><div class="num">${came.length}</div></div>
      <div class="card tile"><div class="label">Not there</div><div class="num">${list.length - came.length}</div></div>
      <div class="card tile"><div class="label">Need a call</div><div class="num">${need.length}</div></div></div>
    <div class="card"><div class="card-head"><h2>Your people</h2></div>
      ${list.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Came</th><th>Status</th><th>Missed in a row</th><th>Phone</th></tr></thead><tbody>
      ${list.slice().sort((a, b) => (b.level !== "ok") - (a.level !== "ok") || b.missed - a.missed || byName(a, b)).map(x => `<tr><td>${whoBtn(x)}</td><td>${p.here[x.id] ? "Yes" : `<span class="muted">No</span>`}</td><td>${badge(x.flag)}</td><td>${x.missed}</td>
        <td>${x.phone ? `<a href="tel:${esc(x.phone.replace(/[^0-9+]/g, ""))}">${esc(x.phone)}</a>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="empty">${me ? `Nobody is assigned to ${esc(me)} yet. Ask your church admin.` : "Your sign-in isn't linked to a pastor name yet. Ask your church admin."}</p>`}</div>`;
  el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { S.view = b.dataset.go; render(); });
  el.querySelector("#wa").onclick = () => waDialog("Message for WhatsApp", message, {day: p.last || today()});
}

// ---------------------------------------------------------------- pastors: each pastor's people
function pastors(el) {
  const NONE = "Not assigned yet", p = picture(), p0 = p, groups = {};
  for (const x of p.people) for (const n of pastorsOf(x).length ? pastorsOf(x) : [NONE]) (groups[n] ??= []).push(x);
  const plist = S.pastorList[S.church] || [], canEdit = S.me.role !== "team";
  for (const n of plist) groups[n] ??= [];  // pastors on the list show even before anyone is assigned to them
  const names = Object.keys(groups).sort((a, b) => (a === NONE) - (b === NONE) || a.localeCompare(b));
  if (!names.includes(S.pastor)) S.pastor = names[0] || "";
  const list = (groups[S.pastor] || []).slice().sort(byName), came = list.filter(x => p.here[x.id]), need = list.filter(x => x.level !== "ok");
  const message = (o = {}) => {
    if (o.day && !p0.dates.includes(o.day)) return null;
    const p = o.day && o.day !== p0.last ? picture(o.day) : p0;
    const list = p.people.filter(x => S.pastor === NONE ? !pastorsOf(x).length : pastorsOf(x).includes(S.pastor)).sort(byName), came = list.filter(x => p.here[x.id]), need = list.filter(x => x.level !== "ok");
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
    <div class="card" id="pastor-people" style="scroll-margin-top:12px"><div class="card-head"><h2>${esc(S.pastor)}</h2><span class="gap"></span><span style="color:var(--ink-3);font-size:13px">${list.length} ${list.length === 1 ? "person" : "people"}</span></div>
      <div class="scroll"><table><thead><tr><th>Name</th>${canEdit ? "<th></th>" : ""}<th>Came</th><th>Status</th><th>Missed in a row</th><th>Phone</th></tr></thead><tbody>
      ${list.map(x => `<tr><td>${whoBtn(x)}</td>${canEdit ? `<td><button class="pill-btn sm" data-edit="${esc(x.id)}" aria-label="Edit ${esc(x.full_name)}">${svg("edit")}Edit</button></td>` : ""}<td>${p.here[x.id] ? "Yes" : `<span class="muted">No</span>`}</td><td>${badge(x.flag)}</td><td>${x.missed}</td><td class="muted">${esc(x.phone || "")}</td></tr>`).join("")}
      </tbody></table></div>
      ${list.length ? "" : `<p class="empty">Nobody is assigned to ${esc(S.pastor)} yet.</p>`}
      </div>`
      : `<p class="empty">Nobody on this register yet.</p>`}
    ${canEdit ? `<div class="card plist" id="plist"><div class="pl-head"><span class="pl-ico">${svg("pastors")}</span><div><h2>Pastor list</h2><p>${esc(S.church)} · ${plist.length} ${plist.length === 1 ? "name" : "names"}</p></div><span class="gap"></span>
        <button type="button" class="pill-btn sm primary" id="pl-add">${svg("plus")}Add pastor</button></div>
      <label class="find-bar pl-find">${svg("search")}<input id="pl-q" type="search" placeholder="Search pastors by name" value="${esc(S.plQ || "")}" autocomplete="off" aria-label="Search pastors"></label>
      <div class="pl-chips" id="pl-chips"></div><div id="pl-rows"></div></div>` : ""}`;
  // The pastor list: search, title chips (Bishop, Reverend, Lady Pastor...), and a row for each name with how many people they have.
  const listBox = el.querySelector("#plist");
  if (listBox) {
    const TITLES_ = ["Lady Pastor", "Bishop", "Reverend", "Apostle", "Prophet", "Evangelist", "Elder", "Deacon", "Pastor"];
    const titleOf = n => TITLES_.find(t => norm(n).startsWith(norm(t) + " ")) || "Other";
    const titles = [...new Set(plist.map(titleOf))].sort((a, b) => TITLES_.indexOf(a) - TITLES_.indexOf(b));
    if (S.plT && !titles.includes(S.plT)) S.plT = "";
    const save = async out => {
      try { await api("settings?on_conflict=key", {method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: {key: "pastors:" + S.church, value: out.join("\n")}}); }
      catch (err) { throw new Error(/settings|policy|permission/i.test(err.message) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : "Not saved: " + err.message); }
      S.pastorList[S.church] = out; render();
    };
    const clean = x => x.replace(/,/g, " ").trim().replace(/\s+/g, " ").slice(0, 80);
    const drawList = () => {
      const q = norm(S.plQ || ""), rows = plist.filter(n => (!S.plT || titleOf(n) === S.plT) && (!q || norm(n).includes(q)));
      el.querySelector("#pl-chips").innerHTML = titles.length > 1 ? [["", "All"], ...titles.map(t => [t, t === "Other" ? "Other" : t])].map(([v, t]) =>
        `<button type="button" class="pl-chip ${(S.plT || "") === v ? "on" : ""}" data-plt="${esc(v)}">${esc(t)}${v ? ` <span>${plist.filter(n => titleOf(n) === v).length}</span>` : ""}</button>`).join("") : "";
      el.querySelector("#pl-rows").innerHTML = rows.length ? rows.map(n => { const g = groups[n] || [], h = hueOf(n);
        return `<div class="pl-row ${n === S.pastor ? "sel" : ""}"><button type="button" class="pl-main" data-pl="${esc(n)}" title="See ${esc(n)}'s people">
          <span class="pl-ava" style="background:var(--h${h}b);color:var(--h${h}t)">${esc(initials(n))}</span>
          <span class="pl-txt"><b>${esc(n)}</b><small><span>${svg("people")}${g.length} ${g.length === 1 ? "person" : "people"}</span><span>${svg("checkin")}${g.filter(x => p.here[x.id]).length} came</span>${g.filter(x => x.level !== "ok").length ? `<span class="warn">${svg("followup")}${g.filter(x => x.level !== "ok").length} need a call</span>` : ""}</small></span></button>
          <button type="button" class="icon-btn sm" data-pledit="${esc(n)}" aria-label="Rename or remove ${esc(n)}">${svg("edit")}</button>${svg("next")}</div>`; }).join("")
        : `<p class="empty">${plist.length ? "No pastor matches that." : "No pastors on the list yet. Tap Add pastor."}</p>`;
    };
    listBox.onclick = e => {
      const c = e.target.closest("[data-plt]"); if (c) { S.plT = c.dataset.plt; drawList(); return; }
      const ed = e.target.closest("[data-pledit]");
      if (ed) { const old = ed.dataset.pledit; return formDialog(`Change ${old}`, [{k: "name", label: "Name on the Pastors list", value: old, required: true, hint: "Renaming here changes the list only. People assigned under the old name keep it until you change them."}],
        async v => { const n = clean(v.name); if (!n || n === old) return; if (plist.some(x => x !== old && norm(x) === norm(n))) throw new Error(`${n} is already on the list.`);
          await save(plist.map(x => x === old ? n : x)); toast("Saved."); }, "Save",
        {label: "Remove from list", confirm: "Tap again to remove", run: async () => { await save(plist.filter(x => x !== old)); toast(`${old} removed from the list.`); }}); }
      const r = e.target.closest("[data-pl]"); if (r) { S.pastor = r.dataset.pl; S.pastorJump = true; render(); }
    };
    el.querySelector("#pl-q").oninput = e => { S.plQ = e.target.value; drawList(); };
    el.querySelector("#pl-add").onclick = () => formDialog("Add a pastor", [{k: "name", label: "Full name with title", value: "", required: true, hint: "e.g. Pastor Grace Mensah, Lady Pastor Rita Kpodonu or Reverend Theodore Kpodonu"}],
      async v => { const n = clean(v.name); if (!n) return; if (plist.some(x => norm(x) === norm(n))) throw new Error(`${n} is already on the list.`);
        await save([...plist, n]); toast(`${n} added.`); }, "Add");
    drawList();
  }
  el.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editPerson(S.members.find(m => m.id === b.dataset.edit)));
  el.querySelectorAll("[data-pastor]").forEach(b => b.onclick = () => { S.pastor = b.dataset.pastor; S.pastorJump = true; render(); });
  if (S.pastorJump) { S.pastorJump = false; requestAnimationFrame(() => el.querySelector("#pastor-people")?.scrollIntoView({behavior: "smooth", block: "start"})); }  // straight to their people
  const btn = el.querySelector("#wa"); if (btn) btn.onclick = () => waDialog(`Message for ${S.pastor}`, message, {day: p.last || today()});
}

// ---------------------------------------------------------------- one person: every day they came
async function person(el) {
  const p = picture(), mine = p.mine.slice().sort(byName), m = mine.find(x => x.id === S.person);
  // Opened by tapping a name on any list, so there's no search box here (finding people is on Congregation)
  const top = head(m ? esc(m.full_name) : "Person", esc(S.church), m ? `<button class="pill-btn" id="dl">Download</button>` : "");
  const bind = () => {};
  if (!m) { el.innerHTML = top + `<div class="card"><p class="empty" style="margin:0 0 12px">Tap a name on any list to see their attendance.</p><button class="pill-btn" data-go-people>Open Congregation</button></div>`;
    el.querySelector("[data-go-people]").onclick = () => { S.view = "people"; render(); }; return; }
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
  const pnames = [...new Set([...(S.pastorList[S.church] || []), ...p.people.flatMap(pastorsOf)])], asPastor = pnames.find(n => isSelf(n, m)) || "";
  const flock = asPastor ? p.people.filter(x => x.id !== m.id && pastorsOf(x).some(n => isSelf(n, m))).sort(byName) : [];  // if they are a pastor: who is under them
  el.innerHTML = top + `
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div class="who big"><span>${esc(initials(m.full_name))}</span>${esc(m.full_name)}</div><span class="gap"></span>${state}</div>
      <p class="facts">${[typeName(m), isKid(m) ? "Child" : "Adult", m.phone || ""].filter(Boolean).map(esc).join(" · ")}${pastorsOf(m).length ? `<br>Pastor: ${pastorsOf(m).map(pastorBtn).join(", ")}` : ""}</p></div>
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

// ---------------------------------------------------------------- archive: not seen for two years
function archive(el) {
  const p = picture(), list = p.archived.slice().sort(byName);
  el.innerHTML = head("Archive", `${esc(S.church)} · not seen for two years`, list.length ? `<button class="pill-btn" id="dl">Download</button>` : "") + `
    ${S.seen ? "" : `<div class="msg" style="margin:0 0 14px">Run the latest setup SQL in Supabase once so this list can look back further than the last year.</div>`}
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
    <form class="card" id="to" style="margin-bottom:14px"><div class="card-head"><h2>Who gets the email</h2><span class="gap"></span><span class="muted" style="font-size:13px">${list.length} ${list.length === 1 ? "person" : "people"}</span></div>
      <div class="rcpts">${list.length ? list.map(m => `<span class="rcpt"><span class="ava" ${avaStyle(m)}>${esc(initials(m))}</span><span class="rcpt-mail">${esc(m)}</span>
          <button type="button" class="rcpt-x" data-unmail="${esc(m)}" aria-label="Take ${esc(m)} off the list" title="Take off the list">${svg("close")}</button></span>`).join("")
        : `<p class="empty" style="margin:0">Nobody gets the report yet. Add the leaders' email addresses below.</p>`}</div>
      <div class="add-mail"><input class="in" id="newmail" type="text" inputmode="email" autocomplete="off" placeholder="Add an email, e.g. fcc@gmail.com" aria-label="Email address to add">
        <button class="pill-btn">${svg("plus")}Add</button><button type="button" class="pill-btn primary" id="send" ${list.length && p.last ? "" : "disabled"}>${svg("reports")}Send report now</button></div>
      <p class="note" style="margin:10px 2px 0">Tap × to take someone off. Changes save straight away.</p></form>
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
      ["What do red and yellow mean?", `Yellow: missed ${YELLOW_AT}–${RED_AT - 1} services in a row. Red: missed ${RED_AT} or more. These are the people to call. Visitors are never flagged.`],
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
      <p class="lede">Answers to common questions about the app, and a quick way to reach the admin.</p>
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
  el.innerHTML = head("Your account", "") + `
    <form class="card" id="me" style="max-width:560px;margin-bottom:14px"><label class="f" for="my-name">Your name</label>
      <input class="in" id="my-name" maxlength="80" autocomplete="name" value="${esc(S.me.name || "")}" placeholder="e.g. Grace Mensah">
      <p class="facts" style="margin-top:14px">Email: ${esc(S.me.email)}<br>Role: ${roleName(S.me)}${S.me.church ? "<br>Church: " + esc(S.me.church) : ""}${S.me.role === "pastor" && S.me.pastor ? "<br>Your people: those assigned to " + esc(S.me.pastor) : ""}</p>
      
      <div style="margin-top:14px"><button class="pill-btn primary">Save name</button></div></form>
    <div id="look"></div>
    <form class="card" id="setpw" style="max-width:560px;margin-bottom:14px"><div class="card-head"><h2>Password</h2></div>
      <p class="note" style="margin-top:0">Set a password to skip the email code when you sign in, or change the one you have. You stay signed in.</p>
      <input type="email" autocomplete="username" value="${esc(S.me.email)}" readonly hidden>
      <label class="f" for="pw1">New password</label><input class="in" id="pw1" type="password" autocomplete="new-password" maxlength="72" required>
      <label class="f" for="pw2" style="margin-top:12px">Type it again</label><input class="in" id="pw2" type="password" autocomplete="new-password" maxlength="72" required>
      <ul class="pw-rules" id="pw-rules" aria-live="polite"></ul>
      <div style="margin-top:14px"><button class="pill-btn primary" id="pw-go">Save password</button></div></form>
    ${S.canSwitch ? `<div class="card" style="max-width:560px;margin-bottom:14px"><div class="card-head"><h2>Your views</h2></div>
      <p class="note" style="margin-top:0">You're ${baseName() === "Admin" ? "an" : "a"} ${baseName()} and also a pastor (${esc(S.me.pastor)}). Switch any time, no need to sign in again.</p>
      <button class="pill-btn primary" data-switch>${svg("pastors")}${switchLabel()}</button></div>` : ""}
    <div class="card" style="max-width:560px"><button class="pill-btn" data-bye>${svg("out")}Log out</button></div>`;
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
    <div class="card set-card"><div class="card-head"><h2>Menu and start page</h2></div>
      ${row("Start page", "The page you land on when you open the app.", `<select class="in" id="set-start" aria-label="Start page"><option value="">Default</option>${starts.map(([k, t]) =>
        `<option value="${k}" ${v.start === k ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`)}
      <div class="set-wide">${flip("set-mini", "Icons-only menu", "On laptops, show the side menu as icons only.", S.mini)}</div>
      ${flip("set-emoji", "Emojis in shared messages", "Adds emojis to the WhatsApp summaries you copy.", S.emoji)}
      <div class="set-row"><span class="gap" style="flex:1"></span><button type="button" class="pill-btn" data-look-reset>Reset to default</button></div></div>`;
  const redo = () => settings(box), $ = q => box.querySelector(q);
  box.querySelectorAll("[data-accent]").forEach(b => b.onclick = () => { saveLook({accent: b.dataset.accent === ACCENTS[0][0] ? "" : b.dataset.accent}); redo(); });
  $("#acc-own").onchange = e => { saveLook({accent: e.target.value}); redo(); };
  $("#acc-own").oninput = e => applyLook({...look(), accent: e.target.value});  // see it while picking
  box.querySelectorAll("[data-theme-pick]").forEach(b => b.onclick = () => {
    const t = b.dataset.themePick; saveLook({theme: t}); try { t === "system" ? localStorage.removeItem("fcc-mode") : localStorage.setItem("fcc-mode", t); } catch {} redo(); });
  box.querySelectorAll("[data-text-pick]").forEach(b => b.onclick = () => { saveLook({text: b.dataset.textPick}); redo(); });
  $("#set-muted").onchange = e => saveLook({muted: e.target.checked});
  $("#set-contrast").onchange = e => saveLook({contrast: e.target.checked});
  $("#set-motion").onchange = e => saveLook({motion: e.target.checked});
  $("#set-start").onchange = e => { saveLook({start: e.target.value}); toast("Saved. You'll start there next time."); };
  $("#set-mini").onchange = e => { S.mini = e.target.checked; try { localStorage.setItem("fcc-mini", S.mini ? "1" : "0"); } catch {}
    document.querySelector(".shell")?.classList.toggle("mini", S.mini); };
  $("#set-emoji").onchange = e => { S.emoji = e.target.checked; try { localStorage.setItem("fcc-emoji", S.emoji ? "on" : "off"); } catch {} };
  $("[data-look-reset]").onclick = () => { saveLook(null); S.mini = false; S.emoji = true;
    try { localStorage.removeItem("fcc-mini"); localStorage.removeItem("fcc-emoji"); } catch {} render(); toast("Back to the default settings."); };
}

// ---------------------------------------------------------------- go
let saved = null; try { saved = localStorage.getItem("fcc-mode"); } catch {}
setMode(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
try { S.emoji = localStorage.getItem("fcc-emoji") !== "off"; } catch {}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Phones (iPhones especially) can keep running an old copy of the app for days. Each time the app is opened or
// brought back to the front, compare the copy we have with the one on the server; if a newer one exists, reload.
let lastCheck = 0;
async function freshCheck() {
  if (Date.now() - lastCheck < 60000) return;
  lastCheck = Date.now();
  try {
    const tag = r => r.headers.get("etag") || r.headers.get("last-modified") || "";
    const have = tag(await fetch("app.js", {cache: "force-cache"}));
    const live = tag(await fetch("app.js", {cache: "reload"}));   // also refreshes the phone's stored copy
    await fetch("index.html", {cache: "reload"});
    if (!have || !live || have === live) return;
    const key = "fcc-updated:" + live;                            // never loop: reload at most once per version
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    location.reload();
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") freshCheck(); });
setTimeout(freshCheck, 3000);
start().catch(e => fatal(e.message));
