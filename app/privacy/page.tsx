import type { Metadata } from "next";

// The privacy policy for the FCC Attendance app and the welcome form, at /privacy. The app stores link to it.
// Set PRIVACY_EMAIL in Vercel (Settings → Environment Variables) to show an email address for privacy questions.
export const metadata: Metadata = {
  title: "Privacy · Favourite Child Church",
  description: "How Favourite Child Church looks after the details in the FCC Attendance app and the welcome form.",
  robots: { index: true, follow: true },
};

const UPDATED = "6 November 2026";

export default function Privacy() {
  const email = process.env.PRIVACY_EMAIL?.trim();
  return (
    <main className="pv">
      <style>{CSS}</style>
      <article>
        <p className="pv-eyebrow">Favourite Child Church</p>
        <h1>Privacy</h1>
        <p className="pv-lede">How we look after the details in the FCC Attendance app and on our welcome form. Last updated {UPDATED}.</p>

        <h2>Who we are</h2>
        <p>Favourite Child Church (FCC) runs the FCC Attendance app for its churches and team. We follow the New Zealand Privacy Act 2020.
          {email ? <> Questions about privacy go to <a href={`mailto:${email}`}>{email}</a>.</> : <> For privacy questions, use Help → Contact the admin in the app, or speak to your church's admin or pastor.</>}</p>

        <h2>What we keep</h2>
        <ul>
          <li><b>From the welcome form:</b> your name and phone, and if you give them your email, who invited you, and anything you'd like prayer or help with.</li>
          <li><b>About people in our congregations:</b> name, phone, email, address and birthday where given, which services, Bacenta and Centa meetings you came to, and notes the team makes to look after you (such as a follow-up call or a home visit).</li>
          <li><b>For people who sign in to the app (our team):</b> your email, name, role and church; your settings; when you last signed in; and what you did in the app (the activity log), such as ticking attendance or downloading a list.</li>
          <li><b>Community messages</b> that team members send each other in the app.</li>
          <li><b>Phone notifications:</b> if you turn on reminders, your phone's notification address (not your number) and the times you chose.</li>
        </ul>
        <p>We don't collect your location, contacts, photos or anything for advertising, and the app has no ads or trackers.</p>

        <h2>Why</h2>
        <p>To welcome new people, keep track of who came, notice when someone has been away so a pastor or shepherd can check in, and share attendance numbers within the church.</p>

        <h2>Who can see it</h2>
        <p>Only signed-in FCC team members, and only what their role needs. An usher sees their own church's check-in; a pastor or shepherd sees the people in their care; church admins see their church; the main admin sees every church. The database itself enforces this. We never sell or share your details with anyone outside the church.</p>

        <h2>Where it's kept</h2>
        <p>The details are stored with Supabase, in their data centre in Seoul, South Korea. The app is hosted by Vercel, and some emails (such as a thank-you to a first-time visitor) are sent through Brevo. The app's lettering comes from Google Fonts. These companies only store or send it for us, protected by their own security and privacy terms. Everything travels encrypted.</p>

        <h2>How long we keep it</h2>
        <ul>
          <li>Someone not seen at church for five years has their name and contact details wiped automatically. Attendance numbers stay, without a name.</li>
          <li>Community messages are deleted after 180 days.</li>
          <li>The activity log keeps 12 months.</li>
          <li>A team member can delete their own sign-in at any time (below).</li>
        </ul>

        <h2>Your choices</h2>
        <ul>
          <li><b>See or correct your details:</b> ask your church's admin or pastor, or {email ? <a href={`mailto:${email}`}>email us</a> : "use Help → Contact the admin in the app"}. You can ask what we hold about you and have it corrected.</li>
          <li><b>Be removed from our lists:</b> ask, and we'll wipe your details.</li>
          <li><b>Delete your app account:</b> in the app, go to You → Your account → Delete my account. This removes your sign-in, settings, phone notifications, reminders and Community messages straight away. Church records, such as attendance, stay with the church without your sign-in.</li>
        </ul>

        <h2>If something goes wrong</h2>
        <p>If there's a privacy breach that could cause serious harm, we'll tell the people affected and the Privacy Commissioner as soon as we can. If you're unhappy with how we've handled your details, talk to us first. You can also contact the <a href="https://www.privacy.org.nz" target="_blank" rel="noopener noreferrer">Office of the Privacy Commissioner</a>.</p>

        <p className="pv-foot"><a href="/app/">Open FCC Attendance</a></p>
      </article>
    </main>
  );
}

const CSS = `
.pv{min-height:100dvh;padding:32px 16px 48px;background:#f4f6fb;color:#141a26;display:block}
.pv article{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e3e7ef;border-radius:22px;padding:32px 30px;line-height:1.6;font-size:15px}
.pv h1{font-size:30px;margin:2px 0 6px;letter-spacing:-.01em}
.pv h2{font-size:17px;margin:28px 0 6px}
.pv p,.pv li{color:#2f3746}
.pv ul{padding-left:20px;margin:6px 0}
.pv li{margin:6px 0}
.pv a{color:#1f6fe5}
.pv-eyebrow{margin:0;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5b6577!important}
.pv-lede{color:#5b6577!important;margin:0 0 8px}
.pv-foot{margin-top:28px;padding-top:16px;border-top:1px solid #e3e7ef}
@media (prefers-color-scheme:dark){.pv{background:#0f1420;color:#eef1f6}.pv article{background:#171e2c;border-color:#263043}.pv p,.pv li{color:#c9d1de}.pv a{color:#6aa5ff}.pv-foot{border-color:#263043}}
@media (max-width:560px){.pv{padding:0}.pv article{border-radius:0;border:0;padding:24px 18px 36px}.pv h1{font-size:26px}}
`;
