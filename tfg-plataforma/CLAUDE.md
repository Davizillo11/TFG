# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the server (port 3000)
npm start          # node server.js

# Reset and seed the database
node seed.js

# The database file lives at database/database.db
# Delete it and restart to get a clean slate
```

No build step, no linter, no test suite configured.

## Architecture

**Stack:** Node.js + Express 5, SQLite3 (via `sqlite3` package), server-side sessions (`express-session`), plain HTML/CSS/JS frontend (no framework).

### Backend

`server.js` is the entry point. It mounts all routes under `/api/v1/*` and serves `public/` as static files. `database/schema.js` is `require()`d at startup — it runs `CREATE TABLE IF NOT EXISTS` for every table and any `ALTER TABLE` migrations (guarded with empty callbacks to swallow duplicate-column errors).

**DB access pattern** — all routes that use async/await define local Promise wrappers:
```js
function dbAll(sql, params = []) { return new Promise(...) }
function dbRun(sql, params = []) { return new Promise(...) }
```
Copy this pattern when adding new routes. Older routes (teachers, subjects, classrooms, auth) use raw callbacks instead.

**Middleware:**
- `requireAuth` — 401 if no session
- `requireAdmin` — 401/403 unless `req.session.user.role === 'admin'`

**Route auth conventions:**
- `GET /` on most resources: `requireAuth`
- `POST`, `PUT`, `DELETE`: `requireAdmin`
- `GET /api/v1/schedules` and `GET /api/v1/schedules/:id`: public (no auth) — needed by `horarios.html`

### Scheduler (`routes/schedules.js`)

The core algorithm lives here. Key concepts:

- **Slot grid:** anchored at 10:00 and 15:00 with `step = duracion` (e.g. 120 min → slots at 10:00, 12:00, 15:00, 17:00). Lunch break 14:00–15:00 is excluded.
- **Fringe slots:** 1h slots just before the first main slot (for leftover 1h sessions).
- **Session durations:** `getSessionDurations(hoursWeek, maxDurMin)` splits total weekly hours into sessions, e.g. 5h → [120, 120, 60].
- **Solver:** tries `solveCSP` (backtracking, `MAX_OPS` limit) then falls back to `solveGreedy`. Both use the same `orderedSlots` priority: new-day slots first (spread across week), same-day last.
- **Occupancy:** tracked at 5-min granularity via string keys `"entityId-day-minute"` in Sets.

### Frontend pages

All pages are self-contained HTML files with inline `<script>` blocks — no bundler.

| Page | Auth required | Purpose |
|------|--------------|---------|
| `index.html` | No | Landing / login redirect |
| `login.html` | No | Session login |
| `admin.html` | Admin | CRUD for aulas, profesores, asignaturas, usuarios; view/export generated schedules |
| `generador.html` | Auth | Configure preferences, trigger schedule generation, view result |
| `horarios.html` | No (overlay needs schedules API) | View static timetable images + overlay of latest generated schedule |
| `resultado.html` | Auth | Full-page result after generation |
| `profile.html` | Auth | Change password |

**Shared `buildPrintHTML(sesiones, title, slotMins, duracion, year, semester)`** — defined identically in both `admin.html` and `horarios.html`. Generates the white schedule table HTML used for inline display (via iframe + postMessage for auto-height) and PDF export (`window.print()`). Any visual change must be applied to both copies.

### Database schema (key relationships)

```
subjects → subject_teachers ← teachers
teachers → teacher_availability
schedules → schedule_sessions (subject_id, teacher_id, classroom_id, day_of_week, slot_start, slot_end)
schedules.{degree, year, semester, slot_mins, duracion} — added via ALTER TABLE at startup
```

`subjects.room_type` drives classroom matching: `NULL` → only `type='teoria'` classrooms; any value → exact match on `classrooms.type`.
