// Gives the attendance app (static files under /app) the two public Supabase settings.
// Both are public by design: the publishable key can do nothing until someone signs in, and after that
// Row Level Security in the database decides what that person may load (see supabase/app_setup.sql).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      url: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, ""),
      key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
