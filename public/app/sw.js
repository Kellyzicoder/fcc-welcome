// Makes the app installable and shows check-in reminders. It deliberately caches nothing: attendance must always come live from the database.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
// a reminder arrives: show it (even with the app closed)
self.addEventListener("push", event => {
  let m = {}; try { m = event.data ? event.data.json() : {}; } catch { m = {body: event.data ? event.data.text() : ""}; }
  event.waitUntil(self.registration.showNotification(m.title || "FCC Attendance", {body: m.body || "", icon: "/app/icon-192.png", badge: "/app/icon-192.png",
    tag: m.tag || "checkin", data: {url: m.url || "/app/"}}));
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
