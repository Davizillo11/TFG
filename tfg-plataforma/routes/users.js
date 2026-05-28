const express      = require("express");
const bcrypt       = require("bcrypt");
const db           = require("../database/db");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();

// GET all (never return password)
router.get("/", requireAdmin, (req, res) => {
  db.all(`
    SELECT u.id, u.username, u.role, u.teacher_id, u.created_at, t.name AS teacher_name
    FROM users u
    LEFT JOIN teachers t ON t.id = u.teacher_id
    ORDER BY u.id
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST create
router.post("/", requireAdmin, async (req, res) => {
  const { username, password, role, teacher_id } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Usuario y contraseña requeridos" });

  const hash = await bcrypt.hash(password, 12);
  const tid  = (role === "profesor" && teacher_id) ? parseInt(teacher_id) : null;
  db.run(
    "INSERT INTO users (username, password, role, teacher_id) VALUES (?,?,?,?)",
    [username, hash, role || "user", tid],
    function (err) {
      if (err) return res.status(500).json({ error: "Usuario ya existe o error en DB" });
      res.json({ id: this.lastID, username, role: role || "user", teacher_id: tid });
    }
  );
});

// DELETE
router.delete("/:id", requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id)
    return res.status(400).json({ error: "No puedes eliminarte a ti mismo" });

  db.run("DELETE FROM users WHERE id=?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ ok: true });
  });
});

module.exports = router;
