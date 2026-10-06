// Makes the app installable. It deliberately caches nothing: attendance must always come live from the database.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
