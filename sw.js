const CACHE_NAME = "ghars-app-v4";
const ASSETS = [
    "./",
    "./index.html",
    "./manifest.json",
    "./logo.jpg"
];

self.addEventListener("install", (e) => {
    self.skipWaiting(); // هذا السطر السحري يجبر التطبيق على التحديث فوراً دون انتظار
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
    return self.clients.claim(); // وهذا السطر يطبق التحديث فورا على الشاشة
});

self.addEventListener("fetch", (e) => {
    e.respondWith(
        caches.match(e.request).then((res) => {
            return res || fetch(e.request);
        })
    );
});
