/**
 * seed.js — Poblar la base de datos con datos realistas de la UAH.
 * Uso: node seed.js
 */
const bcrypt = require("bcrypt");
const db     = require("./database/db");

async function seed() {
  console.log("Iniciando seed...");

  await run("PRAGMA foreign_keys = OFF");

  // ── Crear tablas si no existen ────────────────────
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS classrooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, capacity INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'teoria', building TEXT
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
  const classrooms = [
    ["Aula B-001", 80,  "teoria",       "Escuela Politécnica Superior"],
    ["Aula B-002", 80,  "teoria",       "Escuela Politécnica Superior"],
    ["Aula B-003", 60,  "teoria",       "Escuela Politécnica Superior"],
    ["Aula B-004", 60,  "teoria",       "Escuela Politécnica Superior"],
    ["Aula B-005", 120, "teoria",       "Escuela Politécnica Superior"],
    ["Aula B-006", 120, "teoria",       "Escuela Politécnica Superior"],
    ["Lab Inf-1",  30,  "laboratorio",  "Escuela Politécnica Superior"],
    ["Lab Inf-2",  30,  "laboratorio",  "Escuela Politécnica Superior"],
    ["Lab Inf-3",  30,  "laboratorio",  "Escuela Politécnica Superior"],
    ["Lab Elec-1", 24,  "laboratorio",  "Escuela Politécnica Superior"],
    ["Lab Elec-2", 24,  "laboratorio",  "Escuela Politécnica Superior"],
    ["Seminario 1",20,  "seminario",    "Escuela Politécnica Superior"],
  ];
  for (const [name, capacity, type, building] of classrooms) {
    await run("INSERT INTO classrooms (name, capacity, type, building) VALUES (?,?,?,?)",
      [name, capacity, type, building]);
  }
  console.log("✓ Aulas");

  // ── Profesores ────────────────────────────────────
  const teachers = [
    ["Carlos López Barrio",      "Señales y Comunicaciones",  "c.lopez@uah.es"],
    ["María García Fernández",   "Informática",               "m.garcia@uah.es"],
    ["Antonio Martínez Rojas",   "Matemáticas",               "a.martinez@uah.es"],
    ["Laura Sánchez Pérez",      "Electrónica",               "l.sanchez@uah.es"],
    ["Javier Ruiz Morales",      "Redes y Sistemas",          "j.ruiz@uah.es"],
    ["Ana Jiménez Torres",       "Informática",               "a.jimenez@uah.es"],
    ["Miguel Hernández Vega",    "Matemáticas",               "m.hernandez@uah.es"],
    ["Carmen Díaz Castillo",     "Física",                    "c.diaz@uah.es"],
    ["Roberto Alonso Núñez",     "Señales y Comunicaciones",  "r.alonso@uah.es"],
    ["Isabel Moreno Guerrero",   "Redes y Sistemas",          "i.moreno@uah.es"],
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

  // ── Asignaturas ───────────────────────────────────
   const subjects = [
    // code,           name,                              degree,   yr, sem, students, h/w
    // 1 cuatri teleco
    ["TEL-1-CAL1",  "Cálculo I",                        "Teleco",  1,  1,   450, 4],
    ["TEL-1-SINF",  "Sistemas Informáticos",            "Teleco",  1,  1,   450, 4],
    ["TEL-1-TDC",   "Teoría de Circuitos",              "Teleco",  1,  1,   450, 4],
    ["TEL-1-ALG",   "Álgebra Lineal",                   "Teleco",  1,  1,   450, 4],
    ["TEL-1-TRANS1","Transversal I",                      "Teleco",  1,  1,   450, 4],
    // 2 cuatri teleco
    ["TEL-1-CAL2",  "Cálculo II",                       "Teleco",  1,  2,   450, 4],
    ["TEL-1-PRG",   "Programación",                     "Teleco",  1,  2,   450, 4],
    ["TEL-1-ADC",   "Análisis de Circuitos",            "Teleco",  1,  2,   450, 4],
    ["TEL-1-FF1",   "Fundamentos Físicos I",            "Teleco",  1,  2,   450, 4],
    ["TEL-1-ECO",   "Economia de la Empresa",           "Teleco",  1,  2,   450, 4],
    // 3 cuatri teleco
    ["TEL-2-EBAS",  "Electrónica Básica",               "Teleco",  2,  1,   300, 4],
    ["TEL-2-EST",   "Estadistica",                      "Teleco",  2,  1,   300, 4],
    ["TEL-2-SYS",   "Señales y Sistemas",               "Teleco",  2,  1,   300, 4],
    ["TEL-2-FF2",   "Fundamentos Físicos II",           "Teleco",  2,  1,   300, 4],
    ["TEL-2-REDES1","Arquitectura de Redes I",          "Teleco",  2,  1,   300, 4],
    // 4 cuatri teleco
    ["TEL-2-ED",    "Electrónica Digital",              "Teleco",  2,  2,   300, 4],
    ["TEL-2-EC",    "Electronica de Circuitos",         "Teleco",  2,  2,   300, 4],
    ["TEL-2-PPO",   "Propagacion de Ondas",             "Teleco",  2,  2,   300, 4],
    ["TEL-2-TC",    "Teoria de la Comunicación",        "Teleco",  2,  2,   300, 4],
    ["TEL-2-REDES2","Arquitectura de Redes II",         "Teleco",  2,  2,   300, 4],
    // 5 cuatri GIT
    ["GIT-3-PA",    "Programacion Avanzada",            "GIT",     3,  1,    30, 4],
    ["GIT-3-SERTEL","Servicios Telematicos",            "GIT",     3,  1,    30, 4],
    ["GIT-3-SED",   "Sistemas Electronicos Digitales",  "GIT",     3,  1,    30, 5],
    ["GIT-3-AC",    "Arquitectura de Computadores",     "GIT",     3,  1,    30, 4],
    ["GIT-3-REDES3","Redes de Comunicaciones",          "GIT",     3,  1,    30, 4],
    // 6 cuatri GIT
    ["GIT-3-SEG",    "Seguridad",                                   "GIT",     3,  2,    30, 4],
    ["GIT-3-REDES4", "Conmutacion",                                 "GIT",     3,  2,    30, 4],
    ["GIT-3-SSOO",   "Sistemas Operativos",                         "GIT",     3,  2,    30, 4],
    ["GIT-3-LRSS",   "Laboratorio de Redes, Sistemas y Servicios",  "GIT",     3,  2,    30, 4],
    ["GIT-3-TRANS2", "Transversal II",                              "GIT",     3,  2,    30, 4],
    // 5 cuatri GITT
    ["GIT-3-DIS",   "Diseño Electrónico",               "GITT",    3,  1,    30, 4],
    ["GIT-3-TDS",   "Tratamiento Digital de Señales",   "GITT",    3,  1,    30, 4],
    ["GIT-3-SED",   "Sistemas Electronicos Digitales",  "GITT",    3,  1,    30, 5],
    ["GIT-3-AC",    "Arquitectura de Computadores",     "GITT",    3,  1,    30, 4],
    ["GIT-3-REDES3","Redes de Comunicaciones",          "GITT",    3,  1,    30, 4],
    // 6 cuatri GITT
    ["GIT-3-CD",    "Comunicaciones Digitales",                    "GITT",    3,  2,    30, 4],
    ["GIT-3-MNTO",  "Metodos Numeros y Tecnicas de Optimizacion",  "GITT",    3,  2,    30, 4],
    ["GIT-3-SUBSIS","Subsistemas Electronicos",                    "GITT",    3,  2,    30, 4],
    ["GIT-3-TAF",   "Tecnologias de Alta Frecuencia",              "GITT",    3,  2,    30, 4],
    ["GIT-3-SSOO",   "Sistemas Operativos",                         "GIT",     3,  2,    30, 4],

    ["GIEC-3-TDS",  "Tratamiento Digital de Señales",  "GIEC",    3,  1,    50, 6],
    ["GIEC-3-ELC",  "Electrónica de Comunicaciones",   "GIEC",    3,  1,    50, 4],
    ["GIEC-3-COM",  "Comunicaciones Digitales",        "GIEC",    3,  2,    50, 6],
    ["GIST-3-PLAN", "Planificación de Redes",          "GIST",    3,  1,    45, 4],
    ["GIST-3-SEG",  "Seguridad en Redes",              "GIST",    3,  2,    45, 4],
    ["GITT-3-RF",   "Radiofrecuencia y Microondas",    "GITT",    3,  1,    40, 4],
  ];
  for (const [code, name, degree, year, semester, students, hours_week] of subjects) {
    await run(
      "INSERT INTO subjects (code, name, degree, year, semester, students, hours_week) VALUES (?,?,?,?,?,?,?)",
      [code, name, degree, year, semester, students, hours_week]
    );
  }
  console.log("✓ Asignaturas");

  // ── Asignar profesores a asignaturas ──────────────
  // teacher IDs are 1-based as inserted
  const assignments = [
    [1, 1], [2, 1], [3, 1], // MAT1 → Antonio
    [4, 1], [5, 1],          // FIS1 → Carmen
    [6, 1], [7, 1],          // PRG  → María
    [8, 2],                  // ALG  → Antonio
    [9, 2], [10, 2],         // EXP  → María
    [11, 3],                 // MAT2 → Miguel
    [12, 3],                 // FIS2 → Carmen
    [13, 3],                 // POO  → María
    [14, 4],                 // ELEX → Laura
    [15, 5],                 // REDES → Javier
    [16, 1],                 // SO   → Ana
    [17, 2],                 // BD   → Ana
    [18, 2],                 // IS   → María
    [19, 5],                 // REDES2 → Javier
    [20, 9],                 // TDS  → Carlos
  ];
  const subjectRows = await all("SELECT id FROM subjects ORDER BY id");
  const teacherList = await all("SELECT id FROM teachers ORDER BY id");

  // Simplified: assign teacher by subject index mod num_teachers
  for (let i = 0; i < subjectRows.length; i++) {
    const sid = subjectRows[i].id;
    const tid = teacherList[i % teacherList.length].id;
    await run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)", [sid, tid]);
  }
  console.log("✓ Asignaciones profesor-asignatura");

  console.log("\n✅ Seed completado. Ejecuta: npm start");
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
