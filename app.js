(() => {
  "use strict";

  // رابط النشر الحالي محفوظ كما هو حتى لا يتغير رابط تسجيل الدخول.
  const GAS_URL = "https://script.google.com/macros/s/AKfycbwTezSxIIkrM9d9Y0OFqq2BynFp6yhstSzg3DgKzHlJDnOlCMhJo2f8Hd7x63l66HKSvg/exec";
  const AUTH_STORAGE_KEY = "ghars.auth.v2";
  const QUEUE_STORAGE_KEY = "ghars.offline.queue.v2";
  const ATTENDANCE_STORAGE_PREFIX = "ghars.attendance.v2:";
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
    editType: null,
    toastTimer: null
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
      "sync-status-text", "student-count", "add-student-button", "attendance-form",
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

    window.setInterval(() => {
      updateDateIfNeeded(false);
      if (navigator.onLine && state.auth && pendingCount() > 0) {
        void syncOfflineQueue();
      }
    }, 60000);
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
        void syncOfflineQueue();
      }
    });
    window.addEventListener("offline", updateConnectionUI);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        updateDateIfNeeded(false);
        updateConnectionUI();
        if (navigator.onLine && state.auth && pendingCount() > 0) {
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
      if (navigator.onLine) {
        try {
          const response = await apiLogin(teacherCode);
          const auth = authFromLoginResponse(response, codeHash);
          saveAuth(auth);
          openDashboard(auth, false);
          elements.teacherCode.value = "";
          void syncOfflineQueue();
          return;
        } catch (error) {
          if (!isNetworkFailure(error)) {
            throw error;
          }
        }
      }

      const cachedAuth = readCachedAuth();
      if (!cachedAuth || cachedAuth.idHash !== codeHash || !cachedAuth.sessionToken) {
        throw new ApiError(
          "لا توجد جلسة محفوظة لهذا الكود. يلزم الاتصال بالإنترنت مرة واحدة أولاً.",
          "NO_OFFLINE_SESSION"
        );
      }

      openDashboard(cachedAuth, true);
      enqueueOperation(
        { action: "record_login", occurredAt: new Date().toISOString() },
        "login"
      );
      elements.teacherCode.value = "";
      showToast("تم الدخول من النسخة المحفوظة. سيجري التحديث تلقائياً عند عودة الإنترنت.");
    } catch (error) {
      showFormError(elements.loginError, friendlyError(error, "تعذر تسجيل الدخول."));
    } finally {
      setButtonLoading(elements.loginButton, false);
    }
  }

  async function apiLogin(teacherCode) {
    let response;
    try {
      response = await fetch(GAS_URL, {
        method: "POST",
        cache: "no-store",
        redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ action: "login", teacherId: teacherCode })
      });
    } catch (error) {
      throw new TypeError("تعذر الوصول إلى الخادم.", { cause: error });
    }
    return parseApiResponse(response);
  }

  async function apiPost(payload) {
    if (!state.auth || !state.auth.sessionToken) {
      throw new ApiError("الجلسة غير متاحة. سجّلي الدخول من جديد.", "INVALID_SESSION");
    }

    let response;
    try {
      response = await fetch(GAS_URL, {
        method: "POST",
        redirect: "follow",
        cache: "no-store",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ ...payload, sessionToken: state.auth.sessionToken })
      });
    } catch (error) {
      throw new TypeError("تعذر الوصول إلى الخادم.", { cause: error });
    }
    return parseApiResponse(response);
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

    if (!data || data.status === "error" || data.success === false) {
      throw new ApiError(data && data.message ? data.message : "لم تُنفّذ العملية.", data && data.code);
    }
    return data;
  }

  function authFromLoginResponse(response, idHash) {
    if (!response.sessionToken || !response.teacherKey || !response.teacherName || !response.className) {
      throw new ApiError("بيانات تسجيل الدخول غير مكتملة.", "INVALID_LOGIN_RESPONSE");
    }
    return {
      idHash,
      teacherKey: String(response.teacherKey),
      sessionToken: String(response.sessionToken),
      teacherName: String(response.teacherName),
      className: String(response.className),
      students: normalizeStudentList(response.students),
      savedAt: new Date().toISOString()
    };
  }

  function readCachedAuth() {
    const cached = readJson(AUTH_STORAGE_KEY, null);
    if (!cached || typeof cached !== "object" || !cached.teacherKey || !cached.sessionToken) {
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
        saveAttendanceState();
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
      date: state.currentDate,
      status: state.statuses[studentName] || "حاضر"
    }));
    const payload = { action: "batch_attendance", records };
    setButtonLoading(elements.submitAttendanceButton, true);

    try {
      if (navigator.onLine) {
        try {
          await apiPost(payload);
          removeCompactedQueueItem(`attendance:${state.currentDate}`);
          showToast("تم تسليم حضور اليوم بنجاح.");
          updateSyncStatus();
          return;
        } catch (error) {
          if (!isNetworkFailure(error)) throw error;
        }
      }

      enqueueOperation(payload, `attendance:${state.currentDate}`);
      showToast("تم حفظ الحضور على الجهاز وسيُرسل تلقائياً عند عودة الإنترنت.");
    } catch (error) {
      handleOperationError(error, "تعذر تسليم الحضور.");
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

    setButtonLoading(elements.addSaveButton, true);
    const payload = { action: "add_student", studentName };
    try {
      if (navigator.onLine) {
        try {
          const response = await apiPost(payload);
          applyServerState(response);
          elements.addDialog.close();
          showToast("تمت إضافة الطالب.");
          return;
        } catch (error) {
          if (!isNetworkFailure(error)) throw error;
        }
      }

      state.auth.students.push(studentName);
      state.statuses[studentName] = "حاضر";
      saveAuth();
      saveAttendanceState();
      enqueueOperation(payload);
      renderStudents();
      elements.addDialog.close();
      showToast("أُضيف الطالب على الجهاز وسيُرسل تلقائياً عند عودة الإنترنت.");
    } catch (error) {
      showFormError(elements.addError, friendlyError(error, "تعذرت إضافة الطالب."));
    } finally {
      setButtonLoading(elements.addSaveButton, false);
    }
  }

  async function deleteStudent(studentName, button) {
    const confirmed = window.confirm(`هل تريدين حذف «${studentName}» من قائمة الصف؟`);
    if (!confirmed) return;
    button.disabled = true;
    const payload = { action: "delete_student", studentName };

    try {
      if (navigator.onLine) {
        try {
          const response = await apiPost(payload);
          applyServerState(response);
          showToast("تم حذف الطالب من قائمة الصف.");
          return;
        } catch (error) {
          if (!isNetworkFailure(error)) throw error;
        }
      }

      state.auth.students = state.auth.students.filter((name) => name !== studentName);
      delete state.statuses[studentName];
      saveAuth();
      saveAttendanceState();
      enqueueOperation(payload);
      renderStudents();
      showToast("تم الحذف على الجهاز وسيُرسل تلقائياً عند عودة الإنترنت.");
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
      const response = await apiPost({
        action: "update_teacher_info",
        updateType: state.editType,
        newValue
      });
      applyServerState(response);
      elements.editDialog.close();
      showToast("تم حفظ التعديل وتحديث الورقة والمجلد المرتبطين.");
    } catch (error) {
      showFormError(elements.editError, friendlyError(error, "تعذر حفظ التعديل."));
    } finally {
      setButtonLoading(elements.editSaveButton, false);
    }
  }

  function applyServerState(response) {
    if (!state.auth || !response) return;
    if (typeof response.teacherName === "string" && response.teacherName) {
      state.auth.teacherName = response.teacherName;
    }
    if (typeof response.className === "string" && response.className) {
      state.auth.className = response.className;
    }
    if (Array.isArray(response.students)) {
      state.auth.students = normalizeStudentList(response.students);
    }
    saveAuth();
    applyIdentityToUI();
    loadAttendanceState();
    renderStudents();
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
    if (!state.auth) return;
    let queue = readQueue();
    if (compactKey) {
      queue = queue.filter((item) => !(item.teacherKey === state.auth.teacherKey && item.compactKey === compactKey));
    }
    queue.push({
      id: createOperationId(),
      teacherKey: state.auth.teacherKey,
      compactKey,
      payload,
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: ""
    });
    writeQueue(queue);
    updateSyncStatus();
  }

  function removeCompactedQueueItem(compactKey) {
    if (!state.auth) return;
    const queue = readQueue().filter((item) => !(
      item.teacherKey === state.auth.teacherKey && item.compactKey === compactKey
    ));
    writeQueue(queue);
  }

  async function syncOfflineQueue() {
    if (!navigator.onLine || !state.auth || state.syncing) return;
    state.syncing = true;
    updateSyncStatus();
    let syncedCount = 0;

    try {
      while (navigator.onLine && state.auth) {
        const queue = readQueue();
        const item = queue.find((entry) => entry.teacherKey === state.auth.teacherKey);
        if (!item) break;

        try {
          const response = await apiPost(item.payload);
          const latestQueue = readQueue().filter((entry) => entry.id !== item.id);
          writeQueue(latestQueue);
          applyServerState(response);
          syncedCount++;
        } catch (error) {
          const latestQueue = readQueue();
          const failed = latestQueue.find((entry) => entry.id === item.id);
          if (failed) {
            failed.attempts = Number(failed.attempts || 0) + 1;
            failed.lastError = friendlyError(error, "تعذرت المزامنة.");
            writeQueue(latestQueue);
          }

          if (isSessionError(error)) {
            localStorage.removeItem(AUTH_STORAGE_KEY);
            showLoginView("انتهت الجلسة. سجّلي الدخول بالإنترنت لإرسال البيانات المحفوظة.");
          } else if (!isNetworkFailure(error)) {
            showToast(friendlyError(error, "تعذرت مزامنة إحدى العمليات، وبقيت محفوظة على الجهاز."), true);
          }
          break;
        }
      }

      if (syncedCount > 0 && state.auth && navigator.onLine && pendingCount() === 0) {
        try {
          const profile = await apiPost({ action: "get_profile" });
          applyServerState(profile);
        } catch (error) {
          if (isSessionError(error)) {
            localStorage.removeItem(AUTH_STORAGE_KEY);
            showLoginView("انتهت الجلسة. سجّلي الدخول من جديد.");
          }
        }
      }

      if (syncedCount > 0 && state.auth && pendingCount() === 0) {
        showToast("اكتملت مزامنة البيانات المحفوظة.");
      }
    } finally {
      state.syncing = false;
      updateSyncStatus();
    }
  }

  function readQueue() {
    const queue = readJson(QUEUE_STORAGE_KEY, []);
    return Array.isArray(queue) ? queue : [];
  }

  function writeQueue(queue) {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
    updateSyncStatus();
  }

  function pendingCount() {
    if (!state.auth) return 0;
    return readQueue().filter((item) => item.teacherKey === state.auth.teacherKey).length;
  }

  function updateSyncStatus() {
    if (!elements.syncStatus || !state.auth) return;
    const count = pendingCount();
    elements.syncStatus.classList.toggle("has-pending", count > 0 || !navigator.onLine || state.syncing);
    if (state.syncing) {
      elements.syncStatusText.textContent = "جاري الإرسال…";
    } else if (count > 0) {
      elements.syncStatusText.textContent = `${count} بانتظار المزامنة`;
    } else if (!navigator.onLine) {
      elements.syncStatusText.textContent = "محفوظ على الجهاز";
    } else {
      elements.syncStatusText.textContent = "متزامن";
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

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        // يبقى التطبيق عاملاً عبر الإنترنت حتى إن رفض المتصفح التسجيل.
      });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
