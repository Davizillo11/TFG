const express     = require("express");
const db          = require("../database/db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); })
  );
}

// GET /api/v1/student/items
router.get("/items", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const rows = await dbAll(`
      SELECT
        ssi.id, ssi.subject_id, ssi.degree, ssi.year, ssi.semester,
        ssi.group_letter, ssi.subgroup AS chosen_subgroup,
        sub.name  AS subject_name, sub.code,
        ss.day_of_week, ss.slot_start, ss.slot_end, ss.subgroup AS session_subgroup,
        c.name    AS classroom_name,
        t.name    AS teacher_name
      FROM student_schedule_items ssi
      JOIN subjects sub ON sub.id = ssi.subject_id
      LEFT JOIN schedules sc
        ON  sc.degree       = ssi.degree
        AND sc.year         = ssi.year
        AND sc.semester     = ssi.semester
        AND sc.group_letter = ssi.group_letter
        AND sc.status       = 'active'
      LEFT JOIN schedule_sessions ss
        ON  ss.schedule_id  = sc.id
        AND ss.subject_id   = ssi.subject_id
        AND (ss.subgroup IS NULL
             OR ssi.subgroup IS NULL
             OR ss.subgroup = ssi.subgroup)
      LEFT JOIN classrooms c ON c.id = ss.classroom_id
      LEFT JOIN teachers   t ON t.id = ss.teacher_id
      WHERE ssi.user_id = ?
      ORDER BY ssi.id, ss.day_of_week, ss.slot_start
    `, [userId]);

    const itemMap = {};
    for (const row of rows) {
      if (!itemMap[row.id]) {
        itemMap[row.id] = {
          id:             row.id,
          subject_id:     row.subject_id,
          subject_name:   row.subject_name,
          code:           row.code,
          degree:         row.degree,
          year:           row.year,
          semester:       row.semester,
          group_letter:   row.group_letter,
          chosen_subgroup: row.chosen_subgroup,
          sessions:       []
        };
      }
      if (row.day_of_week !== null) {
        itemMap[row.id].sessions.push({
          day_of_week:     row.day_of_week,
          slot_start:      row.slot_start,
          slot_end:        row.slot_end,
          subgroup:        row.session_subgroup,
          classroom_name:  row.classroom_name,
          teacher_name:    row.teacher_name
        });
      }
    }
    res.json(Object.values(itemMap));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/student/items
router.post("/items", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { subject_id, degree, year, semester, group_letter, subgroup } = req.body;
    if (!subject_id || !degree || year == null || !semester || !group_letter)
      return res.status(400).json({ error: "Faltan campos" });

    const sg = (subgroup != null && subgroup !== '') ? parseInt(subgroup) : null;

    // INSERT OR REPLACE so re-adding the same subject with a different subgroup updates it
    await dbRun(
      `INSERT OR REPLACE INTO student_schedule_items
         (user_id, subject_id, degree, year, semester, group_letter, subgroup)
       VALUES (?,?,?,?,?,?,?)`,
      [userId, subject_id, degree, year, semester, group_letter, sg]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/student/items?semester=X
router.delete("/items", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { semester } = req.query;
    if (!semester) return res.status(400).json({ error: "Falta semester" });
    await dbRun(
      `DELETE FROM student_schedule_items WHERE user_id = ? AND semester = ?`,
      [userId, parseInt(semester)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/student/items/:id
router.delete("/items/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    await dbRun(
      `DELETE FROM student_schedule_items WHERE id = ? AND user_id = ?`,
      [req.params.id, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/student/smart-options?subject_ids=1,2,3
// Devuelve teoría Y subgrupos de lab por grupo (solo horarios activos)
router.get("/smart-options", requireAuth, async (req, res) => {
  try {
    const ids = (req.query.subject_ids || '').split(',').map(Number).filter(Boolean);
    if (!ids.length) return res.json([]);

    const placeholders = ids.map(() => '?').join(',');
    const rows = await dbAll(`
      SELECT ss.subject_id, sub.name AS subject_name, sub.degree, sub.year, sub.semester,
             sc.group_letter, ss.day_of_week, ss.slot_start, ss.slot_end, ss.subgroup
      FROM schedule_sessions ss
      JOIN schedules sc  ON sc.id  = ss.schedule_id AND sc.status = 'active'
      JOIN subjects  sub ON sub.id = ss.subject_id
      WHERE ss.subject_id IN (${placeholders})
      ORDER BY ss.subject_id, sc.group_letter, ss.subgroup, ss.day_of_week, ss.slot_start
    `, ids);

    const map = {};
    for (const r of rows) {
      if (!map[r.subject_id]) {
        map[r.subject_id] = {
          subject_id: r.subject_id, subject_name: r.subject_name,
          degree: r.degree, year: r.year, semester: r.semester,
          groups: {}
        };
      }
      const grp = r.group_letter;
      if (!map[r.subject_id].groups[grp])
        map[r.subject_id].groups[grp] = { theory: [], subgroups: {} };

      const sess = { day: r.day_of_week, start: r.slot_start, end: r.slot_end };
      if (r.subgroup === null) {
        map[r.subject_id].groups[grp].theory.push(sess);
      } else {
        const sg = String(r.subgroup);
        if (!map[r.subject_id].groups[grp].subgroups[sg])
          map[r.subject_id].groups[grp].subgroups[sg] = [];
        map[r.subject_id].groups[grp].subgroups[sg].push(sess);
      }
    }
    res.json(Object.values(map));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
