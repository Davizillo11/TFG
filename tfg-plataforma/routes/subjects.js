const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();

// listar todas
router.get("/", requireAuth, (req, res) => {
  db.all(`
    SELECT s.*,
           GROUP_CONCAT(t.name,       ', ') AS teacher_names,
           GROUP_CONCAT(st.teacher_id, ',') AS teacher_ids_str
    FROM subjects s
    LEFT JOIN subject_teachers st ON s.id = st.subject_id
    LEFT JOIN teachers t ON st.teacher_id = t.id
    GROUP BY s.id
    ORDER BY s.degree, s.year, s.name
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// crear
router.post("/", requireAdmin, (req, res) => {
  const { name, code, degree, year, semester, students, hours_week, teacher_ids, room_type, session_type, theory_hours, lab_hours } = req.body;
  if (!name) return res.status(400).json({ error: "Nombre requerido" });
  const bilingual = req.body.bilingual ? 1 : 0;
  const ids = Array.isArray(teacher_ids) ? teacher_ids.filter(Boolean) : [];
  const hw = parseInt(hours_week) || 4;
  const th = theory_hours != null ? parseInt(theory_hours) : hw - 2;
  const lh = lab_hours    != null ? parseInt(lab_hours)    : 2;

  db.run(
    "INSERT INTO subjects (name, code, degree, year, semester, students, hours_week, bilingual, room_type, session_type, theory_hours, lab_hours) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [name, code || null, degree || null, year || null, semester || null,
     students || null, hw, bilingual, room_type || null, session_type || 'teoria', th, lh],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      const subjectId = this.lastID;
      for (const tid of ids) {
        db.run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)", [subjectId, tid], () => {});
      }
      res.json({ id: subjectId, name, code, degree, year, semester, students, hours_week: hw, bilingual, room_type, session_type, theory_hours: th, lab_hours: lh });
    }
  );
});

// actualizar
router.put("/:id", requireAdmin, (req, res) => {
  const { name, code, degree, year, semester, students, hours_week, teacher_ids, room_type, session_type, theory_hours, lab_hours } = req.body;
  const bilingual = req.body.bilingual ? 1 : 0;
  const hw = parseInt(hours_week) || 4;
  const th = theory_hours != null ? parseInt(theory_hours) : hw - 2;
  const lh = lab_hours    != null ? parseInt(lab_hours)    : 2;
  db.run(
    "UPDATE subjects SET name=?, code=?, degree=?, year=?, semester=?, students=?, hours_week=?, bilingual=?, room_type=?, session_type=?, theory_hours=?, lab_hours=? WHERE id=?",
    [name, code, degree, year, semester, students, hw, bilingual,
     room_type || null, session_type || 'teoria', th, lh, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });

      if (teacher_ids !== undefined) {
        const ids = Array.isArray(teacher_ids) ? teacher_ids.filter(Boolean) : [];
        db.run("DELETE FROM subject_teachers WHERE subject_id=?", [req.params.id], () => {
          for (const tid of ids) {
            db.run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)", [req.params.id, tid], () => {});
          }
        });
      }
      res.json({ ok: true });
    }
  );
});

// eliminar
router.delete("/:id", requireAdmin, (req, res) => {
  db.run("DELETE FROM subjects WHERE id=?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ ok: true });
  });
});

module.exports = router;
