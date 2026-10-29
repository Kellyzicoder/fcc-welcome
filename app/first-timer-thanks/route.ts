// Emails a thank-you to first-timers the morning after they fill in the welcome form.
//
// Run by Vercel Cron once a day (see vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>".
// That key is passed to the database, which checks it against a fingerprint it keeps privately
// (supabase/thank_you_email.sql), so only this job can see who is due or mark them as sent.
// Needs server-only settings on Vercel: CRON_SECRET, BREVO_API_KEY and REPORT_SENDER.
import { CHURCH, thankYouEmail } from "../thank-you-email";

export const dynamic = "force-dynamic";

const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

type Due = { id: string; full_name: string; email: string; first_visit: string };

const say = (message: string, status: number) => Response.json({ message }, { status });

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET, brevo = process.env.BREVO_API_KEY, sender = process.env.REPORT_SENDER;
  if (!secret || !brevo || !sender || !URL_ || !KEY) return say("Not set up: needs CRON_SECRET, BREVO_API_KEY and REPORT_SENDER on Vercel.", 503);
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) return say("Not allowed.", 401);

  const rpc = (name: string, body: unknown) =>
    fetch(`${URL_}/rest/v1/rpc/${name}`, { method: "POST", cache: "no-store",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const dueRes = await rpc("app_thankyou_due", { job_key: secret });
  if (!dueRes.ok) return say(`Couldn't load who is due (${dueRes.status}). Run supabase/thank_you_email.sql and set the job key.`, 500);
  const due = (await dueRes.json()) as Due[];

  const sent: string[] = [], failed: string[] = [];
  for (const p of due) {
    const mail = thankYouEmail(p.full_name, p.first_visit);
    try {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST",
        headers: { "api-key": brevo, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sender: { name: CHURCH, email: sender }, to: [{ email: p.email, name: p.full_name }],
          subject: mail.subject, htmlContent: mail.html, textContent: mail.text }) });
      (r.ok ? sent : failed).push(p.id);
      if (!r.ok) console.error("Thank-you email failed", r.status, (await r.text()).slice(0, 200));
    } catch (e) {
      failed.push(p.id);
      console.error("Thank-you email failed", String(e).slice(0, 200));
    }
  }

  if (sent.length) {
    const markRes = await rpc("app_thankyou_mark", { job_key: secret, ids: sent });
    if (!markRes.ok) console.error("Couldn't mark thank-you emails as sent", markRes.status);
  }
  return Response.json({ due: due.length, sent: sent.length, failed: failed.length });
}
