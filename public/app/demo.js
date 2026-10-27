// Demo mode: open the app at /app/?demo to show it to someone.
// Everything here is invented: a made-up church, made-up people and numbers. Nothing is sent to the real database,
// the email service or the live dashboard, and the browser's real sign-in is never read or changed.
// Changes made in the demo (ticks, new people, settings) last until the tab is closed.
(() => {
  if (!/[?&]demo\b/.test(location.search)) return;
  window.FCC_DEMO = true;

  // 1. Its own storage, so a real sign-in on this browser is never touched
  const box = (real, prefix) => {
    const k = key => prefix + key;
    const api = {
      getItem: key => { try { return real.getItem(k(key)); } catch { return null; } },
      setItem: (key, v) => { try { real.setItem(k(key), String(v)); } catch {} },
      removeItem: key => { try { real.removeItem(k(key)); } catch {} },
      clear: () => {}, key: () => null, get length() { return 0; },
    };
    return api;
  };
  let ss = null; try { ss = window.sessionStorage; } catch {}
  let realLS = null; try { realLS = window.localStorage; } catch {}  // only for the demo's Team forms (see teamRpc)
  const memory = new Map(), mem = {getItem: k => memory.has(k) ? memory.get(k) : null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k)};
  const base = ss || mem;
  Object.defineProperty(window, "localStorage", {value: box(base, "fcc-demo:l:"), configurable: true});
  Object.defineProperty(window, "sessionStorage", {value: box(base, "fcc-demo:s:"), configurable: true});
  try { navigator.serviceWorker.register = () => Promise.resolve(); } catch {}

  // 2. Invented data
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pad = n => String(n).padStart(2, "0"), iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date(), dayAgo = n => { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
  const sundays = [], weds = [];
  for (let i = 0; i < 120; i++) { const d = dayAgo(i); if (d.getDay() === 0) sundays.unshift(iso(d)); if (d.getDay() === 3 && i > 0) weds.unshift(iso(d)); }
  const HOME = "Grace Central", CH = [HOME, "Grace North", "Grace East"];
  const first = ["Ama", "Kofi", "Efua", "Yaw", "Abena", "Kwame", "Akua", "Kojo", "Esi", "Fiifi", "Adwoa", "Kwesi", "Afia", "Nana", "Akosua", "Kwabena",
    "Grace", "Daniel", "Ruth", "Samuel", "Esther", "David", "Mary", "Joseph", "Hannah", "Peter", "Sarah", "James", "Lydia", "Paul", "Naomi", "John",
    "Mercy", "Isaac", "Priscilla", "Caleb", "Deborah", "Joel", "Rebecca", "Elijah", "Faith", "Noah", "Joy", "Aaron", "Hope", "Silas"];
  const last = ["Mensah", "Boateng", "Owusu", "Asante", "Ofori", "Badu", "Quaye", "Appiah", "Darko", "Addo", "Osei", "Amoah", "Agyeman", "Frimpong", "Tetteh", "Ansah"];
  const pastors = {[HOME]: ["Pastor John Asante", "Pastor Grace Owusu", "Pastor Daniel Ofori"], "Grace North": ["Pastor Ruth Mensah"], "Grace East": ["Pastor Samuel Badu"]};
  const roles = ["", "", "", "", "Worship Team", "Ushers", "Media Team", "Children's Ministry", "Ushers, Media Team"];
  const members = [];
  const sizes = {[HOME]: 64, "Grace North": 26, "Grace East": 18};
  let n = 0;
  for (const ch of CH) for (let i = 0; i < sizes[ch]; i++, n++) {
    const kid = rnd() < .18, ft = !kid && rnd() < .12, vis = !kid && !ft && rnd() < .05;
    const name = `${first[Math.floor(rnd() * first.length)]} ${last[Math.floor(rnd() * last.length)]}`;
    if (members.some(m => m.full_name === name && m.church === (ch === HOME ? null : ch))) { i--; n--; continue; }
    members.push({id: "d" + n, full_name: name, phone: `021 555 ${pad(Math.floor(rnd() * 100))}${pad(Math.floor(rnd() * 100))}`, type: ft ? "first_timer" : vis ? "visitor" : "member",
      status: rnd() < .03 ? "Away" : "", age_group: kid ? "Child" : "Adult", gender: rnd() < .52 ? "Female" : "Male",
      pastor: rnd() < .8 ? pastors[ch][Math.floor(rnd() * pastors[ch].length)] : "", shepherd: ch === HOME ? ["Shepherd Kofi Asante", "Shepherd Abena Ofori", "", ""][n % 4] : "", church: ch === HOME ? null : ch,
      role: kid ? "" : roles[Math.floor(rnd() * roles.length)], date_joined: ft || vis ? null : "2023-0" + (1 + Math.floor(rnd() * 9)) + "-1" + Math.floor(rnd() * 9),
      first_visit: ft || vis ? sundays[sundays.length - 1 - Math.floor(rnd() * 6)] : null,
      birthday: kid ? null : `${1970 + Math.floor(rnd() * 35)}-${pad(1 + Math.floor(rnd() * 12))}-${pad(1 + Math.floor(rnd() * 28))}`, address: kid ? null : `${1 + Math.floor(rnd() * 90)} ${["Queen St", "Great North Rd", "Dominion Rd", "Hobsonville Rd"][Math.floor(rnd() * 4)]}, Auckland`, created_at: "2024-01-07T10:00:00+13:00", version: 1});
  }
  const attendance = [];
  const habit = members.map(m => m.type === "first_timer" ? .5 : m.type === "visitor" ? .3 : rnd() < .12 ? .15 : .55 + rnd() * .4);
  for (const d of [...sundays, ...weds]) {
    const wed = weds.includes(d);
    members.forEach((m, i) => {
      if (m.first_visit && d < m.first_visit) return;
      if (rnd() < (wed ? habit[i] * .45 : habit[i])) attendance.push({service_date: d, member_id: m.id, checked_at: `${d}T${wed ? "19" : "10"}:${pad(Math.floor(rnd() * 50))}:00+13:00`});
    });
  }
  // Bacentas: two in the home church, meeting on Tuesdays, each with a few regulars
  const bacentas = [{id: "b1", church: HOME, name: "City Bacenta", shepherd: "Shepherd Kofi Asante", pastor: "Pastor John Asante", meet_day: 2, active: true, created_at: "2024-01-01T00:00:00Z"},
    {id: "b2", church: HOME, name: "West Bacenta", shepherd: "Shepherd Abena Ofori", pastor: "Pastor John Asante", meet_day: 4, active: true, created_at: "2024-01-01T00:00:00Z"}], bacenta_skips = [], bacenta_ticks = [];
  const homeIds = members.filter(m => !m.church && m.age_group !== "Child").map(m => m.id);
  for (let i = 1; i < 90; i++) { const d = dayAgo(i);
    bacentas.forEach((b, j) => d.getDay() === b.meet_day && i !== 8 && i !== 15 && homeIds.slice(j * 9, j * 9 + 9).forEach(id => { if (rnd() < .7) bacenta_ticks.push({bacenta: b.id, meeting_date: iso(d), member_id: id, checked_at: iso(d) + "T19:10:00+13:00"}); })); }
  const services = [...sundays.map(d => ({service_date: d, name: "Sunday Service"})), ...weds.map(d => ({service_date: d, name: "Midweek Service"}))];
  const T = {
    churches: CH.map(name => ({name, livestream: null, created_at: "2024-01-01T00:00:00Z"})),
    members, attendance, services, service_parts: [], service_ticks: [], bacentas, bacenta_ticks, bacenta_skips,
    app_users: [{email: "demo@example.com", role: "admin", church: null, name: "Demo Admin", pastor: null, title: null},
      {email: "lead.north@example.com", role: "lead", church: "Grace North", name: "Ruth Mensah", pastor: "Pastor Ruth Mensah", title: "Lead pastor"},
      {email: "usher@example.com", role: "team", church: HOME, name: "Kojo Appiah", pastor: null, title: null},
      {email: "pastor.john@example.com", role: "pastor", church: HOME, name: "John Asante", pastor: "Pastor John Asante", title: null},
      {email: "bishop@example.com", role: "bishop", church: null, name: "Bishop Kwame Osei", pastor: null, title: null}],
    settings: [...CH.map(c => ({key: "pastors:" + (c === HOME ? HOME : c), value: pastors[c].join("\n")})), {key: "shepherds:" + HOME, value: "Shepherd Kofi Asante\nShepherd Abena Ofori"}, {key: "report_recipients", value: "leaders@example.com, pastor@example.com"}],
    app_prefs: [], email_log: [{kind: "daily", report_date: sundays.at(-1), sent_at: sundays.at(-1) + "T13:05:00+13:00", recipients: "leaders@example.com", ok: true, detail: ""}],
    registrations: [{id: "11111111-1111-4111-8111-111111111111", full_name: "Joy Tetteh", phone: "022 555 0188", email: "joy@example.com", invited_by: "A friend",
      first_visit: sundays.at(-1), notes: "Would love to join the choir", wants_contact: true, created_at: now.toISOString(), status: "pending"}],
    activity_log: [], help_messages: [],
  };

  // 3. A small stand-in for the database's web API (the parts the app uses)
  const unq = v => decodeURIComponent(v).replace(/^"|"$/g, "");
  const test = (row, col, opv) => {
    const i = opv.indexOf("."), op = opv.slice(0, i), v = opv.slice(i + 1), x = row[col] == null ? null : String(row[col]);
    if (op === "eq") return x === unq(v);
    if (op === "neq") return x !== unq(v);
    if (op === "gte") return x !== null && x >= unq(v);
    if (op === "lte") return x !== null && x <= unq(v);
    if (op === "gt") return x !== null && x > unq(v);
    if (op === "lt") return x !== null && x < unq(v);
    if (op === "in") return v.replace(/^\(|\)$/g, "").split(",").map(unq).includes(x);
    if (op === "is") return v === "null" ? x === null : x === v;
    if (op === "like" || op === "ilike") { const re = new RegExp("^" + unq(v).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", op === "ilike" ? "i" : ""); return x !== null && re.test(x); }
    return true;
  };
  const where = (params) => row => {
    for (const [k, v] of params) {
      if (["select", "order", "limit", "offset", "on_conflict"].includes(k)) continue;
      if (k === "or") { const parts = v.replace(/^\(|\)$/g, "").split(/,(?![^()]*\))/); if (!parts.some(p => { const j = p.indexOf("."); return test(row, p.slice(0, j), p.slice(j + 1)); })) return false; continue; }
      if (!test(row, k, v)) return false;
    }
    return true;
  };
  const KEYS = {churches: ["name"], members: ["id"], attendance: ["service_date", "member_id"], services: ["service_date"], service_parts: ["church", "service_date", "part"],
    service_ticks: ["service_date", "part", "member_id"], bacentas: ["id"], bacenta_ticks: ["bacenta", "meeting_date", "member_id"], bacenta_skips: ["bacenta", "meeting_date"], app_users: ["email"], settings: ["key"], app_prefs: ["email"], registrations: ["id"], help_messages: ["id"]};
  const homeOf = m => (m.church || "").trim() || HOME;
  const live = m => !["inactive", "moved", "left", "deceased", "transferred", "away"].includes((m.status || "").toLowerCase());
  const kid = m => ["child", "kid", "kids", "children"].includes((m.age_group || "").toLowerCase());
  const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});

  function rpc(name, body) {
    const people = members.filter(live), byId = Object.fromEntries(people.map(m => [m.id, m]));
    if (name === "app_me") return {email: "demo@example.com", role: "admin", church: null, name: "Demo Admin", home: HOME, pastor: null, title: null, role3: null};
    if (name === "app_last_seen") { const o = {}; for (const a of T.attendance) if (!o[a.member_id] || a.service_date > o[a.member_id]) o[a.member_id] = a.service_date; return Object.entries(o).map(([member_id, last_seen]) => ({member_id, last_seen})); }
    if (name === "church_days") { const o = {}; for (const a of T.attendance) { const m = byId[a.member_id]; if (m) { const k = homeOf(m) + "|" + a.service_date; o[k] = (o[k] || 0) + 1; } }
      return Object.entries(o).map(([k, present]) => ({church: k.split("|")[0], service_date: k.split("|")[1], present})).sort((a, b) => a.service_date.localeCompare(b.service_date)); }
    const upto = body?.upto || "9999";
    const ticks = T.attendance.filter(a => byId[a.member_id] && a.service_date <= upto);
    if (name === "church_trend") return CH.flatMap(c => { const days = [...new Set(ticks.filter(a => homeOf(byId[a.member_id]) === c).map(a => a.service_date))].sort().slice(-12);
      return days.map(d => { const here = ticks.filter(a => a.service_date === d && homeOf(byId[a.member_id]) === c).map(a => byId[a.member_id]);
        return {church: c, service_date: d, name: T.services.find(s => s.service_date === d)?.name || null, adults: here.filter(m => !kid(m)).length, kids: here.filter(kid).length,
          first_timers: here.filter(m => m.type === "first_timer").length, visitors: here.filter(m => m.type === "visitor").length}; }); });
    if (name === "church_numbers") return CH.map(c => {
      const mine = people.filter(m => homeOf(m) === c), t = ticks.filter(a => homeOf(byId[a.member_id]) === c);
      const days = [...new Set(t.map(a => a.service_date))].sort(), latest = days.at(-1) || null, sun = days.filter(d => new Date(d + "T12:00:00").getDay() === 0);
      const at = latest ? t.filter(a => a.service_date === latest).map(a => byId[a.member_id]) : [];
      const missed = m => { if (m.type === "visitor") return 0; const seen = t.filter(a => a.member_id === m.id).map(a => a.service_date).sort().at(-1) || "0000";
        return sun.filter(d => d > seen && d >= (m.date_joined || m.first_visit || "0000")).length; };
      const ms = mine.map(missed);
      return {church: c, latest, present: at.length, adults: at.filter(m => !kid(m)).length, kids: at.filter(kid).length, first_timers: at.filter(m => m.type === "first_timer").length,
        register: mine.length, red: ms.filter(x => x >= 5).length, yellow: ms.filter(x => x >= 3 && x <= 4).length, missed_this: ms.filter(x => x >= 1 && x <= 2).length,
        trend: days.slice(-12).map(d => t.filter(a => a.service_date === d).length)};
    });
    if (name === "bacenta_numbers") {  // numbers only, like the real one: last finished week Monday to Sunday, and 8 weeks of totals
      const d0 = new Date((body?.upto || iso(now)) + "T12:00:00"); d0.setDate(d0.getDate() - ((d0.getDay() + 6) % 7) - 7);
      const wk = k => { const a = new Date(d0); a.setDate(a.getDate() - 7 * k); const z = new Date(a); z.setDate(z.getDate() + 6); return [iso(a), iso(z)]; };
      return CH.map(c => { const bs = T.bacentas.filter(b => b.church === c && b.active), idsB = new Set(bs.map(b => b.id));
        const ppl = ([a, z]) => new Set(T.bacenta_ticks.filter(t => idsB.has(t.bacenta) && t.meeting_date >= a && t.meeting_date <= z).map(t => t.member_id)).size;
        const [a, z] = wk(0);
        return {church: c, bacentas: bs.length, came: ppl(wk(0)), weeks: [7, 6, 5, 4, 3, 2, 1, 0].map(k => ppl(wk(k))),
          behind: bs.filter(b => !T.bacenta_ticks.some(t => t.bacenta === b.id && t.meeting_date >= a && t.meeting_date <= z) && !T.bacenta_skips.some(s => s.bacenta === b.id && s.meeting_date >= a && s.meeting_date <= z)).length}; });
    }
    if (name === "app_db_size") return {total: 31457280, tables: [{name: "attendance", bytes: 9437184}, {name: "members", bytes: 2097152}]};
    if (name === "app_set_my_name") return body?.new_name || "";
    if (name === "app_rename_church") return body?.new_name || body?.n || "";
    if (name === "app_approve_signup") { T.registrations = T.registrations.filter(r => r.id !== body?.rid && r.id !== body?.id); return "d" + (++n); }
    if (name === "app_reject_signup") { T.registrations = []; return true; }
    if (name === "app_ask") return {answer: "This is the demo, so questions aren't sent anywhere. In the real app, the answer comes from your church's own numbers."};
    return null;
  }

  // Team forms in the demo: a link names its church, and what's sent through it is kept on this browser (shared with the
  // demo's other tabs), so a link opened in a new tab shows up back on the Team forms page.
  const sent = {get: () => { try { return JSON.parse(realLS?.getItem("fcc-demo:team") || "[]"); } catch { return []; } }, set: v => { try { realLS?.setItem("fcc-demo:team", JSON.stringify(v.slice(-200))); } catch {} }};
  function teamRpc(name, body) {
    if (name === "app_team_link") { const tok = "demo-" + (body?.ch || HOME).replace(/ /g, "_") + "-" + (++n);
      (T.team_links ??= []).push({token: tok, church: body?.ch || HOME, made_by: "demo@example.com", made_by_name: "Demo Admin", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 14 * 864e5).toISOString()}); return tok; }
    if (name === "app_team_form") { const m = /^demo-(.+)-\d+$/.exec(body?.tok || ""); return m ? {church: m[1].replace(/_/g, " "), by: "Demo Admin", until: new Date(Date.now() + 14 * 864e5).toISOString(), sent: 0} : null; }
    if (name === "app_team_submit") { const m = /^demo-(.+)-\d+$/.exec(body?.tok || ""); if (!m) throw new Error("This form link has expired. Ask for a new one.");
      const all = sent.get(); for (const p of body.people || []) all.push({id: crypto.randomUUID(), church: m[1].replace(/_/g, " "), sent_by: body.from_name, name: p.name, email: p.email, role: p.role, pastor: ["pastor", "shepherd"].includes(p.role) ? p.name : null, status: "pending", created_at: new Date().toISOString()});
      sent.set(all); return (body.people || []).length; }
    if (name === "app_team_approve") { const all = sent.get(); let added = 0, had = 0;
      for (const it of body?.items || []) { const r = all.find(x => x.id === it.id && x.status === "pending"); if (!r) continue; r.status = "approved";
        if (T.app_users.some(u => u.email === r.email)) had++; else { const rl = it.role || r.role; T.app_users.push({email: r.email, role: rl === "shepherd" ? "pastor" : rl, church: r.church, name: r.name, pastor: ["pastor", "shepherd"].includes(rl) ? it.pastor || r.pastor : null, title: rl === "shepherd" ? "Shepherd" : null}); added++; } }
      sent.set(all); return {added, had}; }
    if (name === "app_team_reject") { const all = sent.get(); let k = 0; for (const r of all) if ((body?.ids || []).includes(r.id) && r.status === "pending") { r.status = "rejected"; k++; } sent.set(all); return k; }
    return undefined;
  }

  function rest(method, url, bodyText, prefer) {
    const path = url.pathname.replace(/^\/rest\/v1\//, ""), params = [...url.searchParams.entries()], body = bodyText ? JSON.parse(bodyText) : undefined;
    if (path.startsWith("rpc/")) { const name = path.slice(4); if (name.startsWith("app_team_")) { try { const v = teamRpc(name, body); if (v !== undefined) return json(v); } catch (e) { return json({message: e.message}, 400); } } return json(rpc(name, body)); }
    const table = path; if (!T[table]) T[table] = [];
    if (table === "team_requests") T.team_requests = sent.get();
    let rows = T[table];
    if (method === "GET") {
      let out = rows.filter(where(params));
      const order = url.searchParams.get("order");
      if (order) { const keys = order.split(",").map(o => o.split(".")); out = out.slice().sort((a, b) => { for (const [k, dir] of keys) { const x = String(a[k] ?? ""), y = String(b[k] ?? ""); if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1); } return 0; }); }
      const off = +(url.searchParams.get("offset") || 0), lim = +(url.searchParams.get("limit") || 1e9);
      out = out.slice(off, off + lim);
      const sel = url.searchParams.get("select");
      if (sel && sel !== "*") { const cols = sel.split(","); out = out.map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null]))); }
      return json(out);
    }
    const ret = /return=representation/.test(prefer || "");
    if (method === "POST") {
      const list = [].concat(body), keys = (url.searchParams.get("on_conflict") || "").split(",").filter(Boolean).length ? url.searchParams.get("on_conflict").split(",") : KEYS[table] || [];
      const merge = /merge-duplicates/.test(prefer || ""), ignore = /ignore-duplicates/.test(prefer || "");
      for (const r of list) {
        if (table === "help_messages" && !r.id) r.id = crypto.randomUUID?.() || String(Date.now());
        const i = keys.length ? rows.findIndex(x => keys.every(k => String(x[k]) === String(r[k]))) : -1;
        if (i >= 0) { if (merge) rows[i] = {...rows[i], ...r}; else if (!ignore) return json({message: "That's already saved."}, 409); }
        else rows.push({...r});
      }
      return ret ? json(list, 201) : json(null, 201);
    }
    if (method === "PATCH") {
      const hit = rows.filter(where(params));
      for (const r of hit) { Object.assign(r, body); if (table === "members") r.version = (r.version || 1) + 1; }
      return ret ? json(hit) : json(null, 204);
    }
    if (method === "DELETE") {
      const f = where(params), gone = rows.filter(f); T[table] = rows.filter(r => !f(r));
      if (table === "members") T.members.splice(0, T.members.length, ...T[table]);
      if (table === "attendance") T.attendance = T[table];
      return ret ? json(gone) : json(null, 204);
    }
    return json(null, 204);
  }

  // Livestream: a made-up Sunday and Wednesday
  function liveStats(u) {
    const from = +u.searchParams.get("from"), to = +u.searchParams.get("to");
    const at = (d, h, m) => { const x = new Date(d + "T00:00:00"); x.setHours(h, m); return x.getTime(); };
    const svc = [...sundays.slice(-5).map((d, i) => ({start: at(d, 9, 25), end: at(d, 12, 40), youtube: 38 + i * 3, facebook: 14 + i, zoom: 22 - i})),
      ...weds.slice(-4).map((d, i) => ({start: at(d, 19, 0), end: at(d, 20, 50), youtube: 17 + i, facebook: 6, zoom: 15 + i}))].map(x => ({...x, total: x.youtube + x.facebook + x.zoom - 3}));
    if (from) return {church: HOME, services: svc.filter(x => x.start >= from && x.start < to)};
    return {church: HOME, home: true, updatedAt: Date.now(), total: 0, peak: 0, history: [], peaks: {},
      platforms: {youtube: {status: "offline", viewers: null}, facebook: {status: "offline", viewers: null}, zoom: {status: "offline", viewers: null}}};
  }

  // 4. Answer the app's requests here instead of the network
  const realFetch = window.fetch.bind(window), DB = "https://demo.invalid";
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href), method = (init.method || "GET").toUpperCase();
    await new Promise(r => setTimeout(r, 60));  // feels like a real connection
    if (url.pathname === "/app-config") return json({url: DB, key: "demo"});
    if (url.origin === DB && url.pathname.startsWith("/auth/v1/")) return json({access_token: "demo", refresh_token: "demo", expires_in: 86400, user: {email: "demo@example.com"}});
    if (url.origin === DB && url.pathname.startsWith("/rest/v1/")) {
      const h = init.headers || {}, prefer = h.Prefer || h.prefer || "";
      try { return rest(method, url, init.body, prefer); } catch (e) { return json({message: "Demo: " + e.message}, 400); }
    }
    if (url.pathname === "/app-live") return json(method === "GET" ? liveStats(url) : {message: "This is the demo: channels can't be connected here."}, method === "GET" ? 200 : 400);
    if (url.pathname === "/app-send") return json({message: "This is the demo, so no email was sent."}, 400);
    if (url.pathname === "/app-help") return json({saved: true, emailed: false});
    if (url.origin === location.origin) return realFetch(input, init);  // the app's own files
    return json({message: "Not available in the demo."}, 400);
  };
  // Start signed in as the demo admin
  if (!localStorage.getItem("fcc-session")) localStorage.setItem("fcc-session", JSON.stringify({access_token: "demo", refresh_token: "demo", expires_at: Date.now() + 864e5}));

  // 5. A small banner so nobody mistakes it for the real thing
  addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div"); b.className = "demo-banner";
    b.innerHTML = `<b>Demo</b> Invented church and people. Nothing here is saved.`;
    document.body.prepend(b);
  });
})();
