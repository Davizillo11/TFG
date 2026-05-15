const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();

// GET all
router.get("/", requireAuth, (req, res) => {
  db.all("SELECT * FROM teachers ORDER BY name", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST create
router.post("/", requireAdmin, (req, res) => {
  const { name, department, email, session_type } = req.body;
  if (!name) return res.status(400).json({ error: "Nombre requerido" });

  db.run(
    "INSERT INTO teachers (name, department, email, session_type) VALUES (?,?,?,?)",
    [name, department || null, email || null, session_type || 'ambos'],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, department, email, session_type: session_type || 'ambos' });
    }
  );
});

// PUT update
router.put("/:id", requireAdmin, (req, res) => {
  const { name, department, email, session_type } = req.body;
  db.run(
    "UPDATE teachers SET name=?, department=?, email=?, session_type=? WHERE id=?",
    [name, department, email, session_type || 'ambos', req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });
      res.json({ ok: true });
    }
  );
});

// DELETE
router.delete("/:id", requireAdmin, (req, res) => {
  db.run("DELETE FROM teachers WHERE id=?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ ok: true });
  });
});

// GET /:id/sessions — todas las sesiones asignadas a este profesor
router.get("/:id/sessions", requireAuth, (req, res) => {
  db.all(`
    SELECT ss.day_of_week, ss.slot_start, ss.slot_end,
           s.name  AS subject,
           sc.degree, sc.year, sc.semester, sc.group_letter,
           c.name  AS classroom
    FROM schedule_sessions ss
    JOIN schedules  sc ON sc.id = ss.schedule_id
    JOIN subjects    s ON  s.id = ss.subject_id
    JOIN classrooms  c ON  c.id = ss.classroom_id
    WHERE ss.teacher_id = ?
    ORDER BY ss.day_of_week, ss.slot_start, sc.degree, sc.year, sc.semester
  `, [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

module.exports = router;
