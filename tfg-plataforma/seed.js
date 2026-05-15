/**
 * seed.js — Poblar la base de datos con datos de la UAH (EPS).
 * Uso: node seed.js
 */
const bcrypt = require("bcrypt");
const db     = require("./database/db");

async function seed() {
  console.log("Iniciando seed...");

  await run("PRAGMA foreign_keys = OFF");

  // ── Crear tablas ──────────────────────────────────
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
  await run("DROP TABLE IF EXISTS subjects");
  await run(`CREATE TABLE subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, code TEXT UNIQUE, degree TEXT,
    year INTEGER, semester INTEGER, students INTEGER,
    hours_week INTEGER DEFAULT 4,
    bilingual INTEGER DEFAULT 0,
    room_type TEXT,
    session_type TEXT DEFAULT 'teoria',
    theory_hours INTEGER DEFAULT 2,
    lab_hours INTEGER DEFAULT 2
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
    day_of_week INTEGER NOT NULL, slot_start TEXT NOT NULL, slot_end TEXT NOT NULL,
    subgroup INTEGER DEFAULT NULL
  )`);

  // ── Limpiar datos ─────────────────────────────────
  await run("DELETE FROM schedule_sessions");
  await run("DELETE FROM schedules");
  await run("DELETE FROM teacher_availability");
  await run("DELETE FROM subject_teachers");
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

  const wings = [
    { prefix: "EA", zone: "Este"  },
    { prefix: "SA", zone: "Sur"   },
    { prefix: "OA", zone: "Oeste" },
    { prefix: "NA", zone: "Norte" },
  ];
  for (const { prefix, zone } of wings) {
    for (let i = 1; i <= 8; i++) {
      const capacity = (i === 6 || i === 7) ? 40 : 80;
      await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)",
        [`${prefix}${i}`, capacity, "teoria", EPS, zone]);
    }
  }
  const labWings = [
    { prefix: "EL", zone: "Este"  },
    { prefix: "SL", zone: "Sur"   },
    { prefix: "OL", zone: "Oeste" },
  ];
  for (const { prefix, zone } of labWings) {
    const cap = zone === "Este" ? 40 : 30;
    for (let i = 1; i <= 12; i++) {
      await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)",
        [`${prefix}${i}`, cap, "laboratorio", EPS, zone]);
    }
  }
  await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)", ["PL1", 60, "seminario", EPS, "Norte"]);
  await run("INSERT INTO classrooms (name, capacity, type, building, zone) VALUES (?,?,?,?,?)", ["PL2", 60, "seminario", EPS, "Norte"]);
  console.log("✓ Aulas");

  // ── Profesores ────────────────────────────────────
  // Índices 1-based para la tabla de asignaciones:
  //  1=Ana Belén García (Mat)        2=J.A.Fernández (Mat)    29=Carlos Buendía (Mat)
  //  3=Carmen López (Fís)            4=Pedro Martínez (Fís)
  //  5=Mª José Sánchez (Inf)         6=David Torres (Inf)
  //  7=Elena Ramírez (Inf)           8=Roberto Gómez (Inf)
  //  9=Luis M. Herrera (Elec)       10=Patricia Moreno (Elec)
  // 11=Alejandro Ruiz (Elec)        12=Isabel Díaz (Elec)
  // 13=Fernando Jiménez (Elec)      14=Carlos A. Núñez (S&C)
  // 15=Cristina Vargas (S&C)        16=Miguel Á. Lozano (S&C)
  // 17=Laura Castillo (S&C)         18=Javier Ortega (Redes)
  // 19=Sandra Morales (Redes)       20=Andrés Serrano (Redes)
  // 21=Rafael Benítez (S&C)         22=Marta Iglesias (Redes)
  // 23=Diego Navarro (Elec)         24=Silvia Pardo (Inf)
  // 25=Gonzalo Esteban (S&C)        26=Verónica Castro (S&C)
  // 27=Álvaro Medina (Redes)        28=Beatriz Fuentes (Elec)
  const teacherDefs = [
    ["Ana Belén García Ruiz",         "Matemáticas Aplicadas",    "a.garcia@uah.es"],
    ["José Antonio Fernández Molina", "Matemáticas Aplicadas",    "ja.fernandez@uah.es"],
    ["Carmen López Herrero",          "Física Aplicada",          "c.lopez@uah.es"],
    ["Pedro Martínez Sanz",           "Física Aplicada",          "p.martinez@uah.es"],
    ["María José Sánchez Pérez",      "Informática",              "mj.sanchez@uah.es"],
    ["David Torres Álvarez",          "Informática",              "d.torres@uah.es"],
    ["Elena Ramírez Castro",          "Informática",              "e.ramirez@uah.es"],
    ["Roberto Gómez Navarro",         "Informática",              "r.gomez@uah.es"],
    ["Luis Miguel Herrera Vega",      "Electrónica",              "lm.herrera@uah.es"],
    ["Patricia Moreno Delgado",       "Electrónica",              "p.moreno@uah.es"],
    ["Alejandro Ruiz Blanco",         "Electrónica",              "a.ruiz@uah.es"],
    ["Isabel Díaz Fuentes",           "Electrónica",              "i.diaz@uah.es"],
    ["Fernando Jiménez Cano",         "Electrónica",              "f.jimenez@uah.es"],
    ["Carlos Alberto Núñez Reyes",    "Señales y Comunicaciones", "ca.nunez@uah.es"],
    ["Cristina Vargas Iglesias",      "Señales y Comunicaciones", "c.vargas@uah.es"],
    ["Miguel Ángel Lozano Pardo",     "Señales y Comunicaciones", "ma.lozano@uah.es"],
    ["Laura Castillo Mendoza",        "Señales y Comunicaciones", "l.castillo@uah.es"],
    ["Javier Ortega Prieto",          "Redes y Telemática",       "j.ortega@uah.es"],
    ["Sandra Morales Guerrero",       "Redes y Telemática",       "s.morales@uah.es"],
    ["Andrés Serrano Campos",         "Redes y Telemática",       "a.serrano@uah.es"],
    ["Rafael Benítez Vega",           "Señales y Comunicaciones", "r.benitez@uah.es"],
    ["Marta Iglesias Ramos",          "Redes y Telemática",       "m.iglesias@uah.es"],
    ["Diego Navarro Fuentes",         "Electrónica",              "d.navarro@uah.es"],
    ["Silvia Pardo Montoya",          "Informática",              "s.pardo@uah.es"],
    ["Gonzalo Esteban Rubio",         "Señales y Comunicaciones", "g.esteban@uah.es"],
    ["Verónica Castro Lima",          "Señales y Comunicaciones", "v.castro@uah.es"],
    ["Álvaro Medina Torres",          "Redes y Telemática",       "al.medina@uah.es"],
    ["Beatriz Fuentes Molina",        "Electrónica",              "b.fuentes@uah.es"],
    ["Carlos Buendía López",          "Matemáticas Aplicadas",    "c.buendia@uah.es"],
  ];
  const teacherIds = [];
  for (const [name, department, email, session_type = 'ambos'] of teacherDefs) {
    const r = await run("INSERT INTO teachers (name, department, email, session_type) VALUES (?,?,?,?)", [name, department, email, session_type]);
    teacherIds.push(r.lastID);
  }
  console.log("✓ Profesores");

  // ── Disponibilidad ────────────────────────────────
  // Carmen (índice 2, 0-based): lunes/miércoles 09:00-14:00 y viernes 10:00-19:00
  // Todos los demás: lunes-viernes 08:00-20:00 (ventana completa, sin granular)
  for (let i = 0; i < teacherIds.length; i++) {
    const id = teacherIds[i];
    if (i === 2) {
      // Carmen — disponibilidad acotada
      await run("INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,?)", [id, 0, "09:00", "14:00", 1]); // Lun
      await run("INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,?)", [id, 2, "09:00", "14:00", 1]); // Mié
      await run("INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,?)", [id, 4, "10:00", "19:00", 1]); // Vie
    } else {
      for (let day = 0; day <= 4; day++) {
        await run("INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,?)",
          [id, day, "08:00", "20:00", 1]);
      }
    }
  }
  console.log("✓ Disponibilidades");

  // ── Asignaturas ───────────────────────────────────
  // Teleco año 1/2: 5 grupos (A-D regular + E bilingüe)
  // GIT/GITT/GIEC/GIST año 3/4: 1 grupo por especialidad
  const subjects = [
    // code,            name,                              degree,  yr, sem, sts, h/w
    // ── Teleco 1er cuatrimestre ──
    ["TEL-1-CAL1",  "Cálculo I",                         "Teleco", 1, 1, 80, 4],
    ["TEL-1-SINF",  "Sistemas Informáticos",             "Teleco", 1, 1, 80, 4],
    ["TEL-1-TDC",   "Teoría de Circuitos",               "Teleco", 1, 1, 80, 4],
    ["TEL-1-ALG",   "Álgebra Lineal",                    "Teleco", 1, 1, 80, 4],
    ["TEL-1-TRANS1","Transversal I",                     "Teleco", 1, 1, 80, 4],
    // ── Teleco 2do cuatrimestre ──
    ["TEL-1-CAL2",  "Cálculo II",                        "Teleco", 1, 2, 80, 4],
    ["TEL-1-PRG",   "Programación",                      "Teleco", 1, 2, 80, 4],
    ["TEL-1-ADC",   "Análisis de Circuitos",             "Teleco", 1, 2, 80, 4],
    ["TEL-1-FF1",   "Fundamentos Físicos I",             "Teleco", 1, 2, 80, 4],
    ["TEL-1-ECO",   "Economía de la Empresa",            "Teleco", 1, 2, 80, 4],
    // ── Teleco 3er cuatrimestre ──
    ["TEL-2-EBAS",  "Electrónica Básica",                "Teleco", 2, 1, 80, 4],
    ["TEL-2-EST",   "Estadística",                       "Teleco", 2, 1, 80, 4],
    ["TEL-2-SYS",   "Señales y Sistemas",                "Teleco", 2, 1, 80, 4],
    ["TEL-2-FF2",   "Fundamentos Físicos II",            "Teleco", 2, 1, 80, 4],
    ["TEL-2-REDES1","Arquitectura de Redes I",           "Teleco", 2, 1, 80, 4],
    // ── Teleco 4to cuatrimestre ──
    ["TEL-2-ED",    "Electrónica Digital",               "Teleco", 2, 2, 80, 4],
    ["TEL-2-EC",    "Electrónica de Circuitos",          "Teleco", 2, 2, 80, 4],
    ["TEL-2-PPO",   "Propagación de Ondas",              "Teleco", 2, 2, 80, 4],
    ["TEL-2-TC",    "Teoría de la Comunicación",         "Teleco", 2, 2, 80, 4],
    ["TEL-2-REDES2","Arquitectura de Redes II",          "Teleco", 2, 2, 80, 4],
    // ── GIT año 3 sem 1 ──
    ["GIT-3-PA",    "Programación Avanzada",             "GIT",    3, 1, 30, 4],
    ["GIT-3-SERTEL","Servicios Telemáticos",             "GIT",    3, 1, 30, 4],
    ["GIT-3-SED",   "Sistemas Electrónicos Digitales",  "GIT",    3, 1, 30, 5],
    ["GIT-3-AC",    "Arquitectura de Computadores",      "GIT",    3, 1, 30, 4],
    ["GIT-3-REDES3","Redes de Comunicaciones",           "GIT",    3, 1, 30, 4],
    // ── GIT año 3 sem 2 ──
    ["GIT-3-SEG",   "Seguridad",                         "GIT",    3, 2, 30, 4],
    ["GIT-3-REDES4","Conmutación",                       "GIT",    3, 2, 30, 4],
    ["GIT-3-SSOO",  "Sistemas Operativos",               "GIT",    3, 2, 30, 4],
    ["GIT-3-LRSS",  "Laboratorio de Redes, Sistemas y Servicios", "GIT", 3, 2, 30, 4],
    ["GIT-3-TRANS2","Transversal II",                    "GIT",    3, 2, 30, 4],
    // ── GITT año 3 sem 1 ──
    ["GITT-3-DIS",  "Diseño Electrónico",                "GITT",   3, 1, 30, 4],
    ["GITT-3-TDS",  "Tratamiento Digital de Señales",   "GITT",   3, 1, 30, 4],
    ["GITT-3-SED",  "Sistemas Electrónicos Digitales",  "GITT",   3, 1, 30, 5],
    ["GITT-3-AC",   "Arquitectura de Computadores",      "GITT",   3, 1, 30, 4],
    ["GITT-3-REDES3","Redes de Comunicaciones",          "GITT",   3, 1, 30, 4],
    // ── GITT año 3 sem 2 ──
    ["GITT-3-CD",   "Comunicaciones Digitales",          "GITT",   3, 2, 30, 4],
    ["GITT-3-MNTO", "Métodos Numéricos y Técnicas de Optimización", "GITT", 3, 2, 30, 4],
    ["GITT-3-SUBSIS","Subsistemas Electrónicos",         "GITT",   3, 2, 30, 4],
    ["GITT-3-TAF",  "Tecnologías de Alta Frecuencia",   "GITT",   3, 2, 30, 4],
    ["GITT-3-SSOO", "Sistemas Operativos",               "GITT",   3, 2, 30, 4],
    // ── GIEC año 3 sem 1 ──
    ["GIEC-3-DIS",  "Diseño Electrónico",                "GIEC",   3, 1, 30, 4],
    ["GIEC-3-POT",  "Electrónica de Potencia",           "GIEC",   3, 1, 30, 4],
    ["GIEC-3-SED",  "Sistemas Electrónicos Digitales",  "GIEC",   3, 1, 30, 5],
    ["GIEC-3-SUBSIS","Subsistemas Electrónicos",         "GIEC",   3, 1, 30, 4],
    ["GIEC-3-REDES3","Redes de Comunicaciones",          "GIEC",   3, 1, 30, 4],
    // ── GIEC año 3 sem 2 ──
    ["GIEC-3-INS",  "Instrumentación Electrónica",       "GIEC",   3, 2, 30, 4],
    ["GIEC-3-CE",   "Control Electrónico",               "GIEC",   3, 2, 30, 4],
    ["GIEC-3-TECE", "Tecnología Electrónica",            "GIEC",   3, 2, 30, 4],
    ["GIEC-3-SEC",  "Sistemas Electrónicos para Comunicaciones", "GIEC", 3, 2, 30, 4],
    ["GIEC-3-TRANS2","Transversal II",                   "GIEC",   3, 2, 30, 4],
    // ── GIST año 3 sem 1 ──
    ["GIST-3-CD",   "Comunicaciones Digitales",          "GIST",   3, 1, 30, 4],
    ["GIST-3-TDS",  "Tratamiento Digital de Señales",   "GIST",   3, 1, 30, 4],
    ["GIST-3-SED",  "Sistemas Electrónicos Digitales",  "GIST",   3, 1, 30, 5],
    ["GIST-3-TAF",  "Tecnologías de Alta Frecuencia",   "GIST",   3, 1, 30, 4],
    ["GIST-3-REDES3","Redes de Comunicaciones",          "GIST",   3, 1, 30, 4],
    // ── GIST año 3 sem 2 ──
    ["GIST-3-CO",   "Comunicaciones Ópticas",            "GIST",   3, 2, 30, 4],
    ["GIST-3-CC",   "Circuitos de Comunicación",         "GIST",   3, 2, 30, 4],
    ["GIST-3-RADIO","Radiación y Radiocomunicación",     "GIST",   3, 2, 30, 4],
    ["GIST-3-STEL", "Sistemas de Telecomunicaciones",   "GIST",   3, 2, 30, 4],
    ["GIST-3-TRANS2","Transversal II",                   "GIST",   3, 2, 30, 4],
    // ── GIT año 4 sem 1 ──
    ["GIT-4-IRyS",  "Ingeniería de Redes y Servicios",  "GIT",    4, 1, 30, 4],
    ["GIT-4-ASO",   "Ampliación de Sistemas Operativos","GIT",    4, 1, 30, 4],
    ["GIT-4-PV",    "Programación Visual",               "GIT",    4, 1, 30, 4],
    ["GIT-4-GAR",   "Gestión y Administración de Redes","GIT",    4, 1, 30, 4],
    ["GIT-4-TRAF",  "Ingeniería de Tráfico",             "GIT",    4, 1, 30, 4],
    // ── GIT año 4 sem 2 ──
    ["GIT-4-ISW",   "Ingeniería del Software",           "GIT",    4, 2, 30, 4],
    ["GIT-4-TST",   "Tecnología de Sistemas de Telecomunicación", "GIT", 4, 2, 30, 4],
    ["GIT-4-TSE",   "Tecnología en Sistemas Electrónicos", "GIT", 4, 2, 30, 4],
    ["GIT-4-CMOV",  "Comunicaciones Móviles",            "GIT",    4, 2, 30, 4],
    ["GIT-4-SISNG", "Sistemas Inteligentes y Sostenibles de Nueva Generación", "GIT", 4, 2, 30, 4],
    ["GIT-4-TFOT",  "Tecnologías Fotónicas",             "GIT",    4, 2, 30, 4],
    // ── GITT año 4 sem 1 ──
    ["GITT-4-CO",     "Comunicaciones Ópticas",                                  "GITT",   4, 1, 30, 4],
    ["GITT-4-VA",     "Visión Artificial",                                       "GITT",   4, 1, 30, 4],
    ["GITT-4-POT",    "Electrónica de Potencia",                                 "GITT",   4, 1, 30, 4],
    ["GITT-4-PV",     "Programación Visual",                                     "GITT",   4, 1, 30, 4],
    ["GITT-4-SEC",    "Sistemas Electrónicos para Comunicaciones",               "GITT",   4, 1, 30, 4],
    ["GITT-4-INSTR",  "Instrumentación Electrónica",                             "GITT",   4, 1, 30, 4],
    ["GITT-4-RADIO",  "Radiación y Radiocomunicación",                           "GITT",   4, 1, 30, 4],
    ["GITT-4-REDES4", "Conmutación",                                             "GITT",   4, 1, 30, 4],
    ["GITT-4-SEDA",   "Sistemas Electrónicos Digitales Avanzados",               "GITT",   4, 1, 30, 4],
    ["GITT-4-SEG",    "Seguridad",                                               "GITT",   4, 1, 30, 4],
    ["GITT-4-CC",     "Circuitos de Comunicación",                               "GITT",   4, 1, 30, 4],
    ["GITT-4-SERTEL", "Servicios Telemáticos",                                   "GITT",   4, 1, 30, 4],
    // ── GITT año 4 sem 2 ──
    ["GITT-4-CE",   "Control Electrónico",               "GITT",   4, 2, 30, 4],
    ["GITT-4-TRAF", "Ingeniería de Tráfico",             "GITT",   4, 2, 30, 4],
    ["GITT-4-STEL", "Sistemas de Telecomunicación",      "GITT",   4, 2, 30, 4],
    ["GITT-4-CMOV", "Comunicaciones Móviles",            "GITT",   4, 2, 30, 4],
    ["GITT-4-SISNG","Sistemas Inteligentes y Sostenibles de Nueva Generación", "GITT", 4, 2, 30, 4],
    ["GITT-4-TFOT", "Tecnología Electrónica",            "GITT",   4, 2, 30, 4],
    ["GITT-4-LRSS", "Laboratorio de Redes, Sistemas y Servicios", "GITT", 4, 2, 30, 4],
    // ── GIEC año 4 sem 1 ──
    ["GIEC-4-RISE", "Ruido e Interferencia en Sistemas Electrónicos", "GIEC", 4, 1, 30, 4],
    ["GIEC-4-VA",   "Visión Artificial",                 "GIEC",   4, 1, 30, 4],
    ["GIEC-4-EBIO", "Electrónica Biomédica",             "GIEC",   4, 1, 30, 4],
    ["GIEC-4-PV",   "Programación Visual",               "GIEC",   4, 1, 30, 4],
    ["GIEC-4-SEDA", "Sistemas Electrónicos Digitales Avanzados", "GIEC", 4, 1, 30, 4],
    ["GIEC-4-CIND", "Control Industrial",                "GIEC",   4, 1, 30, 4],
    ["GIEC-4-EEREN","Electrónica para Energías Renovables", "GIEC", 4, 1, 30, 4],
    // ── GIEC año 4 sem 2 ──
    ["GIEC-4-ISW",  "Ingeniería del Software",           "GIEC",   4, 2, 30, 4],
    ["GIEC-4-TST",  "Tecnología de Sistemas de Telecomunicación", "GIEC", 4, 2, 30, 4],
    ["GIEC-4-TRST", "Tecnología de Redes y Servicios Telemáticos", "GIEC", 4, 2, 30, 4],
    ["GIEC-4-SISNG","Sistemas Inteligentes y Sostenibles de Nueva Generación", "GIEC", 4, 2, 30, 4],
    ["GIEC-4-TFOT", "Tecnologías Fotónicas",             "GIEC",   4, 2, 30, 4],
    ["GIEC-4-CMOV", "Comunicaciones Móviles",            "GIEC",   4, 2, 30, 4],
    // ── GIST año 4 sem 1 ──
    ["GIST-4-PVA",  "Procesado de Voz y Audio",          "GIST",   4, 1, 30, 4],
    ["GIST-4-RADAR","Radiodeterminación y Radar",        "GIST",   4, 1, 30, 4],
    ["GIST-4-PV",   "Programación Visual",               "GIST",   4, 1, 30, 4],
    ["GIST-4-PIVC", "Procesado de Imagen y Visión por Computador", "GIST", 4, 1, 30, 4],
    ["GIST-4-SAT",  "Comunicaciones por Satélite",       "GIST",   4, 1, 30, 4],
    ["GIST-4-ASTEL","Ampliación de Sistemas de Telecomunicación", "GIST", 4, 1, 30, 4],
    ["GIST-4-TINAM","Tecnologías Inalámbricas",          "GIST",   4, 1, 30, 4],
    // ── GIST año 4 sem 2 ──
    ["GIST-4-CMOV", "Comunicaciones Móviles",            "GIST",   4, 2, 30, 4],
    ["GIST-4-ISW",  "Ingeniería del Software",           "GIST",   4, 2, 30, 4],
    ["GIST-4-TRST", "Tecnología de Redes y Servicios Telemáticos", "GIST", 4, 2, 30, 4],
    ["GIST-4-TSE",  "Tecnología en Sistemas Electrónicos", "GIST", 4, 2, 30, 4],
    ["GIST-4-TFOT", "Tecnologías Fotónicas",             "GIST",   4, 2, 30, 4],
  ];

  // Asignaturas bilingües (grupo E solo tiene estas)
  // Teleco 1 sem1: 2 bilingües → grupo E = 4 sesiones
  // Teleco 1 sem2: 3 bilingües → grupo E = 6 sesiones
  // Teleco 2 sem1: 3 bilingües → grupo E = 6 sesiones
  // Teleco 2 sem2: 3 bilingües → grupo E = 6 sesiones
  const bilingualCodes = new Set([
    "TEL-1-CAL1", "TEL-1-ALG",
    "TEL-1-FF1",  "TEL-1-PRG",  "TEL-1-ADC",
    "TEL-2-EBAS", "TEL-2-FF2",  "TEL-2-REDES1",
    "TEL-2-EC",   "TEL-2-PPO",  "TEL-2-REDES2",
  ]);

  for (const [code, name, degree, year, semester, students, hours_week] of subjects) {
    await run(
      "INSERT INTO subjects (code, name, degree, year, semester, students, hours_week, bilingual, room_type, session_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [code, name, degree, year, semester, students, hours_week, bilingualCodes.has(code) ? 1 : 0, null, 'teoria']
    );
  }

  // room_type para asignaturas Teleco con sesiones de prácticas
  const labRoomTypes = [
    ['laboratorio', ['TEL-1-SINF','TEL-1-TDC','TEL-1-PRG','TEL-1-ADC',
                     'TEL-1-CAL1','TEL-1-ALG','TEL-1-CAL2','TEL-1-FF1',
                     'TEL-2-EBAS','TEL-2-REDES1','TEL-2-ED','TEL-2-EC',
                     'TEL-2-FF2','TEL-2-REDES2','TEL-2-EST','TEL-2-SYS','TEL-2-TC']],
    ['seminario',   ['TEL-2-PPO','GITT-3-TAF','GIST-3-TAF','GIST-3-RADIO','GITT-4-RADIO','GIST-4-TINAM']],
  ];
  for (const [rt, codes] of labRoomTypes) {
    const ph = codes.map(() => '?').join(',');
    await run(`UPDATE subjects SET room_type=? WHERE code IN (${ph})`, [rt, ...codes]);
  }
  // Assign room_type='laboratorio' to non-Teleco subjects without one (GIT, GITT, GIEC, etc.)
  await run(`UPDATE subjects SET room_type='laboratorio' WHERE room_type IS NULL AND name NOT LIKE '%Transversal%'`);
  // Transversal subjects: all theory, no lab
  await run(`UPDATE subjects SET lab_hours=0, theory_hours=hours_week WHERE name LIKE '%Transversal%'`);
  // All other subjects: lab=2h, theory=hours_week-2
  await run(`UPDATE subjects SET lab_hours=2, theory_hours=hours_week-2 WHERE name NOT LIKE '%Transversal%'`);
  console.log("✓ Asignaturas");

  // ── Asignaciones profesor → asignatura ───────────
  // Año 1/2 Teleco: pools de 2 profesores por asignatura (5 grupos comparten el pool)
  //   Pool cubre la demanda aunque un profesor tenga disponibilidad acotada (Carmen).
  // Año 3/4: un profesor por asignatura (1 grupo, sin conflicto de capacidad).
  const assignments = {
    // ── Teleco año 1 ─────────────────────────────────────────────────────
    // Pool Matemáticas: Ana Belén [1] + J.A.Fernández [2] + Carlos Buendía [29]
    "TEL-1-CAL1":    [1, 2, 29],
    "TEL-1-ALG":     [1, 2, 29],
    "TEL-1-CAL2":    [1, 2, 29],
    // Pool Informática básica: Mª José [5] + David Torres [6]
    "TEL-1-SINF":    [5, 6],
    // Pool Circuitos: Pedro [4] + Luis M. Herrera [9]
    "TEL-1-TDC":     [4, 9],
    "TEL-1-ADC":     [4, 9],
    // Pool Transversal/Humanidades: Elena Ramírez [7] + Roberto Gómez [8]
    "TEL-1-TRANS1":  [7, 8],
    "TEL-1-ECO":     [7, 8],
    // Pool Física: Carmen [3] + Pedro [4]
    // Carmen: lun/mié 09-14, vie 10-19 → 8 slots 2h disponibles
    // Pedro: lun-vie 08-20 → 20 slots → pool total 28, suficiente para 10 sesiones
    "TEL-1-FF1":     [3, 4],
    // Pool Programación: David Torres [6] + Elena Ramírez [7]
    "TEL-1-PRG":     [6, 7],

    // ── Teleco año 2 ─────────────────────────────────────────────────────
    // Pool Electrónica: Luis M. Herrera [9] + Patricia Moreno [10]
    "TEL-2-EBAS":    [9, 10],
    "TEL-2-ED":      [9, 11],  // Luis [9] + Alejandro Ruiz [11]
    "TEL-2-EC":      [10, 12], // Patricia [10] + Isabel Díaz [12]
    // Pool Estadística: Ana Belén [1] + J.A.Fernández [2] + Carlos Buendía [29]
    "TEL-2-EST":     [1, 2, 29],
    // Pool Señales: Carlos A. Núñez [14] + Miguel Á. Lozano [16]
    "TEL-2-SYS":     [14, 16],
    "TEL-2-TC":      [15, 17], // Cristina Vargas [15] + Laura Castillo [17]
    // Pool Física II + Propagación: Carmen [3] + Pedro [4]
    "TEL-2-FF2":     [3, 4],
    "TEL-2-PPO":     [3, 4],
    // Pool Redes: Javier Ortega [18] + Sandra Morales [19]
    "TEL-2-REDES1":  [18, 19],
    "TEL-2-REDES2":  [18, 19],

    // ── GIT año 3 ────────────────────────────────────────────────────────
    "GIT-3-PA":      6,   // David Torres
    "GIT-3-SERTEL":  20,  // Andrés Serrano
    "GIT-3-SED":     11,  // Alejandro Ruiz
    "GIT-3-AC":      8,   // Roberto Gómez
    "GIT-3-REDES3":  19,  // Sandra Morales
    "GIT-3-SEG":     20,  // Andrés Serrano
    "GIT-3-REDES4":  18,  // Javier Ortega
    "GIT-3-SSOO":    7,   // Elena Ramírez
    "GIT-3-LRSS":    19,  // Sandra Morales
    "GIT-3-TRANS2":  7,   // Elena Ramírez

    // ── GITT año 3 ───────────────────────────────────────────────────────
    "GITT-3-DIS":    10,  // Patricia Moreno
    "GITT-3-TDS":    16,  // Miguel Á. Lozano
    "GITT-3-SED":    11,  // Alejandro Ruiz
    "GITT-3-AC":     8,   // Roberto Gómez
    "GITT-3-REDES3": 19,  // Sandra Morales
    "GITT-3-CD":     15,  // Cristina Vargas
    "GITT-3-MNTO":   2,   // J.A. Fernández
    "GITT-3-SUBSIS": 13,  // Fernando Jiménez
    "GITT-3-TAF":    14,  // Carlos A. Núñez
    "GITT-3-SSOO":   24,  // Silvia Pardo

    // ── GIEC año 3 ───────────────────────────────────────────────────────
    "GIEC-3-DIS":    10,  // Patricia Moreno
    "GIEC-3-POT":    9,   // Luis M. Herrera
    "GIEC-3-SED":    23,  // Diego Navarro
    "GIEC-3-SUBSIS": 13,  // Fernando Jiménez
    "GIEC-3-REDES3": 27,  // Álvaro Medina
    "GIEC-3-INS":    12,  // Isabel Díaz
    "GIEC-3-CE":     12,  // Isabel Díaz
    "GIEC-3-TECE":   13,  // Fernando Jiménez
    "GIEC-3-SEC":    13,  // Fernando Jiménez
    "GIEC-3-TRANS2": 24,  // Silvia Pardo

    // ── GIST año 3 ───────────────────────────────────────────────────────
    "GIST-3-CD":     15,  // Cristina Vargas
    "GIST-3-TDS":    16,  // Miguel Á. Lozano
    "GIST-3-SED":    23,  // Diego Navarro
    "GIST-3-TAF":    14,  // Carlos A. Núñez
    "GIST-3-REDES3": 27,  // Álvaro Medina
    "GIST-3-CO":     17,  // Laura Castillo
    "GIST-3-CC":     14,  // Carlos A. Núñez
    "GIST-3-RADIO":  21,  // Rafael Benítez
    "GIST-3-STEL":   15,  // Cristina Vargas
    "GIST-3-TRANS2": 24,  // Silvia Pardo

    // ── GIT año 4 ────────────────────────────────────────────────────────
    "GIT-4-IRyS":    18,  // Javier Ortega
    "GIT-4-ASO":     7,   // Elena Ramírez
    "GIT-4-PV":      6,   // David Torres
    "GIT-4-GAR":     20,  // Andrés Serrano
    "GIT-4-TRAF":    22,  // Marta Iglesias
    "GIT-4-ISW":     8,   // Roberto Gómez
    "GIT-4-TST":     18,  // Javier Ortega
    "GIT-4-TSE":     10,  // Patricia Moreno
    "GIT-4-CMOV":    16,  // Miguel Á. Lozano
    "GIT-4-SISNG":   17,  // Laura Castillo
    "GIT-4-TFOT":    17,  // Laura Castillo

    // ── GITT año 4 ───────────────────────────────────────────────────────
    "GITT-4-CO":     17,  // Laura Castillo
    "GITT-4-VA":     5,   // Mª José Sánchez
    "GITT-4-POT":    9,   // Luis M. Herrera
    "GITT-4-PV":     6,   // David Torres
    "GITT-4-SEC":    13,  // Fernando Jiménez
    "GITT-4-INSTR":  12,  // Isabel Díaz
    "GITT-4-RADIO":  21,  // Rafael Benítez
    "GITT-4-REDES4": 18,  // Javier Ortega
    "GITT-4-SEDA":   11,  // Alejandro Ruiz
    "GITT-4-SEG":    20,  // Andrés Serrano
    "GITT-4-CC":     21,  // Rafael Benítez
    "GITT-4-SERTEL": 22,  // Marta Iglesias
    "GITT-4-CE":     12,  // Isabel Díaz
    "GITT-4-TRAF":   27,  // Álvaro Medina
    "GITT-4-STEL":   25,  // Gonzalo Esteban
    "GITT-4-CMOV":   16,  // Miguel Á. Lozano
    "GITT-4-SISNG":  25,  // Gonzalo Esteban
    "GITT-4-TFOT":   23,  // Diego Navarro
    "GITT-4-LRSS":   19,  // Sandra Morales

    // ── GIEC año 4 ───────────────────────────────────────────────────────
    "GIEC-4-RISE":   13,  // Fernando Jiménez
    "GIEC-4-VA":     5,   // Mª José Sánchez
    "GIEC-4-EBIO":   12,  // Isabel Díaz
    "GIEC-4-PV":     24,  // Silvia Pardo
    "GIEC-4-SEDA":   23,  // Diego Navarro
    "GIEC-4-CIND":   12,  // Isabel Díaz
    "GIEC-4-EEREN":  28,  // Beatriz Fuentes
    "GIEC-4-ISW":    8,   // Roberto Gómez
    "GIEC-4-TST":    22,  // Marta Iglesias
    "GIEC-4-TRST":   20,  // Andrés Serrano
    "GIEC-4-SISNG":  25,  // Gonzalo Esteban
    "GIEC-4-TFOT":   26,  // Verónica Castro
    "GIEC-4-CMOV":   26,  // Verónica Castro

    // ── GIST año 4 ───────────────────────────────────────────────────────
    "GIST-4-PVA":    16,  // Miguel Á. Lozano
    "GIST-4-RADAR":  14,  // Carlos A. Núñez
    "GIST-4-PV":     24,  // Silvia Pardo
    "GIST-4-PIVC":   24,  // Silvia Pardo
    "GIST-4-SAT":    17,  // Laura Castillo
    "GIST-4-ASTEL":  15,  // Cristina Vargas
    "GIST-4-TINAM":  21,  // Rafael Benítez
    "GIST-4-CMOV":   21,  // Rafael Benítez
    "GIST-4-ISW":    8,   // Roberto Gómez
    "GIST-4-TRST":   20,  // Andrés Serrano
    "GIST-4-TSE":    10,  // Patricia Moreno
    "GIST-4-TFOT":   26,  // Verónica Castro

    // Prácticas Teleco año 1
    "TEL-1-SINF-P":   [5, 6],   // Mª José Sánchez + David Torres
    "TEL-1-TDC-P":    [4, 9],   // Pedro Martínez + Luis M. Herrera
    "TEL-1-PRG-P":    [6, 7],   // David Torres + Elena Ramírez
    "TEL-1-ADC-P":    [4, 9],   // Pedro Martínez + Luis M. Herrera
    // Prácticas Teleco año 2
    "TEL-2-EBAS-P":   [9, 10],  // Luis M. Herrera + Patricia Moreno
    "TEL-2-REDES1-P": [18, 19], // Javier Ortega + Sandra Morales
    "TEL-2-ED-P":     [9, 11],  // Luis M. Herrera + Alejandro Ruiz
    "TEL-2-EC-P":     [10, 12], // Patricia Moreno + Isabel Díaz
  };

  const subjectRows = await all("SELECT id, code FROM subjects ORDER BY id");

  for (const { id: sid, code } of subjectRows) {
    const val = assignments[code];
    if (val !== undefined) {
      const idxs = Array.isArray(val) ? val : [val];
      for (const idx of idxs) {
        await run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)",
          [sid, teacherIds[idx - 1]]);
      }
    } else {
      await run("INSERT INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)",
        [sid, teacherIds[0]]);
      console.warn(`  ⚠ Sin asignación para ${code}, asignado por defecto`);
    }
  }
  console.log("✓ Asignaciones profesor-asignatura");

  // ── Configuración de grupos ───────────────────────
  await run("DELETE FROM group_config");
  const groupConfigs = [
    // Teleco 1º: F = tarde
    { degree: 'Teleco', year: 1, group_letter: 'F', afternoon: 1, bilingual: 0 },
    // Teleco 1º: E = bilingüe
    { degree: 'Teleco', year: 1, group_letter: 'E', afternoon: 0, bilingual: 1 },
    // Teleco 2º: D = tarde
    { degree: 'Teleco', year: 2, group_letter: 'D', afternoon: 1, bilingual: 0 },
    // Teleco 2º: E = bilingüe
    { degree: 'Teleco', year: 2, group_letter: 'E', afternoon: 0, bilingual: 1 },
  ];
  for (const { degree, year, group_letter, afternoon, bilingual } of groupConfigs) {
    await run(
      `INSERT OR REPLACE INTO group_config (degree, year, group_letter, afternoon, bilingual) VALUES (?,?,?,?,?)`,
      [degree, year, group_letter, afternoon, bilingual]
    );
  }
  console.log("✓ Configuración de grupos");

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
