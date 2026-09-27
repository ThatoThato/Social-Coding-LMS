// db.js — Social Coding LMS Database (Group 29) — v2.1
// Seed profiles:
//   'demo' — full dataset: 162 learners, 10 facilitators, 1 admin, 10 schools.
//            Loaded automatically on first boot.
//   'lean' — starter dataset: 2 learners, 1 facilitator, 1 admin. Used when
//            SEED_PROFILE=lean, or chosen via the tiny dot on the login page
//            (POST /api/dev/reseed, disabled on the cloud deployment).
// Real curriculum content ships in ./seed-content and is copied into ./uploads
// at seed time, so slides, worksheets and assignment briefs are real PDFs.

require('dotenv').config();
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const SEED_DIR = path.join(__dirname, 'seed-content');
const UP_DIR   = path.join(__dirname, 'uploads');

let client;

async function getDb() {
    if (client) return client;
    const mode = process.env.DB_MODE || 'local';
    if (mode === 'turso') {
        if (!process.env.TURSO_URL || !process.env.TURSO_TOKEN)
            throw new Error('TURSO_URL and TURSO_TOKEN must be set in .env for Turso mode');
        client = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });
        console.log('🌐 Connected to Turso cloud database');
    } else {
        client = createClient({ url: 'file:social_coding.db' });
        console.log('📂 Using local SQLite database');
    }
    await createTables();
    const existing = await get(`SELECT COUNT(*) as cnt FROM users`);
    if (!existing || Number(existing.cnt) === 0) {
        await seed(process.env.SEED_PROFILE === 'lean' ? 'lean' : 'demo');   // full dataset by default
    } else {
        console.log('✅ Database already seeded');
        await backfill();   // an existing database may predate a later feature
    }
    return client;
}

async function run(sql, params = []) { return client.execute({ sql, args: params }); }
async function all(sql, params = []) {
    const res = await client.execute({ sql, args: params });
    return res.rows.map(r => ({ ...r }));
}
async function get(sql, params = []) { const rows = await all(sql, params); return rows[0] || null; }

// Today ± n days as YYYY-MM-DD in South African time
function d(offsetDays = 0) {
    const dt = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(dt);
}

// Copy a bundled content file into uploads/, return its size in KB (null if missing)
function placeFile(name) {
    try {
        if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });
        fs.copyFileSync(path.join(SEED_DIR, name), path.join(UP_DIR, name));
        return Math.max(1, Math.round(fs.statSync(path.join(UP_DIR, name)).size / 1024));
    } catch { console.warn('⚠ seed-content missing:', name); return null; }
}


// Bulk insert: one statement per chunk instead of one per row. With a few
// thousand attendance records this is the difference between seconds and minutes.
async function bulk(table, cols, rows, chunk = 150) {
    for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const ph = slice.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
        await run(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES ${ph}`, slice.flat());
    }
}

async function createTables() {
    const tables = [
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, surname TEXT NOT NULL,
            email TEXT UNIQUE,
            student_number TEXT UNIQUE,
            employee_id TEXT UNIQUE,
            password TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin','facilitator','student')),
            school_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS schools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, location TEXT NOT NULL,
            facilitator_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS modules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT,
            created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER NOT NULL, title TEXT NOT NULL, lesson_order INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id INTEGER NOT NULL, title TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('slides','document','link','video')),
            file_name TEXT, url TEXT, file_size_kb INTEGER,
            uploaded_by INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL, facilitator_id INTEGER NOT NULL, lesson_id INTEGER,
            session_date TEXT NOT NULL,
            session_type TEXT NOT NULL CHECK(session_type IN ('morning','afternoon','evening')),
            validated INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(school_id, session_date, session_type))`,
        `CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL, student_id INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('present','absent')),
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(session_id, student_id))`,
        `CREATE TABLE IF NOT EXISTS assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER, title TEXT NOT NULL, description TEXT,
            brief_file TEXT, total_marks INTEGER DEFAULT 100,
            submission_type TEXT NOT NULL DEFAULT 'code'
                CHECK(submission_type IN ('code','document','link','text')),
            open_date TEXT NOT NULL, due_date TEXT NOT NULL, close_date TEXT NOT NULL,
            marking_due_date TEXT NOT NULL, published INTEGER DEFAULT 1,
            facilitator_id INTEGER NOT NULL, school_id INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER NOT NULL, student_id INTEGER NOT NULL,
            notes TEXT, file_name TEXT, is_late INTEGER DEFAULT 0,
            submitted_at TEXT DEFAULT (datetime('now')),
            UNIQUE(assignment_id, student_id))`,
        `CREATE TABLE IF NOT EXISTS marks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            submission_id INTEGER NOT NULL UNIQUE,
            score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
            feedback TEXT, graded_by INTEGER NOT NULL,
            graded_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS module_schools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER NOT NULL, school_id INTEGER NOT NULL,
            active INTEGER DEFAULT 1,
            allocated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(module_id, school_id))`,
        `CREATE TABLE IF NOT EXISTS facilitator_modules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, module_id INTEGER NOT NULL,
            certified_on TEXT, certified_by INTEGER,
            -- Facilitators are trained rather than formally qualified, so each
            -- module they teach is signed off, and that sign-off is reviewed.
            status TEXT NOT NULL DEFAULT 'provisional'
                CHECK(status IN ('verified','provisional','expired')),
            verified_on TEXT, verified_by INTEGER, review_due TEXT, evidence TEXT,
            UNIQUE(user_id, module_id))`,
        `CREATE TABLE IF NOT EXISTS rubric_criteria (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER NOT NULL,
            label TEXT NOT NULL,              -- e.g. 'Correctness'
            descriptor TEXT,                  -- what earns full points
            max_points INTEGER NOT NULL,
            criterion_order INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS mark_criteria (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mark_id INTEGER NOT NULL,
            criterion_id INTEGER NOT NULL,
            points INTEGER NOT NULL,
            comment TEXT,
            UNIQUE(mark_id, criterion_id))`,
        `CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL, description TEXT, category TEXT NOT NULL,
            file_name TEXT, url TEXT, added_by INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS student_profiles (
            user_id INTEGER PRIMARY KEY,          -- 1:1 specialisation of users (role=student)
            grade TEXT,                            -- e.g. 'Grade 10'
            date_of_birth TEXT, gender TEXT,
            guardian_name TEXT, guardian_phone TEXT,
            enrolment_date TEXT, cohort TEXT,      -- e.g. '2025'
            status TEXT NOT NULL DEFAULT 'studying' CHECK(status IN ('studying','completed','withdrawn')))`,
        `CREATE TABLE IF NOT EXISTS facilitator_profiles (
            user_id INTEGER PRIMARY KEY,          -- 1:1 specialisation of users (role=facilitator)
            phone TEXT, qualification TEXT,
            specialisation TEXT, start_date TEXT)`,
        `CREATE TABLE IF NOT EXISTS enrollments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, -- historical record: who studied what, and outcome
            student_id INTEGER NOT NULL, module_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'studying' CHECK(status IN ('studying','completed','withdrawn')),
            enrolled_at TEXT, completed_at TEXT,
            UNIQUE(student_id, module_id))`,
        `CREATE TABLE IF NOT EXISTS sponsors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organisation TEXT NOT NULL,
            contact_person TEXT, email TEXT, phone TEXT,
            focus_area TEXT,                     -- e.g. 'STEM education', 'Digital inclusion'
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','prospective','lapsed')),
            notes TEXT, created_at TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE IF NOT EXISTS sponsorships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sponsor_id INTEGER NOT NULL,
            school_id INTEGER NOT NULL,
            annual_amount INTEGER,               -- Rand per year
            start_date TEXT, end_date TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(sponsor_id, school_id))`,
    ];
    for (const sql of tables) await run(sql);

    // Indexes. Without these, every filtered query scans the whole table —
    // fine at 180 learners, painful at 900, unusable at 5 000.
    const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_users_school_role ON users(school_id, role)`,
        `CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id)`,
        `CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id)`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_school_date ON sessions(school_id, session_date)`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_facilitator ON sessions(facilitator_id)`,
        `CREATE INDEX IF NOT EXISTS idx_assignments_school ON assignments(school_id, close_date)`,
        `CREATE INDEX IF NOT EXISTS idx_assignments_facilitator ON assignments(facilitator_id)`,
        `CREATE INDEX IF NOT EXISTS idx_assignments_module ON assignments(module_id)`,
        `CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id)`,
        `CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id)`,
        `CREATE INDEX IF NOT EXISTS idx_marks_graded_by ON marks(graded_by)`,
        `CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id)`,
        `CREATE INDEX IF NOT EXISTS idx_lessons_module ON lessons(module_id)`,
        `CREATE INDEX IF NOT EXISTS idx_materials_lesson ON materials(lesson_id)`,
        `CREATE INDEX IF NOT EXISTS idx_module_schools_school ON module_schools(school_id, active)`,
        `CREATE INDEX IF NOT EXISTS idx_fac_modules_user ON facilitator_modules(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_rubric_assignment ON rubric_criteria(assignment_id)`,
        `CREATE INDEX IF NOT EXISTS idx_mark_criteria_mark ON mark_criteria(mark_id)`,
        `CREATE INDEX IF NOT EXISTS idx_student_profiles_status ON student_profiles(status)`,
    ];
    for (const sql of indexes) await run(sql);
}

async function wipeData() {
    for (const t of ['mark_criteria','rubric_criteria','module_schools','facilitator_modules','enrollments','student_profiles','facilitator_profiles','sponsorships','sponsors','attendance','sessions','marks','submissions','assignments',
                     'materials','lessons','modules','readings','users','schools'])
        await run(`DELETE FROM ${t}`);
}

// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
//  BACKFILL — repair a database that was seeded before a feature existed
//
//  Seeding only runs against an empty database, so that a deployment can never
//  wipe real records. The side effect is that tables added in a later version
//  stay empty on an existing database, and any query joining against them
//  quietly returns nothing. That is how a deployed site can show every module
//  to an administrator and none at all to a facilitator.
//
//  This runs on every start, fills only what is missing, and is silent when
//  there is nothing to do.
// ═════════════════════════════════════════════════════════════════════════════
async function backfill() {
    const count = async (table) => Number((await get(`SELECT COUNT(*) c FROM ${table}`))?.c || 0);
    const repairs = [];

    const modules = await all(`SELECT id, code FROM modules`);
    const schools = await all(`SELECT id FROM schools`);

    // 1. Which modules run at which school. Without a row here a school sees
    //    no curriculum at all, so an empty table is filled permissively:
    //    every module runs everywhere until head office says otherwise.
    if (modules.length && schools.length && (await count('module_schools')) === 0) {
        const rows = [];
        for (const s of schools) for (const m of modules) rows.push([m.id, s.id, 1]);
        await bulk('module_schools', ['module_id', 'school_id', 'active'], rows);
        repairs.push(`allocated ${modules.length} modules to ${schools.length} schools`);
    }

    // 2. What each facilitator is signed off to teach. Existing staff are
    //    marked provisional rather than verified — the system should not
    //    invent a verification nobody performed.
    if (modules.length && (await count('facilitator_modules')) === 0) {
        const facs = await all(`SELECT id, school_id FROM users WHERE role='facilitator'`);
        const rows = [];
        for (const f of facs) {
            const running = await all(`
                SELECT module_id FROM module_schools WHERE school_id = ? AND active = 1`, [f.school_id]);
            for (const r of running) rows.push([f.id, r.module_id, 'provisional']);
        }
        if (rows.length) {
            await bulk('facilitator_modules', ['user_id', 'module_id', 'status'], rows);
            repairs.push(`${rows.length} facilitator sign-offs created as provisional`);
        }
    }

    // 3. Marking criteria. An assignment with no rubric cannot be marked at
    //    all, because the grading screen has nothing to score against.
    const DEFAULTS = {
        code:     [['Correctness', 'The program runs and produces the expected output', 40],
                   ['Completeness', 'Every task in the brief is attempted', 25],
                   ['Code quality', 'Sensible names, tidy structure, no repetition', 20],
                   ['Comments', 'The code explains what it is doing', 15]],
        document: [['Content', 'Covers everything the brief asked for', 45],
                   ['Understanding', 'Explains the concepts in their own words', 30],
                   ['Presentation', 'Clear structure, readable, referenced', 25]],
        link:     [['Functionality', 'The site or page works as described', 40],
                   ['Requirements', 'All required elements are present', 35],
                   ['Presentation', 'Layout and styling are considered', 25]],
        text:     [['Accuracy', 'Answers are correct', 50],
                   ['Reasoning', 'Working and explanation are shown', 30],
                   ['Clarity', 'Written clearly', 20]],
    };
    const noRubric = await all(`
        SELECT a.id, COALESCE(a.submission_type, 'code') AS submission_type
        FROM assignments a
        WHERE NOT EXISTS (SELECT 1 FROM rubric_criteria rc WHERE rc.assignment_id = a.id)`);
    if (noRubric.length) {
        const rows = [];
        for (const a of noRubric) {
            const set = DEFAULTS[a.submission_type] || DEFAULTS.code;
            set.forEach(([label, descriptor, pts], i) =>
                rows.push([a.id, label, descriptor, pts, i + 1]));
        }
        await bulk('rubric_criteria',
            ['assignment_id', 'label', 'descriptor', 'max_points', 'criterion_order'], rows);
        repairs.push(`${noRubric.length} assignments given marking criteria`);
    }

    // 4. Assignments created before hand-in types existed
    const untyped = await run(`UPDATE assignments SET submission_type='code' WHERE submission_type IS NULL`);
    if (untyped?.rowsAffected) repairs.push(`${untyped.rowsAffected} assignments defaulted to a code hand-in`);

    if (repairs.length) {
        console.log('🔧 Backfilled existing data:');
        repairs.forEach(r => console.log('   ·', r));
    }
}

async function seed(profile = 'lean') {
    console.log(`🌱 Seeding '${profile}' dataset...`);
    const hash = pw => bcrypt.hashSync(pw, 10);
    const uid = {};   // login_id -> user id

    // Schools
    const schoolData = [
        ['Thembalethu High School','KwaZulu-Natal'],['Siyabonga Secondary','Limpopo'],
        ['Isipho High School','Gauteng'],['Ubuntu Primary','Eastern Cape'],
        ['Nkosi Secondary','North West'],['Luthuli High','Mpumalanga'],
        ['Sizwe Technical','Free State'],['Phambili Primary','Northern Cape'],
        ['Masakhane High','Western Cape'],['Ikusasa Primary','Eastern Cape'],
    ];
    for (const [n,l] of schoolData) await run(`INSERT INTO schools (name,location) VALUES (?,?)`,[n,l]);
    const schools = await all(`SELECT id FROM schools ORDER BY id`);
    const sch = i => Number(schools[i-1].id);

    async function addUser(name, surname, loginId, role, schoolIdx, pw) {
        const isStudent = role === 'student';
        await run(`INSERT INTO users (name,surname,student_number,employee_id,password,role,school_id)
                   VALUES (?,?,?,?,?,?,?)`,
            [name, surname, isStudent ? loginId : null, isStudent ? null : loginId,
             hash(pw), role, schoolIdx ? sch(schoolIdx) : null]);
        const u = await get(`SELECT id FROM users WHERE student_number=? OR employee_id=?`, [loginId, loginId]);
        uid[loginId] = Number(u.id);
    }

    // ── Users ────────────────────────────────────────────────────────────────
    await addUser('System','Admin','ADM-001','admin', null, 'admin123');
    await addUser('Sibusiso','Mkhize','FAC-001','facilitator', 1, 'pass123');
    await run(`UPDATE schools SET facilitator_id=? WHERE id=?`, [uid['FAC-001'], sch(1)]);

    let school1Students;
    if (profile === 'demo') {
        for (const [n,s,id,scIdx] of [['Nomsa','Ndlovu','FAC-002',2],['Thabo','Maluleke','FAC-003',3],
                                      ['Lerato','Mabaso','FAC-004',4],['Kagiso','Mohapi','FAC-005',5]]) {
            await addUser(n,s,id,'facilitator',scIdx,'pass123');
            await run(`UPDATE schools SET facilitator_id=? WHERE id=?`, [uid[id], sch(scIdx)]);
        }
        for (const [n,s,num,scIdx] of [
            ['Amahle','Dlamini','SC-2025-0001',1],['Sipho','Khumalo','SC-2025-0002',1],
            ['Naledi','Mokoena','SC-2025-0003',1],['Tebogo','Sithole','SC-2025-0004',1],
            ['Zanele','Nkosi','SC-2025-0005',1],['Lungelo','Zulu','SC-2025-0006',1],
            ['Precious','Ndlovu','SC-2025-0007',2],['Bongani','Mthembu','SC-2025-0008',2],
            ['Karabo','Molefe','SC-2025-0009',3],['Ayanda','Mahlangu','SC-2025-0010',4],
        ]) await addUser(n,s,num,'student',scIdx,'pass123');
        school1Students = ['SC-2025-0001','SC-2025-0002','SC-2025-0003','SC-2025-0004','SC-2025-0005','SC-2025-0006'];
    } else {
        await addUser('Amahle','Dlamini','SC-2025-0001','student',1,'pass123');
        await addUser('Sipho','Khumalo','SC-2025-0002','student',1,'pass123');
        school1Students = ['SC-2025-0001','SC-2025-0002'];
    }
    const s1 = school1Students.map(k => uid[k]);

    // ── Specialised profiles ────────────────────────────────────────────────
    const facProfiles = { 'FAC-001':['082 555 0101','PathMakers Certified Facilitator','Python & Web Development', d(-420)],
        'FAC-002':['083 555 0202','PathMakers Certified Facilitator','Web Development', d(-360)],
        'FAC-003':['084 555 0303','PathMakers Certified Facilitator','Digital Literacy', d(-300)],
        'FAC-004':['081 555 0404','PathMakers Certified Facilitator','Python', d(-250)],
        'FAC-005':['079 555 0505','PathMakers Certified Facilitator','Cyber Safety', d(-200)] };
    for (const [eid, [ph,q,sp,sd]] of Object.entries(facProfiles))
        if (uid[eid]) await run(`INSERT INTO facilitator_profiles (user_id,phone,qualification,specialisation,start_date) VALUES (?,?,?,?,?)`,
            [uid[eid], ph, q, sp, sd]);

    const stuProfiles = { // num: [grade, dob, gender, guardian, guardianPhone]
        'SC-2025-0001':['Grade 10','2009-03-14','F','Nomusa Dlamini','082 111 0001'],
        'SC-2025-0002':['Grade 11','2008-07-22','M','Petros Khumalo','083 111 0002'],
        'SC-2025-0003':['Grade 10','2009-01-30','F','Dikeledi Mokoena','084 111 0003'],
        'SC-2025-0004':['Grade 12','2007-11-05','M','Grace Sithole','081 111 0004'],
        'SC-2025-0005':['Grade 11','2008-05-18','F','Sizwe Nkosi','079 111 0005'],
        'SC-2025-0006':['Grade 10','2009-09-02','M','Thandiwe Zulu','082 111 0006'],
        'SC-2025-0007':['Grade 11','2008-02-12','F','Jabu Ndlovu','083 111 0007'],
        'SC-2025-0008':['Grade 12','2007-06-25','M','Lindiwe Mthembu','084 111 0008'],
        'SC-2025-0009':['Grade 10','2009-04-09','M','Refilwe Molefe','081 111 0009'],
        'SC-2025-0010':['Grade 11','2008-10-17','F','Sibongile Mahlangu','079 111 0010'] };
    for (const [num, [g,dob,gen,gn,gp]] of Object.entries(stuProfiles))
        if (uid[num]) await run(`INSERT INTO student_profiles (user_id,grade,date_of_birth,gender,guardian_name,guardian_phone,enrolment_date,cohort,status)
            VALUES (?,?,?,?,?,?,?,?,'studying')`, [uid[num], g, dob, gen, gn, gp, d(-180), '2025']);

    // ── Historical data: alumni who COMPLETED (visible to sponsors as progress) ──
    const alumni = profile === 'demo'
        ? [['Thulani','Ngcobo','SC-2024-0012',1],['Buhle','Zwane','SC-2024-0018',1],['Nomvula','Cele','SC-2024-0021',2]]
        : [['Thulani','Ngcobo','SC-2024-0012',1],['Buhle','Zwane','SC-2024-0018',1]];
    for (const [n,s,num,scIdx] of alumni) {
        await addUser(n,s,num,'student',scIdx,'pass123');
        await run(`INSERT INTO student_profiles (user_id,grade,date_of_birth,gender,guardian_name,guardian_phone,enrolment_date,cohort,status)
            VALUES (?,?,?,?,?,?,?,?,'completed')`, [uid[num],'Grade 12','2006-08-11','M','Sarah Ngcobo','082 555 1212', d(-560),'2024']);
    }


    // ── Curriculum with REAL content files ──────────────────────────────────
    for (const [c,t,de] of [
        ['SC101','Introduction to Python','Variables, control flow, functions and problem solving.'],
        ['SC102','Web Development Fundamentals','HTML, CSS and JavaScript for building real pages.'],
        ['SC103','Digital Literacy & Cyber Safety','Safe, confident and productive use of the internet.'],
    ]) await run(`INSERT INTO modules (code,title,description) VALUES (?,?,?)`,[c,t,de]);
    const mod = {}; for (const m of await all(`SELECT id,code FROM modules`)) mod[m.code] = Number(m.id);

    for (const [c,t,o] of [
        ['SC101','Variables & Data Types',1],['SC101','Control Flow: If & Loops',2],['SC101','Functions',3],
        ['SC102','HTML Structure',1],['SC102','Styling with CSS',2],['SC102','JavaScript Basics',3],
        ['SC103','Staying Safe Online',1],['SC103','Search & Research Skills',2],
    ]) await run(`INSERT INTO lessons (module_id,title,lesson_order) VALUES (?,?,?)`,[mod[c],t,o]);
    const les = {}; for (const l of await all(`SELECT id,module_id,lesson_order FROM lessons`))
        les[`${l.module_id}-${l.lesson_order}`] = Number(l.id);
    const L = (code, order) => les[`${mod[code]}-${order}`];

    for (const [lid,title,kind,fname] of [
        [L('SC101',1),'Lesson 1 Slides — Variables & Data Types','slides','SC101-L1-variables-slides.pdf'],
        [L('SC101',1),'Python Variables Cheat Sheet','document','SC101-L1-cheatsheet.pdf'],
        [L('SC101',2),'Lesson 2 Worksheet — If & Loops (5 exercises)','document','SC101-L2-loops-worksheet.pdf'],
        [L('SC101',3),'Lesson 3 Notes — Functions','document','SC101-L3-functions-notes.pdf'],
        [L('SC102',1),'Lesson 1 Guide — HTML Structure','slides','SC102-L1-html-guide.pdf'],
        [L('SC102',2),'Lesson 2 Guide — Styling with CSS','document','SC102-L2-css-guide.pdf'],
        [L('SC103',1),'Guide — Staying Safe Online','document','SC103-L1-online-safety.pdf'],
    ]) {
        const kb = placeFile(fname);
        await run(`INSERT INTO materials (lesson_id,title,kind,file_name,url,file_size_kb,uploaded_by) VALUES (?,?,?,?,?,?,?)`,
            [lid, title, kind, kb ? fname : null, kb ? null : 'https://docs.python.org/3/tutorial/', kb, uid['FAC-001']]);
    }
    await run(`INSERT INTO materials (lesson_id,title,kind,url,uploaded_by) VALUES (?,?,?,?,?)`,
        [L('SC102',3),'MDN — JavaScript First Steps (online)','link',
         'https://developer.mozilla.org/en-US/docs/Learn/JavaScript/First_steps', uid['FAC-001']]);

    // ── Enrollments: current cohort studying, alumni completed ──────────────
    for (let i=0;i<s1.length;i++) {
        // SC101 completed by those who passed A1; SC102 in progress
        const passed = i !== 1;   // Sipho (58) passed too, but keep one 'studying' for variety
        await run(`INSERT INTO enrollments (student_id,module_id,status,enrolled_at,completed_at) VALUES (?,?,?,?,?)`,
            [s1[i], mod['SC101'], passed?'completed':'studying', d(-180), passed?d(-8):null]);
        await run(`INSERT INTO enrollments (student_id,module_id,status,enrolled_at) VALUES (?,?,'studying',?)`,
            [s1[i], mod['SC102'], d(-60)]);
    }
    for (const [,,num] of alumni)
        for (const code of ['SC101','SC102','SC103'])
            await run(`INSERT INTO enrollments (student_id,module_id,status,enrolled_at,completed_at) VALUES (?,?,'completed',?,?)`,
                [uid[num], mod[code], d(-560), d(-310)]);
    if (profile === 'demo')
        for (const num of ['SC-2025-0007','SC-2025-0008','SC-2025-0009','SC-2025-0010'])
            await run(`INSERT INTO enrollments (student_id,module_id,status,enrolled_at) VALUES (?,?,'studying',?)`,
                [uid[num], mod['SC101'], d(-120)]);

    // ── Sessions & attendance (Thembalethu / FAC-001) ───────────────────────
    const sessionDates = [
        [-28,'morning',L('SC101',1)],[-26,'morning',L('SC101',1)],[-21,'morning',L('SC101',2)],
        [-19,'afternoon',L('SC101',2)],[-14,'morning',L('SC101',3)],[-12,'morning',L('SC102',1)],
        [-7,'afternoon',L('SC102',2)],[-5,'morning',L('SC102',3)],
    ];
    for (const [off,t,lid] of sessionDates)
        await run(`INSERT INTO sessions (school_id,facilitator_id,lesson_id,session_date,session_type,validated) VALUES (?,?,?,?,?,1)`,
            [sch(1), uid['FAC-001'], lid, d(off), t]);
    const ses1 = await all(`SELECT id FROM sessions WHERE school_id=? ORDER BY session_date`, [sch(1)]);
    // Sipho absent for the three most recent sessions -> triggers the streak signal
    const absentAt = { 2:0, 4:(s1.length>3?3:0), 5:1 % s1.length, 6:1 % s1.length, 7:1 % s1.length };
    for (let si=0; si<ses1.length; si++)
        for (let sti=0; sti<s1.length; sti++)
            await run(`INSERT INTO attendance (session_id,student_id,status) VALUES (?,?,?)`,
                [ses1[si].id, s1[sti], absentAt[si]===sti ? 'absent':'present']);

    if (profile === 'demo') {
        for (const [scIdx, fac, dates, kids] of [
            [2,'FAC-002',[[-8,'morning'],[-3,'morning']],['SC-2025-0007','SC-2025-0008']],
            [3,'FAC-003',[[-6,'afternoon']],['SC-2025-0009']],
        ]) {
            for (const [off,typ] of dates) {
                await run(`INSERT INTO sessions (school_id,facilitator_id,session_date,session_type,validated) VALUES (?,?,?,?,1)`,
                    [sch(scIdx), uid[fac], d(off), typ]);
                const s = await get(`SELECT id FROM sessions WHERE school_id=? AND session_date=? AND session_type=?`,
                    [sch(scIdx), d(off), typ]);
                for (const k of kids)
                    await run(`INSERT INTO attendance (session_id,student_id,status) VALUES (?,?,'present')`, [s.id, uid[k]]);
            }
        }
    }

    // ── Assignments: real briefs + every lifecycle state visible today ──────
    async function addAssignment(code,title,desc,briefName,openOff,dueOff,closeOff,facId,schoolId) {
        placeFile(briefName);
        await run(`INSERT INTO assignments (module_id,title,description,brief_file,total_marks,open_date,due_date,close_date,marking_due_date,facilitator_id,school_id)
                   VALUES (?,?,?,?,100,?,?,?,?,?,?)`,
            [mod[code], title, desc, briefName, d(openOff), d(dueOff), d(closeOff), d(dueOff+7), facId, schoolId]);
        return Number((await get(`SELECT id FROM assignments WHERE title=? AND school_id=?`,[title,schoolId])).id);
    }
    const a1 = await addAssignment('SC101','A1 · Python Basics','Variables, types, input and f-strings — one file: about_me.py. Full brief attached.','brief-A1-python-basics.pdf',-25,-18,-16,uid['FAC-001'],sch(1));
    const a2 = await addAssignment('SC101','A2 · Control Flow Challenge','The five worksheet problems in one file: control_flow.py. Full brief attached.','brief-A2-control-flow.pdf',-12,-4,-2,uid['FAC-001'],sch(1));
    const a3 = await addAssignment('SC102','A3 · Build a 2-Page Website','index.html + about.html, linked both ways, styled with CSS. Full brief attached.','brief-A3-website.pdf',-5,3,5,uid['FAC-001'],sch(1));
    await addAssignment('SC102','A4 · JavaScript Mini-Project','An airtime top-up calculator with VAT and bundle maths. Full brief attached.','brief-A4-js-project.pdf',4,14,16,uid['FAC-001'],sch(1));

    // A1 — RETURNED: all submitted, all marked; one below pass; last mark 1 day past SLA
    for (const sid of s1)
        await run(`INSERT INTO submissions (assignment_id,student_id,notes,submitted_at) VALUES (?,?,?,?)`,
            [a1, sid, 'about_me.py attached', d(-19)+' 14:02:00']);
    const sub1 = await all(`SELECT id FROM submissions WHERE assignment_id=? ORDER BY id`,[a1]);
    const g1 = [82,38,92,42,78,88].slice(0, sub1.length);   // index 1 (Sipho) is the at-risk case
    for (let i=0;i<sub1.length;i++)
        await run(`INSERT INTO marks (submission_id,score,feedback,graded_by,graded_at) VALUES (?,?,?,?,?)`,
            [sub1[i].id, g1[i],
             g1[i]>=80 ? 'Excellent — clean logic and clear comments.' :
             g1[i]<50  ? 'Below the pass mark — come see me and we will go through it together.' :
                         'Good effort. Practise the input conversion pattern.',
             uid['FAC-001'], (i===sub1.length-1 ? d(-10) : d(-15))+' 10:00:00']);

    // A2 — MARKING WINDOW: most submitted (one late), about half marked
    const lateIdx = s1.length - 1;
    for (let i=0;i<s1.length;i++) {
        if (i === 1) continue;                     // Sipho never submitted A2
        if (s1.length > 3 && i === 3) continue;    // demo: Tebogo also missed it
        const late = i === lateIdx ? 1 : 0;
        await run(`INSERT INTO submissions (assignment_id,student_id,notes,is_late,submitted_at) VALUES (?,?,?,?,?)`,
            [a2, s1[i], 'control_flow.py attached', late, d(late?-3:-5)+' 09:30:00']);
    }
    const sub2 = await all(`SELECT id FROM submissions WHERE assignment_id=? ORDER BY id`,[a2]);
    const g2=[88,79,95,67];
    for (let i=0;i<Math.max(1, Math.floor(sub2.length/2));i++)
        await run(`INSERT INTO marks (submission_id,score,feedback,graded_by,graded_at) VALUES (?,?,?,?,?)`,
            [sub2[i].id, g2[i%4],
             ['Great problem solving on FizzBuzz!','Watch your loop bounds on Exercise 3.','Perfect score — outstanding work.','Solid; tidy up your comments.'][i%4],
             uid['FAC-001'], d(-2)+' 16:00:00']);

    // A3 — OPEN: one early submission
    await run(`INSERT INTO submissions (assignment_id,student_id,notes) VALUES (?,?,?)`,
        [a3, s1[0], 'site.zip attached — submitted early']);

    // Demo: FAC-002 also has a closed, fully-marked assignment (one mark past SLA)
    if (profile === 'demo') {
        const a5 = await addAssignment('SC101','A1 · Python Basics (Siyabonga)','Variables, types, input and f-strings. Full brief attached.','brief-A1-python-basics.pdf',-16,-10,-8,uid['FAC-002'],sch(2));
        for (const k of ['SC-2025-0007','SC-2025-0008'])
            await run(`INSERT INTO submissions (assignment_id,student_id,notes,submitted_at) VALUES (?,?,?,?)`,
                [a5, uid[k], 'about_me.py attached', d(-11)+' 11:00:00']);
        const sub5 = await all(`SELECT id FROM submissions WHERE assignment_id=? ORDER BY id`,[a5]);
        const g5=[74,61];
        for (let i=0;i<sub5.length;i++)
            await run(`INSERT INTO marks (submission_id,score,feedback,graded_by,graded_at) VALUES (?,?,?,?,?)`,
                [sub5[i].id, g5[i], 'Marked — see comments in class.', uid['FAC-002'],
                 (i===1 ? d(-2) : d(-6))+' 12:00:00']);   // second mark misses the SLA
    }

    // ── Sponsors & sponsorships (the funders the impact report exists for) ──
    const sponsorRows = profile === 'demo' ? [] : [
        ['Ubuntu Digital Trust','Naledi Khoza','grants@ubuntudigital.org.za','011 555 0142','STEM education','active','Requires quarterly attendance & outcomes reporting.'],
    ];
    for (const [o,c,e,p,f2,st,n] of sponsorRows)
        await run(`INSERT INTO sponsors (organisation,contact_person,email,phone,focus_area,status,notes) VALUES (?,?,?,?,?,?,?)`,[o,c,e,p,f2,st,n]);
    const spo = {}; for (const s of await all(`SELECT id,organisation FROM sponsors`)) spo[s.organisation]=Number(s.id);
    const spons = profile === 'demo' ? [] : [['Ubuntu Digital Trust',1,180000]];
    for (const [org,scIdx,amt] of spons)
        await run(`INSERT INTO sponsorships (sponsor_id,school_id,annual_amount,start_date,end_date) VALUES (?,?,?,?,?)`,
            [spo[org], sch(scIdx), amt, d(-200), d(165)]);

    // Readings
    for (const [ti,de,c,u] of [
        ['Python for Beginners','Official Python tutorial — start here.','Programming','https://docs.python.org/3/tutorial/'],
        ['Staying Safe Online','National cyber-safety resources.','Cyber Safety','https://staysafeonline.org'],
        ['Intro to Web Dev','MDN Learn: HTML, CSS and JS.','Web Development','https://developer.mozilla.org/en-US/docs/Learn'],
    ]) await run(`INSERT INTO readings (title,description,category,url,added_by) VALUES (?,?,?,?,?)`,[ti,de,c,u,uid['ADM-001']]);

    if (profile === 'demo') await seedLarge({ sch, hash });

    console.log(`✅ '${profile}' seed complete — real materials in place, all lifecycle states live today`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  LARGE DEMO DATASET — a full programme year across all ten schools.
//  Deterministic (no randomness) so every demo run looks identical.
// ═════════════════════════════════════════════════════════════════════════════

// Deterministic pseudo-random in [0,1) — same demo every time it is seeded.
function prand(n) { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); }

// Every learner gets a consistent profile, so their attendance, submission rate
// and marks agree with each other instead of being independently random.
//   ability    drives marks
//   engagement drives attendance and whether work gets handed in
//   trend      -1 declining, 0 steady, +1 improving
function learnerProfile(sid) {
    const r = prand(sid), r2 = prand(sid + 7777), r3 = prand(sid + 4242);
    let ability, engagement;
    if (r < 0.12)      { ability = 0.82 + r2 * 0.18; engagement = 0.85 + r3 * 0.15; }  // 12% excelling
    else if (r < 0.42) { ability = 0.60 + r2 * 0.22; engagement = 0.72 + r3 * 0.24; }  // 30% doing well
    else if (r < 0.72) { ability = 0.42 + r2 * 0.20; engagement = 0.55 + r3 * 0.28; }  // 30% middling
    else if (r < 0.90) { ability = 0.26 + r2 * 0.18; engagement = 0.35 + r3 * 0.30; }  // 18% struggling
    else               { ability = 0.10 + r2 * 0.18; engagement = 0.12 + r3 * 0.28; }  // 10% at serious risk
    const t = prand(sid + 999);
    return { ability, engagement, trend: t < 0.18 ? -1 : (t > 0.84 ? 1 : 0) };
}

async function seedLarge(ctx) {
    const { sch, hash } = ctx;
    console.log('   generating full programme dataset...');
    // Every demo account uses the same password, so hash it once. bcrypt is
    // deliberately slow; hashing per row would add ~13 seconds to the reseed.
    const PW = hash('pass123');

    const FIRST = ['Amahle','Sipho','Naledi','Tebogo','Zanele','Lungelo','Precious','Bongani','Karabo','Ayanda',
        'Thandiwe','Sizwe','Nomsa','Mpho','Refilwe','Katlego','Lerato','Themba','Nosipho','Kagiso',
        'Palesa','Andile','Busisiwe','Tshepo','Nandi','Siyabonga','Lindiwe','Musa','Zodwa','Olwethu',
        'Anele','Buhle','Dineo','Fikile','Gugu','Hlengiwe','Itumeleng','Jabulani','Khanya','Lwazi'];
    const LAST = ['Dlamini','Khumalo','Mokoena','Sithole','Nkosi','Zulu','Ndlovu','Mthembu','Molefe','Mahlangu',
        'Mabaso','Ngcobo','Zwane','Cele','Sekgobela','Maluleke','Mohapi','Radebe','Shabalala','Tshabalala',
        'Baloyi','Chauke','Dube','Gumede','Hadebe','Ismail','Jantjies','Kunene','Langa','Masondo'];
    const nameFor = i => [FIRST[i % FIRST.length], LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length]];

    // ── Facilitators for every remaining school (FAC-006 … FAC-010) ──────────
    const facRows = [];
    for (let s = 6; s <= 10; s++) {
        const [fn, ln] = nameFor(s * 3 + 11);
        facRows.push([fn, ln, null, `FAC-${String(s).padStart(3,'0')}`, PW, 'facilitator', sch(s)]);
    }
    await bulk('users', ['name','surname','student_number','employee_id','password','role','school_id'], facRows);
    const facs = await all(`SELECT id, employee_id, school_id FROM users WHERE role='facilitator'`);
    const facBySchool = {}; facs.forEach(f => { facBySchool[Number(f.school_id)] = Number(f.id); });
    for (const [scId, fid] of Object.entries(facBySchool))
        await run(`UPDATE schools SET facilitator_id=? WHERE id=? AND facilitator_id IS NULL`, [fid, scId]);
    for (let s = 6; s <= 10; s++)
        await run(`INSERT OR IGNORE INTO facilitator_profiles (user_id,phone,qualification,specialisation,start_date)
                   VALUES (?,?,?,?,?)`,
            [facBySchool[sch(s)], `08${s} 555 0${s}00`, 'PathMakers Certified Facilitator',
             ['Python','Web Development','Digital Literacy','Cyber Safety','Data Skills'][s % 5], d(-300 - s*10)]);

    // ── Learners: ~150 across all ten schools, three cohort states ───────────
    // Top every school up to the same size so any school filter shows a full class
    // Set SEED_SCALE to multiply the dataset for load testing, e.g. SEED_SCALE=5
    const SCALE = Math.max(1, Number(process.env.SEED_SCALE) || 1);
    // Schools differ in size, as they do in reality: an established site runs a
    // full class, a newer one starts small. This matters for allocation planning.
    const SIZES = [26, 22, 19, 18, 16, 15, 14, 12, 11, 9];
    const existing = await all(`SELECT school_id, COUNT(*) c FROM users WHERE role='student' GROUP BY school_id`);
    const have = {}; existing.forEach(r => { have[Number(r.school_id)] = Number(r.c); });
    const learnerRows = [], profileRows = [];
    let n = 0;
    for (let s = 1; s <= 10; s++) {
        const need = Math.max(0, SIZES[s - 1] * SCALE - (have[sch(s)] || 0));
        for (let k = 0; k < need; k++) {
            n++;
            const [fn, ln] = nameFor(n * 3 + s);
            // roughly: 78% studying (2025), 17% completed (2024), 5% withdrawn
            const bucket = n % 20;
            const status = bucket === 0 ? 'withdrawn' : (bucket <= 3 ? 'completed' : 'studying');
            const cohort = status === 'completed' ? '2024' : '2025';
            // Numbered from 0101 so they never collide with the hand-written
            // seed learners (0001–0010), which keeps every login predictable.
            const num = status === 'completed'
                ? `SC-2024-${String(100 + n).padStart(4,'0')}`
                : `SC-2025-${String(100 + n).padStart(4,'0')}`;
            learnerRows.push([fn, ln, num, null, PW, 'student', sch(s)]);
            profileRows.push([num, status, cohort, ['Grade 9','Grade 10','Grade 11','Grade 12'][n % 4],
                `200${7 + (n % 3)}-0${1 + (n % 9)}-1${n % 9}`, n % 2 ? 'F' : 'M',
                `${FIRST[(n * 5) % FIRST.length]} ${ln}`, `08${n % 4}${n % 10} 555 ${String(1000 + n).slice(1)}`,
                d(status === 'completed' ? -540 : -190)]);
        }
    }
    await bulk('users', ['name','surname','student_number','employee_id','password','role','school_id'], learnerRows);

    const students = await all(`SELECT id, student_number, school_id FROM users WHERE role='student'`);
    const idByNum = {}; students.forEach(s2 => { idByNum[s2.student_number] = Number(s2.id); });
    await bulk('student_profiles',
        ['user_id','status','cohort','grade','date_of_birth','gender','guardian_name','guardian_phone','enrolment_date'],
        profileRows.filter(r => idByNum[r[0]]).map(r => [idByNum[r[0]], ...r.slice(1)]));

    // ── Extra curriculum so filters have range ───────────────────────────────
    for (const [c,t,de] of [
        ['SC104','Data & Spreadsheets','Organising, calculating and presenting data.'],
        ['SC105','Introduction to Databases','Tables, keys and simple queries.'],
    ]) await run(`INSERT OR IGNORE INTO modules (code,title,description) VALUES (?,?,?)`,[c,t,de]);
    const allMods = await all(`SELECT id, code FROM modules`);
    const modId = {}; allMods.forEach(m => { modId[m.code] = Number(m.id); });
    const lessonRows = [];
    for (const [code, titles] of [['SC104',['Spreadsheet Basics','Formulas & Charts']],
                                  ['SC105',['What is a Database','Tables & Keys']]])
        titles.forEach((t, i) => lessonRows.push([modId[code], t, i + 1]));
    await bulk('lessons', ['module_id','title','lesson_order'], lessonRows);
    const newLessons = await all(`SELECT l.id FROM lessons l JOIN modules m ON m.id=l.module_id WHERE m.code IN ('SC104','SC105')`);
    const facOne = facBySchool[sch(1)];
    await bulk('materials', ['lesson_id','title','kind','url','uploaded_by'],
        newLessons.map((l, i) => [Number(l.id), ['Worksheet','Practice Set','Reference Notes','Exercises'][i % 4],
            'document', 'https://developer.mozilla.org/en-US/docs/Learn', facOne]));

    // ── Sessions and attendance across every school ──────────────────────────
    const sessionRows = [];
    const lessonPool = (await all(`SELECT id FROM lessons ORDER BY id`)).map(r => Number(r.id));
    for (let s = 1; s <= 10; s++) {
        const count = 12 + (s % 4);                       // 12–15 sessions per school
        for (let k = 0; k < count; k++) {
            const off = -(120 - k * 8 - (s % 5));
            sessionRows.push([sch(s), facBySchool[sch(s)], lessonPool[(k + s) % lessonPool.length],
                d(off), ['morning','afternoon'][k % 2], k % 7 === 6 ? 0 : 1]);
        }
    }
    await bulk('sessions', ['school_id','facilitator_id','lesson_id','session_date','session_type','validated'], sessionRows);

    const sessions = await all(`SELECT id, school_id, session_date FROM sessions ORDER BY school_id, session_date`);
    const studBySchool = {};
    for (const st of students) (studBySchool[Number(st.school_id)] ||= []).push(Number(st.id));
    const attRows = [];
    for (const ses of sessions) {
        const roster = studBySchool[Number(ses.school_id)] || [];
        roster.forEach((sid, idx) => {
            const pr = learnerProfile(sid);
            // Attendance rate ranges from about 45% for a disengaged learner to
            // near 100% for a committed one, with day-to-day variation on top.
            let rate = 0.45 + pr.engagement * 0.55;
            if (idx === 0) rate = Math.min(rate, 0.5);   // one clear case per school
            const roll = prand(sid * 31 + Number(ses.id) * 17);
            attRows.push([Number(ses.id), sid, roll > rate ? 'absent' : 'present']);
        });
    }
    await bulk('attendance', ['session_id','student_id','status'], attRows);

    // ── Enrollments: every learner on 2–3 modules ────────────────────────────
    const enrolRows = [];
    students.forEach((st, i) => {
        const codes = ['SC101','SC102','SC103','SC104','SC105'];
        const picks = [codes[i % 5], codes[(i + 1) % 5], ...(i % 3 === 0 ? [codes[(i + 2) % 5]] : [])];
        picks.forEach((c, j) => {
            const done = (i + j) % 3 === 0;
            enrolRows.push([Number(st.id), modId[c], done ? 'completed' : 'studying',
                d(-180), done ? d(-40) : null]);
        });
    });
    await bulk('enrollments', ['student_id','module_id','status','enrolled_at','completed_at'], enrolRows);

    // ── Which modules run at which school ────────────────────────────────────
    // Not every school runs every module: the two foundation modules run
    // everywhere, the rest are rolled out gradually.
    const allocRows = [];
    for (let sIdx = 1; sIdx <= 10; sIdx++) {
        allocRows.push([modId['SC101'], sch(sIdx), 1]);
        allocRows.push([modId['SC102'], sch(sIdx), 1]);
        if (sIdx <= 7) allocRows.push([modId['SC103'], sch(sIdx), 1]);
        if (sIdx <= 4) allocRows.push([modId['SC104'], sch(sIdx), 1]);
        if (sIdx <= 2) allocRows.push([modId['SC105'], sch(sIdx), 1]);
    }
    await bulk('module_schools', ['module_id','school_id','active'], allocRows);

    // ── What each facilitator is certified to teach ──────────────────────────
    const qualRows = [];
    for (let sIdx = 1; sIdx <= 10; sIdx++) {
        const fid = facBySchool[sch(sIdx)];
        const running = allocRows.filter(r => r[1] === sch(sIdx)).map(r => r[0]);
        running.forEach((mid, j) => {
            // Two facilitators are deliberately left uncertified on one module
            // they are teaching — the compliance view exists to surface exactly this.
            if ((sIdx === 3 && j === running.length - 1) || (sIdx === 6 && j === running.length - 1)) return;
            // Most sign-offs are verified; some are provisional, and one is
            // overdue for review, so the verification view has real cases.
            const state = (sIdx === 4 && j === 0) ? 'expired'
                        : ((sIdx + j) % 5 === 0 ? 'provisional' : 'verified');
            qualRows.push([fid, mid, d(-240 + sIdx * 12), state,
                state === 'provisional' ? null : d(-200 + sIdx * 10),
                state === 'provisional' ? null : 1,
                state === 'expired' ? d(-20) : d(160 + sIdx * 5),
                state === 'verified' ? 'Observed teaching a full session; assessment passed.' : null]);
        });
    }
    await bulk('facilitator_modules', ['user_id','module_id','certified_on','status','verified_on','verified_by','review_due','evidence'], qualRows);

    // ── Assignments per school, spread across lifecycle states ───────────────
    const asgnRows = [];
    // Offsets chosen so every lifecycle state is visible on whatever day this runs:
    // fully marked -> RETURNED · closed -> MARKING · due passed -> LATE WINDOW · OPEN · SCHEDULED
    const SPREAD = [[-40,-33,-31],[-26,-19,-17],[-10,-1,2],[-6,4,6],[5,15,17]];
    const codeById = {}; Object.entries(modId).forEach(([c, id]) => { codeById[id] = c; });
    for (let s = 1; s <= 10; s++) {
        // Only modules allocated to this school can have assignments here
        const allocated = allocRows.filter(r => r[1] === sch(s)).map(r => r[0]);
        SPREAD.forEach((offsets, k) => {
            const [o, du, cl] = offsets;
            const mid = allocated[k % allocated.length];
            const code = codeById[mid];
            asgnRows.push([mid, `${code} Task ${k + 1}`,
                `Practical work for ${code}. Full brief attached.`, 100,
                d(o), d(du), d(cl), d(du + 7), facBySchool[sch(s)], sch(s)]);
        });
    }
    await bulk('assignments',
        ['module_id','title','description','total_marks','open_date','due_date','close_date','marking_due_date','facilitator_id','school_id'],
        asgnRows);

    // ── Rubrics: what each assignment is marked on ───────────────────────────
    const RUBRICS = {
        code: [['Correctness','The program runs and produces the expected output',40],
               ['Completeness','Every task in the brief is attempted',25],
               ['Code quality','Sensible names, tidy structure, no repetition',20],
               ['Comments','The code explains what it is doing',15]],
        document: [['Content','Covers everything the brief asked for',45],
                   ['Understanding','Explains the concepts in their own words',30],
                   ['Presentation','Clear structure, readable, referenced',25]],
        link: [['Functionality','The site or page works as described',40],
               ['Requirements','All required elements are present',35],
               ['Presentation','Layout and styling are considered',25]],
        text: [['Accuracy','Answers are correct',50],
               ['Reasoning','Working and explanation are shown',30],
               ['Clarity','Written clearly',20]],
    };
    const asgnAll = await all(`SELECT id, module_id FROM assignments`);
    const critRows = [];
    for (const a of asgnAll) {
        const code = codeById[Number(a.module_id)] || 'SC101';
        // Python and web modules hand in code; the digital-literacy module writes
        const type = ['SC101','SC102','SC105'].includes(code) ? 'code'
                   : code === 'SC104' ? 'document' : 'text';
        await run(`UPDATE assignments SET submission_type=? WHERE id=?`, [type, a.id]);
        RUBRICS[type].forEach(([label, descriptor, pts], i) =>
            critRows.push([Number(a.id), label, descriptor, pts, i + 1]));
    }
    await bulk('rubric_criteria', ['assignment_id','label','descriptor','max_points','criterion_order'], critRows);

    // ── Submissions and marks ────────────────────────────────────────────────
    const today = d(0);
    const asgns = await all(`SELECT id, school_id, due_date, close_date, total_marks, submission_type, open_date FROM assignments`);
    const subRows = [];
    for (const a of asgns) {
        if (a.open_date > today) continue;
        const roster = studBySchool[Number(a.school_id)] || [];
        roster.forEach((sid, idx) => {
            const pr = learnerProfile(sid);
            const roll = prand(sid * 19 + Number(a.id) * 23);
            // Handing work in ranges from about 45% of the time to near always
            if (roll > 0.45 + pr.engagement * 0.53) return;
            const late = prand(sid * 7 + Number(a.id) * 3) > 0.82 && a.due_date < today;
            // The file attached matches the learner's standard, so the marking
            // screen shows work that is consistent with the mark it receives.
            const t = a.submission_type;
            const fname = t === 'code'
                ? (pr.ability > 0.62 ? 'sub-python-strong.py'
                   : pr.ability > 0.38 ? 'sub-python-partial.py' : 'sub-python-weak.py')
                : t === 'document' ? 'sub-worksheet.md' : 'sub-answers.txt';
            placeFile(fname);
            subRows.push([Number(a.id), sid, 'Submitted through the LMS', fname, late ? 1 : 0,
                (late ? a.close_date : a.due_date) + ' 10:00:00']);
        });
    }
    await bulk('submissions', ['assignment_id','student_id','notes','file_name','is_late','submitted_at'], subRows);

    const subs = await all(`
        SELECT s.id, s.student_id, a.due_date, a.close_date, a.total_marks, a.facilitator_id, a.title
        FROM submissions s JOIN assignments a ON a.id=s.assignment_id
        WHERE a.close_date < ?`, [today]);
    const FEEDBACK_HIGH = ['Excellent logic and a clean layout.','Well structured — good use of comments.',
        'Correct throughout. Try the extension task next time.','Very strong work.'];
    const FEEDBACK_MID = ['Solid work; check your loop bounds.','Good effort. Practise the input conversion pattern.',
        'Correct, but tidy up your variable names.','On the right track — watch your indentation.'];
    const FEEDBACK_LOW = ['Below the pass mark — come and see me so we can work through it.',
        'Incomplete. Please attempt every question, even partially.',
        'Several problems here. Let us go through it together in the next session.',
        'This does not run. Bring your laptop and we will debug it.'];
    const markRows = [];
    subs.forEach((s2, i) => {
        // Task 1 at every school is marked in full so it reaches RETURNED;
        // elsewhere a share stays unmarked so the marking queue is never empty.
        const mustMark = String(s2.title || '').includes('Task 1');
        if (!mustMark && i % 9 === 0) return;
        const sid = Number(s2.student_id);
        const pr = learnerProfile(sid);
        // Centre the mark on the learner's ability (roughly 18% to 92%), vary it
        // by up to 12 points per assignment, and apply their trend over time.
        const centre = 18 + pr.ability * 74;
        const wobble = (prand(sid * 13 + Number(s2.id) * 29) - 0.5) * 24;
        const drift  = pr.trend * (i % 5) * 2.5;
        const score  = Math.max(3, Math.min(Number(s2.total_marks), Math.round(centre + wobble + drift)));
        // Some facilitators are consistently prompt, others let marking slip.
        // This is what the compliance column exists to reveal.
        const fid = Number(s2.facilitator_id);
        const lateness = [0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.34, 0.45][fid % 8];
        const late = prand(Number(s2.id) * 5 + fid) < lateness;
        const gradedAt = new Date(new Date(s2.due_date).getTime() + (late ? 9 : 3 + (i % 4)) * 86400000)
            .toISOString().slice(0,10) + ' 12:00:00';
                const fb = score >= 80 ? FEEDBACK_HIGH[i % FEEDBACK_HIGH.length]
                 : score >= 50 ? FEEDBACK_MID[i % FEEDBACK_MID.length]
                 : FEEDBACK_LOW[i % FEEDBACK_LOW.length];
        markRows.push([Number(s2.id), score, fb, Number(s2.facilitator_id), gradedAt]);
    });
    await bulk('marks', ['submission_id','score','feedback','graded_by','graded_at'], markRows);

    // Split every mark across that assignment's criteria, so a learner sees
    // where the points came from rather than only a total.
    const gradedMarks = await all(`
        SELECT m.id, m.score, su.assignment_id FROM marks m
        JOIN submissions su ON su.id = m.submission_id`);
    const critByAsgn = {};
    for (const c of await all(`SELECT * FROM rubric_criteria ORDER BY criterion_order`))
        (critByAsgn[Number(c.assignment_id)] ||= []).push(c);
    const breakdown = [];
    for (const m of gradedMarks) {
        const crits = critByAsgn[Number(m.assignment_id)] || [];
        if (!crits.length) continue;
        const ratio = Number(m.score) / 100;
        let allocated = 0;
        crits.forEach((c, i) => {
            const max = Number(c.max_points);
            // vary each criterion slightly around the overall ratio
            let pts = Math.round(max * Math.min(1, Math.max(0, ratio + (prand(Number(m.id) * 7 + i) - 0.5) * 0.3)));
            if (i === crits.length - 1) pts = Math.max(0, Math.min(max, Number(m.score) - allocated));
            allocated += pts;
            breakdown.push([Number(m.id), Number(c.id), pts, null]);
        });
    }
    await bulk('mark_criteria', ['mark_id','criterion_id','points','comment'], breakdown);


    // ── Sponsors and sponsorships ────────────────────────────────────────────
    const sponsorRows = [
        ['Ubuntu Digital Trust','Naledi Khoza','grants@ubuntudigital.org.za','011 555 0142','STEM education','active','Quarterly attendance and outcomes reporting required.'],
        ['Kopano Foundation','James van der Merwe','jvdm@kopano.org','021 555 0987','Digital inclusion','active','Funds facilitator stipends at two schools.'],
        ['TechBridge SA','Ayesha Patel','ayesha@techbridge.co.za','012 555 3321','Youth employability','prospective','Site visit scheduled; wants delivery evidence first.'],
        ['Sizwe Community Fund','Bongani Nkuna','info@sizwefund.org.za','013 555 7788','Rural development','active','Renews annually in March.'],
        ['Highveld Mining CSI','Karen Botha','csi@highveldmining.co.za','017 555 2211','Community upliftment','active','Reports to their board twice a year.'],
        ['Thuto Education Trust','Refilwe Mahlangu','trust@thuto.org.za','015 555 6644','Teacher development','lapsed','Funding paused pending new impact evidence.'],
        ['Cape Tech Collective','Dylan Adams','hello@capetech.org','021 555 9090','Coding skills','prospective','Interested in the Western Cape schools.'],
        ['Masakhane Bursary Fund','Zinhle Dube','apply@masakhane.org.za','031 555 4433','Learner bursaries','active','Sponsors individual learners into further study.'],
    ];
    for (const r of sponsorRows)
        await run(`INSERT OR IGNORE INTO sponsors (organisation,contact_person,email,phone,focus_area,status,notes) VALUES (?,?,?,?,?,?,?)`, r);
    const sponsors = await all(`SELECT id, organisation FROM sponsors`);
    // Every school must have at least one funder so the sponsor view is never empty
    const sponsorshipRows = [];
    const active = sponsors.filter((_, i) => i < 6);
    for (let sIdx = 1; sIdx <= 10; sIdx++) {
        const sp = active[(sIdx - 1) % active.length];
        sponsorshipRows.push([Number(sp.id), sch(sIdx), 80000 + (sIdx % 5) * 30000, d(-260), d(105)]);
        if (sIdx % 3 === 0) {                     // some schools have a second funder
            const sp2 = active[(sIdx + 2) % active.length];
            sponsorshipRows.push([Number(sp2.id), sch(sIdx), 45000 + (sIdx % 4) * 20000, d(-180), d(180)]);
        }
    }
    await bulk('sponsorships', ['sponsor_id','school_id','annual_amount','start_date','end_date'], sponsorshipRows);

    const c = async q => Number((await get(q))?.c || 0);
    console.log(`   dataset: ${await c('SELECT COUNT(*) c FROM users WHERE role=\'student\'')} learners · ` +
        `${await c('SELECT COUNT(*) c FROM users WHERE role=\'facilitator\'')} facilitators · ` +
        `${await c('SELECT COUNT(*) c FROM sessions')} sessions · ` +
        `${await c('SELECT COUNT(*) c FROM attendance')} attendance records · ` +
        `${await c('SELECT COUNT(*) c FROM assignments')} assignments · ` +
        `${await c('SELECT COUNT(*) c FROM submissions')} submissions · ` +
        `${await c('SELECT COUNT(*) c FROM marks')} marks · ` +
        `${await c('SELECT COUNT(*) c FROM sponsors')} sponsors`);
}

async function reseed(profile = 'lean') {
    await getDb();
    await wipeData();
    await seed(profile === 'demo' ? 'demo' : 'lean');
}

module.exports = { getDb, run, all, get, reseed };
