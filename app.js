(() => {
  "use strict";

  // رابط النشر الحالي محفوظ كما هو حتى لا يتغير رابط تسجيل الدخول.
  const GAS_URL = "https://script.google.com/macros/s/AKfycbwTezSxIIkrM9d9Y0OFqq2BynFp6yhstSzg3DgKzHlJDnOlCMhJo2f8Hd7x63l66HKSvg/exec";
  const AUTH_STORAGE_KEY = "ghars.auth.v2";
  const QUEUE_STORAGE_KEY = "ghars.offline.queue.v2";
  const ATTENDANCE_STORAGE_PREFIX = "ghars.attendance.v2:";
  const APP_VERSION = "2.4.0";
  const LOGIN_TIMEOUT_MS = 15000;
  const API_TIMEOUT_MS = 15000;
  const AUTO_SYNC_INTERVAL_MS = 20000;
  const STATUS_OPTIONS = [
    { value: "حاضر", className: "present" },
    { value: "مأذون", className: "excused" },
    { value: "غائب", className: "absent" }
  ];

  const state = {
    auth: null,
    statuses: {},
    currentDate: "",
    currentDateLabel: "",
    syncing: false,
    syncPromise: null,
    syncRetryTimer: null,
    editType: null,
    toastTimer: null,
    attendanceSaveTimer: null
  };

  const elements = {};

  class ApiError extends Error {
    constructor(message, code = "API_ERROR") {
      super(message);
      this.name = "ApiError";
      this.code = code;
    }
  }

  function cacheElements() {
    const ids = [
      "offline-banner", "login-view", "dashboard-view", "login-form", "teacher-code",
      "toggle-code", "login-button", "login-error", "login-connection-dot",
      "login-connection-text", "logout-button", "teacher-name", "class-name",
      "edit-teacher-button", "edit-class-button", "current-date-label", "sync-status",
      "sync-status-text", "manual-sync-button", "student-count", "add-student-button", "attendance-form",
      "student-list", "empty-state", "completed-count", "submit-attendance-button",
      "edit-dialog", "edit-form", "edit-dialog-title", "edit-input-label", "edit-input",
      "edit-error", "edit-save-button", "add-dialog", "add-form", "new-student-name",
      "add-error", "add-save-button", "toast-region"
    ];
    ids.forEach((id) => {
      elements[toCamelCase(id)] = document.getElementById(id);
    });
  }

  function toCamelCase(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  function init() {
    cacheElements();
    bindEvents();
    updateConnectionUI();
    updateDateIfNeeded(true);
    registerServiceWorker();
    document.documentElement.dataset.appVersion = APP_VERSION;

    window.setInterval(() => {
      updateDateIfNeeded(false);
      if (navigator.onLine && state.auth && sendablePendingCount() > 0) {
        void syncOfflineQueue();
      }
    }, AUTO_SYNC_INTERVAL_MS);
  }

  function bindEvents() {
    elements.loginForm.addEventListener("submit", handleLogin);
    elements.toggleCode.addEventListener("click", toggleCodeVisibility);
    elements.logoutButton.addEventListener("click", () => showLoginView());
    elements.attendanceForm.addEventListener("submit", handleAttendanceSubmit);
    elements.addStudentButton.addEventListener("click", openAddDialog);
    elements.addForm.addEventListener("submit", handleAddStudent);
    elements.editTeacherButton.addEventListener("click", () => openEditDialog("teacherName"));
    elements.editClassButton.addEventListener("click", () => openEditDialog("className"));
    elements.editForm.addEventListener("submit", handleEditSave);
    elements.manualSyncButton.addEventListener("click", () => void handleManualSync());

    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => {
        const dialog = document.getElementById(button.dataset.closeDialog);
        if (dialog && dialog.open) {
          dialog.close();
        }
      });
    });

    window.addEventListener("online", () => {
      updateConnectionUI();
      if (state.auth) {
        requestSyncSoon(150);
      }
    });
    window.addEventListener("offline", updateConnectionUI);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        flushAttendanceSave();
      } else {
        updateDateIfNeeded(false);
        updateConnectionUI();
        if (navigator.onLine && state.auth && sendablePendingCount() > 0) {
          void syncOfflineQueue();
        }
      }
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    hideFormError(elements.loginError);
    const teacherCode = elements.teacherCode.value.trim();
    if (!teacherCode) {
      showFormError(elements.loginError, "اكتبي كود المعلمة أولاً.");
      elements.teacherCode.focus();
      return;
    }

    setButtonLoading(elements.loginButton, true);
    try {
      const codeHash = await hashTeacherCode(teacherCode);
      const cachedAuth = readCachedAuth();
      if (cachedAuth && cachedAuth.idHash === codeHash) {
        cachedAuth.teacherId = teacherCode;
        cachedAuth.teacherKey = cachedAuth.teacherKey || teacherKeyFromHash(codeHash);
        saveAuth(cachedAuth);
        openDashboard(cachedAuth, !navigator.onLine);
        elements.teacherCode.value = "";

        if (navigator.onLine) {
          showToast("تم الدخول فوراً، وجارٍ تحديث بيانات الصف في الخلفية.");
          void refreshSessionFromCode(teacherCode, codeHash, cachedAuth.teacherKey);
        } else {
          showToast("تم الدخول من النسخة المحفوظة. سيجري الإرسال تلقائياً عند عودة الإنترنت.");
        }
        return;
      }

      if (!navigator.onLine) {
        throw new ApiError(
          "لا توجد جلسة محفوظة لهذا الكود. يلزم الاتصال بالإنترنت مرة واحدة أولاً.",
          "NO_OFFLINE_SESSION"
        );
      }

      const response = await apiLogin(teacherCode);
      const auth = authFromLoginResponse(response, codeHash, teacherCode);
      saveAuth(auth);
      openDashboard(auth, false);
      elements.teacherCode.value = "";
      void syncOfflineQueue();
    } catch (error) {
      showFormError(elements.loginError, friendlyError(error, "تعذر تسجيل الدخول."));
    } finally {
      setButtonLoading(elements.loginButton, false);
    }
  }

  async function refreshSessionFromCode(teacherCode, codeHash, activeTeacherKey) {
    try {
      const response = await apiLogin(teacherCode);
      let freshAuth = authFromLoginResponse(response, codeHash, teacherCode);
      if (!state.auth || state.auth.teacherKey !== activeTeacherKey) return;
      if (freshAuth.teacherKey !== activeTeacherKey) {
        throw new ApiError("تعذر مطابقة الحساب المحفوظ مع الخادم.", "INVALID_SESSION");
      }

      freshAuth = replayQueuedRoster(freshAuth);
      state.auth = freshAuth;
      saveAuth();
      applyIdentityToUI();
      loadAttendanceState();
      renderStudents();
      updateConnectionUI();
      void syncOfflineQueue();
    } catch (error) {
      if (!state.auth || state.auth.teacherKey !== activeTeacherKey) return;
      // عند ضعف الشبكة تبقى الجلسة المحلية والعمليات المعلّقة محفوظة، وتُعاد المحاولة تلقائياً.
      updateSyncStatus();
    }
  }

  function replayQueuedRoster(auth) {
    let students = normalizeStudentList(auth.students);
    readQueue()
      .filter((item) => item.teacherKey === auth.teacherKey)
      .forEach((item) => {
        const payload = item && item.payload ? item.payload : {};
        const studentName = String(payload.studentName || "").trim();
        if (payload.action === "add_student" && studentName && !students.includes(studentName)) {
          students.push(studentName);
        } else if (payload.action === "delete_student" && studentName) {
          students = students.filter((name) => name !== studentName);
        }
      });
    auth.students = students;
    return auth;
  }

  async function apiLogin(teacherCode) {
    const url = `${GAS_URL}?action=login&teacherId=${encodeURIComponent(teacherCode)}`;
    const response = await fetchWithTimeout(url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow"
    }, LOGIN_TIMEOUT_MS);
    return parseApiResponse(response);
  }

  async function apiPost(payload) {
    const response = await fetchWithTimeout(GAS_URL, {
      method: "POST",
      redirect: "follow",
      cache: "no-store",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(payload)
    }, API_TIMEOUT_MS);
    return parseApiResponse(response);
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    let timeoutId;
    const deadline = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        controller.abort();
        reject(new TypeError("انتهت مهلة الاتصال. بقيت العملية محفوظة وستُعاد تلقائياً."));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        fetch(url, { ...options, signal: controller.signal }),
        deadline
      ]);
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new TypeError("انتهت مهلة الاتصال. حاولي مرة أخرى.", { cause: error });
      }
      if (error instanceof TypeError && String(error.message || "").includes("مهلة الاتصال")) throw error;
      throw new TypeError("تعذر الوصول إلى الخادم. تحققي من الإنترنت وحاولي مجدداً.", { cause: error });
    } finally {
      window.clearTimeout(timeoutId);
      controller.abort();
    }
  }

  async function parseApiResponse(response) {
    if (!response.ok) {
      throw new TypeError("تعذر الوصول إلى الخدمة.");
    }

    let data;
    try {
      data = JSON.parse(await response.text());
    } catch (error) {
      throw new TypeError("وصل رد غير صالح من الخدمة.", { cause: error });
    }

    if (data && data.fastLogin && data.success === false) {
      throw new ApiError("كود المعلمة غير صحيح.", "INVALID_LOGIN");
    }
    if (!data || data.status === "error" || data.success === false) {
      throw new ApiError(data && data.message ? data.message : "لم تُنفّذ العملية.", data && data.code);
    }
    return data;
  }

  function authFromLoginResponse(response, idHash, teacherId) {
    if (!response.fastLogin || response.success !== true || !response.teacherName || !response.className) {
      throw new ApiError("بيانات تسجيل الدخول غير مكتملة.", "INVALID_LOGIN_RESPONSE");
    }
    return {
      idHash,
      teacherId: String(teacherId),
      teacherKey: teacherKeyFromHash(idHash),
      teacherName: String(response.teacherName),
      className: String(response.className),
      students: normalizeStudentList(response.students),
      savedAt: new Date().toISOString()
    };
  }

  function readCachedAuth() {
    const cached = readJson(AUTH_STORAGE_KEY, null);
    if (!cached || typeof cached !== "object" || !cached.idHash || !cached.teacherName || !cached.className) {
      return null;
    }
    cached.students = normalizeStudentList(cached.students);
    return cached;
  }

  function saveAuth(auth = state.auth) {
    if (!auth) {
      return;
    }
    auth.savedAt = new Date().toISOString();
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
  }

  function openDashboard(auth, offlineLogin) {
    state.auth = auth;
    migrateOriginalQueue();
    elements.loginView.hidden = true;
    elements.dashboardView.hidden = false;
    applyIdentityToUI();
    updateDateIfNeeded(true);
    loadAttendanceState();
    renderStudents();
    updateConnectionUI();
    updateSyncStatus();

    if (offlineLogin) {
      elements.syncStatus.classList.add("has-pending");
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function showLoginView(message = "") {
    state.auth = null;
    state.statuses = {};
    elements.dashboardView.hidden = true;
    elements.loginView.hidden = false;
    if (elements.editDialog.open) elements.editDialog.close();
    if (elements.addDialog.open) elements.addDialog.close();
    if (message) {
      showFormError(elements.loginError, message);
    } else {
      hideFormError(elements.loginError);
    }
    elements.teacherCode.focus();
    updateConnectionUI();
  }

  function applyIdentityToUI() {
    if (!state.auth) return;
    elements.teacherName.textContent = state.auth.teacherName;
    elements.className.textContent = state.auth.className;
  }

  function updateDateIfNeeded(force) {
    const dateInfo = getGazaDateInfo();
    if (!force && state.currentDate === dateInfo.iso) {
      return;
    }
    state.currentDate = dateInfo.iso;
    state.currentDateLabel = dateInfo.label;
    if (elements.currentDateLabel) {
      elements.currentDateLabel.textContent = dateInfo.label;
    }
    if (state.auth) {
      loadAttendanceState();
      renderStudents();
    }
  }

  function getGazaDateInfo(date = new Date()) {
    const dateParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Gaza",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = {};
    dateParts.forEach((part) => {
      if (part.type !== "literal") values[part.type] = part.value;
    });
    const iso = `${values.year}-${values.month}-${values.day}`;
    const label = new Intl.DateTimeFormat("ar-PS", {
      timeZone: "Asia/Gaza",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    }).format(date);
    return { iso, label };
  }

  function attendanceStorageKey() {
    return `${ATTENDANCE_STORAGE_PREFIX}${state.auth.teacherKey}:${state.currentDate}`;
  }

  function loadAttendanceState() {
    if (!state.auth || !state.currentDate) return;
    const stored = readJson(attendanceStorageKey(), {});
    const validNames = new Set(state.auth.students);
    state.statuses = {};
    Object.keys(stored || {}).forEach((name) => {
      if (validNames.has(name) && STATUS_OPTIONS.some((option) => option.value === stored[name])) {
        state.statuses[name] = stored[name];
      }
    });
    state.auth.students.forEach((name) => {
      if (!state.statuses[name]) state.statuses[name] = "حاضر";
    });
    saveAttendanceState();
  }

  function saveAttendanceState() {
    if (!state.auth || !state.currentDate) return;
    localStorage.setItem(attendanceStorageKey(), JSON.stringify(state.statuses));
  }

  function renderStudents() {
    if (!state.auth) return;
    const students = normalizeStudentList(state.auth.students);
    state.auth.students = students;
    elements.studentList.replaceChildren();

    const fragment = document.createDocumentFragment();
    students.forEach((studentName, index) => {
      if (!state.statuses[studentName]) state.statuses[studentName] = "حاضر";
      fragment.appendChild(createStudentCard(studentName, index));
    });
    elements.studentList.appendChild(fragment);
    elements.emptyState.hidden = students.length !== 0;
    elements.studentCount.textContent = `${students.length} طالب/طالبة`;
    elements.completedCount.textContent = `${students.length} من ${students.length}`;
    elements.submitAttendanceButton.disabled = students.length === 0;
    saveAttendanceState();
  }

  function createStudentCard(studentName, index) {
    const card = document.createElement("article");
    card.className = "student-card";

    const identity = document.createElement("div");
    identity.className = "student-identity";

    const number = document.createElement("span");
    number.className = "student-number";
    number.textContent = String(index + 1);

    const name = document.createElement("p");
    name.className = "student-name";
    name.textContent = studentName;

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-student";
    deleteButton.setAttribute("aria-label", `حذف ${studentName}`);
    deleteButton.appendChild(createTrashIcon());
    deleteButton.addEventListener("click", () => void deleteStudent(studentName, deleteButton));

    identity.append(number, name, deleteButton);

    const statusGroup = document.createElement("div");
    statusGroup.className = "status-group";
    statusGroup.setAttribute("role", "radiogroup");
    statusGroup.setAttribute("aria-label", `حالة ${studentName}`);

    STATUS_OPTIONS.forEach((option, optionIndex) => {
      const wrapper = document.createElement("div");
      wrapper.className = `status-option ${option.className}`;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `attendance-${index}`;
      input.id = `attendance-${index}-${optionIndex}`;
      input.value = option.value;
      input.checked = state.statuses[studentName] === option.value;
      input.addEventListener("change", () => {
        state.statuses[studentName] = option.value;
        scheduleAttendanceSave();
      });
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.textContent = option.value;
      wrapper.append(input, label);
      statusGroup.appendChild(wrapper);
    });

    card.append(identity, statusGroup);
    return card;
  }

  function createTrashIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", "M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5");
    svg.appendChild(path);
    return svg;
  }

  async function handleAttendanceSubmit(event) {
    event.preventDefault();
    if (!state.auth || state.auth.students.length === 0) return;
    updateDateIfNeeded(false);

    const records = state.auth.students.map((studentName) => ({
      studentName,
      className: state.auth.className,
      date: state.currentDate,
      status: state.statuses[studentName] || "حاضر",
      teacherName: state.auth.teacherName
    }));
    const payload = { action: "batch_attendance", records };
    flushAttendanceSave();
    const queuedItem = enqueueOperation(payload, `attendance:${state.currentDate}`);

    if (!navigator.onLine) {
      showToast("تم حفظ الحضور على الجهاز وسيُرسل تلقائياً عند عودة الإنترنت.");
      return;
    }

    setButtonLoading(elements.submitAttendanceButton, true);
    try {
      await syncOfflineQueue();
      if (!hasQueueItem(queuedItem.id)) {
        showToast("تم تسليم حضور اليوم إلى قاعدة البيانات.");
      } else {
        const pendingItem = getQueueItem(queuedItem.id);
        showToast(
          pendingItem && pendingItem.lastError
            ? pendingItem.lastError
            : "لم يصل تأكيد التسليم بعد. بقيت البيانات محفوظة لإعادة الإرسال.",
          true
        );
      }
    } catch (error) {
      showToast(friendlyError(error, "تعذر تأكيد التسليم. بقيت البيانات محفوظة للمزامنة."), true);
    } finally {
      setButtonLoading(elements.submitAttendanceButton, false);
    }
  }

  function openAddDialog() {
    hideFormError(elements.addError);
    elements.newStudentName.value = "";
    elements.addDialog.showModal();
    window.setTimeout(() => elements.newStudentName.focus(), 0);
  }

  async function handleAddStudent(event) {
    event.preventDefault();
    hideFormError(elements.addError);
    const studentName = elements.newStudentName.value.trim();
    if (!studentName) {
      showFormError(elements.addError, "اكتبي اسم الطالب.");
      return;
    }
    if (state.auth.students.includes(studentName)) {
      showFormError(elements.addError, "هذا الاسم موجود بالفعل في الصف.");
      return;
    }

    const payload = { action: "add_student", className: state.auth.className, studentName };
    try {
      state.auth.students.push(studentName);
      state.statuses[studentName] = "حاضر";
      saveAuth();
      saveAttendanceState();
      enqueueOperation(payload, `student:${studentName}`);
      renderStudents();
      elements.addDialog.close();
      showToast(navigator.onLine
        ? "تم حفظ الإضافة، وجارٍ إرسالها في الخلفية."
        : "أُضيف الطالب على الجهاز وسيُرسل تلقائياً عند عودة الإنترنت.");
      if (navigator.onLine) requestSyncSoon(0);
    } catch (error) {
      showFormError(elements.addError, friendlyError(error, "تعذرت إضافة الطالب."));
    }
  }

  async function deleteStudent(studentName, button) {
    const confirmed = window.confirm(`هل تريدين حذف «${studentName}» من قائمة الصف؟`);
    if (!confirmed) return;
    button.disabled = true;
    const payload = { action: "delete_student", className: state.auth.className, studentName };

    try {
      state.auth.students = state.auth.students.filter((name) => name !== studentName);
      delete state.statuses[studentName];
      saveAuth();
      saveAttendanceState();
      enqueueOperation(payload, `student:${studentName}`);
      renderStudents();
      showToast(navigator.onLine
        ? "تم حفظ الحذف، وجارٍ إرساله في الخلفية."
        : "تم الحذف على الجهاز وسيُرسل تلقائياً عند عودة الإنترنت.");
      if (navigator.onLine) requestSyncSoon(0);
    } catch (error) {
      button.disabled = false;
      handleOperationError(error, "تعذر حذف الطالب.");
    }
  }

  function openEditDialog(type) {
    if (!navigator.onLine) {
      showToast("تعديل اسم المعلمة أو الصف يحتاج إلى اتصال بالإنترنت.", true);
      return;
    }
    state.editType = type;
    hideFormError(elements.editError);
    const isTeacher = type === "teacherName";
    elements.editDialogTitle.textContent = isTeacher ? "تعديل اسم المعلمة" : "تعديل اسم الصف";
    elements.editInputLabel.textContent = isTeacher ? "اسم المعلمة الجديد" : "اسم الصف الجديد";
    elements.editInput.value = isTeacher ? state.auth.teacherName : state.auth.className;
    elements.editDialog.showModal();
    window.setTimeout(() => {
      elements.editInput.focus();
      elements.editInput.select();
    }, 0);
  }

  async function handleEditSave(event) {
    event.preventDefault();
    hideFormError(elements.editError);
    if (!navigator.onLine) {
      showFormError(elements.editError, "يلزم الاتصال بالإنترنت لحفظ هذا التعديل.");
      return;
    }
    const newValue = elements.editInput.value.trim();
    if (!newValue) {
      showFormError(elements.editError, "لا يمكن ترك القيمة فارغة.");
      return;
    }

    setButtonLoading(elements.editSaveButton, true);
    try {
      const queuedItem = enqueueOperation({
        action: "update_teacher_info",
        updateType: state.editType,
        oldValue: state.editType === "teacherName" ? state.auth.teacherName : state.auth.className,
        newValue,
        teacherId: state.auth.teacherId
      }, `edit:${state.editType}`);
      await syncOfflineQueue({ manual: true });
      if (!hasQueueItem(queuedItem.id)) {
        if (state.editType === "teacherName") state.auth.teacherName = newValue;
        else state.auth.className = newValue;
        saveAuth();
        applyIdentityToUI();
        elements.editDialog.close();
        showToast("تم حفظ التعديل في قاعدة البيانات.");
      } else {
        const pendingItem = getQueueItem(queuedItem.id);
        showFormError(
          elements.editError,
          pendingItem && pendingItem.lastError
            ? pendingItem.lastError
            : "لم يصل تأكيد الحفظ بعد. يمكنك المحاولة من زر المزامنة."
        );
      }
    } catch (error) {
      showFormError(elements.editError, friendlyError(error, "تعذر حفظ التعديل."));
    } finally {
      setButtonLoading(elements.editSaveButton, false);
    }
  }

  function applyServerState(response) {
    if (!state.auth || !response) return;
    let identityChanged = false;
    let rosterChanged = false;
    if (typeof response.teacherName === "string" && response.teacherName) {
      if (state.auth.teacherName !== response.teacherName) {
        state.auth.teacherName = response.teacherName;
        identityChanged = true;
      }
    }
    if (typeof response.className === "string" && response.className) {
      if (state.auth.className !== response.className) {
        state.auth.className = response.className;
        identityChanged = true;
      }
    }
    if (Array.isArray(response.students)) {
      const nextStudents = normalizeStudentList(response.students);
      if (!sameStringArray(state.auth.students, nextStudents)) {
        state.auth.students = nextStudents;
        rosterChanged = true;
      }
    }
    if (!identityChanged && !rosterChanged) {
      return;
    }
    saveAuth();
    if (identityChanged) applyIdentityToUI();
    if (rosterChanged) {
      loadAttendanceState();
      renderStudents();
    }
  }

  function sameStringArray(left, right) {
    if (!Array.isArray(left) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  function scheduleAttendanceSave() {
    window.clearTimeout(state.attendanceSaveTimer);
    state.attendanceSaveTimer = window.setTimeout(() => {
      state.attendanceSaveTimer = null;
      saveAttendanceState();
    }, 180);
  }

  function flushAttendanceSave() {
    if (!state.attendanceSaveTimer) return;
    window.clearTimeout(state.attendanceSaveTimer);
    state.attendanceSaveTimer = null;
    saveAttendanceState();
  }

  function normalizeStudentList(students) {
    if (!Array.isArray(students)) return [];
    const seen = new Set();
    const result = [];
    students.forEach((value) => {
      const name = String(value == null ? "" : value).trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    });
    return result;
  }

  function enqueueOperation(payload, compactKey = "") {
    if (!state.auth) return null;
    let queue = readQueue();
    if (compactKey) {
      queue = queue.filter((item) => !(item.teacherKey === state.auth.teacherKey && item.compactKey === compactKey));
    }
    const item = {
      id: createOperationId(),
      teacherKey: state.auth.teacherKey,
      compactKey,
      payload,
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: "",
      blocked: false
    };
    queue.push(item);
    writeQueue(queue);
    return item;
  }

  function getQueueItem(id) {
    return readQueue().find((item) => item.id === id) || null;
  }

  function hasQueueItem(id) {
    return Boolean(getQueueItem(id));
  }

  function requestSyncSoon(delayMs = 0) {
    if (!navigator.onLine || !state.auth) return;
    window.clearTimeout(state.syncRetryTimer);
    state.syncRetryTimer = window.setTimeout(() => {
      state.syncRetryTimer = null;
      void syncOfflineQueue();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function unblockTeacherQueue() {
    if (!state.auth) return;
    const queue = readQueue();
    let changed = false;
    queue.forEach((item) => {
      if (item.teacherKey === state.auth.teacherKey && item.blocked) {
        item.blocked = false;
        changed = true;
      }
    });
    if (changed) writeQueue(queue);
  }

  async function syncOfflineQueue(options = {}) {
    if (!navigator.onLine || !state.auth) {
      return { syncedCount: 0, retryDelay: 0 };
    }
    if (options.manual) unblockTeacherQueue();
    if (state.syncPromise) return state.syncPromise;

    state.syncing = true;
    updateSyncStatus();

    let outcome = null;
    const running = runQueueSync();
    state.syncPromise = running;
    try {
      outcome = await running;
      return outcome;
    } finally {
      state.syncing = false;
      state.syncPromise = null;
      updateSyncStatus();
      if (outcome && outcome.retryDelay > 0 && navigator.onLine && state.auth && sendablePendingCount() > 0) {
        requestSyncSoon(outcome.retryDelay);
      }
    }
  }

  async function runQueueSync() {
    let syncedCount = 0;
    let retryDelay = 0;

    while (navigator.onLine && state.auth) {
      const item = readQueue()
        .find((entry) => entry.teacherKey === state.auth.teacherKey && !entry.blocked);
      if (!item) break;

      try {
        const response = await apiPost(payloadForFastBackend(item.payload));
        writeQueue(readQueue().filter((entry) => entry.id !== item.id));
        applyServerState(response);
        syncedCount++;
      } catch (error) {
        const retryable = isNetworkFailure(error) || String(error && error.message || "").includes("مشغول");
        markBatchFailed([item], error, !retryable);
        if (retryable) {
          retryDelay = 5000;
        } else {
          showToast(friendlyError(error, "تعذرت المزامنة، وبقيت العمليات محفوظة على الجهاز."), true);
        }
        break;
      }
    }

    return { syncedCount, retryDelay };
  }

  function payloadForFastBackend(payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    if (source.action === "batch_attendance") {
      return {
        action: "batch_attendance",
        records: Array.isArray(source.records) ? source.records.map((record) => ({
          ...record,
          className: state.auth.className,
          teacherName: state.auth.teacherName
        })) : []
      };
    }
    if (source.action === "add_student" || source.action === "delete_student") {
      return { ...source, className: state.auth.className };
    }
    if (source.action === "update_teacher_info") {
      const oldValue = source.updateType === "teacherName"
        ? state.auth.teacherName
        : state.auth.className;
      return {
        ...source,
        teacherId: source.teacherId || state.auth.teacherId,
        oldValue: source.oldValue || oldValue
      };
    }
    return source;
  }

  function markBatchFailed(batch, error, blocked) {
    const ids = new Set(batch.map((item) => item.id));
    const queue = readQueue();
    queue.forEach((item) => {
      if (!ids.has(item.id)) return;
      item.attempts = Number(item.attempts || 0) + 1;
      item.lastError = friendlyError(error, "تعذرت المزامنة.");
      item.blocked = Boolean(blocked);
    });
    writeQueue(queue);
  }

  async function handleManualSync() {
    if (!state.auth) return;
    if (!navigator.onLine) {
      showToast("لا يوجد اتصال الآن. بياناتك محفوظة وستُرسل تلقائياً عند عودة الإنترنت.", true);
      return;
    }
    if (state.syncing) {
      showToast("المزامنة جارية بالفعل.");
      return;
    }
    if (pendingCount() === 0) {
      showToast("لا توجد عمليات مزامنة معلقة.");
      return;
    }

    try {
      await syncOfflineQueue({ manual: true });
      if (!state.auth) return;
      if (pendingCount() === 0) {
        showToast("اكتملت مزامنة جميع العمليات.");
      } else {
        showToast(pendingStatusText(pendingCount(), true), true);
      }
    } catch (error) {
      showToast(friendlyError(error, "تعذرت المزامنة اليدوية."), true);
    }
  }

  function readQueue() {
    const queue = readJson(QUEUE_STORAGE_KEY, []);
    if (!Array.isArray(queue)) return [];
    const cleaned = queue.filter((item) => item && item.payload && item.payload.action !== "record_login");
    if (cleaned.length !== queue.length) {
      localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(cleaned));
    }
    return cleaned;
  }

  function writeQueue(queue) {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
    updateSyncStatus();
  }

  function pendingCount() {
    if (!state.auth) return 0;
    return readQueue().filter((item) => item.teacherKey === state.auth.teacherKey).length;
  }

  function sendablePendingCount() {
    if (!state.auth) return 0;
    return readQueue().filter((item) => item.teacherKey === state.auth.teacherKey && !item.blocked).length;
  }

  function blockedPendingCount() {
    if (!state.auth) return 0;
    return readQueue().filter((item) => item.teacherKey === state.auth.teacherKey && item.blocked).length;
  }

  function pendingStatusText(count, needsRetry = false) {
    let text;
    if (count === 1) text = "عملية مزامنة معلقة";
    else if (count === 2) text = "عمليتا مزامنة معلقتان";
    else text = `${count} عمليات مزامنة معلقة`;
    return needsRetry ? `${text} — اضغطي «مزامنة الآن»` : text;
  }

  function updateSyncStatus() {
    if (!elements.syncStatus || !state.auth) return;
    const count = pendingCount();
    elements.syncStatus.classList.toggle("has-pending", count > 0 || !navigator.onLine || state.syncing);
    if (state.syncing) {
      elements.syncStatusText.textContent = count > 0
        ? `جاري الإرسال — ${pendingStatusText(count)}`
        : "جاري تأكيد المزامنة…";
    } else if (count > 0) {
      elements.syncStatusText.textContent = pendingStatusText(count, blockedPendingCount() > 0);
    } else if (!navigator.onLine) {
      elements.syncStatusText.textContent = "محفوظ على الجهاز";
    } else {
      elements.syncStatusText.textContent = "متزامن";
    }
    if (elements.manualSyncButton) {
      elements.manualSyncButton.disabled = state.syncing || !navigator.onLine;
      elements.manualSyncButton.classList.toggle("is-syncing", state.syncing);
    }
  }

  function updateConnectionUI() {
    const online = navigator.onLine;
    if (!elements.offlineBanner) return;
    elements.offlineBanner.hidden = online;
    elements.loginConnectionText.textContent = online ? "متصل بالإنترنت" : "وضع عدم الاتصال";
    elements.loginConnectionDot.classList.toggle("is-offline", !online);
    elements.editTeacherButton.disabled = !online;
    elements.editClassButton.disabled = !online;
    updateSyncStatus();
  }

  function toggleCodeVisibility() {
    const reveal = elements.teacherCode.type === "password";
    elements.teacherCode.type = reveal ? "text" : "password";
    elements.toggleCode.setAttribute("aria-label", reveal ? "إخفاء الكود" : "إظهار الكود");
  }

  function setButtonLoading(button, loading) {
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
    button.setAttribute("aria-busy", loading ? "true" : "false");
  }

  function showFormError(element, message) {
    element.textContent = message;
    element.hidden = false;
  }

  function hideFormError(element) {
    element.textContent = "";
    element.hidden = true;
  }

  function showToast(message, isError = false) {
    window.clearTimeout(state.toastTimer);
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.replaceChildren(toast);
    state.toastTimer = window.setTimeout(() => elements.toastRegion.replaceChildren(), 4200);
  }

  function handleOperationError(error, fallback) {
    if (isSessionError(error)) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      showLoginView("انتهت الجلسة. سجّلي الدخول مجدداً؛ بياناتك المحفوظة لن تُحذف.");
      return;
    }
    showToast(friendlyError(error, fallback), true);
  }

  function friendlyError(error, fallback) {
    return error && error.message ? error.message : fallback;
  }

  function isNetworkFailure(error) {
    return !navigator.onLine || (error instanceof TypeError && !(error instanceof ApiError));
  }

  function isSessionError(error) {
    return error instanceof ApiError && ["INVALID_SESSION", "SESSION_EXPIRED"].includes(error.code);
  }

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function createOperationId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function hashTeacherCode(value) {
    if (!crypto.subtle || !window.TextEncoder) {
      throw new Error("المتصفح قديم ولا يدعم تسجيل الدخول الآمن.");
    }
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function teacherKeyFromHash(hexHash) {
    const pairs = String(hexHash || "").match(/.{1,2}/g) || [];
    const binary = pairs.map((pair) => String.fromCharCode(Number.parseInt(pair, 16))).join("");
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function migrateOriginalQueue() {
    if (!state.auth) return;
    const original = readJson("ghars_offline_queue", []);
    if (!Array.isArray(original) || original.length === 0) return;

    const queue = readQueue();
    const remaining = [];
    original.forEach((payload) => {
      if (!payload || typeof payload !== "object") return;
      const payloadClass = payload.className || (
        Array.isArray(payload.records) && payload.records[0] ? payload.records[0].className : ""
      );
      const belongsToTeacher = payload.teacherId
        ? String(payload.teacherId) === String(state.auth.teacherId)
        : String(payloadClass || "") === String(state.auth.className);
      if (!belongsToTeacher) {
        remaining.push(payload);
        return;
      }
      queue.push({
        id: createOperationId(),
        teacherKey: state.auth.teacherKey,
        compactKey: "",
        payload,
        createdAt: new Date().toISOString(),
        attempts: 0,
        lastError: "",
        blocked: false
      });
    });
    if (remaining.length > 0) {
      localStorage.setItem("ghars_offline_queue", JSON.stringify(remaining));
    } else {
      localStorage.removeItem("ghars_offline_queue");
    }
    writeQueue(queue);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {
        // يبقى التطبيق عاملاً عبر الإنترنت حتى إن رفض المتصفح التسجيل.
      });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
