// auth.js — Shared authentication helpers (Group 29) — v2
// Same-origin by default (web + TWA). A native shell can set window.SC_API_BASE
// to the deployed server URL before this script loads.
// Where the server lives. A value saved on the device wins over the one built
// into the app, so a single APK can be pointed at the deployed server or at a
// laptop on the same network without rebuilding — which is what makes a local
// fallback possible if the internet fails during a demonstration.
function apiBase() {
    try {
        const override = localStorage.getItem('sc_api_base');
        if (override) return override.replace(/\/+$/, '');
    } catch (e) { /* storage unavailable — fall through */ }
    return (typeof window !== 'undefined' && window.SC_API_BASE) || '';
}
const API = apiBase();

// Build an absolute API link (needed when the frontend is hosted separately,
// e.g. static frontend on Netlify + Express server on Render).
function apiUrl(path) { return API + path; }

function getToken()  { return localStorage.getItem('sc_token'); }
function getUser()   { return JSON.parse(localStorage.getItem('sc_user') || 'null'); }
function saveAuth(token, user) {
    localStorage.setItem('sc_token', token);
    localStorage.setItem('sc_user', JSON.stringify(user));
}
function clearAuth() {
    localStorage.removeItem('sc_token');
    localStorage.removeItem('sc_user');
}

function requireAuth(...allowedRoles) {
    const token = getToken(), user = getUser();
    if (!token || !user) { window.location.href = '/login.html'; return null; }
    if (allowedRoles.length && !allowedRoles.includes(user.role)) {
        window.location.href = '/login.html'; return null;
    }
    return user;
}

async function apiFetch(endpoint, options = {}) {
    const token = getToken();
    try {
        const res = await fetch(API + endpoint, {
            ...options,
            headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}`, ...(options.headers||{}) },
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        if (res.status === 401) { clearAuth(); window.location.href = '/login.html'; return null; }
        return res.json();
    } catch {
        return { error: 'Could not reach the server. Check your connection and try again.' };
    }
}

// multipart upload (assignment briefs, lesson slides, submissions)
async function apiUpload(endpoint, formData) {
    const res = await fetch(API + endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken()}` },
        body: formData
    });
    if (res.status === 401) { clearAuth(); window.location.href = '/login.html'; return null; }
    return res.json();
}

function populateHeader() {
    const user = getUser();
    if (!user) return;
    const nameEl = document.getElementById('userName');
    const metaEl = document.getElementById('userMeta');
    const avatarEl = document.getElementById('userAvatar');
    if (nameEl)   nameEl.textContent = user.name + ' ' + user.surname;
    if (metaEl)   metaEl.textContent = user.student_number || user.employee_id ||
                     user.schoolName || (user.role==='admin' ? 'Social Coding HQ' : '');
    if (avatarEl) avatarEl.textContent = user.name[0] + user.surname[0];
}

function logout() {
    if (confirm('Log out of Social Coding LMS?')) { clearAuth(); window.location.href = '/login.html'; }
}

function initTheme() {
    const saved = localStorage.getItem('scTheme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = saved === 'dark' ? 'Dark' : 'Light';
}
function toggleTheme() {
    const html = document.documentElement;
    const light = html.getAttribute('data-theme') !== 'dark';
    html.setAttribute('data-theme', light ? 'dark' : 'light');
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = light ? 'Dark' : 'Light';
    localStorage.setItem('scTheme', light ? 'dark' : 'light');
}

function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    if (!t) return;
    document.getElementById('toastMsg').textContent = msg;
    t.classList.remove('toast-error','toast-warn');
    if (type === 'error') t.classList.add('toast-error');
    if (type === 'warn')  t.classList.add('toast-warn');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3500);
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }



// ── Change your own password ────────────────────────────────────────────────
// Accounts are issued with a temporary password, so every user needs a way to
// replace it. The modal is created on demand, so no page needs extra markup.
function openPasswordModal() {
    let m = document.getElementById('pwModal');
    if (!m) {
        m = document.createElement('div');
        m.className = 'modal';
        m.id = 'pwModal';
        m.innerHTML = `
            <div class="modal-card">
                <div class="modal-title">Change your password</div>
                <div class="modal-sub">Choose something only you know, at least 6 characters.</div>
                <div class="form-group"><label class="form-label">Current password</label>
                    <input type="password" class="form-input" id="pwCurrent" autocomplete="current-password"></div>
                <div class="form-group"><label class="form-label">New password</label>
                    <input type="password" class="form-input" id="pwNew" autocomplete="new-password"></div>
                <div class="form-group"><label class="form-label">Confirm new password</label>
                    <input type="password" class="form-input" id="pwConfirm" autocomplete="new-password"></div>
                <div class="modal-actions">
                    <button class="btn-cancel" onclick="closeModal('pwModal')">Cancel</button>
                    <button class="btn btn-primary" onclick="submitPassword()">Change password</button>
                </div>
            </div>`;
        document.body.appendChild(m);
        m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
    }
    ['pwCurrent','pwNew','pwConfirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    m.classList.add('open');
}

async function submitPassword() {
    const current = document.getElementById('pwCurrent').value;
    const next = document.getElementById('pwNew').value;
    const confirmed = document.getElementById('pwConfirm').value;
    if (!current || !next) { showToast('Fill in both passwords.', 'warn'); return; }
    if (next !== confirmed) { showToast('The new passwords do not match.', 'error'); return; }
    const res = await apiFetch('/api/auth/password', { method:'POST', body:{ current_password: current, new_password: next } });
    if (res?.error) { showToast(res.error, 'error'); return; }
    closeModal('pwModal');
    showToast('Password changed.');
}


// ── Live refresh ────────────────────────────────────────────────────────────
// Screens reload their own data on a timer, so a demonstration never requires
// a manual refresh. Three rules keep it unobtrusive:
//   1. It pauses while the tab is hidden, so a laptop left open does not poll.
//   2. It skips a cycle if a dialog is open or a field has focus, so it can
//      never wipe something half-typed.
//   3. It refreshes immediately when the tab is brought back into view.
function startLiveRefresh(reload, seconds = 30) {
    let timer = null, busy = false;

    const blocked = () => {
        if (document.querySelector('.modal.open')) return true;
        const el = document.activeElement;
        return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    };

    async function cycle() {
        if (busy || document.hidden || blocked()) return;
        busy = true;
        const dot = document.getElementById('liveDot');
        if (dot) dot.classList.add('updating');
        try { await reload(); markRefreshed(); }
        catch (e) { /* a failed refresh should never break the page */ }
        finally {
            busy = false;
            if (dot) dot.classList.remove('updating');
        }
    }

    const start = () => { stop(); timer = setInterval(cycle, Math.max(5, seconds) * 1000); };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop();
        else { cycle(); start(); }
    });
    start();
    return { stop, refreshNow: cycle };
}

function markRefreshed() {
    const el = document.getElementById('liveTime');
    if (el) el.textContent = new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Drop the indicator into a page header without each page needing markup
function liveIndicator() {
    return '<span class="live-dot" id="liveDot"><i></i>live · <span id="liveTime">—</span></span>';
}


// ── Change the server this app talks to ─────────────────────────────────────
// Used for the offline fallback: if the deployed server is unreachable, point
// the installed app at a laptop running the same system on the local network.
function setServerAddress() {
    const current = (function () {
        try { return localStorage.getItem('sc_api_base') || ''; } catch (e) { return ''; }
    })();
    const entered = prompt(
        'Server address for this device.\n\n' +
        'Leave empty to use the built-in address' +
        (window.SC_API_BASE ? ' (' + window.SC_API_BASE + ')' : '') + '.\n' +
        'For a laptop on the same network, use the address it prints next to "Mobile:".',
        current);
    if (entered === null) return;
    const value = entered.trim().replace(/\/+$/, '');
    try {
        if (value) localStorage.setItem('sc_api_base', value);
        else localStorage.removeItem('sc_api_base');
    } catch (e) {
        alert('This device would not let the app save the address.');
        return;
    }
    alert(value ? 'Now using ' + value : 'Back to the built-in address.');
    window.location.reload();
}
