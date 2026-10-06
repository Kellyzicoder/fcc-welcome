// Sends a church's attendance email from the phone app (Reports → Send report now).
//
// The person's own sign-in is used for every database call, so Row Level Security decides what they may do:
// only the admin or that church's admin can read the church's recipient list, and nobody else gets past step 2.
// The recipients always come from the saved list in the database, never from the browser.
// Needs two server-only settings on Vercel: BREVO_API_KEY and REPORT_SENDER. Neither is ever sent to the browser.
export const dynamic = "force-dynamic";

const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const say = (message: string, status: number) => Response.json({ message }, { status });

type File_ = { name: string; text: string };

export async function POST(req: Request) {
  const brevo = process.env.BREVO_API_KEY, sender = process.env.REPORT_SENDER;
  if (!brevo || !sender) return say("Email sending isn't set up yet: add BREVO_API_KEY and REPORT_SENDER on Vercel.", 503);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return say("Please sign in again.", 401);
  const db = (path: string, init: RequestInit = {}) =>
    fetch(`${URL_}/rest/v1/${path}`, { ...init, cache: "no-store",
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });

  let body: { church?: string; date?: string; at?: string; text?: string; files?: File_[] };
  try { body = await req.json(); } catch { return say("That request couldn't be read.", 400); }
  const church = String(body.church ?? "").trim(), text = String(body.text ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) ? String(body.date) : new Date().toISOString().slice(0, 10);
  const files = (Array.isArray(body.files) ? body.files : []).slice(0, 3)
    .filter((f) => f && /^[\w .()-]{1,80}\.csv$/.test(String(f.name)) && typeof f.text === "string" && f.text.length < 400_000);
  if (!church || !text || text.length > 20_000) return say("There is nothing to send.", 400);

  // 1. who is asking
  const meRes = await db("rpc/app_me", { method: "POST", body: "{}" });
  if (!meRes.ok) return say("Please sign in again.", 401);
  const me = await meRes.json();
  if (!me || !["admin", "lead"].includes(me.role)) return say("Only an admin or a church admin can send the report.", 403);
  if (me.role === "lead" && me.church !== church) return say("You can only send your own church's report.", 403);

  // 2. the saved list for that church (the database refuses anyone who shouldn't see it)
  const home = church === me.home, key = home ? "report_recipients" : `report_recipients:${church}`;
  const listRes = await db(`settings?select=value&key=eq.${encodeURIComponent(key)}`);
  if (!listRes.ok) return say("The list of recipients couldn't be loaded. Run the latest setup SQL in Supabase once.", 500);
  const to = [...new Set(String((await listRes.json())[0]?.value ?? "").split(/[,\s;]+/).map((x) => x.trim().toLowerCase())
    .filter((x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(x)))].slice(0, 30);
  if (!to.length) return say(`Nobody is on the list for ${church} yet. Add at least one email address and press Save first.`, 400);

  // 3. send, then record what happened
  const subject = `FCC ${church} attendance · ${date}`;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${text.split("\n")
    .map((l) => (l.trim() ? `<div>${esc(l).replace(/\*(.+?)\*/g, "<b>$1</b>")}</div>` : "<br>")).join("")}
    <p style="color:#666;font-size:13px;margin-top:18px">Sent from the FCC Attendance app by ${esc(String(me.name || me.email))}.
    This email contains members' details: please don't forward it outside the leadership team.</p></div>`;
  let ok = false, detail = subject;
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST",
      headers: { "api-key": brevo, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "FCC Attendance", email: sender }, to: to.map((email) => ({ email })), subject, htmlContent: html,
        ...(files.length ? { attachment: files.map((f) => ({ name: f.name, content: Buffer.from("﻿" + f.text, "utf8").toString("base64") })) } : {}) }) });
    ok = r.ok;
    if (!ok) detail = `Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`;
  } catch (e) { detail = `Could not reach the email service: ${String(e).slice(0, 160)}`; }
  await db("email_log", { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ id: crypto.randomUUID().replace(/-/g, ""), kind: home ? "manual" : `manual:${church}`, report_date: date,
      sent_at: /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}[+-]\d{2}:\d{2}$/.test(String(body.at)) ? String(body.at) : new Date().toISOString(), recipients: to.join(", "), ok, detail }) }).catch(() => {});
  return ok ? Response.json({ sent: to.length }) : say("The email was not sent. " + detail, 502);
}
