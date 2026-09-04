(function () {
  "use strict";

  var API = "https://script.google.com/macros/s/AKfycbyLo60SsdFtB8Sttx347Jn26erlDINiishZiDYHMsbRO_paRJUiVgCSR4-Kl0UWDjzQyg/exec";
  var K_STATE = "ghars.state.v4";
  var K_DIR = "ghars.dir.v4";
  var K_QUEUE = "ghars.queue.v4";
  var MAX_BATCH = 12;
  var DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  var CLS = { "حاضر": "p", "غائب": "a", "مأذون": "e" };
  var FATAL = {
    NOT_FOUND: 1, BAD_STATUS: 1, DUPLICATE: 1, RESERVED: 1, BAD_NAME: 1,
    REQUIRED: 1, BAD_DATE: 1, TOO_LONG: 1, BAD_CHARS: 1,
    UNKNOWN_ACTION: 1, NO_SHEET: 1, NO_SS: 1, TOO_MANY: 1, STALE_BINDING: 1
  };

  var storageFailed = false;
  var busy = false;
  var timer = null;
  var backoff = 0;
  var inFlight = {};
  var batchSupported = true;
  var refreshAfterDrain = false;
  var loudPullAfterDrain = false;

  function $(id) { return document.getElementById(id); }

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      storageFailed = true;
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      storageFailed = true;
      return false;
    }
  }

  function baseState() {
    return {
      teacherId: "", teacherName: "", className: "", students: [], marks: {},
      classSheetId: "",
      date: "", submitted: false, dirty: false, pendingAttendanceId: "",
      syncedAttendanceId: "", lastSyncedAt: 0
    };
  }

  function normalizeState(entry, typedId) {
    var out = baseState();
    entry = entry || {};
    out.teacherId = String(entry.teacherId || typedId || "").trim();
    out.teacherName = String(entry.teacherName || "").trim();
    out.className = String(entry.className || "").trim();
    out.classSheetId = String(entry.classSheetId || "").trim();
    out.students = Array.isArray(entry.students) ? entry.students.slice() : [];
    out.marks = entry.marks && typeof entry.marks === "object" ? entry.marks : {};
    out.date = entry.date || today();
    out.submitted = !!entry.submitted;
    out.dirty = !!entry.dirty;
    out.pendingAttendanceId = String(entry.pendingAttendanceId || "");
    out.syncedAttendanceId = String(entry.syncedAttendanceId || (out.submitted && !out.pendingAttendanceId ? "legacy" : ""));
    out.lastSyncedAt = Number(entry.lastSyncedAt || 0);
    out.marks = fillDefaults(out.students, out.marks);
    return out;
  }

  var S = normalizeState(load(K_STATE, null));

  function dirKey(id) { return String(id || "").trim().toLowerCase(); }
  function loadDir() { return load(K_DIR, {}); }
  function saveDir(value) { save(K_DIR, value); }

  function persist() {
    save(K_STATE, S);
    if (!S.teacherId) return;
    var dir = loadDir();
    dir[dirKey(S.teacherId)] = normalizeState(S);
    saveDir(dir);
  }

  function updateStoredTeacher(teacherId, updater) {
    var key = dirKey(teacherId);
    var dir = loadDir();
    if (!dir[key]) return;
    var entry = normalizeState(dir[key], teacherId);
    updater(entry);
    dir[key] = entry;
    saveDir(dir);
    if (dirKey(S.teacherId) === key) {
      S = entry;
      save(K_STATE, S);
    }
  }

  function today() {
    try {
      var parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Gaza", year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(new Date());
      var values = {};
      for (var i = 0; i < parts.length; i++) values[parts[i].type] = parts[i].value;
      if (values.year && values.month && values.day) return values.year + "-" + values.month + "-" + values.day;
    } catch (_) {}
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function pad2(value) { return ("0" + value).slice(-2); }
  function dayName(iso) { var p = iso.split("-"); return DAYS[new Date(+p[0], +p[1] - 1, +p[2]).getDay()]; }
  function pretty(iso) { var p = iso.split("-"); return (+p[2]) + "/" + (+p[1]) + "/" + p[0]; }
  function uid() {
    if (window.crypto && crypto.getRandomValues) {
      var bytes = new Uint32Array(2);
      crypto.getRandomValues(bytes);
      return Date.now().toString(36) + "-" + bytes[0].toString(36) + bytes[1].toString(36);
    }
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 11);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function normName(value) {
    return String(value || "").replace(/[\u064B-\u0652\u0670\u0640]/g, "")
      .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
      .replace(/\s+/g, " ").trim().toLowerCase();
  }

  function cleanName(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

  function toast(message, kind) {
    var item = document.createElement("div");
    item.className = "toast" + (kind ? " " + kind : "");
    item.textContent = message;
    $("toasts").appendChild(item);
    setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 3200);
  }

  function nameHue(name) {
    var hash = 0;
    for (var i = 0; i < String(name || "").length; i++) hash = (hash * 31 + String(name).charCodeAt(i)) % 360;
    return hash;
  }

  function initialOf(name) { var value = String(name || "").trim(); return value ? value[0] : "؟"; }

  function netErr(message) { var error = new Error(message); error.network = true; return error; }

  function call(payload, timeoutMs) {
    var controller = ("AbortController" in window) ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 18000) : null;
    return fetch(API, {
      method: "POST",
      redirect: "follow",
      cache: "no-store",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (timeout) clearTimeout(timeout);
      if (!response.ok) throw netErr("HTTP " + response.status);
      return response.json();
    }).catch(function (error) {
      if (timeout) clearTimeout(timeout);
      throw netErr(error && error.message ? error.message : "تعذّر الاتصال");
    });
  }

  function callFirstLogin(payload) {
    return call(payload, 18000).catch(function (firstError) {
      if (!navigator.onLine) throw firstError;
      return new Promise(function (resolve) { setTimeout(resolve, 900); })
        .then(function () { return call(payload, 18000); });
    });
  }

  function Q() {
    var value = load(K_QUEUE, []);
    return Array.isArray(value) ? value : [];
  }

  function setQ(queue) {
    save(K_QUEUE, queue);
    paintWire();
    paintDock();
  }

  function enqueue(op, options) {
    var queue = Q();
    op.opId = op.opId || uid();
    op.teacherId = op.teacherId || S.teacherId;
    op.className = op.className || S.className;
    op.classSheetId = op.classSheetId || S.classSheetId;
    op.createdAt = op.createdAt || Date.now();
    if (options && options.replaceKey) {
      op.replaceKey = options.replaceKey;
      queue = queue.filter(function (old) {
        return old.replaceKey !== op.replaceKey || !!inFlight[old.opId];
      });
    }
    queue.push(op);
    setQ(queue);
    requestBackgroundSync();
    // توزيع أقل من نصف ثانية يمنع 30 جهازًا من ضرب Apps Script في اللحظة نفسها.
    scheduleSync(120 + Math.floor(Math.random() * 480));
    return op;
  }

  function requestBackgroundSync() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(function (registration) {
      if (registration.sync && registration.sync.register) return registration.sync.register("ghars-sync");
    }).catch(function () {});
  }

  function pendingAttendance(teacherId, date) {
    var key = "att:" + dirKey(teacherId) + ":" + date;
    var queue = Q();
    for (var i = queue.length - 1; i >= 0; i--) if (queue[i].replaceKey === key) return queue[i];
    return null;
  }

  function scheduleSync(delay) {
    clearTimeout(timer);
    timer = setTimeout(runSync, Math.max(0, Number(delay || 0)));
  }

  function serverCopy(op) {
    var out = {};
    Object.keys(op).forEach(function (key) {
      if (key.charAt(0) !== "_" && key !== "replaceKey" && key !== "createdAt" && key !== "attempts") out[key] = op[key];
    });
    return out;
  }

  function runSync() {
    if (busy) return;
    var queue = Q();
    if (!queue.length) { finishSyncCycle(); return; }
    if (!navigator.onLine) { paintWire(); return; }
    busy = true;
    paintWire("work");

    var batch = queue.slice(0, batchSupported ? MAX_BATCH : 1);
    inFlight = {};
    for (var i = 0; i < batch.length; i++) inFlight[batch[i].opId] = true;

    if (!batchSupported) {
      call(serverCopy(batch[0]), 18000).then(function (result) {
        handleResults(batch, [Object.assign({ opId: batch[0].opId }, result || {})]);
      }).catch(function () { finishAttempt(); retrySync(); });
      return;
    }

    call({ action: "sync_batch", operations: batch.map(serverCopy) }, 20000)
      .then(function (response) {
        if (!response || !response.ok) {
          if (response && response.code === "UNKNOWN_ACTION") {
            batchSupported = false;
            finishAttempt();
            scheduleSync(0);
            return;
          }
          finishAttempt();
          retrySync();
          return;
        }
        handleResults(batch, Array.isArray(response.results) ? response.results : []);
      })
      .catch(function () { finishAttempt(); retrySync(); });
  }

  function finishAttempt() {
    busy = false;
    inFlight = {};
  }

  function handleResults(batch, results) {
    var byId = {};
    for (var i = 0; i < results.length; i++) byId[String(results[i].opId || "")] = results[i];
    var remove = {};
    var transientFailure = false;

    for (var j = 0; j < batch.length; j++) {
      var op = batch[j];
      var result = byId[op.opId];
      if (!result) { transientFailure = true; continue; }
      if (result.ok) {
        remove[op.opId] = true;
        afterOk(op, result);
      } else if (FATAL[result.code]) {
        remove[op.opId] = true;
        afterFatal(op, result);
      } else {
        transientFailure = true;
      }
    }

    finishAttempt();
    var latest = Q().filter(function (op) { return !remove[op.opId]; });
    setQ(latest);

    if (transientFailure) retrySync();
    else {
      backoff = 0;
      if (latest.length) scheduleSync(180);
      else finishSyncCycle();
    }
  }

  function afterOk(op, result) {
    if (op.action === "save_attendance") {
      updateStoredTeacher(op.teacherId, function (entry) {
        if (entry.date !== op.date || entry.pendingAttendanceId !== op.opId) return;
        entry.pendingAttendanceId = "";
        entry.syncedAttendanceId = op.opId;
        entry.submitted = true;
        entry.lastSyncedAt = Number(result.serverTime || Date.now());
      });
    }
    if (op.action === "add_student" && result.duplicate) toast("الطالب موجود أصلًا في الشيت", "good");
    if (result.teacherName && dirKey(S.teacherId) === dirKey(op.teacherId)) S.teacherName = result.teacherName;
    if (result.className && dirKey(S.teacherId) === dirKey(op.teacherId)) S.className = result.className;
    if (result.classSheetId && dirKey(S.teacherId) === dirKey(op.teacherId)) S.classSheetId = String(result.classSheetId);
    persist();
  }

  function afterFatal(op, result) {
    if (op.action === "save_attendance") {
      updateStoredTeacher(op.teacherId, function (entry) {
        if (entry.pendingAttendanceId === op.opId) entry.pendingAttendanceId = "";
        entry.submitted = false;
        entry.dirty = true;
      });
    }
    refreshAfterDrain = true;
    toast((result && result.message) || "تعذّر حفظ إحدى العمليات", "bad");
  }

  function retrySync() {
    backoff = Math.min(backoff ? Math.round(backoff * 1.7) : 1800, 30000);
    backoff += Math.floor(Math.random() * 500);
    paintWire(navigator.onLine ? "bad" : "wait");
    scheduleSync(backoff);
  }

  function finishSyncCycle() {
    busy = false;
    inFlight = {};
    backoff = 0;
    paintWire();
    paintDock();
    if (!Q().length && S.teacherId && (refreshAfterDrain || loudPullAfterDrain)) {
      var loud = loudPullAfterDrain;
      refreshAfterDrain = false;
      loudPullAfterDrain = false;
      pull(loud);
    }
  }

  function repairPendingState() {
    if (!S.teacherId) return;
    var pending = pendingAttendance(S.teacherId, S.date);
    if (pending) {
      S.pendingAttendanceId = pending.opId;
      S.submitted = true;
    } else if (S.pendingAttendanceId) {
      S.pendingAttendanceId = "";
    }
    persist();
  }

  function paintWire(force) {
    if (!$("wire")) return;
    var count = Q().length;
    $("btn-sync").setAttribute("data-n", String(count));
    $("btn-sync").classList.toggle("spinning", force === "work");
    var cls = "ok";
    var text = "البيانات محفوظة على الجهاز";
    if (storageFailed) { cls = "bad"; text = "تعذّر التخزين على الجهاز — أغلقي التصفح الخاص"; }
    else if (force === "work") { cls = "work"; text = "جارٍ المزامنة — أبقي التطبيق مفتوحًا"; }
    else if (count && !navigator.onLine) { cls = "wait"; text = "محفوظ على الجهاز — " + count + " بانتظار الإنترنت"; }
    else if (force === "bad") { cls = "bad"; text = "الاتصال ضعيف — سنعيد المحاولة تلقائيًا"; }
    else if (count) { cls = "wait"; text = count + " عملية بانتظار تأكيد الشيت"; }
    else if (S.dirty) { cls = "wait"; text = "مسودة محفوظة — اضغطي تسليم الحضور"; }
    else if (S.submitted && S.syncedAttendanceId) { cls = "ok"; text = "تم التسليم والمزامنة بنجاح ✓"; }
    $("wire").className = "wire " + cls;
    $("wire-txt").textContent = text;
  }

  function showNote(message, kind) {
    var note = $("gate-note");
    note.textContent = message;
    note.className = "note " + (kind || "err");
    note.hidden = false;
  }

  function fillDefaults(list, existing) {
    var marks = {};
    existing = existing || {};
    for (var i = 0; i < list.length; i++) marks[list[i]] = existing[list[i]] || "حاضر";
    return marks;
  }

  function adopt(entry, typedId) {
    S = normalizeState(entry, typedId);
    persist();
    repairPendingState();
  }

  function signIn() {
    var id = String($("code").value || "").trim();
    if (!id) { showNote("اكتبي رقم المعلمة أولًا.", "hint"); return; }
    var button = $("enter");
    button.disabled = true;
    button.textContent = "جارٍ التحقق…";
    $("gate-note").hidden = true;

    var cached = loadDir()[dirKey(id)];
    if (cached) {
      adopt(cached, id);
      openApp();
      button.disabled = false;
      button.textContent = "دخول";
      if (navigator.onLine) {
        if (Q().length) { refreshAfterDrain = true; scheduleSync(100); }
        else silentRefresh();
      }
      return;
    }

    if (!navigator.onLine) {
      showNote("أول دخول لهذا الرقم يحتاج إنترنت مرة واحدة. بعد ذلك يعمل التطبيق دون إنترنت.", "hint");
      button.disabled = false;
      button.textContent = "دخول";
      return;
    }

    callFirstLogin({ action: "login", teacherId: id, date: today() })
      .then(function (result) {
        if (!result || !result.ok) { showNote((result && result.message) || "الرقم غير موجود."); return; }
        adopt({
          teacherId: result.teacherId,
          teacherName: result.teacherName,
          className: result.className,
          classSheetId: result.classSheetId,
          students: result.students || [],
          date: result.date,
          marks: fillDefaults(result.students || [], result.attendance || {}),
          submitted: !!result.submitted,
          dirty: false,
          syncedAttendanceId: result.submitted ? "server" : "",
          lastSyncedAt: Number(result.serverTime || Date.now())
        }, id);
        openApp();
        if (result.classCreated) toast("أُنشئ الصف المؤقت تلقائيًا", "good");
      })
      .catch(function () {
        showNote(navigator.onLine ? "الاتصال ضعيف. حاولي مرة أخرى، ولن يضيع أي تسجيل محفوظ." : "لا يوجد اتصال بالإنترنت.");
      })
      .then(function () { button.disabled = false; button.textContent = "دخول"; });
  }

  function silentRefresh() {
    if (!navigator.onLine || !S.teacherId) return;
    if (Q().length) { refreshAfterDrain = true; scheduleSync(0); return; }
    pull(false);
  }

  function openApp() {
    $("gate").hidden = true;
    $("app").classList.add("on");
    rollDay();
    repairPendingState();
    paintAll();
    if (Q().length) scheduleSync(250 + Math.floor(Math.random() * 500));
    if (storageFailed) toast("التخزين المحلي غير متاح على هذا الجهاز", "bad");
  }

  function rollDay() {
    var current = today();
    if (S.date !== current) {
      S.date = current;
      S.marks = fillDefaults(S.students, {});
      S.submitted = false;
      S.dirty = false;
      S.pendingAttendanceId = "";
      S.syncedAttendanceId = "";
      persist();
    }
  }

  function paintAll() { paintHeader(); paintDay(); paintRoster(); paintDock(); paintWire(); }
  function paintHeader() { $("t-name").textContent = S.teacherName; $("t-class").textContent = S.className; }

  function countMarks() {
    var count = { p: 0, a: 0, e: 0 };
    for (var i = 0; i < S.students.length; i++) {
      var status = S.marks[S.students[i]];
      if (status === "غائب") count.a++;
      else if (status === "مأذون") count.e++;
      else count.p++;
    }
    return count;
  }

  function paintDay() {
    $("d-day").textContent = dayName(S.date);
    $("d-date").textContent = pretty(S.date);
    $("d-count").textContent = S.students.length + " طالبًا";
    var counts = countMarks();
    $("c-p").textContent = counts.p;
    $("c-a").textContent = counts.a;
    $("c-e").textContent = counts.e;
  }

  function paintRoster() {
    var box = $("roster");
    if (!S.students.length) {
      box.innerHTML = '<div class="blank"><b>لا يوجد طلاب في هذا الصف بعد</b>ابدئي بإضافة أول طالب من الشريط السفلي.</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < S.students.length; i++) {
      var name = S.students[i];
      var status = S.marks[name] || "حاضر";
      var key = CLS[status];
      var hue = nameHue(name);
      html += '<div class="row ' + (key === "a" ? "absent" : key === "e" ? "excused" : "") + '" data-i="' + i + '">' +
        '<div class="row-h"><div class="av" style="background:hsl(' + hue + ',46%,89%);color:hsl(' + hue + ',55%,30%)">' + esc(initialOf(name)) + '</div>' +
        '<div class="nm">' + esc(name) + '</div><button class="more" data-act="more" aria-label="خيارات الطالب">⋮</button></div>' +
        '<div class="stamps"><button data-st="حاضر" class="p' + (key === "p" ? " on" : "") + '">حاضر</button>' +
        '<button data-st="غائب" class="a' + (key === "a" ? " on" : "") + '">غائب</button>' +
        '<button data-st="مأذون" class="e' + (key === "e" ? " on" : "") + '">مأذون</button></div></div>';
    }
    box.innerHTML = html;
  }

  function paintRow(index) {
    var row = $("roster").querySelector('.row[data-i="' + index + '"]');
    if (!row) return;
    var status = S.marks[S.students[index]] || "حاضر";
    var key = CLS[status];
    row.className = "row " + (key === "a" ? "absent" : key === "e" ? "excused" : "");
    var buttons = row.querySelectorAll(".stamps button");
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle("on", buttons[i].getAttribute("data-st") === status);
  }

  function paintDock() {
    if (!$("btn-submit")) return;
    var button = $("btn-submit");
    var pending = pendingAttendance(S.teacherId, S.date);
    button.classList.remove("done", "pending");
    if (S.dirty) button.textContent = S.submitted ? "تسليم التعديلات" : "تسليم الحضور";
    else if (pending) { button.classList.add("pending"); button.textContent = "محفوظ · بانتظار المزامنة"; }
    else if (S.submitted && S.syncedAttendanceId) { button.classList.add("done"); button.textContent = "تم التسليم ✓"; }
    else button.textContent = "تسليم الحضور";
  }

  function attendanceRecords() {
    return S.students.map(function (name) { return { studentName: name, status: S.marks[name] || "حاضر" }; });
  }

  function queueAttendanceSnapshot() {
    var key = "att:" + dirKey(S.teacherId) + ":" + S.date;
    var op = enqueue({ action: "save_attendance", date: S.date, records: attendanceRecords() }, { replaceKey: key });
    S.submitted = true;
    S.dirty = false;
    S.pendingAttendanceId = op.opId;
    persist();
    paintDock();
    paintWire();
    return op;
  }

  function findStudent(name) {
    var wanted = normName(name);
    for (var i = 0; i < S.students.length; i++) if (normName(S.students[i]) === wanted) return i;
    return -1;
  }

  function rosterChanged(wasSubmitted) {
    S.dirty = true;
    persist();
    paintRoster();
    paintDay();
    paintDock();
    paintWire();
    if (wasSubmitted) queueAttendanceSnapshot();
  }

  function pull(loud) {
    if (!navigator.onLine) { if (loud) toast("لا يوجد إنترنت الآن", "bad"); return; }
    if (Q().length || busy) {
      refreshAfterDrain = true;
      loudPullAfterDrain = loudPullAfterDrain || !!loud;
      scheduleSync(0);
      if (loud) toast("سنرسل البيانات المحفوظة أولًا");
      return;
    }

    paintWire("work");
    call({ action: "pull", teacherId: S.teacherId, date: today() }, 18000)
      .then(function (result) {
        if (!result || !result.ok) {
          paintWire("bad");
          if (loud) toast((result && result.message) || "تعذّر التحديث", "bad");
          return;
        }
        var localMarks = S.marks;
        var localDirty = S.dirty;
        S.teacherName = result.teacherName;
        S.className = result.className;
        S.classSheetId = String(result.classSheetId || S.classSheetId || "");
        S.students = result.students || [];
        S.date = result.date;
        S.marks = fillDefaults(S.students, result.attendance || {});
        if (localDirty) {
          Object.keys(localMarks || {}).forEach(function (name) {
            if (S.students.indexOf(name) !== -1) S.marks[name] = localMarks[name];
          });
          S.dirty = true;
        } else {
          S.submitted = !!result.submitted;
          S.syncedAttendanceId = result.submitted ? "server" : "";
          S.pendingAttendanceId = "";
        }
        S.lastSyncedAt = Number(result.serverTime || Date.now());
        persist();
        paintAll();
        if (loud) toast("تم تحديث البيانات من الشيت", "good");
      })
      .catch(function () { paintWire("bad"); if (loud) toast("تعذّر الاتصال — حاولي لاحقًا", "bad"); });
  }

  $("enter").addEventListener("click", signIn);
  $("code").addEventListener("keydown", function (event) { if (event.key === "Enter") signIn(); });

  $("roster").addEventListener("click", function (event) {
    var row = event.target.closest ? event.target.closest(".row") : null;
    if (!row) return;
    var index = Number(row.getAttribute("data-i"));
    if (event.target.getAttribute("data-act") === "more") { openRowMenu(index); return; }
    var status = event.target.getAttribute("data-st");
    if (!status || S.marks[S.students[index]] === status) return;
    S.marks[S.students[index]] = status;
    S.dirty = true;
    persist();
    paintRow(index);
    paintDay();
    paintDock();
    paintWire();
  });

  $("btn-submit").addEventListener("click", function () {
    if (!S.students.length) { toast("لا يوجد طلاب لتسليمهم"); return; }
    var pending = pendingAttendance(S.teacherId, S.date);
    if (pending && !S.dirty) { toast("التسليم محفوظ، وسنرسله تلقائيًا عند توفر الإنترنت", "good"); scheduleSync(0); return; }
    if (S.submitted && S.syncedAttendanceId && !S.dirty) { toast("الحضور مُسلّم ومؤكد في الشيت", "good"); return; }
    queueAttendanceSnapshot();
    toast(navigator.onLine ? "تم حفظ التسليم على الجهاز — جارٍ إرساله" : "تم حفظ التسليم — سيُرسل عند عودة الإنترنت", "good");
  });

  $("btn-sync").addEventListener("click", function () {
    backoff = 0;
    if (!Q().length) { pull(true); return; }
    scheduleSync(0);
    toast(navigator.onLine ? "جارٍ إرسال البيانات المحفوظة…" : "البيانات محفوظة، لكن لا يوجد إنترنت");
  });

  $("btn-add").addEventListener("click", function () {
    $("i-add").value = "";
    open("v-add");
    setTimeout(function () { $("i-add").focus(); }, 120);
  });

  $("do-add").addEventListener("click", function () {
    var name = cleanName($("i-add").value);
    if (!name) { toast("اكتبي اسم الطالب"); return; }
    if (name.length > 120) { toast("اسم الطالب طويل جدًا", "bad"); return; }
    if (findStudent(name) !== -1) { toast("الاسم موجود مسبقًا"); return; }
    var wasSubmitted = S.submitted && !S.dirty;
    S.students.push(name);
    S.marks[name] = "حاضر";
    enqueue({ action: "add_student", studentName: name });
    shut("v-add");
    rosterChanged(wasSubmitted);
    toast("تمت إضافة " + name, "good");
  });

  $("i-add").addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("do-add").click();
  });

  var rowIdx = -1;
  function openRowMenu(index) {
    if (!Number.isInteger(index) || index < 0 || index >= S.students.length) return;
    rowIdx = index;
    $("row-h").textContent = S.students[index];
    open("v-row");
  }

  $("row-ren").addEventListener("click", function () {
    shut("v-row");
    $("i-ren").value = S.students[rowIdx];
    open("v-ren");
    setTimeout(function () { $("i-ren").focus(); }, 120);
  });

  $("do-ren").addEventListener("click", function () {
    var oldName = S.students[rowIdx];
    var newName = cleanName($("i-ren").value);
    if (!newName || newName === oldName) { shut("v-ren"); return; }
    var duplicateIndex = findStudent(newName);
    if (duplicateIndex !== -1 && duplicateIndex !== rowIdx) { toast("يوجد طالب آخر بهذا الاسم", "bad"); return; }
    var wasSubmitted = S.submitted && !S.dirty;
    S.students[rowIdx] = newName;
    S.marks[newName] = S.marks[oldName] || "حاضر";
    delete S.marks[oldName];
    enqueue({ action: "rename_student", oldName: oldName, newName: newName });
    shut("v-ren");
    rosterChanged(wasSubmitted);
    toast("تم تعديل الاسم", "good");
  });

  $("i-ren").addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("do-ren").click();
  });

  $("row-del").addEventListener("click", function () {
    var name = S.students[rowIdx];
    shut("v-row");
    if (!confirm("حذف «" + name + "» من قائمة الصف ومن تسجيل اليوم؟\nستبقى سجلات الأيام السابقة محفوظة.")) return;
    var wasSubmitted = S.submitted && !S.dirty;
    S.students.splice(rowIdx, 1);
    delete S.marks[name];
    enqueue({ action: "delete_student", studentName: name, date: S.date });
    rosterChanged(wasSubmitted);
    toast("حُذف " + name + " من القائمة وتسجيل اليوم");
  });

  $("btn-menu").addEventListener("click", function () { open("v-menu"); });
  $("m-pull").addEventListener("click", function () { shut("v-menu"); pull(true); });
  function signOut() {
    var teacherKey = dirKey(S.teacherId);
    var count = Q().filter(function (op) { return dirKey(op.teacherId) === teacherKey; }).length;
    var message = count ? "لديك " + count + " عملية محفوظة لم تُرسل بعد. ستبقى محفوظة بعد الخروج.\nمتابعة؟" : "تسجيل الخروج؟";
    if (!confirm(message)) return;

    clearTimeout(timer);
    shut("v-menu");
    S = baseState();
    try { localStorage.removeItem(K_STATE); } catch (_) {}

    var openVeils = document.querySelectorAll(".veil.open");
    for (var i = 0; i < openVeils.length; i++) openVeils[i].classList.remove("open");
    $("app").classList.remove("on");
    $("gate").hidden = false;
    $("code").value = "";
    $("gate-note").hidden = true;
    setTimeout(function () { $("code").focus(); }, 50);
  }
  $("m-out").addEventListener("click", signOut);

  $("btn-sum").addEventListener("click", function () {
    var counts = countMarks();
    $("s-p").textContent = counts.p;
    $("s-a").textContent = counts.a;
    $("s-e").textContent = counts.e;
    var html = "";
    var any = false;
    for (var i = 0; i < S.students.length; i++) {
      var name = S.students[i];
      var status = S.marks[name];
      if (status !== "غائب" && status !== "مأذون") continue;
      if (!any) { html += "<h3>غير الحاضرين</h3>"; any = true; }
      html += "<div><span>" + esc(name) + '</span><em class="' + (status === "غائب" ? "e-a" : "e-e") + '">' + status + "</em></div>";
    }
    if (!any) html = '<div class="allgood">جميع الطلاب حاضرون اليوم</div>';
    $("s-list").innerHTML = html;
    open("v-sum");
  });

  function open(id) { $(id).classList.add("open"); }
  function shut(id) { $(id).classList.remove("open"); }

  document.addEventListener("click", function (event) {
    if (event.target.hasAttribute && event.target.hasAttribute("data-close")) {
      var veil = event.target.closest(".veil");
      if (veil) veil.classList.remove("open");
    }
  });

  var veils = document.querySelectorAll(".veil");
  for (var vi = 0; vi < veils.length; vi++) {
    veils[vi].addEventListener("click", function (event) { if (event.target === this) this.classList.remove("open"); });
  }

  window.addEventListener("online", function () {
    backoff = 0;
    paintWire();
    if (Q().length) {
      toast("عاد الاتصال — جارٍ إرسال البيانات", "good");
      scheduleSync(150 + Math.floor(Math.random() * 1200));
    }
    else if (S.teacherId && !S.dirty) silentRefresh();
  });
  window.addEventListener("offline", function () { paintWire(); });
  window.addEventListener("focus", function () { if (Q().length) scheduleSync(100); });
  window.addEventListener("pageshow", function () { if (Q().length) scheduleSync(100); });
  window.addEventListener("pagehide", persist);
  window.addEventListener("storage", function (event) {
    if (event.key === K_QUEUE) { paintWire(); paintDock(); if (Q().length && navigator.onLine) scheduleSync(200); }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !S.teacherId) return;
    rollDay();
    paintAll();
    if (Q().length) scheduleSync(100);
    else if (!S.dirty) silentRefresh();
  });

  setInterval(function () {
    if (Q().length && navigator.onLine && !busy) scheduleSync(0);
  }, 12000);

  if (S.teacherId) { $("gate").hidden = true; openApp(); }
  else $("code").focus();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").then(function (registration) { registration.update(); }).catch(function () {});
    });
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "GHARS_SYNC_NOW" && Q().length) scheduleSync(0);
    });
  }
})();
