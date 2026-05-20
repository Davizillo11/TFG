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
    const rows = await dbAll("SELECT * FROM slot_limits ORDER BY degree, year, semester");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT upsert
router.put("/", requireAdmin, async (req, res) => {
  try {
    const { degree, year, semester, max_parallel } = req.body;
    if (!degree || year == null || semester == null)
      return res.status(400).json({ error: "degree, year y semester son obligatorios" });
    const mp = parseInt(max_parallel);
    if (isNaN(mp) || mp < 1)
      return res.status(400).json({ error: "max_parallel debe ser >= 1" });
    await dbRun(
      `INSERT INTO slot_limits (degree, year, semester, max_parallel)
       VALUES (?,?,?,?)
       ON CONFLICT(degree, year, semester) DO UPDATE SET max_parallel=excluded.max_parallel`,
      [degree, parseInt(year), parseInt(semester), mp]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE
router.delete("/", requireAdmin, async (req, res) => {
  try {
    const { degree, year, semester } = req.body;
    await dbRun("DELETE FROM slot_limits WHERE degree=? AND year=? AND semester=?",
      [degree, parseInt(year), parseInt(semester)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
