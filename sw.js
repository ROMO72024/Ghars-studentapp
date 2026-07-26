const CACHE_NAME = "ghars-app-v1";
const urlsToCache = [
  "./index.html",
  "./logo.jpg",
  "./manifest.json"
];

// تثبيت ملفات التطبيق في ذاكرة الهاتف
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

// جلب الملفات من الذاكرة عند انقطاع الإنترنت
self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
