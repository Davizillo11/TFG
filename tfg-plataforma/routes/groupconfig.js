const express     = require("express");
const db          = require("../database/db");
const requireAuth = require("../middleware/auth");
const requireAdmin= require("../middleware/adminOnly");

const router = express.Router();

function dbAll(sql, p=[]) { return new Promise((ok,ko) => db.all(sql,p,(e,r)=>e?ko(e):ok(r))); }
function dbRun(sql, p=[]) { return new Promise((ok,ko) => db.run(sql,p,function(e){e?ko(e):ok(this)})); }

// listar todas
router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM group_config ORDER BY year, degree, group_letter");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// crear o actualizar una entrada
router.put("/", requireAdmin, async (req, res) => {
  try {
    const { degree, year, group_letter, afternoon = 0, bilingual = 0 } = req.body;
    if (!degree || year == null || !group_letter)
      return res.status(400).json({ error: "degree, year y group_letter son obligatorios" });
    await dbRun(
      `INSERT INTO group_config (degree, year, group_letter, afternoon, bilingual)
       VALUES (?,?,?,?,?)
       ON CONFLICT(degree, year, group_letter) DO UPDATE SET afternoon=excluded.afternoon, bilingual=excluded.bilingual`,
      [degree, year, group_letter, afternoon ? 1 : 0, bilingual ? 1 : 0]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// eliminar
router.delete("/", requireAdmin, async (req, res) => {
  try {
    const { degree, year, group_letter } = req.body;
    await dbRun("DELETE FROM group_config WHERE degree=? AND year=? AND group_letter=?", [degree, year, group_letter]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
