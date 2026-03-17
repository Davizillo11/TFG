function requireAdmin(req, res, next) {
  if (!req.session.user)              return res.status(401).json({ error: "No autenticado" });
  if (req.session.user.role !== "admin") return res.status(403).json({ error: "Acceso denegado" });
  next();
}

module.exports = requireAdmin;
