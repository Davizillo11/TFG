/**
 * cole.js — Seed de colegio: 8 asignaturas típicas de primaria/secundaria.
 * Uso: node cole.js
 */
const bcrypt  = require("bcrypt");
const sqlite3 = require("sqlite3").verbose();
const path    = require("path");

// Conexión propia sin PRAGMA foreign_keys = ON
const db = new sqlite3.Database(path.join(__dirname, "database/database.db"));

async function seed() {
  console.log("Iniciando seed colegio...");

  // Eliminar todas las tablas para evitar conflictos de FK
  await run("DROP TABLE IF EXISTS schedule_sessions");
  await run("DROP TABLE IF EXISTS schedules");
  await run("DROP TABLE IF EXISTS teacher_availability");
  await run("DROP TABLE IF EXISTS subject_teachers");
  await run("DROP TABLE IF EXISTS subjects");
  await run("DROP TABLE IF EXISTS teachers");
  await run("DROP TABLE IF EXISTS classrooms");
  await run("DROP TABLE IF EXISTS users");

  // ── Crear tablas ──────────────────────────────────
  await run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE classrooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, capacity INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'teoria', building TEXT, zone TEXT
  )`);
  await run(`CREATE TABLE teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, department TEXT, email TEXT
  )`);
  await run(`CREATE TABLE subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, code TEXT UNIQUE, degree TEXT,
    year INTEGER, semester INTEGER, students INTEGER, hours_week INTEGER DEFAULT 4,
    room_type TEXT DEFAULT NULL
  )`);
  await run(`CREATE TABLE subject_teachers (
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
    PRIMARY KEY (subject_id, teacher_id)
  )`);
  await run(`CREATE TABLE teacher_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL,
    slot_start TEXT NOT NULL, slot_end TEXT NOT NULL, available INTEGER DEFAULT 1
  )`);
  await run(`CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'draft'
  )`);
  await run(`CREATE TABLE schedule_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE,
    subject_id INTEGER REFERENCES subjects(id),
    teacher_id INTEGER REFERENCES teachers(id),
    classroom_id INTEGER REFERENCES classrooms(id),
    day_of_week INTEGER NOT NULL, slot_start TEXT NOT NULL, slot_end TEXT NOT NULL
  )`);

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
    ["Lab Ciencias",    30, "laboratorio", null],
    ["Sala Informática",30, "informatica", null],
    ["Gimnasio",        30, "gimnasio",    null],
    ["Sala Música",     30, "musica",      null],
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
    ["Raquel Vidal Serrano",    "Ciencias Sociales",    "r.vidal@sani.es"],
    ["Marcos Peña Herrera",     "Tecnología",           "m.pena@sani.es"],
  ];
  for (const [name, department, email] of teachers) {
    await run("INSERT INTO teachers (name, department, email) VALUES (?,?,?)",
      [name, department, email]);
  }
  console.log("✓ Profesores");

  // ── Disponibilidad: 6 franjas de 55min con recreo 10:45-11:15 ──
  // Bloque mañana:  08:00-08:55 | 08:55-09:50 | 09:50-10:45
  // Recreo:         10:45-11:15  (sin disponibilidad)
  // Bloque tarde:   11:15-12:10 | 12:10-13:05 | 13:05-14:00
  const SLOTS = [
    ["08:00","08:55"],
    ["08:55","09:50"],
    ["09:50","10:45"],
    ["11:15","12:10"],
    ["12:10","13:05"],
    ["13:05","14:00"],
  ];
  const teacherRows = await all("SELECT id FROM teachers");
  for (const { id } of teacherRows) {
    for (let day = 0; day <= 4; day++) {
      for (const [start, end] of SLOTS) {
        await run(
          "INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,?)",
          [id, day, start, end, 1]
        );
      }
    }
  }
  console.log("✓ Disponibilidades");

  // ── Asignaturas ───────────────────────────────────
  // code, name, degree, year, semester, students, hours_week, room_type
  // room_type null  → aula normal (teoria)
  // room_type 'X'  → solo puede usar aulas con type='X'
  const subjects = [
    ["COLE-MAT",  "Matemáticas",        "Primaria", 1, null, 28, 4, null],
    ["COLE-LEN",  "Lengua Castellana",  "Primaria", 1, null, 28, 4, null],
    ["COLE-ING",  "Inglés",             "Primaria", 1, null, 28, 4, null],
    ["COLE-CN",   "Ciencias Naturales", "Primaria", 1, null, 28, 3, "laboratorio"],
    ["COLE-CS",   "Ciencias Sociales",  "Primaria", 1, null, 28, 3, null],
    ["COLE-HIS",  "Historia",           "Primaria", 1, null, 28, 3, null],
    ["COLE-EF",   "Educación Física",   "Primaria", 1, null, 28, 3, "gimnasio"],
    ["COLE-MUS",  "Música",             "Primaria", 1, null, 28, 2, "musica"],
    ["COLE-PLA",  "Plástica",           "Primaria", 1, null, 28, 2, null],
    ["COLE-TIC",  "Tecnologia",         "Primaria", 1, null, 28, 2, "informatica"],
  ];
  for (const [code, name, degree, year, semester, students, hours_week, room_type] of subjects) {
    await run(
      "INSERT INTO subjects (code, name, degree, year, semester, students, hours_week, room_type) VALUES (?,?,?,?,?,?,?,?)",
      [code, name, degree, year, semester, students, hours_week, room_type]
    );
  }
  console.log("✓ Asignaturas");

  // ── Asignaciones profesor → asignatura ───────────
  // 1=Laura (Mat)  2=Carlos (Len)  3=María (CN)    4=Antonio (His)
  // 5=Elena (Ing)  6=Pablo (EF)    7=Sofía (Mus)   8=Javier (Pla)
  // 9=Raquel (CS)  10=Marcos (TIC)
  const assignments = {
    "COLE-MAT": 1,
    "COLE-LEN": 2,
    "COLE-CN":  3,
    "COLE-HIS": 4,
    "COLE-ING": 5,
    "COLE-EF":  6,
    "COLE-MUS": 7,
    "COLE-PLA": 8,
    "COLE-CS":  9,
    "COLE-TIC": 10,
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
