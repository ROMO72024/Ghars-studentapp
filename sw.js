/* مدرسة وروضة غرس الحديثة — Service Worker
   يخزّن الواجهة على الجهاز لتفتح فوراً وبلا إنترنت.
   ⚠️ عند أي تعديل على index.html غيّر رقم النسخة هنا. */

var VERSION = "ghars-v5.0.0";
var SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./styles.css?v=5.0.0",
  "./app.js?v=5.0.0",
  "./logo.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      // addAll يفشل كله إذا فشل ملف واحد — نضيف كل ملف على حدة
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === VERSION ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);

  // نداءات Apps Script لا تُخزَّن أبداً — يتكفّل بها طابور المزامنة
  if (url.hostname.indexOf("script.google") !== -1 ||
      url.hostname.indexOf("googleusercontent") !== -1) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // التنقّل: من الكاش فوراً، مع تحديث في الخلفية
  if (req.mode === "navigate") {
    e.respondWith(
      caches.match("./index.html").then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) {
            caches.open(VERSION).then(function (c) { c.put("./index.html", res.clone()); });
          }
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
    return;
  }

  // بقية الملفات: كاش أولاً ثم تحديث صامت
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok && res.type === "basic") {
          caches.open(VERSION).then(function (c) { c.put(req, res.clone()); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});

// إذا سمح المتصفح بالمزامنة الخلفية، نوقظ الصفحة المفتوحة لتفرغ طابورها.
self.addEventListener("sync", function (e) {
  if (e.tag !== "ghars-sync") return;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      clients.forEach(function (client) { client.postMessage({ type: "GHARS_SYNC_NOW" }); });
    })
  );
});
