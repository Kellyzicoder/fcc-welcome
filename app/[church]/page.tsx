import Image from "next/image";
import { redirect } from "next/navigation";
import WelcomeForm from "../WelcomeForm";

// The welcome form for one church: fcc-connect.vercel.app/melbourne. Sign-ups from here go to that church's Sign-ups.
// The address is the church's name in small letters with dashes for spaces; any other address goes to the plain form.
export const revalidate = 300;

async function churchFor(slug: string, url: string, key: string): Promise<string | null> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/app_form_church`, {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ s: slug }), next: { revalidate: 300 } });
    return r.ok ? ((await r.json()) as string | null) : null;
  } catch { return null; }
}

export default async function ChurchWelcome({ params }: { params: Promise<{ church: string }> }) {
  const { church: slug } = await params;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const church = url && key && /^[a-z0-9-]{1,60}$/i.test(slug) ? await churchFor(slug, url, key) : null;
  if (!church || !url || !key) redirect("/");

  return (
    <main>
      <div className="card">
        <header className="hero">
          <Image src="/logo.png" alt="" width={56} height={71} priority />
          <div>
            <p className="eyebrow">Favourite Child Church · {church}</p>
            <h1>Welcome — we&rsquo;re glad you&rsquo;re here</h1>
            <p className="lede">Tell us a little about yourself so we can say hello properly.</p>
          </div>
        </header>
        <div className="body">
          <WelcomeForm config={{ url, key }} church={church} />
        </div>
      </div>
    </main>
  );
}
