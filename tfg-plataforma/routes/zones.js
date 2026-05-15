const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();

function dbAll(sql, p = []) { return new Promise((ok, ko) => db.all(sql, p, (e, r) => e ? ko(e) : ok(r))); }
function dbRun(sql, p = []) { return new Promise((ok, ko) => db.run(sql, p, function(e) { e ? ko(e) : ok(this); })); }

// lista todas las preferencias de zona
router.get("/", requireAuth, async (req, res) => {
  try {
    res.json(await dbAll("SELECT * FROM zone_preferences ORDER BY degree, year"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// crea o actualiza la preferencia para un grado/año
router.post("/", requireAdmin, async (req, res) => {
  const { degree, year, zone } = req.body;
  if (!degree || !year) return res.status(400).json({ error: "degree y year son obligatorios" });
  try {
    await dbRun(
      "INSERT INTO zone_preferences (degree, year, zone) VALUES (?,?,?) ON CONFLICT(degree,year) DO UPDATE SET zone=excluded.zone",
      [degree, parseInt(year), zone || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await dbRun("DELETE FROM zone_preferences WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
