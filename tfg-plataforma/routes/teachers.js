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
  const { name, department, email } = req.body;
  if (!name) return res.status(400).json({ error: "Nombre requerido" });

  db.run(
    "INSERT INTO teachers (name, department, email) VALUES (?,?,?)",
    [name, department || null, email || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, department, email });
    }
  );
});

// PUT update
router.put("/:id", requireAdmin, (req, res) => {
  const { name, department, email } = req.body;
  db.run(
    "UPDATE teachers SET name=?, department=?, email=? WHERE id=?",
    [name, department, email, req.params.id],
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

module.exports = router;
