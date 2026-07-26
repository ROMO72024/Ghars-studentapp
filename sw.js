const CACHE_NAME = "ghars-app-v5";
const ASSETS = [
    "./",
    "./index.html",
    "./manifest.json",
    "./logo.jpg"
];

self.addEventListener("install", (e) => {
    self.skipWaiting(); // فرض التحديث فوراً
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
    // 1. إذا كان الطلب لقاعدة البيانات (Google Script)، دعه يمر عبر الإنترنت فوراً ولا تتدخل!
    if (e.request.url.includes("script.google.com") || e.request.url.includes("googleusercontent.com")) {
        e.respondWith(fetch(e.request));
        return;
    }

    // 2. لباقي الملفات (التصميم): جرب الإنترنت أولاً، وإذا انقطع، استخدم الذاكرة
    e.respondWith(
        fetch(e.request).catch(() => {
            return caches.match(e.request);
        })
    );
});
