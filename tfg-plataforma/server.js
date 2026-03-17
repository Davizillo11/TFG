const express = require("express");
const session = require("express-session");
const path    = require("path");

const app  = express();
const PORT = 3000;

// ── Middleware ────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(session({
  secret:            process.env.SESSION_SECRET || "tfg-secret-2024",
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24h
}));

// ── Database & Schema ─────────────────────────────
require("./database/schema");

// ── Routes ────────────────────────────────────────
app.use("/api/v1/auth",       require("./routes/auth"));
app.use("/api/v1/classrooms", require("./routes/classrooms"));
app.use("/api/v1/teachers",   require("./routes/teachers"));
app.use("/api/v1/subjects",   require("./routes/subjects"));
app.use("/api/v1/users",      require("./routes/users"));

// ── Serve app ─────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando en http://localhost:${PORT}`);
});
