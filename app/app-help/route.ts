// Help → Contact the admin, from the phone app.
//
// The person's own sign-in is used for the database call, so only someone on the app's sign-in list can send.
// app_help_post saves the message (at most 5 an hour per person) and returns the main admins' emails;
// the email then goes to them through Brevo, with Reply-To set to the sender so the admin can just press Reply.
// Uses the same server-only settings as Send report: BREVO_API_KEY and REPORT_SENDER. If they are missing,
// the message is still saved and shows in the inbox on the Admin page.
export const dynamic = "force-dynamic";

const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const say = (message: string, status: number) => Response.json({ message }, { status });
const ROLE: Record<string, string> = { admin: "Admin", bishop: "Bishop", lead: "Church admin", team: "Usher", pastor: "Pastor" };

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return say("Please sign in again.", 401);

  let body: { topic?: string; message?: string };
  try { body = await req.json(); } catch { return say("That request couldn't be read.", 400); }
  const topic = String(body.topic ?? "").trim().slice(0, 80), message = String(body.message ?? "").trim();
  if (!message) return say("Please type your message.", 400);
  if (message.length > 2000) return say("Please keep the message under 2000 characters.", 400);

  // 1. save it (the database checks who is asking and how many they have sent)
  const r = await fetch(`${URL_}/rest/v1/rpc/app_help_post`, { method: "POST", cache: "no-store",
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ topic, message }) });
  const saved = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = String(saved?.message ?? "");
    if (/app_help_post/.test(m)) return say("Contact isn't set up yet: run the latest setup SQL in Supabase once.", 500);
    if (/not allowed|JWT/i.test(m) || r.status === 401) return say("Please sign in again.", 401);
    return say(m || "The message was not sent.", 400);
  }

  // 2. email the main admins (a failure here is fine: the message is already in the Admin inbox)
  const brevo = process.env.BREVO_API_KEY, sender = process.env.REPORT_SENDER;
  const to = (Array.isArray(saved.to) ? saved.to : []).filter((x: unknown) => typeof x === "string" && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x)).slice(0, 10);
  if (!brevo || !sender || !to.length) return Response.json({ saved: true, emailed: false });
  const who = `${saved.name}${saved.name !== saved.email ? ` (${saved.email})` : ""}`;
  const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">
    <p style="margin:0 0 4px"><b>${esc(who)}</b></p>
    <p style="margin:0 0 14px;color:#666">${esc(ROLE[saved.role] ?? String(saved.role ?? ""))}${saved.church ? " · " + esc(String(saved.church)) : ""}${topic ? " · " + esc(topic) : ""}</p>
    <div style="white-space:pre-wrap;border-left:3px solid #1f6fe5;padding:4px 0 4px 12px">${esc(message)}</div>
    <p style="color:#666;font-size:13px;margin-top:18px">Sent from Help in the FCC Attendance app. Press Reply to answer them.
    It is also in the Messages inbox on the Admin page.</p></div>`;
  try {
    const e = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST",
      headers: { "api-key": brevo, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "FCC Attendance", email: sender }, to: to.map((email: string) => ({ email })),
        replyTo: { email: String(saved.email), name: String(saved.name).slice(0, 80) },
        subject: `FCC app help: ${topic || "message"} from ${String(saved.name).slice(0, 60)}`, htmlContent: html }) });
    return Response.json({ saved: true, emailed: e.ok });
  } catch { return Response.json({ saved: true, emailed: false }); }
}
