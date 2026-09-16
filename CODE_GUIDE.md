# Code Guide — Social Coding LMS

Written for the team. If you did not write this code, start here. You should be
able to answer any question an examiner asks about it after reading this once.

---

## 1. What the system is made of

There are only three languages in this project, and no frameworks on the front end.

| Part | Language / tool | What it does | Where |
|---|---|---|---|
| Front end | HTML, CSS, JavaScript | The 14 pages people look at | `frontend/` |
| Back end | JavaScript on **Node.js**, using **Express** | Answers requests from the pages | `server.js` |
| Database | **SQL** (SQLite, through libSQL) | Stores everything | `db.js` |

Supporting libraries, all on the back end:

| Library | Why it is there |
|---|---|
| `express` | Routing: "when a request comes to `/api/assignments`, run this function" |
| `@libsql/client` | Talks to the SQLite database (a local file, or Turso in the cloud) |
| `bcryptjs` | Hashes passwords so we never store the real ones |
| `jsonwebtoken` | Issues and verifies the login token (JWT) |
| `multer` | Handles file uploads (slides, briefs, submissions) |
| `cors` | Lets the Android app call the API from a different origin |
| `dotenv` | Reads settings from a `.env` file |

**There is no React, Vue, Angular, jQuery or Bootstrap.** Every page is plain
HTML with a `<script>` block. This was a deliberate decision: fewer downloads for
learners on their own data, and nothing to learn beyond the three core languages.

---

## 2. The shape of the project

```
lms/
├── server.js              ← the whole back end: ~43 API endpoints
├── db.js                  ← table definitions + the demo data generator
├── package.json           ← dependency list and npm scripts
├── capacitor.config.json  ← settings for the Android build
├── seed-content/          ← real PDFs used as lesson material and briefs
└── frontend/
    ├── login.html
    ├── student-*.html     ← 6 learner pages
    ├── facilitator-*.html ← 5 facilitator pages
    ├── admin-*.html       ← 2 head-office pages
    ├── shared-theme.css   ← every visual style, used by all pages
    ├── auth.js            ← login state, API helpers, theme, toasts
    ├── config.js          ← where the API lives (empty for web, set for mobile)
    └── icons/             ← logo files and app icons
```

Two rules explain most of the layout:

1. **`shared-theme.css` owns the look.** Individual pages only add styles unique
   to that page. If a colour or spacing looks wrong everywhere, it is in the
   shared file.
2. **`auth.js` owns talking to the server.** Pages never call `fetch()` directly;
   they call `apiFetch()`, which attaches the login token for them.

---

## 3. How one request works, end to end

Follow a single click: a learner opens their assignments page.

**Step 1 — the page loads and checks who you are.**

```js
const user = requireAuth('student');   // in auth.js
```

`requireAuth` reads the token saved in the browser. No token, or the wrong role,
and it sends you back to the login page.

**Step 2 — the page asks the server for data.**

```js
const data = await apiFetch('/api/assignments');
```

`apiFetch` (in `auth.js`) adds the `Authorization: Bearer <token>` header and
returns the parsed JSON.

**Step 3 — Express receives it.**

```js
app.get('/api/assignments', auth, async (req, res) => { ... });
```

Read this as: *for GET requests to `/api/assignments`, first run `auth`, then run
this function*. `auth` is **middleware** — a function that runs before the main
one and can stop the request. It verifies the token and attaches the user to
`req.user`, so the rest of the code knows who is asking.

**Step 4 — the function queries the database.**

```js
const assignments = await all(`
    SELECT a.*, u.name || ' ' || u.surname AS teacher_name
    FROM assignments a JOIN users u ON u.id = a.facilitator_id
    WHERE a.school_id = ?`, [req.user.school_id]);
```

`all()` returns many rows, `get()` returns one, `run()` changes data. The `?` is
a **parameter placeholder** — never paste values into SQL, because that is how
SQL-injection attacks happen.

**Step 5 — the server may compute things before replying.**

The assignment lifecycle is not stored; it is worked out from today's date each
time it is asked for (see section 5).

**Step 6 — the page turns the data into rows.**

```js
document.getElementById('assignmentsList').innerHTML = filtered.map(a => `
    <tr>
        <td class="mono">${a.module_code}</td>
        <td class="strong">${a.title}</td>
    </tr>`).join('');
```

Those backticks are a **template literal** — a string that can contain
`${variables}`. `.map()` turns each assignment into a row of HTML, `.join('')`
glues them together, and `innerHTML` puts them on the page.

That is the entire pattern. Every page in the system is this same six-step loop.

---

## 4. The five patterns you will see everywhere

**a) Role guards.** Every protected endpoint names who may use it:

```js
app.get('/api/marking-queue', auth, role('facilitator'), ...)
```

`role('facilitator')` rejects anyone else with 403. Security is enforced on the
**server**, never by hiding a button.

**b) Filtering happens in the browser.** The data is already loaded, so filters
are instant and cost no extra requests:

```js
const rows = learners.filter(u =>
    (!q      || `${u.name} ${u.surname}`.toLowerCase().includes(q)) &&
    (!status || u.status === status) &&
    (!module || (u.modules || []).includes(module)));
```

Each line reads: *if no filter is set, allow everything; otherwise it must match*.

**c) Tables are rendered from arrays.** `<tbody id="...">` in the HTML,
`.map()` in the JavaScript. Nothing is written by hand.

**d) Dates are always South African.** Never use `new Date()` directly for a
date comparison. Use the helpers, which are fixed to `Africa/Johannesburg`:

```js
function todaySAST() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
}
```

We had a real bug here: UTC is two hours behind us, so between midnight and 2am
the server thought it was still yesterday and late work counted as on time.

**e) Uniqueness is enforced by the database, not by code.**

```sql
UNIQUE(session_id, student_id)
```

That line means a learner can only have one attendance record per session, no
matter how many times it is saved. The database refuses the duplicate, so we do
not have to remember to check.

---

## 5. The three pieces of logic worth understanding properly

These are what examiners ask about, so everyone should be able to explain them.

### The assignment lifecycle

An assignment has four dates: `open_date`, `due_date`, `close_date` and
`marking_due_date`. Its **state is never stored** — it is calculated from today:

```js
function lifecycleState(a, today) {
    if (!a.published)          return 'draft';
    if (today <  a.open_date)  return 'scheduled';
    if (today <= a.due_date)   return 'open';
    if (today <= a.close_date) return 'late_window';
    return 'closed';
}
```

Why calculate instead of store? Because a stored state would need a scheduled job
to move assignments from `open` to `closed` at midnight. Calculating on read is
always correct and needs no background process.

`marking_due_date` is set once, when the assignment is created:
`due_date + 7 days`. That is the marking service level.

### The early-warning engine (`/api/at-risk`)

For each active learner, five signals are checked and points added:

| Signal | Points |
|---|---|
| Attendance below 50% (below 70%) | 40 (22) |
| Absent 3 sessions in a row (2 in a row) | 35 (15) |
| 2+ assignments never submitted (1) | 30 (14) |
| Average below 40% (below 50%) | 35 (20) |
| Marks dropped more than 15 points | 12 |

60+ is "needs attention", 30+ is "watch", below that is not shown. Every flag
carries the **reasons in words**, because a number alone tells a facilitator
nothing. This is the feature the examiner liked; be able to explain the signals.

### Actor specialisation in the database

Learners and facilitators need different fields, so:

- `users` holds what everyone shares — name, login ID, role, password, school
- `student_profiles` extends it 1:1 — grade, date of birth, guardian, cohort, status
- `facilitator_profiles` extends it 1:1 — phone, qualification, specialisation

This avoids one enormous table where half the columns are empty. Say the word
"specialisation" if asked.

**There is no direct link between a learner and a facilitator.** They are
connected two ways: *structurally* through the school they share, and
*behaviourally* through the records of interaction — who took whose register
(`sessions` → `attendance`) and who marked whose work (`submissions` → `marks`).

---

## 6. How to add something new

### A new API endpoint

In `server.js`, copy the shape of an existing one:

```js
app.get('/api/thing', auth, role('admin'), async (req, res) => {
    try {
        await getDb();
        const rows = await all(`SELECT * FROM thing WHERE school_id = ?`, [req.query.school_id]);
        res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
```

Every endpoint follows that pattern: `try`, `await getDb()`, query, `res.json`,
and a `catch` that returns a clean error.

### A new table

In `db.js`, add it to the `tables` array in `createTables()`. Existing databases
are not migrated automatically — delete `social_coding.db` and restart to rebuild
with fresh demo data.

### A new page

1. Copy the closest existing page — it already has the header, navigation, theme
   toggle and bottom navigation.
2. Change the title, the `active` navigation link, and the content.
3. Add the page to the navigation lists on the other pages of that role.

### A new filter on an existing table

1. Add a `<select class="filter-select" id="fThing" onchange="render()">` to the
   filter bar.
2. Add one line to the filter chain in `render()`.
3. Populate its options after the data loads.

---

## 7. Traps we have already fallen into

| Trap | What happens | Rule |
|---|---|---|
| Using `new Date()` for date comparisons | Deadlines shift by two hours | Use the SAST helper |
| Writing CSS in a page that also exists in `shared-theme.css` | The page wins and quietly overrides the theme — this caused white text on a white bar | Put shared styles in the shared file |
| Changing a rendering function without changing its container | Table rows rendered inside a plain `<div>` and looked broken | Check the HTML container matches |
| Adding a button without the endpoint | The button silently does nothing | Test the click, not just the API |
| Forgetting `colspan` on empty-state rows | The "no results" row does not span the table | Match the column count |
| Editing `frontend/` and expecting the Android app to change | The app has its own copy | Run `npx cap sync android` |

---

## 8. Words you should be able to define

**API** — the set of URLs the front end can call to get or change data.
**Endpoint** — one of those URLs, e.g. `/api/assignments`.
**Middleware** — a function that runs before the main handler; ours check the
token and the role.
**JWT** — the signed token proving you logged in; sent with every request.
**bcrypt** — the one-way hashing used for passwords; we can check a password but
never recover it.
**Foreign key** — a column pointing at another table's row, e.g.
`submissions.student_id` → `users.id`.
**UNIQUE constraint** — a rule stopping duplicate combinations.
**Idempotent** — an operation you can repeat safely with the same result.
**CRUD** — create, read, update, delete.
**Template literal** — a backtick string that can embed `${values}`.
**Capacitor** — the tool that wraps our web pages into an Android app.

---

## 9. Running it

```bash
npm install          # once, downloads the libraries
node server.js       # start the server
```

Open <http://localhost:3000>. Logins: `ADM-001 / admin123`,
`FAC-001 … FAC-010 / pass123`, learners `SC-2025-0001` and upward.

Seeing only one school? Delete `social_coding.db` and start again — you have an
old database file from a previous version.

For the Android build, see `MOBILE_APP.md`.

---

## 10. Scalability — the measured answer

The system was load tested by generating five times the normal dataset
(`SEED_SCALE=5`): **900 learners, 13 140 attendance records, 3 259 submissions**.
The bottlenecks were measured, fixed, and measured again.

| Endpoint | Before | After | What changed |
|---|---|---|---|
| `/api/at-risk` | 1 021 ms | **83 ms** | Five aggregate queries for the whole cohort instead of five per learner |
| `/api/facilitator/students` | 85 ms | **6 ms** | Indexes on the foreign keys it filters by |
| `/api/admin/users` | 261 KB | **57 KB** | Server-side pagination and role filtering |
| `/api/marking-queue` | 90 KB | **71 KB** | Result cap |

Three techniques did the work:

**1. Indexes.** Nineteen indexes on foreign keys and the columns used for
filtering (`users(school_id, role)`, `attendance(student_id)`,
`assignments(school_id, close_date)` and so on). Without them SQLite scans whole
tables; with them it jumps straight to the rows it needs.

**2. Set-based queries instead of loops.** The early-warning engine used to run
five queries for every learner — 4 500 queries at 900 learners. It now runs five
queries in total and combines the results in memory, using window functions
(`ROW_NUMBER() OVER (PARTITION BY ...)`) for "the last three sessions" and "the
two most recent marks". This is the single biggest lesson in the project: the
problem was never the amount of data, it was the number of round trips.

**3. Pagination.** Lists that grow without limit accept `?page=` and
`?per_page=`, and return a total so the caller can show "page 1 of 18".

### If asked "will it scale beyond this?"

The honest answer: the current architecture is comfortable into the low tens of
thousands of records, which is far beyond ten schools. Past that the next steps
would be moving from a single SQLite file to Turso's replicated cloud database
(already supported — set `DB_MODE=turso`), and caching the reports, which are
read far more often than the underlying data changes.

## 11. Security measures

- **Passwords** are hashed with bcrypt and never stored or logged in plain text.
- **Every request** carries a JWT, verified server-side; role middleware enforces
  who may call what, and facilitators are additionally restricted to their own
  school on learner data.
- **Login is rate limited** — eight failed attempts from an address triggers a
  ten-minute cooldown, which stops password guessing.
- **Every user can change their own password**, since accounts are issued with a
  temporary one.
- **Uploads** are restricted by extension and size, and files read back into the
  marking screen are capped at 200 KB and limited to text and code formats.
- **The demo-data endpoint** is disabled in cloud deployments unless explicitly
  enabled, so a public deployment cannot be wiped.
