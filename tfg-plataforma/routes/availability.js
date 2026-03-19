const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router({ mergeParams: true });

// GET /api/v1/teachers/:id/availability
router.get("/", requireAuth, (req, res) => {
  db.all(
    "SELECT * FROM teacher_availability WHERE teacher_id = ? ORDER BY day_of_week, slot_start",
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// PUT /api/v1/teachers/:id/availability — reemplaza todos los slots
router.put("/", requireAdmin, (req, res) => {
  const { slots } = req.body; // [{day_of_week, slot_start, slot_end}]
  const tid = req.params.id;

  db.run("DELETE FROM teacher_availability WHERE teacher_id = ?", [tid], err => {
    if (err) return res.status(500).json({ error: err.message });
    if (!slots || !slots.length) return res.json({ ok: true });

    const stmt = db.prepare(
      "INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,1)"
    );
    for (const s of slots) {
      stmt.run([tid, s.day_of_week, s.slot_start, s.slot_end]);
    }
    stmt.finalize(err2 => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ ok: true });
    });
  });
});

module.exports = router;
