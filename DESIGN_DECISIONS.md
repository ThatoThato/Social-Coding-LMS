# Design Decisions — Social Coding LMS

Why the system is built the way it is. Every entry states the decision, the
alternatives considered, and the reason one was chosen. If an evaluator asks
"why did you do it that way?", the answer is here.

---

## Part 1 — The algorithms

These are the decision-making parts of the system: the places where it does not
simply store what happened, but works something out.

### 1.1 Forecasting learner outcomes

**Decision.** Fit a least-squares linear regression to each learner's marks in
the order they were awarded, project it two assessments forward, and combine it
with attendance and submission rate into a completion probability.

**Why regression rather than a simple average.** An average tells you where a
learner has been; it cannot distinguish a learner who scored 40, 50, 60 from one
who scored 60, 50, 40. Both average 50, but only one is in trouble. The slope of
the fitted line is what separates them, and the slope is what a facilitator needs
in order to intervene early.

**Why linear rather than something more sophisticated.** Learners have between
one and six marks. A polynomial or a moving average would fit that little data
more tightly while predicting worse — with three points, a quadratic passes
exactly through all three and tells you nothing. A straight line is the most
complex model this quantity of data can honestly support.

**The problem with a naive fit, and how it is handled.** Our first version
projected a learner with two marks and a steep downward slope to a final mark
below zero. Two points always define a perfect line, so `r²` was 1 and the model
appeared certain when it was guessing. The projection is now shrunk towards the
learner's current average in proportion to the evidence behind it:

```
evidence = min(1, (n − 1) / 4) × (0.4 + 0.6 × r²)
projection = raw_projection × evidence + current_average × (1 − evidence)
```

With six marks on a clean line the raw projection dominates. With two marks it
barely moves off the current average. This is shrinkage towards the mean, and it
is the standard defence against over-fitting small samples.

**Why combine with attendance and submission rate.** A learner scoring 75% who
has stopped attending is not on track, and a mark-only model would say otherwise.
The weights (0.45 performance, 0.35 attendance, 0.20 submissions) put the most
on marks, but enough on engagement that disappearance is visible. The weights are
a judgement, not a fitted result, and are stated openly as such.

**Complexity.** O(n) per learner over their own marks, O(N) across the cohort.

### 1.2 Scheduling the marking workload

**Decision.** Order outstanding submissions Earliest Deadline First, lay them out
against a daily capacity, and report both the resulting plan and the minimum
daily capacity that would meet every deadline.

**Why Earliest Deadline First.** For a single worker with a fixed rate, EDF is
optimal for meeting deadlines: if any ordering can complete all the work on time,
EDF does. This is a known result, and it means the schedule the system produces
is not merely reasonable but provably the best available ordering.

**Why also compute the required capacity.** Telling a manager "this cannot be
done" is not useful. The schedule therefore also answers "what would it take?" by
taking, for every deadline, the amount of work due by then divided by the days
available, and reporting the largest of those values:

```
required = max over i of ⌈(i + 1) / days_available(deadline_i)⌉
```

That figure is the smallest daily rate at which no deadline is missed. It turns
the output from a complaint into a staffing decision.

**A distinction we had to add.** Our first version reported every facilitator as
"infeasible", because much of the seeded work was already past its deadline — no
schedule could fix that. Work already overdue is now separated from work that a
given plan would cause to be missed. The first is a fact about the past; only the
second is a scheduling result.

**Complexity.** O(n log n) for the sort, O(n) for the layout.

### 1.3 Allocating equipment optimally

**Decision.** Score each school on unmet need, attendance and retention risk;
treat each additional device at a school as worth slightly less than the one
before; then repeatedly assign the next device wherever it yields the greatest
gain.

**Why this is optimal and not merely sensible.** The devices are identical and
indivisible, and the benefit function is concave — the tenth device at a school
of twelve learners helps less than the first. For concave benefit functions over
identical items, the greedy choice at every step produces the allocation with the
highest achievable total. It is not an approximation.

**Why not simply split evenly.** Because an even split ignores that schools
differ. The system computes both and reports the difference. On the current data,
distributing 60 devices optimally is about 3% better than an even split; with
only 25 devices it is 23% better. That result is worth understanding: **optimisation
matters most when resources are scarcest**, which is exactly the situation this
organisation is in.

**Why these weights (0.55 need, 0.25 attendance, 0.20 risk).** Unmet need
dominates because a device is useless to a learner who already has one.
Attendance is second because equipment given where learners do not come is wasted.
Retention risk is included because a learner about to drop out is where an
intervention has the most value. The weights are a policy choice; they are
exposed in the method note on screen so that they can be argued with rather than
hidden.

**Complexity.** O(D · S) as implemented, which for tens of devices across ten
schools is instant. With a priority queue it would be O(D log S) if it ever
needed to scale.

---

## Part 2 — Architecture

### 2.1 No frontend framework

**Decision.** Plain HTML, CSS and JavaScript. No React, Vue, jQuery or Bootstrap.

**Why.** Learners take devices home and pay for their own data there. Every
framework is a download before the first useful byte arrives. The whole interface
is text and tables the browser can already render. It also means the entire team
can read every line of the front end without learning a framework first, which
matters when everyone must be able to explain the code.

**The cost, stated honestly.** More repetition than a component framework would
need, and no reactive rendering — pages redraw a table rather than updating one
row. At this size that is a fair trade.

### 2.2 SQLite through libSQL, rather than PostgreSQL or MySQL

**Decision.** SQLite in development as a single file; the same code runs against
Turso, a hosted SQLite service, in production.

**Why.** The whole dataset for ten schools is a few megabytes. A separate
database server would add an installation, a service to keep running and a second
thing to deploy, for no benefit at this size. Using libSQL means moving to the
cloud is a change of environment variable, not a change of code.

### 2.3 The assignment lifecycle is computed, not stored

**Decision.** An assignment's state (scheduled, open, late window, closed,
returned) is worked out from its dates every time it is read.

**Why.** The alternative is a stored `status` column, which then needs a
scheduled job to move assignments between states at midnight. That job is another
moving part that can fail silently — and if it fails, the system lies about
deadlines. A computed state cannot drift out of date, and the cost is a handful
of date comparisons.

### 2.4 Actor specialisation in the database

**Decision.** Shared identity in `users`; role-specific fields in
`student_profiles` and `facilitator_profiles`, one row each.

**Why.** Learners need grade, guardian and cohort; facilitators need
qualifications and specialisation. Putting all of it in one table gives every row
a set of columns that can never apply to it. Splitting the tables entirely would
mean two login paths and duplicated authentication. Specialisation keeps
authentication uniform and the data honest.

### 2.5 No direct link between learner and facilitator

**Decision.** They are connected through the school they share, and through the
records of what actually happened between them.

**Why.** A stored `facilitator_id` on every learner would have to be updated for
every learner whenever a facilitator changes school — hundreds of writes for one
real-world event, with the risk that some are missed. Deriving the relationship
from the school makes reassignment a single update. The history of the
relationship is then a matter of record: who took whose register, and who marked
whose work.

### 2.6 Offline capability was removed

**Decision.** Built, then deliberately removed.

**Why.** Our early design assumed rural schools had no connectivity. Research
with the programme manager established that Social Coding supplies its own router
and issues devices, so the premise was wrong. Rather than keep a feature that
existed to solve a problem the organisation does not have, it was removed. The
system is smaller and easier to defend as a result. This is recorded here because
the reasoning matters more than the code that was deleted.

---

## Part 3 — Product decisions

### 3.1 The facilitator takes the register, not the learners

**Why.** Learners take their devices home, so a learner could mark themselves
present from anywhere. Only the person in the room knows who is there. It is also
faster: one person confirming a class they can see takes about thirty seconds,
where eighteen individual sign-ins would consume several minutes of teaching time.

**Design consequence.** The register loads with everybody marked present and the
facilitator taps the absentees — because in a functioning class most learners
attend, so the default should be the common case. This is the single biggest
reduction in typing in the system.

### 3.2 Curriculum is owned by head office

**Why.** Facilitators are trained through the PathMakers programme; they are not
qualified curriculum designers, and ten facilitators each inventing modules would
produce ten different programmes. Facilitators upload materials to existing
lessons — which is teaching — while creating modules and lessons is restricted to
head office. Modules are then allocated to the schools that run them, so a school
sees only its own curriculum.

### 3.3 Marking uses a rubric, and the total is computed from it

**Why.** A single number tells a learner nothing about what to fix. Criteria with
weights make the mark explainable and consistent between facilitators. The server
recomputes the total by summing the criteria rather than trusting the number sent
to it, so a mark and its breakdown can never disagree.

### 3.4 Code is read inside the system

**Why.** Coding assignments are code. Downloading a `.py` file, opening it in
another program, and typing a number back in is where marking gets abandoned. The
submission is displayed with line numbers beside the rubric, so reviewing and
marking happen in one place. Files are capped at 200 KB and limited to text
formats, so this can never be used to make the server read something it should not.

### 3.5 Status is shown in words, not colour alone

**Why.** Colour alone fails for colour-blind users, in bright sunlight, in
screenshots and in print. Every state — "late", "3d overdue", "studying",
"needs support" — is a word. Colour reinforces it but never carries it alone.

### 3.6 Navigation icons are inline SVG

**Why.** Word labels alone did not fit a phone screen. Icon fonts are a separate
download of tens of kilobytes; image icons are several requests. Inline SVG is a
few hundred bytes of path data in a page the browser already has, and it inherits
the current text colour, so it themes correctly. Labels remain beneath the icons,
so meaning never depends on recognising a glyph.

---

## Part 4 — Decisions forced by defects we found

Each of these changed the design, and each was found by our own testing.

| What we found | What it changed |
|---|---|
| Deadlines were evaluated in UTC, so between midnight and 02:00 South African time work submitted after a deadline counted as on time | All date comparisons now go through a single helper fixed to `Africa/Johannesburg` |
| The demo-data endpoint had no authentication and would wipe a deployed database | Disabled in cloud deployments unless explicitly enabled by an environment variable |
| The early-warning engine ran five queries per learner — 4 500 at 900 learners, taking over a second | Rewritten as five aggregate queries over the whole cohort, using window functions; 83 ms at the same scale |
| Page-level CSS silently overrode the shared theme, producing white text on a white bar | Shared styles raised in specificity; a rule about where styles belong |
| Table rows were being rendered into a plain container after a refactor | The container and its renderer are now checked together |
| Every learner in the demo data had almost the same attendance and marks | Data is generated from per-learner ability and engagement profiles, so a record is internally consistent |

---

## Part 5 — What we chose not to build, and why

**A sponsor login.** The data model supports it, and it would be a good feature.
It was not built because the remaining time was better spent making what exists
correct than adding a surface we could not test properly.

**Notifications by SMS or email.** Marking deadlines are enforced by visibility
in the compliance report instead. A messaging gateway costs money per message and
needs credentials we do not have, and a demonstration of it would have to be
faked. We would rather show something real.

**Offline capability.** Removed after research showed the schools have
connectivity. Described in 2.6.

**A background job scheduler.** Everything time-dependent is computed on read
instead. See 2.3.

In each case the choice was the same: a smaller system that works and can be
explained, rather than a larger one that cannot be demonstrated honestly.
