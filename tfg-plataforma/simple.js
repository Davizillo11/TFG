/**
 * seed_simple.js — Seed mínimo: solo asignaturas de 1er año (Teleco).
 * Uso: node seed_simple.js
 */
const bcrypt = require("bcrypt");
const db     = require("./database/db");

async function seed() {
  console.log("Iniciando seed simple...");

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
  const EPS = "Escuela Politécnica Superior";
  const classrooms = [
    ["EA1", 80, "teoria",       "Este" ],
    ["EA2", 80, "teoria",       "Este" ],
    ["EA3", 80, "teoria",       "Este" ],
    ["SA1", 80, "teoria",       "Sur"  ],
    ["SA2", 80, "teoria",       "Sur"  ],
    ["EL1", 30, "laboratorio",  "Este" ],
    ["EL2", 30, "laboratorio",  "Este" ],
    ["SL1", 30, "laboratorio",  "Sur"  ],
  ];
  for (const [name, capacity, type, zone] of classrooms) {
    await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)",
      [name, capacity, type, EPS, zone]);
  }
  console.log("✓ Aulas");

  // ── Profesores ────────────────────────────────────
  const teachers = [
    ["Ana Belén García Ruiz",         "Matemáticas Aplicadas",    "a.garcia@uah.es"],
    ["José Antonio Fernández Molina", "Matemáticas Aplicadas",    "ja.fernandez@uah.es"],
    ["Carmen López Herrero",          "Física Aplicada",          "c.lopez@uah.es"],
    ["Pedro Martínez Sanz",           "Física Aplicada",          "p.martinez@uah.es"],
    ["María José Sánchez Pérez",      "Informática",              "mj.sanchez@uah.es"],
    ["David Torres Álvarez",          "Informática",              "d.torres@uah.es"],
    ["Luis Miguel Herrera Vega",      "Electrónica",              "lm.herrera@uah.es"],
    ["Javier Ortega Prieto",          "Redes y Telemática",       "j.ortega@uah.es"],
  ];
  for (const [name, department, email] of teachers) {
    await run("INSERT INTO teachers (name, department, email) VALUES (?,?,?)",
      [name, department, email]);
  }
  console.log("✓ Profesores");

  // ── Disponibilidad (Lun-Vie, 8:00-20:00) ─────────
  const teacherRows = await all("SELECT id FROM teachers");
  for (const { id } of teacherRows) {
    for (let day = 0; day <= 4; day++) {
      await run(
        "INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,?)",
        [id, day, "08:00", "20:00", 1]
      );
    }
  }
  console.log("✓ Disponibilidades");

  // ── Asignaturas (solo 1er año, Teleco) ───────────
  // code, name, degree, year, semester, students, hours_week
  const subjects = [
    // Cuatrimestre 1
    ["TEL-1-CAL1",   "Cálculo I",              "Teleco", 1, 1, 450, 4],
    ["TEL-1-SINF",   "Sistemas Informáticos",  "Teleco", 1, 1, 450, 4],
    ["TEL-1-TDC",    "Teoría de Circuitos",    "Teleco", 1, 1, 450, 4],
    ["TEL-1-ALG",    "Álgebra Lineal",         "Teleco", 1, 1, 450, 4],
    ["TEL-1-TRANS1", "Transversal I",          "Teleco", 1, 1, 450, 4],
    // Cuatrimestre 2
    ["TEL-1-CAL2",   "Cálculo II",             "Teleco", 1, 2, 450, 4],
    ["TEL-1-PRG",    "Programación",           "Teleco", 1, 2, 450, 4],
    ["TEL-1-ADC",    "Análisis de Circuitos",  "Teleco", 1, 2, 450, 4],
    ["TEL-1-FF1",    "Fundamentos Físicos I",  "Teleco", 1, 2, 450, 4],
    ["TEL-1-ECO",    "Economía de la Empresa", "Teleco", 1, 2, 450, 4],
  ];
  for (const [code, name, degree, year, semester, students, hours_week] of subjects) {
    await run(
      "INSERT INTO subjects (code, name, degree, year, semester, students, hours_week) VALUES (?,?,?,?,?,?,?)",
      [code, name, degree, year, semester, students, hours_week]
    );
  }
  console.log("✓ Asignaturas");

  // ── Asignaciones profesor → asignatura ───────────
  // 1=Ana García (Mat)  2=J.A.Fernández (Mat)  3=Carmen López (Fís)
  // 4=Pedro Martínez (Fís)  5=Mª José Sánchez (Inf)  6=David Torres (Inf)
  // 7=Luis Herrera (Elec)   8=Javier Ortega (Redes)
  const assignments = {
    "TEL-1-CAL1":   1,
    "TEL-1-ALG":    1,
    "TEL-1-CAL2":   2,
    "TEL-1-TDC":    7,
    "TEL-1-ADC":    7,
    "TEL-1-FF1":    3,
    "TEL-1-SINF":   5,
    "TEL-1-PRG":    6,
    "TEL-1-ECO":    8,
    "TEL-1-TRANS1": 8,
  };

  const subjectRows = await all("SELECT id, code FROM subjects ORDER BY id");
  const teacherList = await all("SELECT id FROM teachers ORDER BY id");

  for (const { id: sid, code } of subjectRows) {
    const idx = assignments[code];
    const tid = teacherList[(idx ?? 1) - 1].id;
    await run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)", [sid, tid]);
  }
  console.log("✓ Asignaciones profesor-asignatura");

  console.log("\n✅ Seed simple completado. Ejecuta: npm start");
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
