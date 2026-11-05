// Makes the app installable and shows check-in reminders. It deliberately caches nothing: attendance must always come live from the database.
// With no internet, opening the app shows a short "You're offline" page (kept here, not cached) instead of the browser's error.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
const OFFLINE = `<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Offline · FCC Attendance</title><meta name="theme-color" content="#f4f6fb" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0f1420" media="(prefers-color-scheme: dark)">
<style>:root{color-scheme:light dark;--bg:#f4f6fb;--card:#fff;--ink:#141a26;--ink2:#5b6577;--accent:#1f6fe5;--line:#e3e7ef}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2c;--ink:#eef1f6;--ink2:#9aa4b5;--line:#263043}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.box{max-width:360px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:28px 24px;text-align:center}
.mark{width:52px;height:52px;margin:0 auto 14px;border-radius:16px;display:grid;place-items:center;background:linear-gradient(135deg,#17616a,#2aa686);color:#ffcf00;font-size:24px;font-weight:700}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;color:var(--ink2)}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:11px 22px;background:var(--accent);color:#fff;cursor:pointer}</style></head>
<body><div class="box"><div class="mark">✝</div><h1>You're offline</h1><p>FCC Attendance needs the internet so everyone sees the same, up-to-date list. Check your Wi-Fi or mobile data, then try again.</p>
<button onclick="location.reload()">Try again</button></div><script>addEventListener("online",()=>location.reload())</script></body></html>`;
self.addEventListener("fetch", event => {
  const r = event.request;
  if (r.mode !== "navigate") return;  // only opening a page; everything else goes straight to the network as before
  event.respondWith(fetch(r).catch(() => new Response(OFFLINE, {status: 503, headers: {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}})));
});
// a reminder arrives: show it (even with the app closed)
self.addEventListener("push", event => {
  let m = {}; try { m = event.data ? event.data.json() : {}; } catch { m = {body: event.data ? event.data.text() : ""}; }
  event.waitUntil(self.registration.showNotification(m.title || "FCC Attendance", {body: m.body || "", icon: "/app/icon-192.png", badge: "/app/icon-192.png",
    tag: m.tag || "checkin", renotify: true, silent: false, vibrate: [200, 100, 200], data: {url: m.url || "/app/"}}));  // with sound and a buzz, as the phone allows
});
// tapping it opens the app (on Check-in), using an open window if there is one
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/app/";
  event.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    const w = list.find(c => c.url.includes("/app/"));
    return w ? w.navigate(url).then(c => (c || w).focus()).catch(() => self.clients.openWindow(url)) : self.clients.openWindow(url);
  }));
});
