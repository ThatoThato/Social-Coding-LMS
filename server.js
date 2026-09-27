// server.js — Social Coding LMS Backend (Group 29) — v2
// Run: node server.js   →   http://localhost:3000

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { getDb, run, all, get, reseed } = require('./db');

const app    = express();
const PORT   = process.env.PORT || 3000;
// A deployed server must have its own secret. The fallback exists only so the
// local demo runs without setup; in cloud mode the server refuses to start without one.
if ((process.env.DB_MODE || 'local') === 'turso' && !process.env.JWT_SECRET) {
    console.error('JWT_SECRET must be set when DB_MODE=turso. Refusing to start.');
    process.exit(1);
}
const SECRET = process.env.JWT_SECRET || 'socialcoding_group29_local_only';
const MARKING_SLA_DAYS = 7;

// South Africa is UTC+2: using UTC dates would flip deadlines two hours late
// (a submission at 00:30 SAST the day after a deadline would count as on time).
function todaySAST() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
}

// ── File uploads ─────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')),
});
const upload = multer({
    storage, limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = ['.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx','.txt','.md','.png','.jpg','.jpeg','.gif','.mp4','.zip','.py','.html','.css','.js']
            .includes(path.extname(file.originalname).toLowerCase());
        ok ? cb(null, true) : cb(new Error('File type not allowed'));
    }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
// Pages, styles and scripts must always be revalidated, so a change is never
// hidden behind a cached copy — during a demonstration there is no opportunity
// to clear a browser cache. Uploaded files may still be cached normally.
app.use(express.static(path.join(__dirname, 'frontend'), {
    etag: true,
    setHeaders: (res, filePath) => {
        if (/\.(html|css|js|json)$/i.test(filePath))
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        if (/\.html$/i.test(filePath)) {
            res.setHeader('Pragma', 'no-cache');     // for older caches and proxies
            res.setHeader('Expires', '0');
        }
    }
}));
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'login.html')));

// ── Auth ─────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
    const header = req.headers['authorization'];
    const token  = req.query.token || (header ? header.split(' ')[1] : null);
    if (!token) return res.status(401).json({ error: 'No token' });
    try { req.user = jwt.verify(token, SECRET); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
}
const role = (...roles) => (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Access denied' });

// Simple in-memory rate limit on login. LOGIN_MAX failures from one address puts
// that address on a short cooldown, which stops password guessing without
// needing another dependency.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000, LOGIN_MAX = 8;
function loginBlocked(key) {
    const rec = loginAttempts.get(key);
    if (!rec) return false;
    if (Date.now() - rec.first > LOGIN_WINDOW_MS) { loginAttempts.delete(key); return false; }
    return rec.count >= LOGIN_MAX;
}
function noteFailure(key) {
    const rec = loginAttempts.get(key);
    if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) loginAttempts.set(key, { count: 1, first: Date.now() });
    else rec.count++;
}

// Login with STUDENT NUMBER (students) or EMPLOYEE ID (staff)
app.post('/api/auth/login', async (req, res) => {
    try {
        await getDb();
        const { login_id, password } = req.body;
        if (!login_id || !password) return res.status(400).json({ error: 'Login ID and password required' });
        const key = req.ip || 'unknown';
        if (loginBlocked(key))
            return res.status(429).json({ error: 'Too many failed attempts. Wait a few minutes and try again.' });

        const user = await get(
            `SELECT * FROM users WHERE student_number=? OR employee_id=? OR email=?`,
            [login_id.trim(), login_id.trim().toUpperCase(), login_id.trim().toLowerCase()]);
        if (!user || !bcrypt.compareSync(password, user.password)) {
            noteFailure(key);
            return res.status(401).json({ error: 'Invalid login ID or password' });
        }
        loginAttempts.delete(key);

        let schoolName = null;
        if (user.school_id) {
            const s = await get(`SELECT name FROM schools WHERE id=?`, [user.school_id]);
            schoolName = s?.name || null;
        }
        const payload = { id:Number(user.id), name:user.name, surname:user.surname, role:user.role,
                          school_id:Number(user.school_id)||null };
        // 30-day tokens: facilitators sign in on shared school devices infrequently,
        // so a long session avoids repeated logins during a programme cycle
        const token = jwt.sign(payload, SECRET, { expiresIn: '30d' });
        res.json({ token, user: { ...payload, schoolName,
            student_number: user.student_number, employee_id: user.employee_id } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Change your own password. Accounts are created with a temporary one, so
// every user needs a way to replace it.
app.post('/api/auth/password', auth, async (req, res) => {
    try {
        await getDb();
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password)
            return res.status(400).json({ error: 'Current and new password are both required' });
        if (String(new_password).length < 6)
            return res.status(400).json({ error: 'The new password must be at least 6 characters' });
        const user = await get(`SELECT password FROM users WHERE id=?`, [req.user.id]);
        if (!user || !bcrypt.compareSync(current_password, user.password))
            return res.status(401).json({ error: 'Your current password is not correct' });
        await run(`UPDATE users SET password=? WHERE id=?`, [bcrypt.hashSync(new_password, 10), req.user.id]);
        res.json({ success: true, message: 'Password changed.' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  CURRICULUM: modules → lessons → materials
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/modules', auth, async (req, res) => {
    try {
        await getDb();
        // Learners and facilitators only see modules allocated to their school.
        const modules = req.user.role === 'admin'
            ? await all(`SELECT * FROM modules ORDER BY code`)
            : await all(`
                SELECT m.* FROM modules m
                JOIN module_schools ms ON ms.module_id = m.id
                WHERE ms.school_id = ? AND ms.active = 1
                ORDER BY m.code`, [req.user.school_id]);
        for (const m of modules) {
            m.lessons = await all(`SELECT * FROM lessons WHERE module_id=? ORDER BY lesson_order`, [m.id]);
            for (const l of m.lessons)
                l.materials = await all(
                    `SELECT mat.*, u.name || ' ' || u.surname AS uploaded_by_name
                     FROM materials mat JOIN users u ON u.id=mat.uploaded_by
                     WHERE mat.lesson_id=? ORDER BY mat.created_at`, [l.id]);
            m.assignment_count = Number((await get(
                `SELECT COUNT(*) c FROM assignments WHERE module_id=?`, [m.id]))?.c || 0);
        }
        res.json(modules);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Curriculum is owned by head office. Facilitators are trained, not qualified
// to design curriculum, and ten schools must run the same programme.
app.post('/api/modules', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { code, title, description } = req.body;
        if (!code || !title) return res.status(400).json({ error: 'Code and title required' });
        await run(`INSERT INTO modules (code,title,description) VALUES (?,?,?)`, [code.toUpperCase(), title, description||'']);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: 'Module code already exists' }); }
});

app.post('/api/modules/:id/lessons', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'Lesson title required' });
        const max = await get(`SELECT COALESCE(MAX(lesson_order),0) m FROM lessons WHERE module_id=?`, [req.params.id]);
        await run(`INSERT INTO lessons (module_id,title,lesson_order) VALUES (?,?,?)`,
            [req.params.id, title, Number(max.m)+1]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Upload slides/documents to a lesson — THE "where is the uploading of slides" endpoint
// Every school runs the same curriculum, so the material itself is uploaded
// once by head office rather than separately at each school.
app.post('/api/lessons/:id/materials', auth, role('admin'), upload.single('file'), async (req, res) => {
    try {
        await getDb();
        const { title, kind, url } = req.body;
        if (!title || !kind) return res.status(400).json({ error: 'Title and kind required' });
        if (!req.file && !url)  return res.status(400).json({ error: 'Attach a file or provide a link' });
        await run(`INSERT INTO materials (lesson_id,title,kind,file_name,url,file_size_kb,uploaded_by) VALUES (?,?,?,?,?,?,?)`,
            [req.params.id, title, kind, req.file?.filename || null, url || null,
             req.file ? Math.round(req.file.size/1024) : null, req.user.id]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/materials/:id/download', auth, async (req, res) => {
    try {
        await getDb();
        const m = await get(`SELECT * FROM materials WHERE id=?`, [req.params.id]);
        if (!m) return res.status(404).json({ error: 'Not found' });
        if (m.file_name) return res.download(path.join(UPLOADS_DIR, m.file_name));
        if (m.url) return res.redirect(m.url);
        res.status(404).json({ error: 'No file or link' });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ASSIGNMENT LIFECYCLE
//  scheduled → open → late_window → closed/marking → returned
// ═════════════════════════════════════════════════════════════════════════════
function lifecycleState(a, today) {
    if (!a.published) return 'draft';
    if (today <  a.open_date)  return 'scheduled';
    if (today <= a.due_date)   return 'open';
    if (today <= a.close_date) return 'late_window';
    return 'closed';
}
function daysBetween(fromISO, toISO) {
    return Math.round((new Date(toISO) - new Date(fromISO)) / 86400000);
}

app.get('/api/assignments', auth, async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const schoolFilter = req.user.role === 'admin' ? '' : 'WHERE a.school_id=?';
        const params = req.user.role === 'admin' ? [] : [req.user.school_id];

        const assignments = await all(`
            SELECT a.*, u.name || ' ' || u.surname AS teacher_name,
                   mo.code AS module_code, mo.title AS module_title,
                   (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id=a.id) AS submission_count,
                   (SELECT COUNT(*) FROM submissions s JOIN marks mk ON mk.submission_id=s.id
                     WHERE s.assignment_id=a.id) AS graded_count
            FROM assignments a
            JOIN users u ON u.id=a.facilitator_id
            LEFT JOIN modules mo ON mo.id=a.module_id
            ${schoolFilter} ORDER BY a.due_date DESC`, params);

        for (const a of assignments) {
            a.submission_count = Number(a.submission_count);
            a.graded_count     = Number(a.graded_count);
            a.lifecycle        = lifecycleState(a, today);
            a.rubric = await all(`SELECT id, label, descriptor, max_points, criterion_order
                                  FROM rubric_criteria WHERE assignment_id=? ORDER BY criterion_order`, [a.id]);
            a.days_to_due      = daysBetween(today, a.due_date);
            // Marking SLA: clock starts at due_date, facilitator has 7 days
            a.marking_days_left = daysBetween(today, a.marking_due_date);
            a.marking_complete  = a.submission_count > 0 && a.graded_count >= a.submission_count;
            if (a.marking_complete && a.lifecycle === 'closed') a.lifecycle = 'returned';

            if (req.user.role === 'student') {
                const sub = await get(`
                    SELECT s.id, s.is_late, s.submitted_at, s.file_name, m.score, m.feedback
                    FROM submissions s LEFT JOIN marks m ON m.submission_id=s.id
                    WHERE s.assignment_id=? AND s.student_id=?`, [a.id, req.user.id]);
                a.submission = sub || null;
                a.status = !sub ? 'pending' : sub.score != null ? 'graded' : 'submitted';
            }
        }
        res.json(assignments);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Create assignment with full lifecycle dates + brief upload
app.post('/api/assignments', auth, role('facilitator'), upload.single('brief'), async (req, res) => {
    try {
        await getDb();
        const { module_id, title, description, total_marks, open_date, due_date, late_days,
                submission_type, criteria } = req.body;
        if (!title || !open_date || !due_date)
            return res.status(400).json({ error: 'Title, open date and due date are required' });
        if (due_date < open_date)
            return res.status(400).json({ error: 'Due date must be after open date' });

        const lateDays = Math.max(0, Number(late_days ?? 2));
        const close = new Date(new Date(due_date).getTime() + lateDays*86400000).toISOString().slice(0,10);
        const markingDue = new Date(new Date(due_date).getTime() + MARKING_SLA_DAYS*86400000).toISOString().slice(0,10);

        const type = ['code','document','link','text'].includes(submission_type) ? submission_type : 'code';
        await run(`INSERT INTO assignments
            (module_id,title,description,brief_file,total_marks,submission_type,open_date,due_date,close_date,marking_due_date,facilitator_id,school_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [module_id || null, title, description || '', req.file?.filename || null,
             Number(total_marks)||100, type, open_date, due_date, close, markingDue,
             req.user.id, req.user.school_id]);
        const created = await get(`SELECT id FROM assignments WHERE facilitator_id=? ORDER BY id DESC LIMIT 1`, [req.user.id]);

        // Marking criteria: either supplied by the facilitator, or a sensible default
        let crits = [];
        try { crits = typeof criteria === 'string' ? JSON.parse(criteria) : (criteria || []); } catch { crits = []; }
        if (!crits.length) crits = DEFAULT_RUBRIC[type];
        let order = 1;
        for (const c of crits) {
            if (!c.label || !c.max_points) continue;
            await run(`INSERT INTO rubric_criteria (assignment_id,label,descriptor,max_points,criterion_order)
                       VALUES (?,?,?,?,?)`,
                [created.id, c.label, c.descriptor || '', Number(c.max_points), order++]);
        }
        res.json({ success: true, close_date: close, marking_due_date: markingDue,
                   message: `Published. Marking due ${MARKING_SLA_DAYS} days after the deadline: ${markingDue}` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/assignments/:id/brief', auth, async (req, res) => {
    try {
        await getDb();
        const a = await get(`SELECT brief_file FROM assignments WHERE id=?`, [req.params.id]);
        if (!a?.brief_file) return res.status(404).json({ error: 'No brief uploaded' });
        res.download(path.join(UPLOADS_DIR, a.brief_file));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Student submit — enforces the window, flags late
app.post('/api/assignments/:id/submit', auth, role('student'), upload.single('file'), async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const a = await get(`SELECT * FROM assignments WHERE id=? AND school_id=?`, [req.params.id, req.user.school_id]);
        if (!a) return res.status(404).json({ error: 'Assignment not found' });

        const state = lifecycleState(a, today);
        if (state === 'scheduled') return res.status(400).json({ error: `Opens on ${a.open_date}` });
        if (state === 'closed' || state === 'returned')
            return res.status(400).json({ error: `Closed on ${a.close_date} — submissions no longer accepted` });

        const isLate = state === 'late_window' ? 1 : 0;
        const existing = await get(`SELECT s.id, m.id AS mark_id FROM submissions s
            LEFT JOIN marks m ON m.submission_id=s.id
            WHERE s.assignment_id=? AND s.student_id=?`, [req.params.id, req.user.id]);

        if (existing) {
            // Resubmission is allowed until the window closes — unless already graded
            if (existing.mark_id) return res.status(400).json({ error: 'Already graded — resubmission not allowed' });
            await run(`UPDATE submissions SET notes=?, file_name=COALESCE(?,file_name),
                       is_late=?, submitted_at=datetime('now') WHERE id=?`,
                [req.body.notes || '', req.file?.filename || null, isLate, existing.id]);
            return res.json({ success: true, is_late: !!isLate, resubmitted: true,
                message: isLate ? 'Resubmitted — flagged LATE (after the due date)' : 'Resubmitted — previous version replaced' });
        }

        await run(`INSERT INTO submissions (assignment_id,student_id,notes,file_name,is_late) VALUES (?,?,?,?,?)`,
            [req.params.id, req.user.id, req.body.notes || '', req.file?.filename || null, isLate]);
        res.json({ success: true, is_late: !!isLate,
            message: isLate ? 'Submitted — flagged LATE (after the due date)' : 'Submitted on time' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

const DEFAULT_RUBRIC = {
    code:     [{label:'Correctness',descriptor:'The program runs and produces the expected output',max_points:40},
               {label:'Completeness',descriptor:'Every task in the brief is attempted',max_points:25},
               {label:'Code quality',descriptor:'Sensible names, tidy structure, no repetition',max_points:20},
               {label:'Comments',descriptor:'The code explains what it is doing',max_points:15}],
    document: [{label:'Content',descriptor:'Covers everything the brief asked for',max_points:45},
               {label:'Understanding',descriptor:'Explains the concepts in their own words',max_points:30},
               {label:'Presentation',descriptor:'Clear structure, readable, referenced',max_points:25}],
    link:     [{label:'Functionality',descriptor:'The site or page works as described',max_points:40},
               {label:'Requirements',descriptor:'All required elements are present',max_points:35},
               {label:'Presentation',descriptor:'Layout and styling are considered',max_points:25}],
    text:     [{label:'Accuracy',descriptor:'Answers are correct',max_points:50},
               {label:'Reasoning',descriptor:'Working and explanation are shown',max_points:30},
               {label:'Clarity',descriptor:'Written clearly',max_points:20}],
};

// Read a submission inside the system instead of downloading it. Text and code
// files are returned as text so they can be shown with line numbers.
const READABLE = ['.py','.js','.html','.css','.txt','.md','.json','.java','.c','.cpp','.sql','.csv'];
const LANGUAGE = { '.py':'python', '.js':'javascript', '.html':'html', '.css':'css',
                   '.sql':'sql', '.java':'java', '.md':'markdown' };
app.get('/api/submissions/:id/content', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const sub = await get(`
            SELECT su.id, su.file_name, su.notes, su.is_late, su.submitted_at,
                   a.title, a.submission_type, a.total_marks, a.facilitator_id,
                   u.name || ' ' || u.surname AS student_name, u.student_number
            FROM submissions su
            JOIN assignments a ON a.id = su.assignment_id
            JOIN users u ON u.id = su.student_id
            WHERE su.id = ?`, [req.params.id]);
        if (!sub) return res.status(404).json({ error: 'Submission not found' });
        if (req.user.role === 'facilitator' && Number(sub.facilitator_id) !== Number(req.user.id))
            return res.status(403).json({ error: 'Not your assignment' });

        const out = { ...sub, readable: false, text: null, language: null, lines: 0 };
        if (sub.file_name) {
            const ext = path.extname(sub.file_name).toLowerCase();
            const full = path.join(UPLOADS_DIR, sub.file_name);
            if (READABLE.includes(ext) && fs.existsSync(full)) {
                const stat = fs.statSync(full);
                if (stat.size <= 200 * 1024) {                 // refuse to inline anything huge
                    out.text = fs.readFileSync(full, 'utf8');
                    out.readable = true;
                    out.language = LANGUAGE[ext] || 'text';
                    out.lines = out.text.split('\n').length;
                } else out.reason = 'File is too large to display here';
            } else out.reason = 'This file type must be downloaded';
        } else out.reason = 'No file was attached';

        out.rubric = await all(`
            SELECT rc.id, rc.label, rc.descriptor, rc.max_points
            FROM rubric_criteria rc
            JOIN submissions s2 ON s2.assignment_id = rc.assignment_id
            WHERE s2.id = ? ORDER BY rc.criterion_order`, [req.params.id]);
        res.json(out);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Marking queue — submissions awaiting grades, sorted by SLA urgency
app.get('/api/marking-queue', auth, role('facilitator'), async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const rows = await all(`
            SELECT s.id AS submission_id, s.notes, s.file_name, s.is_late, s.submitted_at,
                   a.id AS assignment_id, a.title, a.due_date, a.marking_due_date, a.total_marks,
                   mo.code AS module_code,
                   u.name || ' ' || u.surname AS student_name, u.student_number
            FROM submissions s
            JOIN assignments a ON a.id=s.assignment_id
            LEFT JOIN modules mo ON mo.id=a.module_id
            JOIN users u ON u.id=s.student_id
            LEFT JOIN marks m ON m.submission_id=s.id
            WHERE a.facilitator_id=? AND m.id IS NULL
            ORDER BY a.marking_due_date ASC, s.submitted_at ASC
            LIMIT ?`, [req.user.id, Math.min(500, Math.max(20, Number(req.query.limit) || 200))]);
        for (const r of rows) r.sla_days_left = daysBetween(today, r.marking_due_date);
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/submissions/:id/file', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const s = await get(`SELECT file_name FROM submissions WHERE id=?`, [req.params.id]);
        if (!s?.file_name) return res.status(404).json({ error: 'No file attached' });
        res.download(path.join(UPLOADS_DIR, s.file_name));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/submissions/:id/grade', auth, role('facilitator'), async (req, res) => {
    try {
        await getDb();
        const { score, feedback, criteria } = req.body;
        const sub = await get(`SELECT s.id, a.total_marks FROM submissions s
            JOIN assignments a ON a.id=s.assignment_id WHERE s.id=?`, [req.params.id]);
        if (!sub) return res.status(404).json({ error: 'Submission not found' });
        const max = Number(sub.total_marks) || 100;
        const existing = await get(`SELECT id FROM marks WHERE submission_id=?`, [req.params.id]);
        if (existing) return res.status(409).json({ error: 'Already graded' });

        // Where a rubric is used, the total is the sum of the criteria — the
        // facilitator cannot type a number that the breakdown does not support.
        let total = Number(score);
        const rubric = await all(`
            SELECT rc.id, rc.max_points FROM rubric_criteria rc
            JOIN submissions s2 ON s2.assignment_id = rc.assignment_id
            WHERE s2.id = ?`, [req.params.id]);
        const byId = {}; rubric.forEach(r => { byId[Number(r.id)] = Number(r.max_points); });

        let entries = [];
        if (criteria && Object.keys(criteria).length) {
            total = 0;
            for (const [cid, val] of Object.entries(criteria)) {
                const cap = byId[Number(cid)];
                if (cap == null) return res.status(400).json({ error: 'Unknown marking criterion' });
                const pts = Number(val);
                if (isNaN(pts) || pts < 0 || pts > cap)
                    return res.status(400).json({ error: `Each criterion must be between 0 and its maximum (${cap})` });
                total += pts;
                entries.push([Number(cid), pts]);
            }
            if (rubric.length && entries.length !== rubric.length)
                return res.status(400).json({ error: 'Score every criterion before returning the mark' });
        }
        if (total == null || isNaN(total) || total < 0 || total > max)
            return res.status(400).json({ error: `Score must be 0–${max} (this assignment is out of ${max})` });

        await run(`INSERT INTO marks (submission_id,score,feedback,graded_by) VALUES (?,?,?,?)`,
            [req.params.id, total, feedback || '', req.user.id]);
        const mark = await get(`SELECT id FROM marks WHERE submission_id=?`, [req.params.id]);
        for (const [cid, pts] of entries)
            await run(`INSERT INTO mark_criteria (mark_id,criterion_id,points) VALUES (?,?,?)`, [mark.id, cid, pts]);
        res.json({ success: true, score: total, message: `Mark of ${total}/${max} returned to learner` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ATTENDANCE — facilitator roster capture (the 30-second flow)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/roster', auth, role('facilitator'), async (req, res) => {
    try {
        await getDb();
        const students = await all(
            `SELECT u.id, u.name, u.surname, u.student_number FROM users u
             LEFT JOIN student_profiles sp ON sp.user_id=u.id
             WHERE u.role='student' AND u.school_id=? AND (sp.status IS NULL OR sp.status='studying')
             ORDER BY u.surname, u.name`, [req.user.school_id]);
        const lessons = await all(
            `SELECT l.id, l.title, mo.code FROM lessons l JOIN modules mo ON mo.id=l.module_id
             ORDER BY mo.code, l.lesson_order`);
        res.json({ students, lessons });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── My Learners: everyone the facilitator teaches (incl. completed alumni) ──
app.get('/api/facilitator/students', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const schoolId = req.user.role === 'admin' ? (req.query.school_id || null) : req.user.school_id;
        const rows = await all(`
            SELECT u.id, u.name, u.surname, u.student_number,
                   sp.grade, sp.cohort, COALESCE(sp.status,'studying') AS status,
                   (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                     WHERE a.student_id=u.id AND a.status='present') AS present,
                   (SELECT COUNT(*) FROM attendance a WHERE a.student_id=u.id) AS att_total,
                   (SELECT ROUND(AVG(m.score*100.0/asg.total_marks))
                      FROM marks m JOIN submissions su ON su.id=m.submission_id
                      JOIN assignments asg ON asg.id=su.assignment_id
                     WHERE su.student_id=u.id) AS avg_pct,
                   (SELECT COUNT(*) FROM enrollments e WHERE e.student_id=u.id AND e.status='completed') AS modules_completed,
                   (SELECT GROUP_CONCAT(mo.code) FROM enrollments e JOIN modules mo ON mo.id=e.module_id
                     WHERE e.student_id=u.id) AS module_codes,
                   (SELECT GROUP_CONCAT(mo.code) FROM enrollments e JOIN modules mo ON mo.id=e.module_id
                     WHERE e.student_id=u.id AND e.status='completed') AS completed_codes
            FROM users u LEFT JOIN student_profiles sp ON sp.user_id=u.id
            WHERE u.role='student' AND u.school_id=?
            ORDER BY COALESCE(sp.status,'studying')='studying' DESC, u.surname`, [schoolId]);
        for (const r of rows) {
            r.attendance_rate = Number(r.att_total) ? Math.round(Number(r.present)/Number(r.att_total)*100) : null;
            r.avg_pct = r.avg_pct != null ? Number(r.avg_pct) : null;
            r.modules_completed = Number(r.modules_completed);
            r.modules = r.module_codes ? String(r.module_codes).split(',') : [];
            r.completed_modules = r.completed_codes ? String(r.completed_codes).split(',') : [];
            r.performance = r.avg_pct == null ? 'unmarked' : (r.avg_pct >= 50 ? 'passing' : 'at_risk');
        }
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Full learner profile: personal details, guardian, enrollment history, attendance, marks
app.get('/api/students/:id/profile', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const u = await get(`
            SELECT u.id, u.name, u.surname, u.student_number, u.school_id, u.created_at,
                   s.name AS school_name, sp.grade, sp.date_of_birth, sp.gender,
                   sp.guardian_name, sp.guardian_phone, sp.enrolment_date, sp.cohort,
                   COALESCE(sp.status,'studying') AS status
            FROM users u
            LEFT JOIN student_profiles sp ON sp.user_id=u.id
            LEFT JOIN schools s ON s.id=u.school_id
            WHERE u.id=? AND u.role='student'`, [req.params.id]);
        if (!u) return res.status(404).json({ error: 'Learner not found' });
        if (req.user.role === 'facilitator' && Number(u.school_id) !== Number(req.user.school_id))
            return res.status(403).json({ error: 'This learner is not at your school' });

        u.enrollments = await all(`
            SELECT e.status, e.enrolled_at, e.completed_at, mo.code, mo.title
            FROM enrollments e JOIN modules mo ON mo.id=e.module_id
            WHERE e.student_id=? ORDER BY mo.code`, [req.params.id]);
        const att = await get(`
            SELECT COUNT(*) total, SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present
            FROM attendance WHERE student_id=?`, [req.params.id]);
        u.attendance = { total: Number(att?.total||0), present: Number(att?.present||0),
            rate: Number(att?.total) ? Math.round(Number(att.present)/Number(att.total)*100) : null };
        u.marks = await all(`
            SELECT a.title, a.total_marks, m.score, ROUND(m.score*100.0/a.total_marks) AS percentage,
                   m.feedback, m.graded_at, s2.is_late, mo.code AS module_code
            FROM marks m JOIN submissions s2 ON s2.id=m.submission_id
            JOIN assignments a ON a.id=s2.assignment_id
            LEFT JOIN modules mo ON mo.id=a.module_id
            WHERE s2.student_id=? ORDER BY m.graded_at DESC`, [req.params.id]);
        u.average_pct = u.marks.length ? Math.round(u.marks.reduce((t,m)=>t+Number(m.percentage),0)/u.marks.length) : null;
        res.json(u);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Shared by the online path and the sync path
async function saveSessionAttendance(user, p) {
    const { session_date, session_type, lesson_id, records } = p;
    if (!session_date || !session_type || !Array.isArray(records))
        throw new Error('session_date, session_type and records[] required');

    // Upsert session (unique per school+date+type) — latest facilitator save wins
    await run(`INSERT INTO sessions (school_id,facilitator_id,lesson_id,session_date,session_type)
               VALUES (?,?,?,?,?)
               ON CONFLICT(school_id,session_date,session_type)
               DO UPDATE SET facilitator_id=excluded.facilitator_id, lesson_id=excluded.lesson_id`,
        [user.school_id, user.id, lesson_id || null, session_date, session_type]);
    const session = await get(`SELECT id FROM sessions WHERE school_id=? AND session_date=? AND session_type=?`,
        [user.school_id, session_date, session_type]);

    for (const r of records)
        await run(`INSERT INTO attendance (session_id,student_id,status) VALUES (?,?,?)
                   ON CONFLICT(session_id,student_id) DO UPDATE SET status=excluded.status`,
            [session.id, r.student_id, r.status === 'absent' ? 'absent' : 'present']);

    const present = records.filter(r => r.status !== 'absent').length;
    return { session_id: Number(session.id), present, absent: records.length - present };
}

app.post('/api/attendance/session', auth, role('facilitator'), async (req, res) => {
    try {
        await getDb();
        const result = await saveSessionAttendance(req.user, req.body);
        res.json({ success: true, ...result,
            message: `Saved — ${result.present} present, ${result.absent} absent` });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message || 'Server error' }); }
});

app.get('/api/attendance/student', auth, role('student'), async (req, res) => {
    try {
        await getDb();
        const records = await all(`
            SELECT sess.session_date, sess.session_type, sess.validated, att.status,
                   l.title AS lesson_title, mo.code AS module_code
            FROM attendance att
            JOIN sessions sess ON sess.id=att.session_id
            LEFT JOIN lessons l ON l.id=sess.lesson_id
            LEFT JOIN modules mo ON mo.id=l.module_id
            WHERE att.student_id=? ORDER BY sess.session_date DESC`, [req.user.id]);
        const total = records.length, present = records.filter(r=>r.status==='present').length;
        res.json({ records, stats: { total, present, absent: total-present,
            average: total ? Math.round(present/total*100) : 0 } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Admin signs off that a session occurred → data becomes "validated" for reports
app.post('/api/sessions/:id/validate', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`UPDATE sessions SET validated=1 WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  STUDENT: marks
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/marks', auth, role('student'), async (req, res) => {
    try {
        await getDb();
        const graded = await all(`
            SELECT a.title, a.due_date, a.total_marks, mo.code AS module_code, s.is_late,
                   m.score, m.feedback, m.graded_at,
                   ROUND(m.score*100.0/a.total_marks) AS percentage,
                   u.name || ' ' || u.surname AS teacher_name
            FROM marks m JOIN submissions s ON s.id=m.submission_id
            JOIN assignments a ON a.id=s.assignment_id
            LEFT JOIN modules mo ON mo.id=a.module_id
            JOIN users u ON u.id=m.graded_by
            WHERE s.student_id=? ORDER BY m.graded_at DESC`, [req.user.id]);
        const pending = await all(`
            SELECT a.title, a.due_date, a.marking_due_date, s.submitted_at,
                   u.name || ' ' || u.surname AS teacher_name
            FROM submissions s JOIN assignments a ON a.id=s.assignment_id
            JOIN users u ON u.id=a.facilitator_id
            LEFT JOIN marks m ON m.submission_id=s.id
            WHERE s.student_id=? AND m.id IS NULL ORDER BY s.submitted_at DESC`, [req.user.id]);
        for (const g of graded) {
            g.breakdown = await all(`
                SELECT rc.label, rc.descriptor, rc.max_points, mc.points
                FROM mark_criteria mc JOIN rubric_criteria rc ON rc.id = mc.criterion_id
                WHERE mc.mark_id = (SELECT id FROM marks WHERE submission_id = (
                    SELECT s3.id FROM submissions s3 JOIN assignments a3 ON a3.id = s3.assignment_id
                    WHERE s3.student_id = ? AND a3.title = ? LIMIT 1))
                ORDER BY rc.criterion_order`, [req.user.id, g.title]);
        }
        const avg = graded.length ? Math.round(graded.reduce((t,m)=>t+Number(m.percentage),0)/graded.length) : null;
        res.json({ graded, pending, average: avg });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  READINGS (kept from v1)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/readings', auth, async (req, res) => {
    try {
        await getDb();
        res.json(await all(`
            SELECT r.*, u.name || ' ' || u.surname AS added_by_name
            FROM readings r JOIN users u ON u.id=r.added_by ORDER BY r.created_at DESC`));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/readings/:id/download', auth, async (req, res) => {
    try {
        await getDb();
        const r = await get(`SELECT * FROM readings WHERE id=?`, [req.params.id]);
        if (!r) return res.status(404).json({ error: 'Not found' });
        if (r.file_name) return res.download(path.join(UPLOADS_DIR, r.file_name));
        if (r.url) return res.redirect(r.url);
        res.status(404).json({ error: 'No file' });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN: users, schools, and the FUNDER IMPACT REPORT
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/overview', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const n = async q => Number((await get(q))?.c || 0);
        res.json({
            schools:      await n(`SELECT COUNT(*) c FROM schools`),
            students:     await n(`SELECT COUNT(*) c FROM users WHERE role='student'`),
            facilitators: await n(`SELECT COUNT(*) c FROM users WHERE role='facilitator'`),
            sessions:     await n(`SELECT COUNT(*) c FROM sessions`),
            modules:      await n(`SELECT COUNT(*) c FROM modules`),
        });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/users', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        // Paginated: at 900+ accounts an unbounded list is a quarter-megabyte
        // response. Callers may pass ?page= and ?per_page= (default 200).
        const perPage = Math.min(500, Math.max(20, Number(req.query.per_page) || 200));
        const page = Math.max(1, Number(req.query.page) || 1);
        const roleFilter = ['student','facilitator','admin'].includes(req.query.role) ? req.query.role : null;
        const where = roleFilter ? 'WHERE u.role = ?' : '';
        const args = roleFilter ? [roleFilter] : [];

        const totalRow = await get(`SELECT COUNT(*) c FROM users u ${where}`, args);
        const rows = await all(`
            SELECT u.id, u.name, u.surname, u.role, u.student_number, u.employee_id,
                   u.school_id, s.name AS school_name,
                   sp.grade, sp.cohort, COALESCE(sp.status, CASE WHEN u.role='student' THEN 'studying' END) AS student_status,
                   fp.qualification, fp.phone AS fac_phone,
                   (SELECT GROUP_CONCAT(mo.code) FROM enrollments e JOIN modules mo ON mo.id=e.module_id
                     WHERE e.student_id=u.id) AS module_codes
            FROM users u LEFT JOIN schools s ON s.id=u.school_id
            LEFT JOIN student_profiles sp ON sp.user_id=u.id
            LEFT JOIN facilitator_profiles fp ON fp.user_id=u.id
            ${where}
            ORDER BY u.role, u.surname
            LIMIT ? OFFSET ?`, [...args, perPage, (page - 1) * perPage]);

        // The interface still expects a plain array, so only send the envelope
        // when the caller asked for a page.
        if (req.query.page || req.query.per_page)
            return res.json({ page, per_page: perPage, total: Number(totalRow?.c || 0), users: rows });
        res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/users', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { name, surname, login_id, password, role: userRole, school_id,
                grade, date_of_birth, gender, guardian_name, guardian_phone,
                phone, qualification, specialisation } = req.body;
        if (!name || !surname || !login_id || !password || !userRole)
            return res.status(400).json({ error: 'All fields required' });
        const hashed = bcrypt.hashSync(password, 10);
        const isStudent = userRole === 'student';
        await run(`INSERT INTO users (name,surname,student_number,employee_id,password,role,school_id) VALUES (?,?,?,?,?,?,?)`,
            [name, surname, isStudent ? login_id : null, isStudent ? null : login_id.toUpperCase(),
             hashed, userRole, school_id || null]);
        const created = await get(`SELECT id FROM users WHERE student_number=? OR employee_id=?`,
            [login_id, login_id.toUpperCase()]);
        if (isStudent)
            await run(`INSERT INTO student_profiles (user_id,grade,date_of_birth,gender,guardian_name,guardian_phone,enrolment_date,cohort,status)
                       VALUES (?,?,?,?,?,?,date('now','+2 hours'),strftime('%Y','now','+2 hours'),'studying')`,
                [created.id, grade||null, date_of_birth||null, gender||null, guardian_name||null, guardian_phone||null]);
        else if (userRole === 'facilitator')
            await run(`INSERT INTO facilitator_profiles (user_id,phone,qualification,specialisation,start_date)
                       VALUES (?,?,?,?,date('now','+2 hours'))`,
                [created.id, phone||null, qualification||null, specialisation||null]);
        if (userRole === 'facilitator' && school_id) {
            const u = await get(`SELECT id FROM users WHERE employee_id=?`, [login_id.toUpperCase()]);
            await run(`UPDATE schools SET facilitator_id=? WHERE id=?`, [u.id, school_id]);
        }
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: 'Login ID already exists' }); }
});

app.post('/api/admin/schools', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { name, location } = req.body;
        if (!name || !location) return res.status(400).json({ error: 'School name and province are required' });
        const existing = await get(`SELECT id FROM schools WHERE lower(name)=lower(?)`, [name.trim()]);
        if (existing) return res.status(400).json({ error: 'A school with that name already exists' });
        await run(`INSERT INTO schools (name, location) VALUES (?,?)`, [name.trim(), location.trim()]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/schools', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        res.json(await all(`
            SELECT s.*, u.name || ' ' || u.surname AS facilitator_name,
                   (SELECT COUNT(*) FROM users st WHERE st.school_id=s.id AND st.role='student') AS student_count
            FROM schools s LEFT JOIN users u ON u.id=s.facilitator_id ORDER BY s.name`));
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Dashboard stats in the shape the admin dashboard expects
app.get('/api/admin/stats', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const schools = await all(`
            SELECT s.id, s.name,
                (SELECT COUNT(*) FROM users u WHERE u.school_id=s.id AND u.role='student') AS learner_count,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                  WHERE se.school_id=s.id AND a.status='present') AS present,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                  WHERE se.school_id=s.id) AS total_att
            FROM schools s ORDER BY s.name`);
        for (const sc of schools) {
            sc.learner_count = Number(sc.learner_count);
            sc.attendance_rate = Number(sc.total_att) ? Math.round(Number(sc.present)/Number(sc.total_att)*100) : 0;
        }
        const withData = schools.filter(sc => Number(sc.total_att) > 0);
        const sorted = [...withData].sort((a,b) => b.attendance_rate - a.attendance_rate);
        const n = async q => Number((await get(q))?.c || 0);
        res.json({
            totalSchools: schools.length,
            totalLearners: schools.reduce((t,sc)=>t+sc.learner_count,0),
            totalSessions: await n(`SELECT COUNT(*) c FROM sessions`),
            avgAttendance: withData.length ? Math.round(withData.reduce((t,sc)=>t+sc.attendance_rate,0)/withData.length) : 0,
            schools, highest: sorted[0] || null, lowest: sorted[sorted.length-1] || null,
        });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Move a user to a different school
app.patch('/api/admin/users/:id/school', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`UPDATE users SET school_id=? WHERE id=?`, [req.body.school_id || null, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Remove a user (admins protected; you cannot remove yourself)
app.delete('/api/admin/users/:id', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        if (Number(req.params.id) === Number(req.user.id))
            return res.status(400).json({ error: 'You cannot remove your own account' });
        const u = await get(`SELECT role FROM users WHERE id=?`, [req.params.id]);
        if (!u) return res.status(404).json({ error: 'User not found' });
        if (u.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be removed here' });
        await run(`DELETE FROM student_profiles WHERE user_id=?`, [req.params.id]);
        await run(`DELETE FROM facilitator_profiles WHERE user_id=?`, [req.params.id]);
        await run(`DELETE FROM enrollments WHERE student_id=?`, [req.params.id]);
        await run(`DELETE FROM users WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Add / remove readings (admin library management)
app.post('/api/readings', auth, role('admin'), upload.single('file'), async (req, res) => {
    try {
        await getDb();
        const { title, category, description, url } = req.body;
        if (!title || !category) return res.status(400).json({ error: 'Title and category required' });
        if (!req.file && !url) return res.status(400).json({ error: 'Attach a file or provide a URL' });
        await run(`INSERT INTO readings (title,description,category,file_name,url,added_by) VALUES (?,?,?,?,?,?)`,
            [title, description || '', category, req.file?.filename || null, url || null, req.user.id]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/readings/:id', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`DELETE FROM readings WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  EARLY WARNING — which learners need intervention, and why
//  Signals: attendance rate, consecutive absences, missed submissions, marks.
//  Facilitators see their own school; admins see every school.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/at-risk', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const facilitator = req.user.role === 'facilitator';
        const scope = facilitator ? 'AND u.school_id = ?' : '';
        const p = facilitator ? [req.user.school_id] : [];

        // Five aggregate queries for the whole cohort, instead of five queries
        // per learner. At 900 learners that is the difference between about a
        // second and a few tens of milliseconds.
        const learners = await all(`
            SELECT u.id, u.name, u.surname, u.student_number, u.school_id,
                   sc.name AS school_name, sp.grade
            FROM users u
            LEFT JOIN student_profiles sp ON sp.user_id = u.id
            LEFT JOIN schools sc ON sc.id = u.school_id
            WHERE u.role='student' AND COALESCE(sp.status,'studying')='studying' ${scope}
            ORDER BY u.surname`, p);
        if (!learners.length)
            return res.json({ generated_at: new Date().toISOString(),
                summary: { flagged: 0, high: 0, medium: 0, reviewed: 0 }, learners: [] });

        const attRows = await all(`
            SELECT a.student_id AS id, COUNT(*) total,
                   SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) present
            FROM attendance a JOIN users u ON u.id = a.student_id
            WHERE u.role='student' ${scope} GROUP BY a.student_id`, p);

        const streakRows = await all(`
            WITH ranked AS (
                SELECT a.student_id, a.status,
                       ROW_NUMBER() OVER (PARTITION BY a.student_id ORDER BY s.session_date DESC) rn
                FROM attendance a
                JOIN sessions s ON s.id = a.session_id
                JOIN users u ON u.id = a.student_id
                WHERE u.role='student' ${scope})
            SELECT student_id AS id, SUM(CASE WHEN status='absent' THEN 1 ELSE 0 END) recent_absent
            FROM ranked WHERE rn <= 3 GROUP BY student_id`, p);

        const missedRows = await all(`
            SELECT u.id, COUNT(a.id) missed
            FROM users u
            LEFT JOIN student_profiles sp ON sp.user_id = u.id
            JOIN assignments a ON a.school_id = u.school_id AND a.published = 1
                 AND a.close_date < ?
                 -- only work set after the learner joined can count as missed
                 AND (sp.enrolment_date IS NULL OR a.open_date >= sp.enrolment_date)
            LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = u.id
            WHERE u.role='student' AND s.id IS NULL ${scope}
            GROUP BY u.id`, [today, ...p]);

        const markRows = await all(`
            SELECT s.student_id AS id, COUNT(*) n, AVG(m.score * 100.0 / a.total_marks) avg
            FROM marks m
            JOIN submissions s ON s.id = m.submission_id
            JOIN assignments a ON a.id = s.assignment_id
            JOIN users u ON u.id = s.student_id
            WHERE u.role='student' ${scope} GROUP BY s.student_id`, p);

        const trendRows = await all(`
            WITH ranked AS (
                SELECT s.student_id, m.score * 100.0 / a.total_marks pct,
                       ROW_NUMBER() OVER (PARTITION BY s.student_id ORDER BY m.graded_at DESC) rn
                FROM marks m
                JOIN submissions s ON s.id = m.submission_id
                JOIN assignments a ON a.id = s.assignment_id
                JOIN users u ON u.id = s.student_id
                WHERE u.role='student' ${scope})
            SELECT student_id AS id,
                   MAX(CASE WHEN rn = 1 THEN pct END) latest,
                   MAX(CASE WHEN rn = 2 THEN pct END) previous
            FROM ranked WHERE rn <= 2 GROUP BY student_id`, p);

        const index = rows => { const m = {}; rows.forEach(r => { m[Number(r.id)] = r; }); return m; };
        const att = index(attRows), streak = index(streakRows), missed = index(missedRows),
              mark = index(markRows), trend = index(trendRows);

        const out = [];
        for (const l of learners) {
            const id = Number(l.id);
            const signals = [];
            let score = 0;

            const a = att[id];
            const rate = a && Number(a.total) ? Math.round(Number(a.present) / Number(a.total) * 100) : null;
            if (rate != null && rate < 50)      { score += 40; signals.push(`Attendance ${rate}% \u2014 below half of sessions`); }
            else if (rate != null && rate < 70) { score += 22; signals.push(`Attendance ${rate}% \u2014 falling behind`); }

            const st = streak[id] ? Number(streak[id].recent_absent) : 0;
            if (st >= 3)       { score += 35; signals.push('Absent for the last 3 sessions'); }
            else if (st === 2) { score += 15; signals.push('Absent the last 2 sessions'); }

            const ms = missed[id] ? Number(missed[id].missed) : 0;
            if (ms >= 2)       { score += 30; signals.push(`${ms} assignments never submitted`); }
            else if (ms === 1) { score += 14; signals.push('1 assignment never submitted'); }

            const mk = mark[id];
            const avg = mk && mk.avg != null ? Math.round(Number(mk.avg)) : null;
            if (avg != null && avg < 40)      { score += 35; signals.push(`Average ${avg}% \u2014 well below the pass mark`); }
            else if (avg != null && avg < 50) { score += 20; signals.push(`Average ${avg}% \u2014 below the pass mark`); }

            const t = trend[id];
            if (t && t.latest != null && t.previous != null && Number(t.latest) < Number(t.previous) - 15) {
                score += 12;
                signals.push(`Marks dropped ${Math.round(Number(t.previous) - Number(t.latest))} points`);
            }

            const level = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
            if (level !== 'low')
                out.push({ id, name: l.name, surname: l.surname, student_number: l.student_number,
                    grade: l.grade, school_id: Number(l.school_id), school_name: l.school_name,
                    attendance_rate: rate, average_pct: avg, missed_assignments: ms,
                    absent_streak: st, score, level, signals });
        }
        out.sort((x, y) => y.score - x.score);
        res.json({ generated_at: new Date().toISOString(),
            summary: { flagged: out.length, high: out.filter(x => x.level === 'high').length,
                       medium: out.filter(x => x.level === 'medium').length, reviewed: learners.length },
            learners: out });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Sponsor information (the funders the reporting serves) ──────────────────
app.get('/api/admin/sponsors', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const sponsors = await all(`SELECT * FROM sponsors ORDER BY status='active' DESC, organisation`);
        for (const sp of sponsors) {
            sp.sponsorships = await all(`
                SELECT sp2.id, sp2.annual_amount, sp2.start_date, sp2.end_date,
                       s.id AS school_id, s.name AS school_name, s.location
                FROM sponsorships sp2 JOIN schools s ON s.id=sp2.school_id
                WHERE sp2.sponsor_id=? ORDER BY s.name`, [sp.id]);
            sp.total_annual = sp.sponsorships.reduce((t,x)=>t+Number(x.annual_amount||0),0);
        }
        res.json({ sponsors,
            totals: { count: sponsors.length,
                      active: sponsors.filter(x=>x.status==='active').length,
                      annual_funding: sponsors.reduce((t,x)=>t+x.total_annual,0) } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/sponsors', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { organisation, contact_person, email, phone, focus_area, status, notes } = req.body;
        if (!organisation) return res.status(400).json({ error: 'Organisation name required' });
        await run(`INSERT INTO sponsors (organisation,contact_person,email,phone,focus_area,status,notes) VALUES (?,?,?,?,?,?,?)`,
            [organisation, contact_person||'', email||'', phone||'', focus_area||'',
             ['active','prospective','lapsed'].includes(status) ? status : 'active', notes||'']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/admin/sponsors/:id', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`DELETE FROM sponsorships WHERE sponsor_id=?`, [req.params.id]);
        await run(`DELETE FROM sponsors WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
// Link a sponsor to a school (many-to-many with terms)
app.post('/api/admin/sponsors/:id/sponsorships', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { school_id, annual_amount, start_date, end_date } = req.body;
        if (!school_id) return res.status(400).json({ error: 'School required' });
        await run(`INSERT INTO sponsorships (sponsor_id,school_id,annual_amount,start_date,end_date) VALUES (?,?,?,?,?)
                   ON CONFLICT(sponsor_id,school_id) DO UPDATE SET annual_amount=excluded.annual_amount,
                   start_date=excluded.start_date, end_date=excluded.end_date`,
            [req.params.id, school_id, Number(annual_amount)||null, start_date||null, end_date||null]);
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/admin/sponsorships/:id', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`DELETE FROM sponsorships WHERE id=?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  CURRICULUM GOVERNANCE — head office decides what runs where
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/curriculum', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const modules = await all(`SELECT * FROM modules ORDER BY code`);
        for (const m of modules) {
            m.lessons = await all(`SELECT id, title, lesson_order FROM lessons WHERE module_id=? ORDER BY lesson_order`, [m.id]);
            for (const l of m.lessons)
                l.materials = await all(`SELECT id, title, kind, file_name, url, file_size_kb
                                         FROM materials WHERE lesson_id=? ORDER BY created_at`, [l.id]);
            m.schools = await all(`
                SELECT s.id, s.name, ms.active FROM module_schools ms
                JOIN schools s ON s.id = ms.school_id
                WHERE ms.module_id = ? ORDER BY s.name`, [m.id]);
            m.qualified = await all(`
                SELECT u.id, u.name || ' ' || u.surname AS name, u.employee_id
                FROM facilitator_modules fm JOIN users u ON u.id = fm.user_id
                WHERE fm.module_id = ? ORDER BY u.surname`, [m.id]);
            m.material_count = Number((await get(`
                SELECT COUNT(*) c FROM materials mat JOIN lessons l ON l.id = mat.lesson_id
                WHERE l.module_id = ?`, [m.id]))?.c || 0);
        }
        res.json(modules);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/modules/:id/schools', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { school_id } = req.body;
        if (!school_id) return res.status(400).json({ error: 'School required' });
        await run(`INSERT INTO module_schools (module_id, school_id, active) VALUES (?,?,1)
                   ON CONFLICT(module_id, school_id) DO UPDATE SET active = 1`, [req.params.id, school_id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/modules/:id/schools/:schoolId', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const inUse = await get(`SELECT COUNT(*) c FROM assignments WHERE module_id=? AND school_id=?`,
            [req.params.id, req.params.schoolId]);
        if (Number(inUse?.c || 0) > 0)
            return res.status(400).json({ error: 'This school already has assignments on the module — it can be deactivated but not removed.' });
        await run(`DELETE FROM module_schools WHERE module_id=? AND school_id=?`, [req.params.id, req.params.schoolId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  FACILITATOR MANAGEMENT — who is certified for what, and how they are doing
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/facilitators/:id/modules', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { module_id } = req.body;
        if (!module_id) return res.status(400).json({ error: 'Module required' });
        const u = await get(`SELECT role FROM users WHERE id=?`, [req.params.id]);
        if (!u || u.role !== 'facilitator') return res.status(400).json({ error: 'Not a facilitator' });
        await run(`INSERT OR IGNORE INTO facilitator_modules (user_id, module_id, certified_on, certified_by)
                   VALUES (?,?,date('now','+2 hours'),?)`, [req.params.id, module_id, req.user.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/facilitators/:id/modules/:moduleId', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        await run(`DELETE FROM facilitator_modules WHERE user_id=? AND module_id=?`,
            [req.params.id, req.params.moduleId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Verify a facilitator on a module: record who signed them off, on what
// evidence, and when it must be reviewed again.
app.post('/api/admin/facilitators/:id/verify', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { module_id, evidence, months_valid } = req.body;
        if (!module_id) return res.status(400).json({ error: 'Module required' });
        const months = Math.max(1, Math.min(36, Number(months_valid) || 12));
        const row = await get(`SELECT id FROM facilitator_modules WHERE user_id=? AND module_id=?`,
            [req.params.id, module_id]);
        if (!row) return res.status(404).json({ error: 'That facilitator is not assigned to this module' });
        const due = new Date(Date.now() + months * 30 * 86400000).toISOString().slice(0, 10);
        await run(`UPDATE facilitator_modules
                   SET status='verified', verified_on=date('now','+2 hours'), verified_by=?, review_due=?, evidence=?
                   WHERE id=?`, [req.user.id, due, evidence || null, row.id]);
        res.json({ success: true, message: `Verified. Review due ${due}.` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Withdraw a verification — the facilitator keeps the assignment but is no
// longer signed off to teach it unsupervised.
app.post('/api/admin/facilitators/:id/revoke', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { module_id, reason } = req.body;
        if (!module_id) return res.status(400).json({ error: 'Module required' });
        await run(`UPDATE facilitator_modules
                   SET status='provisional', verified_on=NULL, review_due=NULL, evidence=?
                   WHERE user_id=? AND module_id=?`,
            [reason ? `Withdrawn: ${reason}` : 'Verification withdrawn', req.params.id, module_id]);
        res.json({ success: true, message: 'Verification withdrawn.' });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Who is where, and are they signed off for what they are teaching?
app.get('/api/admin/staffing', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const schools = await all(`
            SELECT s.id, s.name, s.location, s.facilitator_id,
                   u.name || ' ' || u.surname AS facilitator, u.employee_id,
                   fp.qualification, fp.specialisation, fp.start_date,
                   (SELECT COUNT(*) FROM users st LEFT JOIN student_profiles sp ON sp.user_id = st.id
                     WHERE st.school_id = s.id AND st.role='student'
                       AND COALESCE(sp.status,'studying')='studying') AS learners
            FROM schools s
            LEFT JOIN users u ON u.id = s.facilitator_id
            LEFT JOIN facilitator_profiles fp ON fp.user_id = u.id
            ORDER BY s.name`);
        for (const sc of schools) {
            sc.learners = Number(sc.learners);
            sc.modules_running = await all(`
                SELECT mo.code, mo.title,
                       COALESCE((SELECT fm.status FROM facilitator_modules fm
                                 WHERE fm.user_id = ? AND fm.module_id = mo.id), 'none') AS sign_off
                FROM module_schools ms JOIN modules mo ON mo.id = ms.module_id
                WHERE ms.school_id = ? AND ms.active = 1 ORDER BY mo.code`,
                [sc.facilitator_id, sc.id]);
            sc.gaps = sc.modules_running.filter(m => m.sign_off !== 'verified').map(m => m.code);
            sc.status = !sc.facilitator_id ? 'no facilitator assigned'
                      : sc.gaps.length ? 'sign-off gap' : 'fully staffed';
        }
        res.json({
            generated_at: new Date().toISOString(),
            summary: {
                schools: schools.length,
                unstaffed: schools.filter(s => !s.facilitator_id).length,
                with_gaps: schools.filter(s => s.gaps.length).length,
            },
            schools,
        });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Performance scorecard: delivery, attendance, marking and learner outcomes
app.get('/api/admin/facilitator-performance', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const facs = await all(`
            SELECT u.id, u.name || ' ' || u.surname AS name, u.employee_id, u.school_id,
                   s.name AS school_name, fp.qualification, fp.start_date
            FROM users u
            LEFT JOIN schools s ON s.id = u.school_id
            LEFT JOIN facilitator_profiles fp ON fp.user_id = u.id
            WHERE u.role = 'facilitator' ORDER BY u.surname`);

        for (const f of facs) {
            const sess = await get(`SELECT COUNT(*) c FROM sessions WHERE facilitator_id=?`, [f.id]);
            f.sessions_delivered = Number(sess?.c || 0);

            const att = await get(`
                SELECT COUNT(*) total, SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) present
                FROM attendance a JOIN sessions se ON se.id = a.session_id
                WHERE se.facilitator_id = ?`, [f.id]);
            f.attendance_rate = Number(att?.total) ? Math.round(Number(att.present) / Number(att.total) * 100) : null;

            const asg = await get(`SELECT COUNT(*) c FROM assignments WHERE facilitator_id=?`, [f.id]);
            f.assignments_published = Number(asg?.c || 0);

            const sla = await get(`
                SELECT COUNT(*) graded,
                       SUM(CASE WHEN date(m.graded_at) <= a.marking_due_date THEN 1 ELSE 0 END) within,
                       ROUND(AVG(julianday(m.graded_at) - julianday(a.due_date)), 1) turnaround
                FROM marks m JOIN submissions su ON su.id = m.submission_id
                JOIN assignments a ON a.id = su.assignment_id
                WHERE m.graded_by = ?`, [f.id]);
            f.marks_returned = Number(sla?.graded || 0);
            f.sla_compliance = f.marks_returned ? Math.round(Number(sla.within) / f.marks_returned * 100) : null;
            f.avg_turnaround_days = sla?.turnaround != null ? Number(sla.turnaround) : null;

            const outstanding = await get(`
                SELECT COUNT(*) c FROM submissions su
                JOIN assignments a ON a.id = su.assignment_id
                LEFT JOIN marks m ON m.submission_id = su.id
                WHERE a.facilitator_id = ? AND m.id IS NULL AND a.close_date < date('now','+2 hours')`, [f.id]);
            f.awaiting_marking = Number(outstanding?.c || 0);

            const learners = await get(`
                SELECT COUNT(*) c FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id
                WHERE u.role='student' AND u.school_id=? AND COALESCE(sp.status,'studying')='studying'`, [f.school_id]);
            f.learners = Number(learners?.c || 0);

            const pass = await get(`
                SELECT COUNT(*) c, SUM(CASE WHEN m.score*1.0/a.total_marks >= 0.5 THEN 1 ELSE 0 END) passed
                FROM marks m JOIN submissions su ON su.id = m.submission_id
                JOIN assignments a ON a.id = su.assignment_id
                WHERE a.school_id = ?`, [f.school_id]);
            f.pass_rate = Number(pass?.c) ? Math.round(Number(pass.passed) / Number(pass.c) * 100) : null;

            f.modules = await all(`
                SELECT mo.id, mo.code, mo.title, fm.certified_on, fm.status,
                       fm.verified_on, fm.review_due, fm.evidence,
                       CASE WHEN fm.review_due IS NOT NULL AND fm.review_due < date('now','+2 hours')
                            THEN 1 ELSE 0 END AS review_overdue
                FROM facilitator_modules fm JOIN modules mo ON mo.id = fm.module_id
                WHERE fm.user_id = ? ORDER BY mo.code`, [f.id]);
            f.verified_count = f.modules.filter(m => m.status === 'verified').length;
            f.provisional_count = f.modules.filter(m => m.status === 'provisional').length;
            f.expired_count = f.modules.filter(m => m.status === 'expired' || Number(m.review_overdue) === 1).length;

            // Is this facilitator teaching anything they are not certified for?
            f.uncertified = await all(`
                SELECT DISTINCT mo.code FROM assignments a JOIN modules mo ON mo.id = a.module_id
                WHERE a.facilitator_id = ?
                  AND mo.id NOT IN (SELECT module_id FROM facilitator_modules
                                    WHERE user_id = ? AND status = 'verified')`,
                [f.id, f.id]);

            // A single standing figure so a manager can sort the list
            const parts = [];
            if (f.sla_compliance != null) parts.push(f.sla_compliance);
            if (f.attendance_rate != null) parts.push(f.attendance_rate);
            if (f.pass_rate != null) parts.push(f.pass_rate);
            f.score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
            f.standing = f.score == null ? 'no data'
                       : f.score >= 75 ? 'strong'
                       : f.score >= 55 ? 'steady' : 'needs support';
            // Teaching a module without a verified sign-off is a compliance
            // problem regardless of how well the class is performing.
            f.compliance = f.uncertified.length ? 'unverified teaching'
                         : f.expired_count ? 'review overdue' : 'compliant';
        }
        facs.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        res.json({ generated_at: new Date().toISOString(), facilitators: facs });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  1. FORECASTING — where is each learner heading?
//
//  Least-squares linear regression over a learner's marks in the order they
//  were awarded gives the trend line of their performance. Projecting that line
//  to the end of the programme estimates the mark they will finish on. The
//  regression is combined with attendance and submission rates into a single
//  completion probability, because a learner who scores well but has stopped
//  attending is not on track either.
//
//  Complexity: O(n) per learner over their marks, O(N) overall.
// ═════════════════════════════════════════════════════════════════════════════
function linearFit(points) {
    // points: [{x, y}] — returns slope, intercept and r² (goodness of fit)
    const n = points.length;
    if (n < 2) return null;
    const mx = points.reduce((t, p) => t + p.x, 0) / n;
    const my = points.reduce((t, p) => t + p.y, 0) / n;
    let num = 0, den = 0;
    for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
    if (den === 0) return { slope: 0, intercept: my, r2: 0, n };
    const slope = num / den;
    const intercept = my - slope * mx;
    let ssRes = 0, ssTot = 0;
    for (const p of points) {
        const pred = intercept + slope * p.x;
        ssRes += (p.y - pred) ** 2;
        ssTot += (p.y - my) ** 2;
    }
    const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
    return { slope, intercept, r2, n };
}

app.get('/api/forecast', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const facilitator = req.user.role === 'facilitator';
        const scope = facilitator ? 'AND u.school_id = ?' : '';
        const p = facilitator ? [req.user.school_id] : [];

        const learners = await all(`
            SELECT u.id, u.name, u.surname, u.student_number, u.school_id, sc.name AS school_name
            FROM users u
            LEFT JOIN student_profiles sp ON sp.user_id = u.id
            LEFT JOIN schools sc ON sc.id = u.school_id
            WHERE u.role='student' AND COALESCE(sp.status,'studying')='studying' ${scope}
            ORDER BY u.surname`, p);

        // All marks in award order, all attendance, all submission counts — three
        // queries for the whole cohort rather than three per learner.
        const marks = await all(`
            SELECT s.student_id AS id, m.score * 100.0 / a.total_marks AS pct, m.graded_at
            FROM marks m
            JOIN submissions s ON s.id = m.submission_id
            JOIN assignments a ON a.id = s.assignment_id
            JOIN users u ON u.id = s.student_id
            WHERE u.role='student' ${scope}
            ORDER BY s.student_id, m.graded_at`, p);
        const att = await all(`
            SELECT a.student_id AS id, COUNT(*) total,
                   SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) present
            FROM attendance a JOIN users u ON u.id = a.student_id
            WHERE u.role='student' ${scope} GROUP BY a.student_id`, p);
        const subs = await all(`
            SELECT u.id,
                   COUNT(DISTINCT a.id) AS expected,
                   COUNT(DISTINCT s.id) AS handed_in
            FROM users u
            LEFT JOIN student_profiles sp ON sp.user_id = u.id
            JOIN assignments a ON a.school_id = u.school_id AND a.published = 1
                 AND a.close_date < date('now','+2 hours')
                 AND (sp.enrolment_date IS NULL OR a.open_date >= sp.enrolment_date)
            LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = u.id
            WHERE u.role='student' ${scope} GROUP BY u.id`, p);

        const byLearner = {};
        for (const m of marks) (byLearner[Number(m.id)] ||= []).push(Number(m.pct));
        const attMap = {}; att.forEach(a => { attMap[Number(a.id)] = a; });
        const subMap = {}; subs.forEach(x => { subMap[Number(x.id)] = x; });

        const out = [];
        for (const l of learners) {
            const id = Number(l.id);
            const series = byLearner[id] || [];
            const a = attMap[id];
            const attendance = a && Number(a.total) ? Number(a.present) / Number(a.total) : null;
            const sb = subMap[id];
            const submission = sb && Number(sb.expected) ? Number(sb.handed_in) / Number(sb.expected) : null;

            const fit = linearFit(series.map((y, i) => ({ x: i + 1, y })));
            const current = series.length ? series.reduce((t, v) => t + v, 0) / series.length : null;

            // Project two assessments beyond the last one, bounded to a sane range
            let projected = null, direction = 'steady';
            if (fit) {
                const raw = fit.intercept + fit.slope * (series.length + 2);
                // Shrink the projection towards the learner's current average in
                // proportion to how little evidence supports the trend. Two marks
                // on a steep line should not be extrapolated as confidently as six.
                const evidence = Math.min(1, (fit.n - 1) / 4) * (0.4 + 0.6 * fit.r2);
                const blended = raw * evidence + (current ?? raw) * (1 - evidence);
                projected = Math.max(0, Math.min(100, blended));
                const effective = fit.slope * evidence;
                direction = effective > 1.5 ? 'improving' : effective < -1.5 ? 'declining' : 'steady';
            } else if (current != null) projected = current;

            // Completion probability: performance, attendance and submission
            // discipline, weighted by how much each predicts finishing.
            let probability = null;
            if (projected != null || attendance != null) {
                const perf = (projected ?? current ?? 50) / 100;
                const parts = [[perf, 0.45]];
                if (attendance != null) parts.push([attendance, 0.35]);
                if (submission != null) parts.push([submission, 0.20]);
                const weight = parts.reduce((t, [, w]) => t + w, 0);
                probability = Math.round(parts.reduce((t, [v, w]) => t + v * w, 0) / weight * 100);
            }

            // Confidence reflects how much evidence the projection rests on
            const confidence = !fit ? 'low'
                : fit.n >= 4 && fit.r2 >= 0.5 ? 'high'
                : fit.n >= 3 ? 'medium' : 'low';

            const outlook = probability == null ? 'unknown'
                : probability >= 70 ? 'on track'
                : probability >= 50 ? 'borderline' : 'unlikely to complete';

            out.push({
                id, name: l.name, surname: l.surname, student_number: l.student_number,
                school_id: Number(l.school_id), school_name: l.school_name,
                marks_recorded: series.length,
                current_average: current == null ? null : Math.round(current),
                projected_final: projected == null ? null : Math.round(projected),
                trend_per_assessment: fit ? Math.round(fit.slope * Math.min(1, (fit.n - 1) / 4) * (0.4 + 0.6 * fit.r2) * 10) / 10 : null,
                direction,
                attendance_rate: attendance == null ? null : Math.round(attendance * 100),
                submission_rate: submission == null ? null : Math.round(submission * 100),
                completion_probability: probability,
                confidence, outlook,
                fit_quality: fit ? Math.round(fit.r2 * 100) / 100 : null,
            });
        }
        out.sort((x, y) => (x.completion_probability ?? 101) - (y.completion_probability ?? 101));
        const known = out.filter(x => x.completion_probability != null);
        res.json({
            generated_at: new Date().toISOString(),
            summary: {
                reviewed: out.length,
                on_track: known.filter(x => x.outlook === 'on track').length,
                borderline: known.filter(x => x.outlook === 'borderline').length,
                unlikely: known.filter(x => x.outlook === 'unlikely to complete').length,
                improving: out.filter(x => x.direction === 'improving').length,
                declining: out.filter(x => x.direction === 'declining').length,
                projected_pass_rate: known.length
                    ? Math.round(known.filter(x => (x.projected_final ?? 0) >= 50).length / known.length * 100) : null,
            },
            learners: out,
        });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. SCHEDULING — can the marking actually be done in time?
//
//  Every unmarked submission has a deadline (its assignment's marking due date).
//  Submissions are scheduled Earliest Deadline First, which is the optimal
//  ordering for meeting deadlines on a single worker: if any ordering can meet
//  them all, EDF does. Work is laid out day by day against a daily capacity,
//  and any submission that lands after its deadline is reported as a breach.
//
//  Where the plan is infeasible, the minimum daily capacity that would make it
//  feasible is computed, so a manager knows what help is actually needed.
//
//  Complexity: O(n log n) for the sort, O(n) for the layout.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/marking-schedule', auth, role('facilitator','admin'), async (req, res) => {
    try {
        await getDb();
        const today = todaySAST();
        const perDay = Math.max(1, Math.min(50, Number(req.query.per_day) || 8));
        const facilitator = req.user.role === 'facilitator';
        const who = facilitator ? 'AND a.facilitator_id = ?' : '';
        const p = facilitator ? [req.user.id] : [];

        const pending = await all(`
            SELECT su.id, su.submitted_at, a.marking_due_date, a.title,
                   a.facilitator_id, u.name || ' ' || u.surname AS facilitator,
                   st.name || ' ' || st.surname AS student_name
            FROM submissions su
            JOIN assignments a ON a.id = su.assignment_id
            JOIN users u ON u.id = a.facilitator_id
            JOIN users st ON st.id = su.student_id
            LEFT JOIN marks m ON m.submission_id = su.id
            WHERE m.id IS NULL AND a.close_date <= ? ${who}
            ORDER BY a.marking_due_date ASC, su.submitted_at ASC`, [today, ...p]);

        const groups = {};
        for (const row of pending) {
            const k = Number(row.facilitator_id);
            (groups[k] ||= { facilitator_id: k, facilitator: row.facilitator, items: [] }).items.push(row);
        }

        const dayOffset = (from, to) => Math.round((new Date(to) - new Date(from)) / 86400000);
        const addDays = (iso, n) => new Date(new Date(iso).getTime() + n * 86400000).toISOString().slice(0, 10);

        const plans = Object.values(groups).map(g => {
            // Earliest Deadline First
            const items = g.items.slice().sort((x, y) => String(x.marking_due_date).localeCompare(String(y.marking_due_date)));
            const days = [];
            let breaches = 0, overdue = 0, firstBreach = null;
            let dayIndex = 0, placedToday = 0;

            for (const it of items) {
                if (placedToday >= perDay) { dayIndex++; placedToday = 0; }
                const scheduled = addDays(today, dayIndex);
                // Work whose deadline has already passed is reported as overdue.
                // A breach is a deadline still ahead that this plan would miss.
                const alreadyOverdue = String(it.marking_due_date) < today;
                const late = !alreadyOverdue && scheduled > String(it.marking_due_date);
                if (alreadyOverdue) overdue++;
                if (late) { breaches++; if (!firstBreach) firstBreach = it; }
                (days[dayIndex] ||= { date: scheduled, items: [], late: 0, overdue: 0 });
                days[dayIndex].items.push({ submission_id: Number(it.id), student: it.student_name,
                    assignment: it.title, due: it.marking_due_date, late, overdue: alreadyOverdue });
                if (late) days[dayIndex].late++;
                if (alreadyOverdue) days[dayIndex].overdue++;
                placedToday++;
            }

            // Minimum daily capacity that would clear every deadline: for each
            // deadline, the work due by then divided by the days available.
            let required = 0;
            const sorted = items.slice();
            for (let i = 0; i < sorted.length; i++) {
                const daysAvailable = Math.max(1, dayOffset(today, sorted[i].marking_due_date) + 1);
                required = Math.max(required, Math.ceil((i + 1) / daysAvailable));
            }

            return {
                facilitator_id: g.facilitator_id, facilitator: g.facilitator,
                outstanding: items.length,
                overdue,
                status: overdue > 0 ? 'behind' : (breaches ? 'will miss deadlines' : 'on track'),
                days_of_work: days.length,
                per_day_assumed: perDay,
                required_per_day: required,
                feasible: breaches === 0,
                breaches,
                first_breach: firstBreach ? { student: firstBreach.student_name,
                    assignment: firstBreach.title, due: firstBreach.marking_due_date } : null,
                plan: days.slice(0, 10),
            };
        }).sort((a, b) => (b.overdue - a.overdue) || (b.breaches - a.breaches) || (b.outstanding - a.outstanding));

        res.json({
            generated_at: new Date().toISOString(),
            assumed_capacity_per_day: perDay,
            summary: {
                facilitators_with_work: plans.length,
                total_outstanding: plans.reduce((t, x) => t + x.outstanding, 0),
                at_risk_of_breach: plans.filter(x => x.breaches > 0).length,
                already_overdue: plans.reduce((t, x) => t + x.overdue, 0),
                behind_schedule: plans.filter(x => x.overdue > 0).length,
            },
            plans,
        });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  3. OPTIMAL ALLOCATION — where should limited equipment go?
//
//  Head office receives a batch of devices and must split them across schools.
//  Each school is scored on need (learners without a device), engagement
//  (attendance) and risk (learners flagged as likely to drop out). A device
//  placed at a school yields a benefit, and each further device yields slightly
//  less than the one before — the tenth device at a school of twelve learners
//  helps less than the first.
//
//  Because the benefit function is concave (diminishing returns) and the
//  devices are identical and indivisible, repeatedly giving the next device to
//  whichever school currently gains the most produces the allocation with the
//  highest achievable total benefit. The result is compared against an even
//  split so the improvement can be seen.
//
//  Complexity: O(D log S) for D devices across S schools using a priority queue;
//  implemented directly as O(D·S), which is trivial at ten schools.
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/allocation', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const available = Math.max(0, Math.min(5000, Number(req.query.devices) || 40));
        const today = todaySAST();

        const schools = await all(`
            SELECT s.id, s.name, s.location,
                (SELECT COUNT(*) FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id
                  WHERE u.school_id = s.id AND u.role='student' AND COALESCE(sp.status,'studying')='studying') AS learners,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id = a.session_id
                  WHERE se.school_id = s.id) AS att_total,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id = a.session_id
                  WHERE se.school_id = s.id AND a.status='present') AS att_present,
                (SELECT COUNT(*) FROM sessions se WHERE se.school_id = s.id) AS sessions
            FROM schools s ORDER BY s.name`);

        // Learners already provided for. Once the asset register exists this
        // reads from it; until then head office can pass ?held=id:count,...
        const held = {};
        String(req.query.held || '').split(',').filter(Boolean).forEach(pair => {
            const [id, count] = pair.split(':');
            held[Number(id)] = Number(count) || 0;
        });

        const risk = await all(`
            SELECT u.school_id AS id, COUNT(*) flagged FROM users u
            LEFT JOIN student_profiles sp ON sp.user_id = u.id
            WHERE u.role='student' AND COALESCE(sp.status,'studying')='studying'
              AND (SELECT COUNT(*) FROM attendance a WHERE a.student_id = u.id AND a.status='absent') >
                  (SELECT COUNT(*) FROM attendance a2 WHERE a2.student_id = u.id) * 0.4
            GROUP BY u.school_id`);
        const riskMap = {}; risk.forEach(r => { riskMap[Number(r.id)] = Number(r.flagged); });

        const rows = schools.map(s => {
            const learners = Number(s.learners);
            const attendance = Number(s.att_total) ? Number(s.att_present) / Number(s.att_total) : 0.5;
            const flagged = riskMap[Number(s.id)] || 0;
            const alreadyHeld = held[Number(s.id)] || 0;
            const unmet = Math.max(0, learners - alreadyHeld);
            // Priority: unmet need dominates, then engagement, then retention risk
            const priority = learners === 0 ? 0
                : 0.55 * (unmet / Math.max(1, learners))
                + 0.25 * attendance
                + 0.20 * (flagged / Math.max(1, learners));
            return { id: Number(s.id), name: s.name, location: s.location,
                learners, held: alreadyHeld, unmet, attendance: Math.round(attendance * 100),
                flagged, priority: Math.round(priority * 1000) / 1000, allocated: 0 };
        });

        // Benefit of the (k+1)-th device at a school, with diminishing returns
        const marginal = (r, k) => (k >= r.unmet || r.unmet === 0) ? 0
            : r.priority * (1 - k / r.unmet);

        // Greedy: always give the next device where it gains the most
        let benefit = 0;
        for (let d = 0; d < available; d++) {
            let best = null, bestGain = 0;
            for (const r of rows) {
                const g = marginal(r, r.allocated);
                if (g > bestGain) { bestGain = g; best = r; }
            }
            if (!best) break;
            best.allocated++;
            benefit += bestGain;
        }

        // Compare with the naive approach: split evenly regardless of need
        const evenShare = Math.floor(available / Math.max(1, rows.length));
        let evenBenefit = 0;
        for (const r of rows) {
            for (let k = 0; k < Math.min(evenShare, r.unmet); k++) evenBenefit += marginal(r, k);
        }

        const totalAllocated = rows.reduce((t, r) => t + r.allocated, 0);
        res.json({
            generated_at: new Date().toISOString(),
            devices_available: available,
            devices_allocated: totalAllocated,
            unallocated: available - totalAllocated,
            total_unmet_need: rows.reduce((t, r) => t + r.unmet, 0),
            benefit_score: Math.round(benefit * 100) / 100,
            even_split_score: Math.round(evenBenefit * 100) / 100,
            improvement_percent: evenBenefit > 0
                ? Math.round((benefit - evenBenefit) / evenBenefit * 100) : null,
            schools: rows.sort((a, b) => b.allocated - a.allocated),
        });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// The funder impact report — the artefact head office attaches to a proposal
app.get('/api/reports/impact', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const { from, to } = req.query;
        const range = [from || '2000-01-01', to || '2100-01-01'];

        const perSchool = await all(`
            SELECT s.id, s.name, s.location,
                (SELECT COUNT(*) FROM users u WHERE u.school_id=s.id AND u.role='student') AS learners,
                (SELECT COUNT(*) FROM sessions se WHERE se.school_id=s.id AND se.session_date BETWEEN ? AND ?) AS sessions,
                (SELECT COUNT(*) FROM sessions se WHERE se.school_id=s.id AND se.validated=1 AND se.session_date BETWEEN ? AND ?) AS validated_sessions,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                  WHERE se.school_id=s.id AND a.status='present' AND se.session_date BETWEEN ? AND ?) AS attendances,
                (SELECT COUNT(*) FROM attendance a JOIN sessions se ON se.id=a.session_id
                  WHERE se.school_id=s.id AND se.session_date BETWEEN ? AND ?) AS attendance_records
            FROM schools s ORDER BY s.name`, [...range, ...range, ...range, ...range]);

        for (const s of perSchool) {
            s.learners = Number(s.learners); s.sessions = Number(s.sessions);
            s.validated_sessions = Number(s.validated_sessions);
            s.attendance_rate = Number(s.attendance_records)
                ? Math.round(Number(s.attendances)/Number(s.attendance_records)*100) : null;
            s.contact_hours = s.sessions * 2;   // 2-hour sessions (programme standard)
        }

        // Marking-SLA compliance per facilitator
        const sla = await all(`
            SELECT u.id, u.name || ' ' || u.surname AS facilitator, u.employee_id,
                   COUNT(m.id) AS graded,
                   SUM(CASE WHEN date(m.graded_at) <= a.marking_due_date THEN 1 ELSE 0 END) AS within_sla,
                   ROUND(AVG(julianday(m.graded_at) - julianday(a.due_date)),1) AS avg_turnaround_days
            FROM marks m
            JOIN submissions su ON su.id=m.submission_id
            JOIN assignments a ON a.id=su.assignment_id
            JOIN users u ON u.id=m.graded_by
            GROUP BY u.id`);
        for (const r of sla) { r.graded=Number(r.graded); r.within_sla=Number(r.within_sla);
            r.sla_compliance = r.graded ? Math.round(r.within_sla/r.graded*100) : null; }

        const marksAgg = await get(`
            SELECT COUNT(*) c, ROUND(AVG(m.score*100.0/a.total_marks),1) avg,
                   SUM(CASE WHEN m.score*1.0/a.total_marks >= 0.5 THEN 1 ELSE 0 END) passed
            FROM marks m JOIN submissions su ON su.id=m.submission_id
            JOIN assignments a ON a.id=su.assignment_id`);

        const totals = {
            learners_reached: perSchool.reduce((t,s)=>t+s.learners,0),
            sessions_delivered: perSchool.reduce((t,s)=>t+s.sessions,0),
            contact_hours: perSchool.reduce((t,s)=>t+s.contact_hours,0),
            avg_attendance: (() => { const withData = perSchool.filter(s=>s.attendance_rate!=null);
                return withData.length ? Math.round(withData.reduce((t,s)=>t+s.attendance_rate,0)/withData.length) : null; })(),
            assessments_marked: Number(marksAgg?.c||0),
            average_mark: marksAgg?.avg != null ? Number(marksAgg.avg) : null,
            pass_rate: Number(marksAgg?.c) ? Math.round(Number(marksAgg.passed)/Number(marksAgg.c)*100) : null,
            data_integrity: (() => { const t = perSchool.reduce((x,s)=>x+s.sessions,0);
                const v = perSchool.reduce((x,s)=>x+s.validated_sessions,0);
                return t ? Math.round(v/t*100) : null; })(),
        };
        res.json({ generated_at: new Date().toISOString(), range: { from: from||'all', to: to||'all' },
                   totals, per_school: perSchool, marking_sla: sla });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  DEV: dataset switch (behind the tiny dot on the login page)
//  lean = 2 learners, 1 facilitator, 1 admin · demo = 10 learners, 5 facilitators, 1 admin
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/dev/reseed', async (req, res) => {
    try {
        // This endpoint wipes and regenerates the whole database, so it must not
        // be open on a public deployment. Locally it stays open for convenience;
        // in cloud mode it only works if ALLOW_DEMO_RESEED=true is set explicitly.
        const isCloud = (process.env.DB_MODE || 'local') === 'turso';
        if (isCloud && process.env.ALLOW_DEMO_RESEED !== 'true')
            return res.status(403).json({ error: 'Dataset switching is disabled on this deployment.' });

        const profile = req.body?.profile === 'demo' ? 'demo' : 'lean';
        await reseed(profile);
        res.json({ success: true, profile,
            message: profile === 'demo'
                ? 'Full demo dataset loaded: 162 learners (SC-2025-0001 upward), 10 facilitators (FAC-001…010), 1 admin (ADM-001). Passwords unchanged.'
                : 'Starter dataset restored: 2 learners (SC-2025-0001, SC-2025-0002), 1 facilitator (FAC-001), 1 admin (ADM-001).' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Reseed failed' }); }
});

// Convert upload/middleware errors (e.g. disallowed file types) into clean JSON
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const known = err.message === 'File type not allowed' || err.code === 'LIMIT_FILE_SIZE';
    if (!known) console.error(err);
    res.status(known ? 400 : 500).json({ error: known ? err.message : 'Server error' });
});

// School progress for sponsors: studying vs completed, per school and per module
app.get('/api/reports/progress', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const perSchool = await all(`
            SELECT s.id, s.name, s.location,
                SUM(CASE WHEN u.id IS NOT NULL AND COALESCE(sp.status,'studying')='studying' THEN 1 ELSE 0 END) AS studying,
                SUM(CASE WHEN sp.status='completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN sp.status='withdrawn' THEN 1 ELSE 0 END) AS withdrawn
            FROM schools s LEFT JOIN users u ON u.school_id=s.id AND u.role='student'
            LEFT JOIN student_profiles sp ON sp.user_id=u.id
            GROUP BY s.id ORDER BY s.name`);
        for (const r of perSchool) {
            r.studying=Number(r.studying||0); r.completed=Number(r.completed||0); r.withdrawn=Number(r.withdrawn||0);
            const done = r.completed + r.withdrawn;
            r.completion_rate = done ? Math.round(r.completed/done*100) : null;
        }
        const perModule = await all(`
            SELECT mo.code, mo.title,
                SUM(CASE WHEN e.status='studying' THEN 1 ELSE 0 END) AS studying,
                SUM(CASE WHEN e.status='completed' THEN 1 ELSE 0 END) AS completed
            FROM modules mo LEFT JOIN enrollments e ON e.module_id=mo.id
            GROUP BY mo.id ORDER BY mo.code`);
        for (const r of perModule) { r.studying=Number(r.studying||0); r.completed=Number(r.completed||0); }
        const totals = {
            studying: perSchool.reduce((t,r)=>t+r.studying,0),
            completed: perSchool.reduce((t,r)=>t+r.completed,0),
            withdrawn: perSchool.reduce((t,r)=>t+r.withdrawn,0),
        };
        res.json({ totals, per_school: perSchool, per_module: perModule });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── START ────────────────────────────────────────────────────────────────────
async function start() {
    await getDb();
    app.listen(PORT, '0.0.0.0', () => {
        const nets = require('os').networkInterfaces();
        const lan = Object.values(nets).flat().find(i => i.family==='IPv4' && !i.internal);
        console.log(`
╔════════════════════════════════════════════════════════╗
║   Social Coding LMS v2 · Group 29                      ║
║   Local:   http://localhost:${PORT}                        ║
║   Mobile:  http://${(lan?.address||'your-ip').padEnd(15)}:${PORT}              ║
╠════════════════════════════════════════════════════════╣
║   ADM-001      / admin123  →  Admin                    ║
║   FAC-001 … FAC-010 / pass123  →  Facilitators         ║
║   SC-2025-0001 / pass123   →  Learner (Amahle)         ║
╠════════════════════════════════════════════════════════╣
║   Full dataset: 10 schools, 162 learners, 10 staff     ║
║   Seeing only one active school? An older small        ║
║   database exists — stop the server, delete            ║
║   social_coding.db, then start it again.               ║
╚════════════════════════════════════════════════════════╝`);
    });
}
start();
