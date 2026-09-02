// ==========================================
// محرك واجهة الحضور والغياب - غرس (نسخة بدون تقطيع)
// ==========================================

// تم وضع الرابط الخاص بك هنا بنجاح
const GAS_URL = "https://script.google.com/macros/s/AKfycbwTezSxIIkrM9d9Y0OFqq2BynFp6yhstSzg3DgKzHlJDnOlCMhJo2f8Hd7x63l66HKSvg/exec";

let state = {
    teacherId: null,
    teacherName: "",
    className: "",
    students: []
};

const DOM = {
    loginView: document.getElementById('login-view'),
    dashView: document.getElementById('dashboard-view'),
    loginForm: document.getElementById('login-form'),
    teacherCode: document.getElementById('teacher-code'),
    loginBtn: document.getElementById('login-button'),
    loginError: document.getElementById('login-error'),
    teacherName: document.getElementById('teacher-name'),
    className: document.getElementById('class-name'),
    studentList: document.getElementById('student-list'),
    studentCount: document.getElementById('student-count'),
    dateLabel: document.getElementById('current-date-label'),
    emptyState: document.getElementById('empty-state'),
    toastRegion: document.getElementById('toast-region'),
    syncStatusText: document.getElementById('sync-status-text')
};

// تهيئة التاريخ
const now = new Date();
const formattedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
if(DOM.dateLabel) DOM.dateLabel.innerText = formattedDate;

// فحص الجلسة عند بدء التطبيق
window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('ghars_auth');
    if (saved) {
        state = JSON.parse(saved);
        showDashboard();
    }
});

// إظهار وإخفاء كلمة المرور
document.getElementById('toggle-code')?.addEventListener('click', () => {
    DOM.teacherCode.type = DOM.teacherCode.type === 'password' ? 'text' : 'password';
});

// تسجيل الدخول السريع
DOM.loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = DOM.teacherCode.value.trim();
    if (!code) return;

    DOM.loginBtn.classList.add('loading');
    
    // الدخول من الذاكرة إذا كان محفوظاً للسرعة القصوى
    const saved = JSON.parse(localStorage.getItem('ghars_auth') || '{}');
    if (saved.teacherId === code) {
        state = saved;
        showDashboard();
        DOM.loginBtn.classList.remove('loading');
        return;
    }

    if (!navigator.onLine) {
        showToast('لا يوجد اتصال بالإنترنت للتحقق من الكود لأول مرة.', 'error');
        DOM.loginBtn.classList.remove('loading');
        return;
    }

    try {
        const res = await fetch(`${GAS_URL}?action=login&teacherId=${encodeURIComponent(code)}`);
        const data = await res.json();
        
        if (data.success) {
            state = {
                teacherId: code,
                teacherName: data.teacherName,
                className: data.className,
                students: data.students || []
            };
            localStorage.setItem('ghars_auth', JSON.stringify(state));
            showDashboard();
        } else {
            DOM.loginError.innerText = "الكود غير صحيح";
            DOM.loginError.hidden = false;
        }
    } catch (err) {
        DOM.loginError.innerText = "حدث خطأ في الاتصال بالسيرفر.";
        DOM.loginError.hidden = false;
    } finally {
        DOM.loginBtn.classList.remove('loading');
    }
});

function showDashboard() {
    DOM.teacherName.innerText = state.teacherName;
    DOM.className.innerText = state.className;
    if(DOM.loginView) DOM.loginView.hidden = true;
    if(DOM.dashView) DOM.dashView.hidden = false;
    renderStudentsFast();
}

// سرعة الرسم (البناء ككتلة واحدة لمنع الـ Lag)
function renderStudentsFast() {
    if (state.students.length === 0) {
        DOM.studentList.innerHTML = '';
        DOM.emptyState.hidden = false;
        DOM.studentCount.innerText = '0 طالب';
        return;
    }

    DOM.emptyState.hidden = true;
    DOM.studentCount.innerText = `${state.students.length} طالب/ة`;

    let html = '';
    state.students.forEach((student, index) => {
        html += `
        <div class="student-card" style="padding: 12px; margin-bottom: 8px; border-radius: 8px; border: 1px solid #e2e8f0; background: #fff; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; color: #1e293b;">${index + 1}. ${student}</span>
            <div style="display: flex; gap: 8px;">
                <label style="cursor: pointer; font-size: 14px;"><input type="radio" name="att_${index}" value="حاضر" checked> حاضر</label>
                <label style="cursor: pointer; font-size: 14px;"><input type="radio" name="att_${index}" value="مأذون"> مأذون</label>
                <label style="cursor: pointer; font-size: 14px;"><input type="radio" name="att_${index}" value="غائب"> غائب</label>
            </div>
        </div>`;
    });
    
    // حقن البيانات في الشاشة مرة واحدة فقط
    DOM.studentList.innerHTML = html;
}

// إرسال الحضور
document.getElementById('attendance-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.students.length === 0) return;

    const btn = document.getElementById('submit-attendance-button');
    btn.classList.add('loading');

    let records = [];
    state.students.forEach((student, i) => {
        const radios = document.getElementsByName(`att_${i}`);
        let status = 'حاضر';
        for (let r of radios) { if (r.checked) status = r.value; }
        
        records.push({
            studentName: student,
            className: state.className,
            date: formattedDate,
            status: status,
            teacherName: state.teacherName
        });
    });

    const payload = { action: 'batch_attendance', records: records };

    if (navigator.onLine) {
        try {
            await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(payload) });
            showToast('تم حفظ الحضور بنجاح!', 'success');
        } catch (err) {
            queueAction(payload);
            showToast('تم الحفظ في الهاتف، سيتم الإرسال عند توفر إنترنت.', 'warning');
        }
    } else {
        queueAction(payload);
        showToast('أنت غير متصل. تم الحفظ في الهاتف.', 'warning');
    }
    btn.classList.remove('loading');
});

// التعامل مع النوافذ المنبثقة (Dialogs)
document.querySelectorAll('[data-close-dialog]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById(btn.getAttribute('data-close-dialog')).close();
    });
});

let currentEditType = '';
document.getElementById('edit-teacher-button')?.addEventListener('click', () => {
    currentEditType = 'teacherName';
    document.getElementById('edit-dialog-title').innerText = 'تعديل المعلمة';
    document.getElementById('edit-input').value = state.teacherName;
    document.getElementById('edit-dialog').showModal();
});

document.getElementById('edit-class-button')?.addEventListener('click', () => {
    currentEditType = 'className';
    document.getElementById('edit-dialog-title').innerText = 'تعديل الصف';
    document.getElementById('edit-input').value = state.className;
    document.getElementById('edit-dialog').showModal();
});

// إرسال التعديل مع الاسم القديم (يمنع تكرار الأوراق)
document.getElementById('edit-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newVal = document.getElementById('edit-input').value.trim();
    if (!newVal) return;

    const oldVal = currentEditType === 'className' ? state.className : state.teacherName;
    const payload = { 
        action: 'update_teacher_info', 
        updateType: currentEditType,
        teacherId: state.teacherId,
        newValue: newVal,
        oldValue: oldVal // التعديل الحرج هنا لحماية الشيتات
    };

    if (currentEditType === 'className') state.className = newVal;
    else state.teacherName = newVal;
    
    localStorage.setItem('ghars_auth', JSON.stringify(state));
    showDashboard();
    document.getElementById('edit-dialog').close();

    if (navigator.onLine) {
        try {
            await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(payload) });
            showToast('تم التحديث بنجاح', 'success');
        } catch (err) { queueAction(payload); }
    } else {
        queueAction(payload);
    }
});

document.getElementById('logout-button')?.addEventListener('click', () => {
    localStorage.removeItem('ghars_auth');
    location.reload();
});

function queueAction(action) {
    let q = JSON.parse(localStorage.getItem('ghars_q') || '[]');
    q.push(action);
    localStorage.setItem('ghars_q', JSON.stringify(q));
    if(DOM.syncStatusText) DOM.syncStatusText.innerText = "يوجد بيانات معلقة";
}

function showToast(msg, type) {
    if(!DOM.toastRegion) return;
    DOM.toastRegion.innerHTML = `<div style="background: ${type==='success'?'#0f5132':'#856404'}; color: #fff; padding: 10px 20px; border-radius: 8px; margin-bottom: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">${msg}</div>`;
    setTimeout(() => DOM.toastRegion.innerHTML = '', 4000);
}
