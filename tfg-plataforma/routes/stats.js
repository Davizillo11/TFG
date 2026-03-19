const express     = require("express");
const db          = require("../database/db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  db.get(`
    SELECT
      (SELECT COUNT(*) FROM classrooms) AS classrooms,
      (SELECT COUNT(*) FROM teachers)   AS teachers,
      (SELECT COUNT(*) FROM subjects)   AS subjects,
      (SELECT COUNT(*) FROM users)      AS users,
      (SELECT COUNT(*) FROM schedules)  AS schedules
  `, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

module.exports = router;
