const express = require("express");
const bcrypt  = require("bcrypt");
const db      = require("../database/db");

const router = express.Router();

// POST /api/v1/auth/login
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: "Faltan credenciales" });

  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err)   return res.status(500).json({ error: "Error del servidor" });
    if (!user) return res.status(401).json({ error: "Credenciales incorrectas" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Credenciales incorrectas" });

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ ok: true, user: req.session.user });
  });
});

// POST /api/v1/auth/logout
router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/v1/auth/me
router.get("/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "No autenticado" });
  res.json({ user: req.session.user });
});

module.exports = router;
