const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();

// aulas libres en una franja horaria concreta
router.get("/free", requireAuth, (req, res) => {
  const { day, start, end } = req.query;
  if (day === undefined || !start || !end)
    return res.status(400).json({ error: "day, start y end son obligatorios" });

  db.all(`
    SELECT DISTINCT classroom_id FROM schedule_sessions
    WHERE day_of_week = ?
      AND slot_start < ?
      AND slot_end   > ?
  `, [parseInt(day), end, start], (err, occupied) => {
    if (err) return res.status(500).json({ error: err.message });
    const occupiedIds = new Set(occupied.map(r => r.classroom_id));
    db.all("SELECT * FROM classrooms ORDER BY type, name", (err2, all) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json(all.filter(c => !occupiedIds.has(c.id)));
    });
  });
});

// GET all
router.get("/", requireAuth, (req, res) => {
  db.all("SELECT * FROM classrooms ORDER BY name", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST create
router.post("/", requireAdmin, (req, res) => {
  const { name, capacity, type, building, zone } = req.body;
  if (!name || !capacity) return res.status(400).json({ error: "Nombre y capacidad requeridos" });

  db.run(
    "INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)",
    [name, parseInt(capacity), type || "teoria", building || null, zone || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, capacity: parseInt(capacity), type: type || "teoria", building, zone: zone || null });
    }
  );
});

// PUT update
router.put("/:id", requireAdmin, (req, res) => {
  const { name, capacity, type, building, zone } = req.body;
  db.run(
    "UPDATE classrooms SET name=?, capacity=?, type=?, building=?, zone=? WHERE id=?",
    [name, parseInt(capacity), type, building, zone || null, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });
      res.json({ ok: true });
    }
  );
});

// DELETE
router.delete("/:id", requireAdmin, (req, res) => {
  db.run("DELETE FROM classrooms WHERE id=?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ ok: true });
  });
});

// GET /:id/sessions — todas las sesiones asignadas a esta aula
router.get("/:id/sessions", requireAuth, (req, res) => {
  db.all(`
    SELECT ss.day_of_week, ss.slot_start, ss.slot_end,
           s.name  AS subject,
           sc.degree, sc.year, sc.semester, sc.group_letter,
           t.name  AS teacher
    FROM schedule_sessions ss
    JOIN schedules  sc ON sc.id = ss.schedule_id
    JOIN subjects    s ON  s.id = ss.subject_id
    LEFT JOIN teachers t ON  t.id = ss.teacher_id
    WHERE ss.classroom_id = ?
    ORDER BY ss.day_of_week, ss.slot_start, sc.degree, sc.year, sc.semester
  `, [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

module.exports = router;
