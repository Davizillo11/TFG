const express     = require("express");
const db          = require("../database/db");
const requireAuth = require("../middleware/auth");
const requireAdmin= require("../middleware/adminOnly");

const router = express.Router();

function dbAll(sql, p=[]) { return new Promise((ok,ko) => db.all(sql,p,(e,r)=>e?ko(e):ok(r))); }
function dbRun(sql, p=[]) { return new Promise((ok,ko) => db.run(sql,p,function(e){e?ko(e):ok(this)})); }

// GET all
router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM degree_groups ORDER BY degree, year, group_letter");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT upsert
router.put("/", requireAdmin, async (req, res) => {
  try {
    const { degree, year, group_letter } = req.body;
    if (!degree || year == null || !group_letter)
      return res.status(400).json({ error: "degree, year y group_letter son obligatorios" });
    await dbRun(
      `INSERT OR IGNORE INTO degree_groups (degree, year, group_letter) VALUES (?,?,?)`,
      [degree, parseInt(year), group_letter.toUpperCase()]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE
router.delete("/", requireAdmin, async (req, res) => {
  try {
    const { degree, year, group_letter } = req.body;
    await dbRun("DELETE FROM degree_groups WHERE degree=? AND year=? AND group_letter=?",
      [degree, parseInt(year), group_letter]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
