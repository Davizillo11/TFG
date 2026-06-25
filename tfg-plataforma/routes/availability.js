const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

function requireAdminOrOwnTeacher(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (user.role === "admin") return next();
  if (user.role === "profesor" && user.teacher_id === parseInt(req.params.id)) return next();
  return res.status(403).json({ error: "Sin permisos" });
}

const router = express.Router({ mergeParams: true });

// devuelve la disponibilidad de un profesor
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

// reemplaza los slots del cuatrimestre indicado (admin o el propio profesor)
// cuerpo: { slots: [{day_of_week, slot_start, slot_end}], semester: null|1|2 }
router.put("/", requireAdminOrOwnTeacher, (req, res) => {
  const { slots, semester = null } = req.body;
  const tid = req.params.id;

  // Borrar solo las filas del cuatrimestre correspondiente (NULL o específico)
  const delSql    = semester == null
    ? "DELETE FROM teacher_availability WHERE teacher_id = ? AND semester IS NULL"
    : "DELETE FROM teacher_availability WHERE teacher_id = ? AND semester = ?";
  const delParams = semester == null ? [tid] : [tid, semester];

  db.run(delSql, delParams, err => {
    if (err) return res.status(500).json({ error: err.message });
    if (!slots || !slots.length) return res.json({ ok: true });

    const stmt = db.prepare(
      "INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available, semester) VALUES (?,?,?,?,1,?)"
    );
    for (const s of slots) {
      stmt.run([tid, s.day_of_week, s.slot_start, s.slot_end, semester ?? null]);
    }
    stmt.finalize(err2 => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ ok: true });
    });
  });
});

module.exports = router;
