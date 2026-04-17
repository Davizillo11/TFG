const bcrypt = require("bcrypt");
const db     = require("./db");

db.serialize(() => {

  // Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    UNIQUE NOT NULL,
    password   TEXT    NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Classrooms
  db.run(`CREATE TABLE IF NOT EXISTS classrooms (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL,
    capacity INTEGER NOT NULL,
    type     TEXT    NOT NULL DEFAULT 'teoria',
    building TEXT,
    zone     TEXT
  )`);
  db.run("ALTER TABLE classrooms ADD COLUMN zone TEXT", () => {});

  // Teachers
  db.run(`CREATE TABLE IF NOT EXISTS teachers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    department TEXT,
    email      TEXT
  )`);

  // Subjects
  db.run(`CREATE TABLE IF NOT EXISTS subjects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    code       TEXT    UNIQUE,
    degree     TEXT,
    year       INTEGER,
    semester   INTEGER,
    students   INTEGER,
    hours_week INTEGER DEFAULT 4,
    room_type  TEXT    DEFAULT NULL
  )`);

  // Subject–Teacher junction
  db.run(`CREATE TABLE IF NOT EXISTS subject_teachers (
    subject_id INTEGER REFERENCES subjects(id)  ON DELETE CASCADE,
    teacher_id INTEGER REFERENCES teachers(id)  ON DELETE CASCADE,
    PRIMARY KEY (subject_id, teacher_id)
  )`);

  // Teacher availability
  db.run(`CREATE TABLE IF NOT EXISTS teacher_availability (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id  INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL,
    slot_start  TEXT    NOT NULL,
    slot_end    TEXT    NOT NULL,
    available   INTEGER DEFAULT 1
  )`);

  // Generated schedules
  db.run(`CREATE TABLE IF NOT EXISTS schedules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status     TEXT DEFAULT 'draft',
    degree     TEXT,
    year       INTEGER
  )`);
  db.run("ALTER TABLE schedules ADD COLUMN degree TEXT", () => {});
  db.run("ALTER TABLE schedules ADD COLUMN year INTEGER", () => {});

  // Schedule sessions
  db.run(`CREATE TABLE IF NOT EXISTS schedule_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id  INTEGER REFERENCES schedules(id)   ON DELETE CASCADE,
    subject_id   INTEGER REFERENCES subjects(id),
    teacher_id   INTEGER REFERENCES teachers(id),
    classroom_id INTEGER REFERENCES classrooms(id),
    day_of_week  INTEGER NOT NULL,
    slot_start   TEXT    NOT NULL,
    slot_end     TEXT    NOT NULL
  )`);

  // Default admin user (bcrypt, cost 12)
  db.get("SELECT id FROM users WHERE username = 'admin'", async (err, row) => {
    if (!row) {
      const hash = await bcrypt.hash("admin", 12);
      db.run(
        "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
        ["admin", hash, "admin"]
      );
      console.log("[DB] Admin user created.");
    }
  });

});

module.exports = db;
