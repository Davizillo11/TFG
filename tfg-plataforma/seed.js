/**
 * seed.js — Poblar la base de datos con datos de la UAH (EPS).
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

  // Planta 1 — Teoría (EA/SA/OA/NA 1-8, aforo 80 excepto x6 y x7 que tienen 40)
  const wings = [
    { prefix: "EA", zone: "Este" },
    { prefix: "SA", zone: "Sur"  },
    { prefix: "OA", zone: "Oeste"},
    { prefix: "NA", zone: "Norte"},
  ];
  for (const { prefix, zone } of wings) {
    for (let i = 1; i <= 8; i++) {
      const capacity = (i === 6 || i === 7) ? 40 : 80;
      await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)",
        [`${prefix}${i}`, capacity, "teoria", EPS, zone]);
    }
  }

  // Planta 2 — Laboratorios Este/Sur/Oeste (EL/SL/OL 1-12, aforo 30)
  const labWings = [
    { prefix: "EL", zone: "Este"  },
    { prefix: "SL", zone: "Sur"   },
    { prefix: "OL", zone: "Oeste" },
  ];
  for (const { prefix, zone } of labWings) {
    for (let i = 1; i <= 12; i++) {
      await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)",
        [`${prefix}${i}`, 30, "laboratorio", EPS, zone]);
    }
  }

  // Planta 2 Norte — Seminarios grandes PL1 y PL2
  await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)", ["PL1", 60, "seminario", EPS, "Norte"]);
  await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)", ["PL2", 60, "seminario", EPS, "Norte"]);

  console.log("✓ Aulas");

  // ── Profesores ────────────────────────────────────
  // 20 profesores distribuidos por departamento
  const teachers = [
    // Matemáticas Aplicadas
    ["Ana Belén García Ruiz",        "Matemáticas Aplicadas",    "a.garcia@uah.es"],
    ["José Antonio Fernández Molina","Matemáticas Aplicadas",    "ja.fernandez@uah.es"],
    // Física Aplicada
    ["Carmen López Herrero",         "Física Aplicada",          "c.lopez@uah.es"],
    ["Pedro Martínez Sanz",          "Física Aplicada",          "p.martinez@uah.es"],
    // Informática
    ["María José Sánchez Pérez",     "Informática",              "mj.sanchez@uah.es"],
    ["David Torres Álvarez",         "Informática",              "d.torres@uah.es"],
    ["Elena Ramírez Castro",         "Informática",              "e.ramirez@uah.es"],
    ["Roberto Gómez Navarro",        "Informática",              "r.gomez@uah.es"],
    // Electrónica
    ["Luis Miguel Herrera Vega",     "Electrónica",              "lm.herrera@uah.es"],
    ["Patricia Moreno Delgado",      "Electrónica",              "p.moreno@uah.es"],
    ["Alejandro Ruiz Blanco",        "Electrónica",              "a.ruiz@uah.es"],
    ["Isabel Díaz Fuentes",          "Electrónica",              "i.diaz@uah.es"],
    ["Fernando Jiménez Cano",        "Electrónica",              "f.jimenez@uah.es"],
    // Señales y Comunicaciones
    ["Carlos Alberto Núñez Reyes",   "Señales y Comunicaciones", "ca.nunez@uah.es"],
    ["Cristina Vargas Iglesias",     "Señales y Comunicaciones", "c.vargas@uah.es"],
    ["Miguel Ángel Lozano Pardo",    "Señales y Comunicaciones", "ma.lozano@uah.es"],
    ["Laura Castillo Mendoza",       "Señales y Comunicaciones", "l.castillo@uah.es"],
    // Redes y Telemática
    ["Javier Ortega Prieto",         "Redes y Telemática",       "j.ortega@uah.es"],
    ["Sandra Morales Guerrero",      "Redes y Telemática",       "s.morales@uah.es"],
    ["Andrés Serrano Campos",        "Redes y Telemática",       "a.serrano@uah.es"],
    // ── Incorporaciones (redistribución de carga) ──
    ["Rafael Benítez Vega",          "Señales y Comunicaciones", "r.benitez@uah.es"],
    ["Marta Iglesias Ramos",         "Redes y Telemática",       "m.iglesias@uah.es"],
    ["Diego Navarro Fuentes",        "Electrónica",              "d.navarro@uah.es"],
    ["Silvia Pardo Montoya",         "Informática",              "s.pardo@uah.es"],
    ["Gonzalo Esteban Rubio",        "Señales y Comunicaciones", "g.esteban@uah.es"],
    ["Verónica Castro Lima",         "Señales y Comunicaciones", "v.castro@uah.es"],
    ["Álvaro Medina Torres",         "Redes y Telemática",       "al.medina@uah.es"],
    ["Beatriz Fuentes Molina",       "Electrónica",              "b.fuentes@uah.es"],
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
  // Nota: se eliminaron códigos duplicados (GITT-4-VA, GIEC-4-VA aparecían dos veces)
  const subjects = [
    // code,             name,                                                      degree,  yr, sem, students, h/w
    // ── 1er cuatrimestre Teleco ──
    ["TEL-1-CAL1",    "Cálculo I",                                               "Teleco",  1,  1,   80, 4],
    ["TEL-1-SINF",    "Sistemas Informáticos",                                   "Teleco",  1,  1,   80, 4],
    ["TEL-1-TDC",     "Teoría de Circuitos",                                     "Teleco",  1,  1,   80, 4],
    ["TEL-1-ALG",     "Álgebra Lineal",                                          "Teleco",  1,  1,   80, 4],
    ["TEL-1-TRANS1",  "Transversal I",                                           "Teleco",  1,  1,   80, 4],
    // ── 2do cuatrimestre Teleco ──
    ["TEL-1-CAL2",    "Cálculo II",                                              "Teleco",  1,  2,   80, 4],
    ["TEL-1-PRG",     "Programación",                                            "Teleco",  1,  2,   80, 4],
    ["TEL-1-ADC",     "Análisis de Circuitos",                                   "Teleco",  1,  2,   80, 4],
    ["TEL-1-FF1",     "Fundamentos Físicos I",                                   "Teleco",  1,  2,   80, 4],
    ["TEL-1-ECO",     "Economía de la Empresa",                                  "Teleco",  1,  2,   80, 4],
    // ── 3er cuatrimestre Teleco ──
    ["TEL-2-EBAS",    "Electrónica Básica",                                      "Teleco",  2,  1,   80, 4],
    ["TEL-2-EST",     "Estadística",                                             "Teleco",  2,  1,   80, 4],
    ["TEL-2-SYS",     "Señales y Sistemas",                                      "Teleco",  2,  1,   80, 4],
    ["TEL-2-FF2",     "Fundamentos Físicos II",                                  "Teleco",  2,  1,   80, 4],
    ["TEL-2-REDES1",  "Arquitectura de Redes I",                                 "Teleco",  2,  1,   80, 4],
    // ── 4to cuatrimestre Teleco ──
    ["TEL-2-ED",      "Electrónica Digital",                                     "Teleco",  2,  2,   80, 4],
    ["TEL-2-EC",      "Electrónica de Circuitos",                                "Teleco",  2,  2,   80, 4],
    ["TEL-2-PPO",     "Propagación de Ondas",                                    "Teleco",  2,  2,   80, 4],
    ["TEL-2-TC",      "Teoría de la Comunicación",                               "Teleco",  2,  2,   80, 4],
    ["TEL-2-REDES2",  "Arquitectura de Redes II",                                "Teleco",  2,  2,   80, 4],
    // ── 5to cuatrimestre GIT ──
    ["GIT-3-PA",      "Programación Avanzada",                                   "GIT",     3,  1,   30, 4],
    ["GIT-3-SERTEL",  "Servicios Telemáticos",                                   "GIT",     3,  1,   30, 4],
    ["GIT-3-SED",     "Sistemas Electrónicos Digitales",                         "GIT",     3,  1,   30, 5],
    ["GIT-3-AC",      "Arquitectura de Computadores",                            "GIT",     3,  1,   30, 4],
    ["GIT-3-REDES3",  "Redes de Comunicaciones",                                 "GIT",     3,  1,   30, 4],
    // ── 6to cuatrimestre GIT ──
    ["GIT-3-SEG",     "Seguridad",                                               "GIT",     3,  2,   30, 4],
    ["GIT-3-REDES4",  "Conmutación",                                             "GIT",     3,  2,   30, 4],
    ["GIT-3-SSOO",    "Sistemas Operativos",                                     "GIT",     3,  2,   30, 4],
    ["GIT-3-LRSS",    "Laboratorio de Redes, Sistemas y Servicios",              "GIT",     3,  2,   30, 4],
    ["GIT-3-TRANS2",  "Transversal II",                                          "GIT",     3,  2,   30, 4],
    // ── 5to cuatrimestre GITT ──
    ["GITT-3-DIS",    "Diseño Electrónico",                                      "GITT",    3,  1,   30, 4],
    ["GITT-3-TDS",    "Tratamiento Digital de Señales",                          "GITT",    3,  1,   30, 4],
    ["GITT-3-SED",    "Sistemas Electrónicos Digitales",                         "GITT",    3,  1,   30, 5],
    ["GITT-3-AC",     "Arquitectura de Computadores",                            "GITT",    3,  1,   30, 4],
    ["GITT-3-REDES3", "Redes de Comunicaciones",                                 "GITT",    3,  1,   30, 4],
    // ── 6to cuatrimestre GITT ──
    ["GITT-3-CD",     "Comunicaciones Digitales",                                "GITT",    3,  2,   30, 4],
    ["GITT-3-MNTO",   "Métodos Numéricos y Técnicas de Optimización",            "GITT",    3,  2,   30, 4],
    ["GITT-3-SUBSIS", "Subsistemas Electrónicos",                                "GITT",    3,  2,   30, 4],
    ["GITT-3-TAF",    "Tecnologías de Alta Frecuencia",                          "GITT",    3,  2,   30, 4],
    ["GITT-3-SSOO",   "Sistemas Operativos",                                     "GITT",    3,  2,   30, 4],
    // ── 5to cuatrimestre GIEC ──
    ["GIEC-3-DIS",    "Diseño Electrónico",                                      "GIEC",    3,  1,   30, 4],
    ["GIEC-3-POT",    "Electrónica de Potencia",                                 "GIEC",    3,  1,   30, 4],
    ["GIEC-3-SED",    "Sistemas Electrónicos Digitales",                         "GIEC",    3,  1,   30, 5],
    ["GIEC-3-SUBSIS", "Subsistemas Electrónicos",                                "GIEC",    3,  1,   30, 4],
    ["GIEC-3-REDES3", "Redes de Comunicaciones",                                 "GIEC",    3,  1,   30, 4],
    // ── 6to cuatrimestre GIEC ──
    ["GIEC-3-INS",    "Instrumentación Electrónica",                             "GIEC",    3,  2,   30, 4],
    ["GIEC-3-CE",     "Control Electrónico",                                     "GIEC",    3,  2,   30, 4],
    ["GIEC-3-TECE",   "Tecnología Electrónica",                                  "GIEC",    3,  2,   30, 4],
    ["GIEC-3-SEC",    "Sistemas Electrónicos para Comunicaciones",               "GIEC",    3,  2,   30, 4],
    ["GIEC-3-TRANS2", "Transversal II",                                          "GIEC",    3,  2,   30, 4],
    // ── 5to cuatrimestre GIST ──
    ["GIST-3-CD",     "Comunicaciones Digitales",                                "GIST",    3,  1,   30, 4],
    ["GIST-3-TDS",    "Tratamiento Digital de Señales",                          "GIST",    3,  1,   30, 4],
    ["GIST-3-SED",    "Sistemas Electrónicos Digitales",                         "GIST",    3,  1,   30, 5],
    ["GIST-3-TAF",    "Tecnologías de Alta Frecuencia",                          "GIST",    3,  1,   30, 4],
    ["GIST-3-REDES3", "Redes de Comunicaciones",                                 "GIST",    3,  1,   30, 4],
    // ── 6to cuatrimestre GIST ──
    ["GIST-3-CO",     "Comunicaciones Ópticas",                                  "GIST",    3,  2,   30, 4],
    ["GIST-3-CC",     "Circuitos de Comunicación",                               "GIST",    3,  2,   30, 4],
    ["GIST-3-RADIO",  "Radiación y Radiocomunicación",                           "GIST",    3,  2,   30, 4],
    ["GIST-3-STEL",   "Sistemas de Telecomunicaciones",                          "GIST",    3,  2,   30, 4],
    ["GIST-3-TRANS2", "Transversal II",                                          "GIST",    3,  2,   30, 4],
    // ── 7mo cuatrimestre GIT ──
    ["GIT-4-IRyS",    "Ingeniería de Redes y Servicios",                         "GIT",     4,  1,   30, 4],
    ["GIT-4-ASO",     "Ampliación de Sistemas Operativos",                       "GIT",     4,  1,   30, 4],
    ["GIT-4-PV",      "Programación Visual",                                     "GIT",     4,  1,   30, 4],
    ["GIT-4-GAR",     "Gestión y Administración de Redes",                       "GIT",     4,  1,   30, 4],
    ["GIT-4-TRAF",    "Ingeniería de Tráfico",                                   "GIT",     4,  1,   30, 4],
    // ── 8vo cuatrimestre GIT ──
    ["GIT-4-ISW",     "Ingeniería del Software",                                 "GIT",     4,  2,   30, 4],
    ["GIT-4-TST",     "Tecnología de Sistemas de Telecomunicación",              "GIT",     4,  2,   30, 4],
    ["GIT-4-TSE",     "Tecnología en Sistemas Electrónicos",                     "GIT",     4,  2,   30, 4],
    ["GIT-4-CMOV",    "Comunicaciones Móviles",                                  "GIT",     4,  2,   30, 4],
    ["GIT-4-SISNG",   "Sistemas Inteligentes y Sostenibles de Nueva Generación", "GIT",     4,  2,   30, 4],
    ["GIT-4-TFOT",    "Tecnologías Fotónicas",                                   "GIT",     4,  2,   30, 4],
    // ── 7mo cuatrimestre GITT ──
    ["GITT-4-CO",     "Comunicaciones Ópticas",                                  "GITT",    4,  1,   30, 4],
    ["GITT-4-VA",     "Visión Artificial",                                       "GITT",    4,  1,   30, 4],
    ["GITT-4-POT",    "Electrónica de Potencia",                                 "GITT",    4,  1,   30, 4],
    ["GITT-4-PV",     "Programación Visual",                                     "GITT",    4,  1,   30, 4],
    ["GITT-4-SEC",    "Sistemas Electrónicos para Comunicaciones",               "GITT",    4,  1,   30, 4],
    ["GITT-4-INSTR",  "Instrumentación Electrónica",                             "GITT",    4,  1,   30, 4],
    ["GITT-4-RADIO",  "Radiación y Radiocomunicación",                           "GITT",    4,  1,   30, 4],
    ["GITT-4-REDES4", "Conmutación",                                             "GITT",    4,  1,   30, 4],
    ["GITT-4-SEDA",   "Sistemas Electrónicos Digitales Avanzados",               "GITT",    4,  1,   30, 4],
    ["GITT-4-SEG",    "Seguridad",                                               "GITT",    4,  1,   30, 4],
    ["GITT-4-CC",     "Circuitos de Comunicación",                               "GITT",    4,  1,   30, 4],
    ["GITT-4-SERTEL", "Servicios Telemáticos",                                   "GITT",    4,  1,   30, 4],
    // ── 8vo cuatrimestre GITT ──
    ["GITT-4-CE",     "Control Electrónico",                                     "GITT",    4,  2,   30, 4],
    ["GITT-4-TRAF",   "Ingeniería de Tráfico",                                   "GITT",    4,  2,   30, 4],
    ["GITT-4-STEL",   "Sistemas de Telecomunicación",                            "GITT",    4,  2,   30, 4],
    ["GITT-4-CMOV",   "Comunicaciones Móviles",                                  "GITT",    4,  2,   30, 4],
    ["GITT-4-SISNG",  "Sistemas Inteligentes y Sostenibles de Nueva Generación", "GITT",    4,  2,   30, 4],
    ["GITT-4-TFOT",   "Tecnología Electrónica",                                  "GITT",    4,  2,   30, 4],
    ["GITT-4-LRSS",   "Laboratorio de Redes, Sistemas y Servicios",              "GITT",    4,  2,   30, 4],
    // ── 7mo cuatrimestre GIEC ──
    ["GIEC-4-RISE",   "Ruido e Interferencia en Sistemas Electrónicos",          "GIEC",    4,  1,   30, 4],
    ["GIEC-4-VA",     "Visión Artificial",                                       "GIEC",    4,  1,   30, 4],
    ["GIEC-4-EBIO",   "Electrónica Biomédica",                                   "GIEC",    4,  1,   30, 4],
    ["GIEC-4-PV",     "Programación Visual",                                     "GIEC",    4,  1,   30, 4],
    ["GIEC-4-SEDA",   "Sistemas Electrónicos Digitales Avanzados",               "GIEC",    4,  1,   30, 4],
    ["GIEC-4-CIND",   "Control Industrial",                                      "GIEC",    4,  1,   30, 4],
    ["GIEC-4-EEREN",  "Electrónica para Energías Renovables",                    "GIEC",    4,  1,   30, 4],
    // ── 8vo cuatrimestre GIEC ──
    ["GIEC-4-ISW",    "Ingeniería del Software",                                 "GIEC",    4,  2,   30, 4],
    ["GIEC-4-TST",    "Tecnología de Sistemas de Telecomunicación",              "GIEC",    4,  2,   30, 4],
    ["GIEC-4-TRST",   "Tecnología de Redes y Servicios Telemáticos",             "GIEC",    4,  2,   30, 4],
    ["GIEC-4-SISNG",  "Sistemas Inteligentes y Sostenibles de Nueva Generación", "GIEC",    4,  2,   30, 4],
    ["GIEC-4-TFOT",   "Tecnologías Fotónicas",                                   "GIEC",    4,  2,   30, 4],
    ["GIEC-4-CMOV",   "Comunicaciones Móviles",                                  "GIEC",    4,  2,   30, 4],
    // ── 7mo cuatrimestre GIST ──
    ["GIST-4-PVA",    "Procesado de Voz y Audio",                                "GIST",    4,  1,   30, 4],
    ["GIST-4-RADAR",  "Radiodeterminación y Radar",                              "GIST",    4,  1,   30, 4],
    ["GIST-4-PV",     "Programación Visual",                                     "GIST",    4,  1,   30, 4],
    ["GIST-4-PIVC",   "Procesado de Imagen y Visión por Computador",             "GIST",    4,  1,   30, 4],
    ["GIST-4-SAT",    "Comunicaciones por Satélite",                             "GIST",    4,  1,   30, 4],
    ["GIST-4-ASTEL",  "Ampliación de Sistemas de Telecomunicación",              "GIST",    4,  1,   30, 4],
    ["GIST-4-TINAM",  "Tecnologías Inalámbricas",                                "GIST",    4,  1,   30, 4],
    // ── 8vo cuatrimestre GIST ──
    ["GIST-4-CMOV",   "Comunicaciones Móviles",                                  "GIST",    4,  2,   30, 4],
    ["GIST-4-ISW",    "Ingeniería del Software",                                 "GIST",    4,  2,   30, 4],
    ["GIST-4-TRST",   "Tecnología de Redes y Servicios Telemáticos",             "GIST",    4,  2,   30, 4],
    ["GIST-4-TSE",    "Tecnología en Sistemas Electrónicos",                     "GIST",    4,  2,   30, 4],
    ["GIST-4-TFOT",   "Tecnologías Fotónicas",                                   "GIST",    4,  2,   30, 4],
  ];
  for (const [code, name, degree, year, semester, students, hours_week] of subjects) {
    await run(
      "INSERT INTO subjects (code, name, degree, year, semester, students, hours_week) VALUES (?,?,?,?,?,?,?)",
      [code, name, degree, year, semester, students, hours_week]
    );
  }
  console.log("✓ Asignaturas");

  // ── Asignaciones profesor → asignatura ───────────
  // Índices de profesores (1-based, orden de inserción):
  //  1=Ana Belén García (Mat)    2=J.A.Fernández (Mat)
  //  3=Carmen López (Fís)        4=Pedro Martínez (Fís)
  //  5=Mª José Sánchez (Inf)     6=David Torres (Inf)
  //  7=Elena Ramírez (Inf)       8=Roberto Gómez (Inf)
  //  9=Luis M. Herrera (Elec)   10=Patricia Moreno (Elec)
  // 11=Alejandro Ruiz (Elec)    12=Isabel Díaz (Elec)
  // 13=Fernando Jiménez (Elec)  14=Carlos A. Núñez (S&C)
  // 15=Cristina Vargas (S&C)    16=Miguel Á. Lozano (S&C)
  // 17=Laura Castillo (S&C)     18=Javier Ortega (Redes)
  // 19=Sandra Morales (Redes)   20=Andrés Serrano (Redes)
  // Índices profesores:
  //  1=Ana Belén García (Mat)       2=J.A.Fernández (Mat)
  //  3=Carmen López (Fís)           4=Pedro Martínez (Fís)
  //  5=Mª José Sánchez (Inf)        6=David Torres (Inf)
  //  7=Elena Ramírez (Inf)          8=Roberto Gómez (Inf)
  //  9=Luis M. Herrera (Elec)      10=Patricia Moreno (Elec)
  // 11=Alejandro Ruiz (Elec)       12=Isabel Díaz (Elec)
  // 13=Fernando Jiménez (Elec)     14=Carlos A. Núñez (S&C)
  // 15=Cristina Vargas (S&C)       16=Miguel Á. Lozano (S&C)
  // 17=Laura Castillo (S&C)        18=Javier Ortega (Redes)
  // 19=Sandra Morales (Redes)      20=Andrés Serrano (Redes)
  // 21=Rafael Benítez (S&C)        22=Marta Iglesias (Redes)
  // 23=Diego Navarro (Elec)        24=Silvia Pardo (Inf)
  // 25=Gonzalo Esteban (S&C)       26=Verónica Castro (S&C)
  // 27=Álvaro Medina (Redes)       28=Beatriz Fuentes (Elec)
  const assignments = {
    // ── Matemáticas ──────────────────────────────────────────────────
    "TEL-1-CAL1":    1,   // sem1 → Ana Belén García
    "TEL-1-ALG":     1,   // sem1 → Ana Belén García
    "TEL-1-CAL2":    2,   // sem2 → J.A. Fernández
    "TEL-2-EST":     2,   // sem1 → J.A. Fernández
    "GITT-3-MNTO":   2,   // sem2 → J.A. Fernández
    // ── Física y Circuitos ───────────────────────────────────────────
    "TEL-1-TDC":     4,   // sem1 → Pedro Martínez
    "TEL-1-ADC":     4,   // sem2 → Pedro Martínez
    "TEL-1-FF1":     3,   // sem2 → Carmen López
    "TEL-2-FF2":     3,   // sem1 → Carmen López
    "TEL-2-PPO":     3,   // sem2 → Carmen López
    // ── Economía / Transversales ─────────────────────────────────────
    "TEL-1-ECO":     7,   // sem2 → Elena Ramírez
    "TEL-1-TRANS1":  7,   // sem1 → Elena Ramírez
    "GIT-3-TRANS2":  7,   // sem2 → Elena Ramírez
    "GIEC-3-TRANS2": 24,  // sem2 → Silvia Pardo
    "GIST-3-TRANS2": 24,  // sem2 → Silvia Pardo
    // ── Informática ──────────────────────────────────────────────────
    "TEL-1-SINF":    5,   // sem1 → Mª José Sánchez
    "TEL-1-PRG":     6,   // sem2 → David Torres
    "GIT-3-PA":      6,   // sem1 → David Torres
    "GIT-4-PV":      6,   // sem1 → David Torres
    "GITT-4-PV":     6,   // sem1 → David Torres
    "GIEC-4-PV":     24,  // sem1 → Silvia Pardo
    "GIST-4-PV":     24,  // sem1 → Silvia Pardo
    "GIT-3-AC":      8,   // sem1 → Roberto Gómez
    "GITT-3-AC":     8,   // sem1 → Roberto Gómez
    "GIT-3-SSOO":    7,   // sem2 → Elena Ramírez
    "GITT-3-SSOO":   24,  // sem2 → Silvia Pardo
    "GIT-4-ASO":     7,   // sem1 → Elena Ramírez
    "GIT-4-ISW":     8,   // sem2 → Roberto Gómez
    "GIEC-4-ISW":    8,   // sem2 → Roberto Gómez
    "GIST-4-ISW":    8,   // sem2 → Roberto Gómez
    "GITT-4-VA":     5,   // sem1 → Mª José Sánchez
    "GIEC-4-VA":     5,   // sem1 → Mª José Sánchez
    "GIST-4-PIVC":   24,  // sem1 → Silvia Pardo
    // ── Electrónica ──────────────────────────────────────────────────
    "TEL-2-EBAS":    9,   // sem1 → Luis M. Herrera
    "TEL-2-ED":      9,   // sem2 → Luis M. Herrera
    "TEL-2-EC":      10,  // sem2 → Patricia Moreno
    "GITT-3-DIS":    10,  // sem1 → Patricia Moreno
    "GIEC-3-DIS":    10,  // sem1 → Patricia Moreno
    "GIT-3-SED":     11,  // sem1 → Alejandro Ruiz
    "GITT-3-SED":    11,  // sem1 → Alejandro Ruiz
    "GIEC-3-SED":    23,  // sem1 → Diego Navarro
    "GIST-3-SED":    23,  // sem1 → Diego Navarro
    "GITT-4-SEDA":   11,  // sem1 → Alejandro Ruiz
    "GIEC-4-SEDA":   23,  // sem1 → Diego Navarro
    "GITT-3-SUBSIS": 13,  // sem2 → Fernando Jiménez
    "GIEC-3-SUBSIS": 13,  // sem1 → Fernando Jiménez
    "GIEC-3-INS":    12,  // sem2 → Isabel Díaz
    "GITT-4-INSTR":  12,  // sem1 → Isabel Díaz
    "GIEC-3-CE":     12,  // sem2 → Isabel Díaz
    "GITT-4-CE":     12,  // sem2 → Isabel Díaz
    "GIEC-4-CIND":   12,  // sem1 → Isabel Díaz
    "GIEC-3-TECE":   13,  // sem2 → Fernando Jiménez
    "GITT-4-TFOT":   23,  // sem2 → Diego Navarro
    "GIEC-3-SEC":    13,  // sem2 → Fernando Jiménez
    "GITT-4-SEC":    13,  // sem1 → Fernando Jiménez
    "GIEC-3-POT":    9,   // sem1 → Luis M. Herrera
    "GITT-4-POT":    9,   // sem1 → Luis M. Herrera
    "GIEC-4-RISE":   13,  // sem1 → Fernando Jiménez
    "GIEC-4-EBIO":   12,  // sem1 → Isabel Díaz
    "GIEC-4-EEREN":  28,  // sem1 → Beatriz Fuentes
    "GIT-4-TSE":     10,  // sem2 → Patricia Moreno
    "GIST-4-TSE":    10,  // sem2 → Patricia Moreno
    // ── Señales y Comunicaciones ─────────────────────────────────────
    "TEL-2-SYS":     14,  // sem1 → Carlos A. Núñez
    "TEL-2-TC":      15,  // sem2 → Cristina Vargas
    "GITT-3-TDS":    16,  // sem1 → Miguel Á. Lozano
    "GIST-3-TDS":    16,  // sem1 → Miguel Á. Lozano
    "GIST-4-PVA":    16,  // sem1 → Miguel Á. Lozano
    "GITT-3-CD":     15,  // sem2 → Cristina Vargas
    "GIST-3-CD":     15,  // sem1 → Cristina Vargas
    "GIST-3-CO":     17,  // sem2 → Laura Castillo
    "GITT-4-CO":     17,  // sem1 → Laura Castillo
    "GIST-3-RADIO":  14,  // sem2 → Carlos A. Núñez
    "GITT-4-RADIO":  21,  // sem1 → Rafael Benítez
    "GIST-3-STEL":   15,  // sem2 → Cristina Vargas
    "GITT-4-STEL":   25,  // sem2 → Gonzalo Esteban
    "GIST-3-CC":     14,  // sem2 → Carlos A. Núñez
    "GITT-4-CC":     21,  // sem1 → Rafael Benítez
    "GITT-3-TAF":    14,  // sem2 → Carlos A. Núñez
    "GIST-3-TAF":    14,  // sem1 → Carlos A. Núñez
    "GIST-4-RADAR":  14,  // sem1 → Carlos A. Núñez
    "GIST-4-SAT":    17,  // sem1 → Laura Castillo
    "GIST-4-ASTEL":  15,  // sem1 → Cristina Vargas
    "GIST-4-TINAM":  21,  // sem1 → Rafael Benítez
    "GIT-4-CMOV":    16,  // sem2 → Miguel Á. Lozano
    "GITT-4-CMOV":   16,  // sem2 → Miguel Á. Lozano
    "GIEC-4-CMOV":   26,  // sem2 → Verónica Castro
    "GIST-4-CMOV":   21,  // sem2 → Rafael Benítez
    "GIT-4-SISNG":   17,  // sem2 → Laura Castillo
    "GITT-4-SISNG":  25,  // sem2 → Gonzalo Esteban
    "GIEC-4-SISNG":  25,  // sem2 → Gonzalo Esteban
    "GIT-4-TFOT":    17,  // sem2 → Laura Castillo
    "GIEC-4-TFOT":   26,  // sem2 → Verónica Castro
    "GIST-4-TFOT":   26,  // sem2 → Verónica Castro
    "GIEC-4-TST":    22,  // sem2 → Marta Iglesias
    // ── Redes y Telemática ───────────────────────────────────────────
    "TEL-2-REDES1":  18,  // sem1 → Javier Ortega
    "TEL-2-REDES2":  18,  // sem2 → Javier Ortega
    "GIT-3-REDES3":  19,  // sem1 → Sandra Morales
    "GITT-3-REDES3": 19,  // sem1 → Sandra Morales
    "GIEC-3-REDES3": 27,  // sem1 → Álvaro Medina
    "GIST-3-REDES3": 27,  // sem1 → Álvaro Medina
    "GIT-3-REDES4":  18,  // sem2 → Javier Ortega
    "GITT-4-REDES4": 18,  // sem1 → Javier Ortega
    "GIT-3-SEG":     20,  // sem2 → Andrés Serrano
    "GITT-4-SEG":    20,  // sem1 → Andrés Serrano
    "GIT-3-SERTEL":  20,  // sem1 → Andrés Serrano
    "GITT-4-SERTEL": 22,  // sem1 → Marta Iglesias
    "GIT-3-LRSS":    19,  // sem2 → Sandra Morales
    "GITT-4-LRSS":   19,  // sem2 → Sandra Morales
    "GIT-4-IRyS":    18,  // sem1 → Javier Ortega
    "GIT-4-GAR":     20,  // sem1 → Andrés Serrano
    "GIT-4-TRAF":    22,  // sem1 → Marta Iglesias
    "GITT-4-TRAF":   27,  // sem2 → Álvaro Medina
    "GIT-4-TST":     18,  // sem2 → Javier Ortega
    "GIEC-4-TRST":   20,  // sem2 → Andrés Serrano
    "GIST-4-TRST":   20,  // sem2 → Andrés Serrano
  };

  const subjectRows = await all("SELECT id, code FROM subjects ORDER BY id");
  const teacherList = await all("SELECT id FROM teachers ORDER BY id");

  for (const { id: sid, code } of subjectRows) {
    const teacherIdx = assignments[code];
    if (teacherIdx) {
      const tid = teacherList[teacherIdx - 1].id;
      await run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)", [sid, tid]);
    } else {
      // Fallback: asignar primer profesor disponible del área
      await run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)", [sid, teacherList[0].id]);
      console.warn(`  ⚠ Sin asignación para ${code}, asignado por defecto`);
    }
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
