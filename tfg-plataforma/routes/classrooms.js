const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();

// GET all
router.get("/", requireAuth, (req, res) => {
  db.all("SELECT * FROM classrooms ORDER BY name", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST create
router.post("/", requireAdmin, (req, res) => {
  const { name, capacity, type, building } = req.body;
  if (!name || !capacity) return res.status(400).json({ error: "Nombre y capacidad requeridos" });

  db.run(
    "INSERT INTO classrooms (name, capacity, type, building) VALUES (?,?,?,?)",
    [name, parseInt(capacity), type || "teoria", building || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, capacity: parseInt(capacity), type: type || "teoria", building });
    }
  );
});

// PUT update
router.put("/:id", requireAdmin, (req, res) => {
  const { name, capacity, type, building } = req.body;
  db.run(
    "UPDATE classrooms SET name=?, capacity=?, type=?, building=? WHERE id=?",
    [name, parseInt(capacity), type, building, req.params.id],
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

module.exports = router;
