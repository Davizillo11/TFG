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

    req.session.user = { id: user.id, username: user.username, role: user.role, teacher_id: user.teacher_id ?? null };
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

// POST /api/v1/auth/change-password
router.post("/change-password", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "No autenticado" });

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "Faltan campos" });
  if (newPassword.length < 4)
    return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres" });

  db.get("SELECT * FROM users WHERE id = ?", [req.session.user.id], async (err, user) => {
    if (err || !user) return res.status(500).json({ error: "Error del servidor" });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: "Contraseña actual incorrecta" });

    const hash = await bcrypt.hash(newPassword, 12);
    db.run("UPDATE users SET password = ? WHERE id = ?", [hash, user.id], err2 => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ ok: true });
    });
  });
});

module.exports = router;
