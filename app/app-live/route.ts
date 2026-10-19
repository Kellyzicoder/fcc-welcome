// Livestream numbers for the phone app's Livestream widget (Dashboard → Add widget → Livestream).
//
// The numbers come from the church's live viewers dashboard (the church-live-dashboard Cloudflare Worker).
//   - The home church gets the full dashboard: YouTube, Facebook and Zoom (its /api/stats).
//   - Any other church can connect its own YouTube channel: its admin pastes the channel link in the widget,
//     the dashboard looks the channel up (/api/youtube/find), and the channel id is saved on the church
//     (churches.livestream, through app_set_livestream, which only that church's admin or the admin may use).
//     The dashboard then counts that channel's live viewers (/api/youtube) with the same YouTube key.
// This route asks the dashboard on the server, so its link settings never reach the browser, and only counts
// are passed on: no names, no keys. Only the admin and a church's own church admin may ask.
// Needs server-only settings on Vercel: LIVE_STATS_URL (the dashboard link, without ?key=) and, only if the
// dashboard has a password on its link, LIVE_KEY (its DASHBOARD_KEY). Neither is ever sent to the browser.
export const dynamic = "force-dynamic";

const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const say = (message: string, status: number) => Response.json({ message }, { status });
const CHANNEL = /^UC[\w-]{22}$/;

type Platform = { status?: string; viewers?: number | null };
type Me = { role?: string; church?: string | null; home?: string };

// Who is asking, and which church they mean. Their own sign-in is used, so the database decides what they see.
async function who(req: Request, church: string) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: say("Please sign in again.", 401) };
  const db = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, cache: "no-store",
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const meRes = await db("rpc/app_me", { method: "POST", body: "{}" });
  if (!meRes.ok) return { error: say("Please sign in again.", 401) };
  const me: Me = await meRes.json();
  const c = church || me?.church || me?.home || "";
  if (!me || !(me.role === "admin" || (me.role === "lead" && me.church === c)))
    return { error: say("The livestream is for the admin and each church's own church admin.", 403) };
  return { me, c, db };
}

function dashboard() {
  const base = (process.env.LIVE_STATS_URL ?? "").trim().replace(/\/+$/, "").replace(/\?.*$/, "");
  const key = (process.env.LIVE_KEY ?? "").trim();
  return { base, ok: /^https:\/\//.test(base), q: key ? `key=${encodeURIComponent(key)}&` : "" };
}

async function ask(url: string) {
  try { return await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) }); } catch { return null; }
}

const p = (x: Platform | undefined) => ({ status: String(x?.status ?? "off"), viewers: typeof x?.viewers === "number" ? x.viewers : null });
const off = { status: "not_configured", viewers: null };
// The highest count on each platform in the dashboard's recent history (about the last 3 hours): the service's peaks,
// which the WhatsApp summary can fill in for YouTube, Facebook and Zoom.
const peaks = (h: unknown, now: Record<string, number | null>) => {
  const out: Record<string, number> = {};
  for (const k of ["youtube", "facebook", "zoom"]) out[k] = Math.max(now[k] ?? 0,
    ...(Array.isArray(h) ? h : []).map((x: Record<string, number>) => Number(x?.[k]) || 0));
  return out;
};
const hist = (h: unknown) => (Array.isArray(h) ? h.slice(-90) : [])
  .map((x: { t: number; youtube?: number; facebook?: number; zoom?: number }) => ({ t: x.t, total: (x.youtube || 0) + (x.facebook || 0) + (x.zoom || 0),
    youtube: x.youtube || 0, facebook: x.facebook || 0, zoom: x.zoom || 0 }));  // each platform too, for the graph's coloured bands

export async function GET(req: Request) {
  const d = dashboard();
  if (!d.ok) return say("The livestream isn't connected yet: add LIVE_STATS_URL on Vercel.", 503);
  const w = await who(req, new URL(req.url).searchParams.get("church")?.trim() ?? "");
  if ("error" in w) return w.error;

  // The saved services between two times (the summary asks about one day). Only the home church's dashboard keeps them
  // (30 days); the app skips morning prayers and picks the day's service from this list.
  const sp = new URL(req.url).searchParams, from = Number(sp.get("from")), to = Number(sp.get("to"));
  if (from > 0 && to > from) {
    if (w.c !== w.me.home) return Response.json({ church: w.c, services: null });
    // ...or, with minutes=1, the numbers through those times in 5-minute steps (the Livestream graph's last 24 hours)
    if (sp.get("minutes") === "1") {
      const r = await ask(`${d.base}/api/minutes?${d.q}from=${from}&to=${to}`);
      const s = r?.ok ? await r.json().catch(() => null) : null;
      if (!s || !Array.isArray(s.points)) return say("The live dashboard needs updating to give the last 24 hours.", 502);
      return Response.json({ church: w.c, points: s.points.slice(0, 400).map((x: Record<string, unknown>) => ({ t: Number(x.t) || 0, total: Number(x.total) || 0,
        ...(x.youtube !== undefined ? { youtube: Number(x.youtube) || 0, facebook: Number(x.facebook) || 0, zoom: Number(x.zoom) || 0 } : {}) })) },
        { headers: { "cache-control": "no-store" } });
    }
    // ...or, with peaks=1, the highest on each platform between the two times (a service's own start and end)
    if (sp.get("peaks") === "1") {
      const r = await ask(`${d.base}/api/peaks?${d.q}from=${from}&to=${to}`);
      const s = r?.ok ? await r.json().catch(() => null) : null;
      if (!s || typeof s.minutes !== "number") return say("The live dashboard needs updating to give the peaks between two times.", 502);
      const m = (v: unknown) => Number(v) || 0;
      return Response.json({ church: w.c, peaks: { minutes: m(s.minutes), youtube: m(s.youtube), facebook: m(s.facebook), zoom: m(s.zoom), total: m(s.total) } },
        { headers: { "cache-control": "no-store" } });
    }
    const r = await ask(`${d.base}/api/services?${d.q}from=${from}&to=${to}`);
    const s = r?.ok ? await r.json().catch(() => null) : null;
    if (!s || !Array.isArray(s.services)) return say("The live dashboard needs updating to list its services.", 502);
    const n = (v: unknown) => Number(v) || 0;
    return Response.json({ church: w.c, services: s.services.slice(0, 20).map((x: Record<string, unknown>) => ({ start: n(x.start), end: n(x.end),
      total: n(x.total), youtube: n(x.youtube), facebook: n(x.facebook), zoom: n(x.zoom) })) }, { headers: { "cache-control": "no-store" } });
  }

  // The home church: the full dashboard (YouTube, Facebook and Zoom)
  if (w.c === w.me.home) {
    const r = await ask(`${d.base}/api/stats?${d.q}`);
    if (r?.status === 401) return say("The live dashboard refused the password: check LIVE_KEY on Vercel.", 502);
    const s = r?.ok ? await r.json().catch(() => null) : null;
    if (!s || typeof s.total !== "number") return say("The live dashboard didn't answer. Try again in a minute.", 502);
    return Response.json({ church: w.c, home: true, updatedAt: Number(s.updatedAt) || Date.now(), total: s.total, peak: Number(s.peak) || s.total,
      platforms: { youtube: p(s.platforms?.youtube), facebook: p(s.platforms?.facebook), zoom: p(s.platforms?.zoom) }, history: hist(s.history),
      peaks: peaks(s.history, { youtube: p(s.platforms?.youtube).viewers, facebook: p(s.platforms?.facebook).viewers, zoom: p(s.platforms?.zoom).viewers }) },
      { headers: { "cache-control": "no-store" } });
  }

  // Any other church: its own YouTube channel, once its church admin has connected it
  const row = await w.db(`churches?select=livestream&name=eq.${encodeURIComponent(w.c)}`);
  let link: { yt?: string; name?: string } = {};
  try { link = JSON.parse((await row.json())[0]?.livestream || "{}") || {}; } catch { link = {}; }
  if (!CHANNEL.test(String(link.yt ?? ""))) return Response.json({ church: w.c, setup: true });
  const r = await ask(`${d.base}/api/youtube?${d.q}channel=${link.yt}`);
  const s = r?.ok ? await r.json().catch(() => null) : null;
  if (!s || typeof s.total !== "number") return say(r?.status === 404 ? "The live dashboard needs updating to show other churches' channels."
    : "The live dashboard didn't answer. Try again in a minute.", 502);
  return Response.json({ church: w.c, channel: String(link.name || "YouTube channel"), updatedAt: Number(s.updatedAt) || Date.now(), total: s.total,
    peak: Number(s.peak) || s.total, platforms: { youtube: p(s.platforms?.youtube), facebook: off, zoom: off }, history: hist(s.history),
    peaks: { youtube: Number(s.peak) || s.total, facebook: 0, zoom: 0 } },
    { headers: { "cache-control": "no-store" } });
}

// A church admin connects (or removes) their church's YouTube channel: { church, link }
export async function POST(req: Request) {
  const d = dashboard();
  if (!d.ok) return say("The livestream isn't connected yet: add LIVE_STATS_URL on Vercel.", 503);
  let body: { church?: string; link?: string };
  try { body = await req.json(); } catch { return say("That request couldn't be read.", 400); }
  const w = await who(req, String(body.church ?? "").trim());
  if ("error" in w) return w.error;
  if (w.c === w.me.home) return say("The home church uses the main live dashboard already.", 400);
  const link = String(body.link ?? "").trim().slice(0, 300);

  let value: string | null = null, name = "";
  if (link) {
    const r = await ask(`${d.base}/api/youtube/find?${d.q}q=${encodeURIComponent(link)}`);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok || !CHANNEL.test(String(j.id ?? ""))) return say(j.message || (r?.status === 404 && !j.message
      ? "The live dashboard needs updating to connect other churches." : "That YouTube channel couldn't be found."), 400);
    name = String(j.title ?? "").slice(0, 100);
    value = JSON.stringify({ yt: j.id, name });
  }
  const save = await w.db("rpc/app_set_livestream", { method: "POST", body: JSON.stringify({ c: w.c, link: value }) });
  if (!save.ok) {
    const m = (await save.json().catch(() => ({}))).message || "";
    return say(/app_set_livestream/.test(m) ? "Not saved: run the latest setup SQL in Supabase once, then try again." : `Not saved: ${m || "the database refused it."}`, 400);
  }
  return Response.json({ church: w.c, channel: name || null });
}
