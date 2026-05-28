const bcrypt = require("bcrypt");
const db     = require("./db");

db.serialize(() => {

  // Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    UNIQUE NOT NULL,
    password   TEXT    NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'user',
    teacher_id INTEGER REFERENCES teachers(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run("ALTER TABLE users ADD COLUMN teacher_id INTEGER REFERENCES teachers(id)", () => {});

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
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    department   TEXT,
    email        TEXT,
    session_type TEXT DEFAULT 'ambos'
  )`);
  db.run("ALTER TABLE teachers ADD COLUMN session_type TEXT DEFAULT 'ambos'", () => {});

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
    available   INTEGER DEFAULT 1,
    semester    INTEGER DEFAULT NULL
  )`);
  db.run("ALTER TABLE teacher_availability ADD COLUMN semester INTEGER DEFAULT NULL", () => {});

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
  db.run("ALTER TABLE schedules ADD COLUMN slot_mins TEXT", () => {});
  db.run("ALTER TABLE schedules ADD COLUMN duracion INTEGER", () => {});
  db.run("ALTER TABLE schedules ADD COLUMN semester INTEGER", () => {});
  db.run("ALTER TABLE subjects ADD COLUMN bilingual INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE schedules ADD COLUMN group_letter TEXT", () => {});
  db.run("ALTER TABLE schedules ADD COLUMN generation_id TEXT", () => {});
  db.run("ALTER TABLE subjects ADD COLUMN session_type TEXT DEFAULT 'teoria'", () => {});
  db.run("ALTER TABLE schedule_sessions ADD COLUMN subgroup INTEGER DEFAULT NULL", () => {});
  db.run("ALTER TABLE subjects ADD COLUMN theory_hours INTEGER DEFAULT 2", () => {});
  db.run("ALTER TABLE subjects ADD COLUMN lab_hours INTEGER DEFAULT 2", () => {});
  db.run(`CREATE TABLE IF NOT EXISTS zone_preferences (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    degree TEXT    NOT NULL,
    year   INTEGER NOT NULL,
    zone   TEXT,
    UNIQUE(degree, year)
  )`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS group_config (
    degree       TEXT    NOT NULL,
    year         INTEGER NOT NULL,
    group_letter TEXT    NOT NULL,
    afternoon    INTEGER NOT NULL DEFAULT 0,
    bilingual    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (degree, year, group_letter)
  )`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS slot_limits (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    degree       TEXT    NOT NULL,
    year         INTEGER NOT NULL,
    semester     INTEGER NOT NULL,
    max_parallel INTEGER NOT NULL DEFAULT 2,
    UNIQUE(degree, year, semester)
  )`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS degree_groups (
    degree       TEXT    NOT NULL,
    year         INTEGER NOT NULL,
    group_letter TEXT    NOT NULL,
    PRIMARY KEY (degree, year, group_letter)
  )`, () => {});

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

  db.run("ALTER TABLE student_schedule_items ADD COLUMN subgroup INTEGER DEFAULT NULL", () => {});

  db.run(`CREATE TABLE IF NOT EXISTS student_schedule_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    subject_id   INTEGER NOT NULL,
    degree       TEXT    NOT NULL,
    year         INTEGER NOT NULL,
    semester     INTEGER NOT NULL,
    group_letter TEXT    NOT NULL,
    UNIQUE(user_id, subject_id, degree, year, semester, group_letter)
  )`, () => {});

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
