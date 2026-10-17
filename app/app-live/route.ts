// Livestream numbers for the phone app's Livestream widget (Dashboard → Add widget → Livestream).
//
// The numbers come from the church's live viewers dashboard (the church-live-dashboard Cloudflare Worker),
// which counts who is watching on YouTube, Facebook and Zoom. This route asks that dashboard on the server,
// so its password never reaches the browser, and only passes the counts on: no names, no keys.
// Only the admin and the home church's admin may ask (the live dashboard is the home church's stream).
// Needs two server-only settings on Vercel: LIVE_STATS_URL (the dashboard link, without ?key=) and,
// if the dashboard has a password, LIVE_KEY (its DASHBOARD_KEY). Neither is ever sent to the browser.
export const dynamic = "force-dynamic";

const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const say = (message: string, status: number) => Response.json({ message }, { status });

type Platform = { status?: string; viewers?: number | null; title?: string; error?: string };

export async function GET(req: Request) {
  const base = (process.env.LIVE_STATS_URL ?? "").trim().replace(/\/+$/, "").replace(/\?.*$/, "");
  if (!/^https:\/\//.test(base)) return say("The livestream isn't connected yet: add LIVE_STATS_URL on Vercel.", 503);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return say("Please sign in again.", 401);

  // 1. who is asking (their own sign-in, checked by the database)
  const meRes = await fetch(`${URL_}/rest/v1/rpc/app_me`, { method: "POST", body: "{}", cache: "no-store",
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!meRes.ok) return say("Please sign in again.", 401);
  const me = await meRes.json();
  if (!me || !(me.role === "admin" || (me.role === "lead" && me.church === me.home)))
    return say("The livestream numbers are for the admin and the home church's admin.", 403);

  // 2. ask the live dashboard (cached there for 15 seconds, so this is cheap)
  const key = (process.env.LIVE_KEY ?? "").trim();
  let r: Response;
  try {
    r = await fetch(`${base}/api/stats${key ? `?key=${encodeURIComponent(key)}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch { return say("The live dashboard didn't answer. Try again in a minute.", 502); }
  if (r.status === 401) return say("The live dashboard refused the password: check LIVE_KEY on Vercel.", 502);
  if (!r.ok) return say("The live dashboard didn't answer. Try again in a minute.", 502);
  const s = await r.json().catch(() => null);
  if (!s || typeof s.total !== "number") return say("The live dashboard sent something unexpected.", 502);

  // 3. only the counts go back
  const p = (x: Platform | undefined) => ({ status: String(x?.status ?? "off"), viewers: typeof x?.viewers === "number" ? x.viewers : null });
  const hist = Array.isArray(s.history) ? s.history.slice(-90) : [];
  return Response.json({
    church: String(s.church ?? ""), updatedAt: Number(s.updatedAt) || Date.now(), total: s.total, peak: Number(s.peak) || s.total,
    platforms: { youtube: p(s.platforms?.youtube), facebook: p(s.platforms?.facebook), zoom: p(s.platforms?.zoom) },
    history: hist.map((h: { t: number; youtube?: number; facebook?: number; zoom?: number }) =>
      ({ t: h.t, total: (h.youtube || 0) + (h.facebook || 0) + (h.zoom || 0) })),
  }, { headers: { "cache-control": "no-store" } });
}
