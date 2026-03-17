const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();

// GET all (with teacher name)
router.get("/", requireAuth, (req, res) => {
  db.all(`
    SELECT s.*, t.name AS teacher_name, t.id AS teacher_id
    FROM subjects s
    LEFT JOIN subject_teachers st ON s.id = st.subject_id
    LEFT JOIN teachers t ON st.teacher_id = t.id
    ORDER BY s.degree, s.year, s.name
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST create
router.post("/", requireAdmin, (req, res) => {
  const { name, code, degree, year, semester, students, hours_week, teacher_id } = req.body;
  if (!name) return res.status(400).json({ error: "Nombre requerido" });

  db.run(
    "INSERT INTO subjects (name, code, degree, year, semester, students, hours_week) VALUES (?,?,?,?,?,?,?)",
    [name, code || null, degree || null, year || null, semester || null,
     students || null, hours_week || 4],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      const subjectId = this.lastID;

      if (teacher_id) {
        db.run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)",
          [subjectId, teacher_id], () => {});
      }

      res.json({ id: subjectId, name, code, degree, year, semester, students, hours_week });
    }
  );
});

// PUT update
router.put("/:id", requireAdmin, (req, res) => {
  const { name, code, degree, year, semester, students, hours_week, teacher_id } = req.body;
  db.run(
    "UPDATE subjects SET name=?, code=?, degree=?, year=?, semester=?, students=?, hours_week=? WHERE id=?",
    [name, code, degree, year, semester, students, hours_week, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });

      if (teacher_id !== undefined) {
        db.run("DELETE FROM subject_teachers WHERE subject_id=?", [req.params.id], () => {
          if (teacher_id) {
            db.run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)",
              [req.params.id, teacher_id], () => {});
          }
        });
      }
      res.json({ ok: true });
    }
  );
});

// DELETE
router.delete("/:id", requireAdmin, (req, res) => {
  db.run("DELETE FROM subjects WHERE id=?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ ok: true });
  });
});

module.exports = router;
