/**
 * cole.js — Seed de colegio: 8 asignaturas típicas de primaria/secundaria.
 * Uso: node cole.js
 */
const bcrypt = require("bcrypt");
const db     = require("./database/db");

async function seed() {
  console.log("Iniciando seed colegio...");

  await run("PRAGMA foreign_keys = OFF");

  // ── Crear tablas si no existen ────────────────────
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run("DROP TABLE IF EXISTS classrooms");
  await run(`CREATE TABLE classrooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, capacity INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'teoria', building TEXT, zone TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, department TEXT, email TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, code TEXT UNIQUE, degree TEXT,
    year INTEGER, semester INTEGER, students INTEGER, hours_week INTEGER DEFAULT 4
  )`);
  await run(`CREATE TABLE IF NOT EXISTS subject_teachers (
    subject_id INTEGER, teacher_id INTEGER,
    PRIMARY KEY (subject_id, teacher_id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS teacher_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER, day_of_week INTEGER NOT NULL,
    slot_start TEXT NOT NULL, slot_end TEXT NOT NULL, available INTEGER DEFAULT 1
  )`);
  await run(`CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
    created_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'draft'
  )`);
  await run(`CREATE TABLE IF NOT EXISTS schedule_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER,
    subject_id INTEGER, teacher_id INTEGER, classroom_id INTEGER,
    day_of_week INTEGER NOT NULL, slot_start TEXT NOT NULL, slot_end TEXT NOT NULL
  )`);

  // ── Limpiar datos anteriores ──────────────────────
  await run("DELETE FROM schedule_sessions");
  await run("DELETE FROM schedules");
  await run("DELETE FROM teacher_availability");
  await run("DELETE FROM subject_teachers");
  await run("DELETE FROM subjects");
  await run("DELETE FROM teachers");
  await run("DELETE FROM classrooms");
  await run("DELETE FROM users");

  // ── Usuarios ──────────────────────────────────────
  const adminHash = await bcrypt.hash("admin", 12);
  const userHash  = await bcrypt.hash("david", 12);
  await run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ["admin", adminHash, "admin"]);
  await run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ["david", userHash,  "user"]);
  console.log("✓ Usuarios");

  // ── Aulas ─────────────────────────────────────────
  const COLE = "Colegio San Isidro";
  const classrooms = [
    ["Aula 1A",         30, "teoria",      null],
    ["Aula 1B",         30, "teoria",      null],
    ["Aula 2A",         30, "teoria",      null],
    ["Aula 2B",         30, "teoria",      null],
    ["Lab Ciencias",    25, "laboratorio", null],
    ["Sala Informática",25, "laboratorio", null],
    ["Gimnasio",        60, "seminario",   null],
    ["Sala Música",     20, "seminario",   null],
  ];
  for (const [name, capacity, type, zone] of classrooms) {
    await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)",
      [name, capacity, type, COLE, zone]);
  }
  console.log("✓ Aulas");

  // ── Profesores ────────────────────────────────────
  const teachers = [
    ["Laura Sanz Moreno",       "Matemáticas",          "l.sanz@sani.es"],
    ["Carlos Ruiz Blanco",      "Lengua",               "c.ruiz@sani.es"],
    ["María García Vega",       "Ciencias Naturales",   "m.garcia@sani.es"],
    ["Antonio López Prieto",    "Historia",             "a.lopez@sani.es"],
    ["Elena Martín Fuentes",    "Inglés",               "e.martin@sani.es"],
    ["Pablo Díaz Castillo",     "Educación Física",     "p.diaz@sani.es"],
    ["Sofía Torres Iglesias",   "Música",               "s.torres@sani.es"],
    ["Javier Romero Campos",    "Plástica",             "j.romero@sani.es"],
  ];
  for (const [name, department, email] of teachers) {
    await run("INSERT INTO teachers (name, department, email) VALUES (?,?,?)",
      [name, department, email]);
  }
  console.log("✓ Profesores");

  // ── Disponibilidad (Lun-Vie, 9:00-17:00) ─────────
  const teacherRows = await all("SELECT id FROM teachers");
  for (const { id } of teacherRows) {
    for (let day = 0; day <= 4; day++) {
      await run(
        "INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,?)",
        [id, day, "09:00", "14:00", 1]
      );
    }
  }
  console.log("✓ Disponibilidades");

  // ── Asignaturas ───────────────────────────────────
  // code, name, degree, year, semester, students, hours_week
  const subjects = [
    ["COLE-MAT",  "Matemáticas",        "Primaria", 1, null, 28, 5],
    ["COLE-LEN",  "Lengua Castellana",  "Primaria", 1, null, 28, 5],
    ["COLE-CN",   "Ciencias Naturales", "Primaria", 1, null, 28, 3],
    ["COLE-HIS",  "Historia",           "Primaria", 1, null, 28, 3],
    ["COLE-ING",  "Inglés",             "Primaria", 1, null, 28, 4],
    ["COLE-EF",   "Educación Física",   "Primaria", 1, null, 28, 2],
    ["COLE-MUS",  "Música",             "Primaria", 1, null, 28, 2],
    ["COLE-PLA",  "Plástica",           "Primaria", 1, null, 28, 2],
  ];
  for (const [code, name, degree, year, semester, students, hours_week] of subjects) {
    await run(
      "INSERT INTO subjects (code, name, degree, year, semester, students, hours_week) VALUES (?,?,?,?,?,?,?)",
      [code, name, degree, year, semester, students, hours_week]
    );
  }
  console.log("✓ Asignaturas");

  // ── Asignaciones profesor → asignatura ───────────
  // 1=Laura (Mat)  2=Carlos (Len)  3=María (CN)   4=Antonio (His)
  // 5=Elena (Ing)  6=Pablo (EF)    7=Sofía (Mus)  8=Javier (Pla)
  const assignments = {
    "COLE-MAT": 1,
    "COLE-LEN": 2,
    "COLE-CN":  3,
    "COLE-HIS": 4,
    "COLE-ING": 5,
    "COLE-EF":  6,
    "COLE-MUS": 7,
    "COLE-PLA": 8,
  };

  const subjectRows = await all("SELECT id, code FROM subjects ORDER BY id");
  const teacherList = await all("SELECT id FROM teachers ORDER BY id");

  for (const { id: sid, code } of subjectRows) {
    const idx = assignments[code];
    const tid = teacherList[(idx ?? 1) - 1].id;
    await run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)", [sid, tid]);
  }
  console.log("✓ Asignaciones profesor-asignatura");

  console.log("\n✅ Seed colegio completado. Ejecuta: npm start");
  db.close();
}

// ── Helpers ───────────────────────────────────────
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

seed().catch(err => {
  console.error("Error en seed:", err);
  db.close();
});
