// The thank-you email sent to first-timers (see app/first-timer-thanks/route.ts).

export const CHURCH = "Favourite Child Church";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** "Sunday 26 October" from "2026-10-26". */
function niceDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-NZ", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(d);
}

export function thankYouEmail(fullName: string, firstVisit: string) {
  const first = fullName.trim().split(/\s+/)[0] || "friend";
  const day = niceDate(firstVisit);
  const subject = `Thank you for coming to ${CHURCH}, ${first}!`;
  const text = [
    `Hi ${first},`,
    "",
    `Thank you so much for visiting ${CHURCH} on ${day}. It was a joy to have you with us.`,
    "",
    "Someone from our welcome team will be in touch this week to say hello and answer any questions you have.",
    "",
    "We'd love to see you again soon. You're always welcome here.",
    "",
    "God bless you,",
    `The ${CHURCH} family`,
  ].join("\n");
  const html = `<!doctype html><html style="height:100%"><body style="margin:0;height:100%;background:#f2f6f7;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;color:#14233a">
  <table role="presentation" width="100%" height="100%" cellpadding="0" cellspacing="0" style="height:100%;min-height:100vh"><tr><td align="center" valign="middle" style="padding:24px 12px;vertical-align:middle">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #d5e0e6">
      <tr><td style="background:#287586;background-image:linear-gradient(140deg,#2d4d79 0%,#287586 50%,#2aa87a 100%);padding:28px 24px;text-align:center">
        <div style="color:#ffffff;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;opacity:.9">${esc(CHURCH)}</div>
        <div style="color:#ffcc00;font-size:28px;line-height:1.1;font-weight:800;text-transform:uppercase;margin-top:8px">Thank you for coming!</div>
      </td></tr>
      <tr><td style="padding:26px 24px;font-size:16px;line-height:1.6">
        <p style="margin:0 0 14px">Hi ${esc(first)},</p>
        <p style="margin:0 0 14px">Thank you so much for visiting ${esc(CHURCH)} on <b>${esc(day)}</b>. It was a joy to have you with us.</p>
        <p style="margin:0 0 14px">Someone from our welcome team will be in touch this week to say hello and answer any questions you have.</p>
        <p style="margin:0 0 22px">We'd love to see you again soon. You're always welcome here.</p>
        <p style="margin:0">God bless you,<br><b>The ${esc(CHURCH)} family</b></p>
      </td></tr>
    </table>
    <p style="max-width:560px;color:#536274;font-size:12px;line-height:1.5;margin:14px auto 0">You're getting this one-off email because you filled in our welcome card and said we could get in touch.</p>
  </td></tr></table></body></html>`;
  return { subject, text, html };
}
