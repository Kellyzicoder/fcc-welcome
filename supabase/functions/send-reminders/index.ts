// send-reminders (FCC Attendance): every 5 minutes pg_cron asks this to send the check-in reminders that are due.
// It can also send a test to one device that has turned notifications on. Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS"};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), {status, headers: {...cors, "Content-Type": "application/json"}});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: cors});
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  webpush.setVapidDetails("mailto:" + (Deno.env.get("VAPID_EMAIL") || "admin@example.com"), Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);
  const body = await req.json().catch(() => ({}));
  let rows: any[] = [];
  if (body.test) {  // "Send a test" in Settings: only to a device that is already signed up
    const { data } = await db.from("push_subs").select("endpoint, p256dh, auth").eq("endpoint", String(body.test));
    rows = (data || []).map((r: any) => ({...r, test: true}));
  } else {
    const { data, error } = await db.rpc("app_due_reminders");
    if (error) return json({error: error.message}, 500);
    rows = data || [];
  }
  let sent = 0;
  for (const r of rows) {
    const msg = r.test ? {title: "Notifications are on", body: "Check-in reminders will show like this.", url: "/app/"}
      : {title: "Time to check people in", body: (r.church ? r.church + ": " : "") + "tap to open Check-in.", url: "/app/?go=checkin"};
    try { await webpush.sendNotification({endpoint: r.endpoint, keys: {p256dh: r.p256dh, auth: r.auth}}, JSON.stringify(msg), {TTL: 3600}); sent++; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subs").delete().eq("endpoint", r.endpoint); }  // the device said no or is gone
  }
  return json({sent});
});
