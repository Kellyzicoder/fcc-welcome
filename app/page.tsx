import Image from "next/image";
import WelcomeForm from "./WelcomeForm";

export default function Home() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const config = url && key ? { url, key } : null;

  return (
    <main>
      <div className="card">
        <header className="hero">
          <Image src="/logo.png" alt="" width={56} height={71} priority />
          <div>
            <p className="eyebrow">Favourite Child Church</p>
            <h1>Welcome — we&rsquo;re glad you&rsquo;re here</h1>
            <p className="lede">Tell us a little about yourself so we can say hello properly.</p>
          </div>
        </header>
        <div className="body">
          <WelcomeForm config={config} />
        </div>
      </div>
    </main>
  );
}
