const CACHE_NAME = "ghars-app-final-v7";
const ASSETS = [
    "./",
    "./index.html",
    "./manifest.json",
    "./logo.jpg"
];

self.addEventListener("install", (e) => {
    self.skipWaiting(); 
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        })
    );
    return self.clients.claim();
});

self.addEventListener("fetch", (e) => {
    // الأهم: منع ملف الأوفلاين من التدخل نهائياً في عمليات جوجل!
    if (e.request.url.includes("script.google.com") || e.request.url.includes("googleusercontent.com") || e.request.method !== "GET") {
        return; 
    }

    // لباقي الملفات (الصور والتصميم)
    e.respondWith(
        fetch(e.request).catch(() => {
            return caches.match(e.request);
        })
    );
});
