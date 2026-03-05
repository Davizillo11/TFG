const express = require("express");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = 3000;

// Base de datos
const db = new sqlite3.Database("./database/database.db");

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(
  session({
    secret: "tfg-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// Crear tabla usuarios si no existe
db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  password TEXT
)
`);

// Insertar admin si no existe
db.get("SELECT * FROM users WHERE username='admin'", (err, row) => {
  if (!row) {
    db.run("INSERT INTO users (username, password) VALUES (?,?)", [
      "admin",
      "admin",
    ]);
  }
});

// LOGIN
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.get(
    "SELECT * FROM users WHERE username=? AND password=?",
    [username, password],
    (err, user) => {
      if (user) {
        req.session.user = user;
        res.redirect("/pages/index.html");
      } else {
        res.send("Credenciales incorrectas");
      }
    }
  );
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/login.html");
});



// Logout
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login.html");
});

app.listen(PORT, () => {
  console.log(`Servidor funcionando en http://localhost:${PORT}`);
});
