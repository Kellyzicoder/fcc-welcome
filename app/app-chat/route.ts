// Help → Ask the helper: a chat that answers "how do I use the app?" questions.
//
// It only knows how the app works (the Help answers sent by the app, plus the short overview below).
// It is never given names, phone numbers or attendance, so it cannot leak any of them.
// The person's own sign-in is checked first (rpc/app_me), and the role used in the prompt comes from the
// database, not from the browser. If the helper isn't sure, it points people to Contact the admin.
// Needs one server-only setting on Vercel: ANTHROPIC_API_KEY. ANTHROPIC_MODEL is optional.
export const dynamic = "force-dynamic";

const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const say = (message: string, status: number) => Response.json({ message }, { status });
const ROLE: Record<string, string> = { admin: "Admin", bishop: "Bishop", lead: "Church admin", team: "Usher", pastor: "Pastor" };

// A simple limit per person: 20 questions an hour. It lives in memory, so it is a guard against runaway use,
// not an exact count (each server instance keeps its own).
const asked = new Map<string, number[]>();
function tooMany(who: string): boolean {
  const now = Date.now(), recent = (asked.get(who) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 20) { asked.set(who, recent); return true; }
  recent.push(now); asked.set(who, recent);
  if (asked.size > 2000) for (const k of asked.keys()) { if (!(asked.get(k) ?? []).some((t) => now - t < 3_600_000)) asked.delete(k); }
  return false;
}

const OVERVIEW = `The app is the FCC Attendance app for Favourite Child Church. People use it on a phone (it can be added to the Home Screen).
What it does: check-in (tick people in as they arrive, with search, lock and unlock, and adding people without a phone number),
a congregation list, follow-up for people who miss services in a row (yellow = missed a few in a row, red = missed more; visitors are never flagged),
pastor home pages (a pastor sees only the people assigned to them), an all-churches dashboard, WhatsApp summaries (phones only), CSV downloads,
and a Help page with a Contact the admin form.
Who sees what: Admin sees every church and the Admin page. Bishop sees numbers for all churches but no names. Church admin sees everything for their own church.
Usher (team) can check people in and look up people in their church. Pastor sees only the people assigned to them and can tick them in.
Sign-in is by an emailed code or by a password (10 or more characters, with capital and small letters, a number and a symbol).`;

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return say("The helper isn't set up yet. Please use Contact the admin below.", 503);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return say("Please sign in again.", 401);

  let body: { messages?: { role?: string; content?: string }[]; faq?: string };
  try { body = await req.json(); } catch { return say("That request couldn't be read.", 400); }
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
    .map((m) => ({ role: m?.role === "assistant" ? "assistant" : "user", content: String(m?.content ?? "").trim().slice(0, 1000) }))
    .filter((m) => m.content);
  if (!messages.length || messages[messages.length - 1].role !== "user") return say("Please type your question.", 400);
  while (messages[0].role !== "user") messages.shift();
  const faq = String(body.faq ?? "").slice(0, 12_000);

  // who is asking (the database checks the sign-in)
  const meRes = await fetch(`${URL_}/rest/v1/rpc/app_me`, { method: "POST", body: "{}", cache: "no-store",
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!meRes.ok) return say("Please sign in again.", 401);
  const me = await meRes.json().catch(() => null);
  if (!me || !me.role) return say("Please sign in again.", 401);
  if (tooMany(String(me.email ?? token.slice(-24)))) return say("That's a lot of questions for now. Please try again in a little while, or use Contact the admin.", 429);

  const system = `You are the helper inside the FCC Attendance app for Favourite Child Church. You help church members and leaders use the app.
The person asking is signed in as: ${ROLE[String(me.role)] ?? "a user"}${me.church ? " at " + String(me.church) : ""}. Only explain things that role can do.

Rules:
- Use short, simple English with no hard words. Most people are on a phone, so keep answers to a few sentences or a few short steps.
- Answer only from the app information below. If it doesn't cover the question, or you aren't sure, say so plainly and tell them to use "Contact the admin" at the bottom of this Help page. Never guess how a button or screen works.
- You cannot see anyone's names, phone numbers or attendance, and you cannot change anything in the app. If asked for that, explain you can't and say where in the app they can look.
- Do not answer questions that are not about using this app. Politely say you can only help with the app.
- Never ask for or repeat passwords or sign-in codes.

App information:
${OVERVIEW}

Help answers already shown in the app:
${faq || "(none)"}`;

  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(25_000),
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: 500, system, messages }) });
  } catch { return say("The helper took too long. Please try again, or use Contact the admin.", 504); }
  if (!r.ok) return say("The helper isn't working right now. Please use Contact the admin below.", 502);
  const out = await r.json().catch(() => null);
  const reply = (Array.isArray(out?.content) ? out.content : []).filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "").join("\n").trim();
  if (!reply) return say("The helper had no answer. Please try again, or use Contact the admin.", 502);
  return Response.json({ reply }, { headers: { "Cache-Control": "no-store" } });
}
