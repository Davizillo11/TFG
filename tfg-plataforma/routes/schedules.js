const express     = require("express");
const db          = require("../database/db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

// ── DB helpers ────────────────────────────────────
function dbAll(sql, params = []) {
  return new Promise((res, rej) =>
    db.all(sql, params, (err, rows) => err ? rej(err) : res(rows))
  );
}
function dbRun(sql, params = []) {
  return new Promise((res, rej) =>
    db.run(sql, params, function(err) { err ? rej(err) : res(this); })
  );
}

// ── Time helpers ──────────────────────────────────
function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minToTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// ── Sesiones por asignatura (duraciones mixtas) ───
// 5h + max120 → [120, 120, 60]
// 3h + max120 → [120, 60]
// 4h + max120 → [120, 120]
// 2h + max120 → [120]
function getSessionDurations(hoursWeek, maxDurMin) {
  const totalMin = hoursWeek * 60;
  const durations = [];
  let remaining = totalMin;
  while (remaining >= maxDurMin) {
    durations.push(maxDurMin);
    remaining -= maxDurMin;
  }
  if (remaining >= 60) durations.push(60);
  return durations;
}

// ── Ocupación a nivel de sub-slot de 5min ─────────
const SLOT_STEP = 5;

function isSegmentFree(sets, key, startMin, endMin) {
  for (let m = startMin; m < endMin; m += SLOT_STEP) {
    const k = `${key}-${m}`;
    for (const s of sets) { if (s.has(k)) return false; }
  }
  return true;
}
function occupySegment(set, key, startMin, endMin) {
  for (let m = startMin; m < endMin; m += SLOT_STEP) set.add(`${key}-${m}`);
}
function freeSegment(set, key, startMin, endMin) {
  for (let m = startMin; m < endMin; m += SLOT_STEP) set.delete(`${key}-${m}`);
}

// ── Disponibilidad del profesor ───────────────────
function isTeacherAvailable(teacherId, dia, startMin, endMin, teacherAvail) {
  const avail = teacherAvail[teacherId];
  if (!avail || avail.length === 0) return true;
  return avail.some(a =>
    a.day === dia &&
    timeToMin(a.start) <= startMin &&
    timeToMin(a.end)   >= endMin
  );
}

// ── Franja de descanso (14:00–15:00) ──────────────
const LUNCH_START = 14 * 60; // 840 min
const LUNCH_END   = 15 * 60; // 900 min

// ── Franjas horarias preferentes (soft) ───────────
// Los slots dentro de estos rangos se intentan primero.
const PREF_RANGES = [
  [10 * 60, 14 * 60], // 10:00–14:00
  [15 * 60, 19 * 60], // 15:00–19:00
];

// ── Lista de tiempos de inicio completamente aleatoria ────────────────────────
// Los slots que solapen 14:00–15:00 se descartan (franja de descanso).
function generateStartTimes(dias, horaInicio, horaFin, step = SLOT_STEP) {
  const times  = [];
  const finMin = timeToMin(horaFin);
  let m = timeToMin(horaInicio);
  while (m + step <= finMin) {
    // Excluir slots que solapen la franja de descanso
    if (!(m < LUNCH_END && m + step > LUNCH_START)) {
      for (const dia of dias) times.push({ dia, startMin: m });
    }
    m += step;
  }
  return times;
}

// ── Fisher-Yates shuffle ──────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Detectar huecos (recreos) dentro del rango horario ──
function detectBreaks(availRows, dias, horaInicio, horaFin) {
  if (!availRows.length || !dias.length) return [];

  const startMin = timeToMin(horaInicio);
  const finMin   = timeToMin(horaFin);
  const day      = dias[0];

  const windows = availRows
    .filter(r => r.day_of_week === day)
    .map(r => [timeToMin(r.slot_start), timeToMin(r.slot_end)]);

  if (!windows.length) return [];

  windows.sort((a, b) => a[0] - b[0]);
  const merged = [windows[0].slice()];
  for (let i = 1; i < windows.length; i++) {
    const last = merged[merged.length - 1];
    if (windows[i][0] <= last[1]) last[1] = Math.max(last[1], windows[i][1]);
    else merged.push(windows[i].slice());
  }

  const breaks = [];
  let prev = startMin;
  for (const [ws, we] of merged) {
    if (ws > prev + 4)
      breaks.push({ start: minToTime(Math.max(prev, startMin)), end: minToTime(Math.min(ws, finMin)) });
    prev = we;
  }
  return breaks;
}

// ── Sesiones consecutivas máximas por profesor/día ──
const MAX_CONSECUTIVE = 3;

// Cuenta cuántas sesiones consecutivas tiene un profesor justo antes de startMin
function countConsecBefore(tid, dia, startMin, teacherSessMap) {
  const key = `${tid}-${dia}`;
  const sessions = teacherSessMap.get(key);
  if (!sessions || !sessions.length) return 0;
  let count = 0;
  let cur = startMin;
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i][1] === cur) { count++; cur = sessions[i][0]; }
    else break;
  }
  return count;
}

// ── Ordenación de slots por asignatura (con diversidad soft) ─────────────────
// Slots dentro de PREF_RANGES (10-14 / 15-19) tienen prioridad sobre slots fuera (19+)
const isPreferredTime = (t) => PREF_RANGES.some(([s, e]) => t.startMin >= s && t.startMin < e);

function getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays) {
  const isPref  = ({ startMin }) => !partialMins.has(startMin);
  const avoided = avoidDays[subject.id] || new Set();
  const av      = t => avoided.has(t.dia);
  const mainPref = startTimes.filter(isPref);
  const fringe   = startTimes.filter(t => !isPref(t));

  // avoidDays es tiebreaker DENTRO de cada franja — nunca un slot tardío
  // debe ganar a un preferido solo porque el preferido está en día evitado.
  if (dur < duracion) {
    const early = mainPref.filter(t => t.startMin >= LUNCH_END && isPreferredTime(t) && !t.isExtreme);
    const late  = mainPref.filter(t => t.startMin >= LUNCH_END && !isPreferredTime(t) && !t.isExtreme);
    return [
      ...early.filter(t => !av(t)), ...early.filter(av),
      ...late.filter(t => !av(t)),  ...late.filter(av),
      ...fringe,
    ];
  } else {
    const pref  = mainPref.filter(t => isPreferredTime(t) && !t.isExtreme);
    const late  = mainPref.filter(t => !isPreferredTime(t) && !t.isExtreme);
    const extr  = mainPref.filter(t => t.isExtreme);
    return [
      ...pref.filter(t => !av(t)), ...pref.filter(av),
      ...late.filter(t => !av(t)), ...late.filter(av),
      ...extr.filter(t => !av(t)), ...extr.filter(av),
    ];
  }
}

// ── Asignación greedy (sin backtracking) ─────────
// Primera opción válida para cada sesión; no deshace nada.
// Las sesiones de la misma asignatura prefieren slots consecutivos.
function solveGreedy(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays = {}) {
  const occupied        = { aulas: new Set(), teachers: new Set(), groups: new Set() };
  const teacherSessMap  = new Map(); // "tid-dia" → [[s,e], ...]
  const subjectSessions = {};        // sid → [{dia, startMin, endMin}]
  const result          = new Array(allSessions.length).fill(null);
  const isPref = ({ startMin }) => !partialMins.has(startMin);

  for (let idx = 0; idx < allSessions.length; idx++) {
    const { subject, dur } = allSessions[idx];
    const sid        = subject.id;
    const placed     = subjectSessions[sid] || [];
    const validAulas = validAulasBySubject[sid];

    const orderedSlots = getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays);

    outer: for (const { dia, startMin } of orderedSlots) {
      const endMin = startMin + dur;
      if (endMin > finMin) continue;

      // Constraint viernes: solo 1er curso, 1er cuatrimestre
      if (subject.year === 1 && subject.semester === 1) {
        if (subject.transversal && dia !== 4) continue;
        if (!subject.transversal && dia === 4) continue;
      }

      const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
      if (gk && !isSegmentFree([occupied.groups], gk, startMin, endMin)) continue;

      for (const aula of validAulas) {
        const ak = `${aula.id}-${dia}`;
        if (!isSegmentFree([occupied.aulas], ak, startMin, endMin)) continue;
        let ok = true;
        for (const tid of subject.teacherIds) {
          if (!isTeacherAvailable(tid, dia, startMin, endMin, teacherAvail)) { ok = false; break; }
          if (!isSegmentFree([occupied.teachers], `${tid}-${dia}`, startMin, endMin)) { ok = false; break; }
          if (countConsecBefore(tid, dia, startMin, teacherSessMap) >= MAX_CONSECUTIVE) { ok = false; break; }
        }
        if (!ok) continue;

        occupySegment(occupied.aulas, ak, startMin, endMin);
        subject.teacherIds.forEach(tid => {
          occupySegment(occupied.teachers, `${tid}-${dia}`, startMin, endMin);
          const key = `${tid}-${dia}`;
          const list = teacherSessMap.get(key) || [];
          list.push([startMin, endMin]);
          list.sort((a, b) => a[0] - b[0]);
          teacherSessMap.set(key, list);
        });
        if (gk) occupySegment(occupied.groups, gk, startMin, endMin);
        if (!subjectSessions[sid]) subjectSessions[sid] = [];
        subjectSessions[sid].push({ dia, startMin, endMin });
        result[idx] = { aulaId: aula.id, dia, startMin, dur, endMin };
        break outer;
      }
    }
  }

  return result;
}

// ── CSP global con backtracking ───────────────────
// Intenta solución perfecta. Si agota MAX_OPS cae al greedy.
// Las sesiones de la misma asignatura prefieren slots consecutivos.
const MAX_OPS = 150_000;

function solveCSP(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays = {}) {
  const n = allSessions.length;

  const occupied        = { aulas: new Set(), teachers: new Set(), groups: new Set() };
  const teacherSessMap  = new Map();
  const subjectSessions = {}; // sid → [{dia, startMin, endMin}]
  const result          = new Array(n).fill(null);
  let ops = 0;
  let timedOut = false;
  const isPref = ({ startMin }) => !partialMins.has(startMin);

  function bt(idx) {
    if (idx === n) return true;
    if (ops++ > MAX_OPS) { timedOut = true; return false; }

    const { subject, dur } = allSessions[idx];
    const sid = subject.id;
    const validAulas = validAulasBySubject[sid];
    const placed = subjectSessions[sid] || [];

    const orderedSlots = getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays);

    for (const { dia, startMin } of orderedSlots) {
      if (timedOut) return false;
      const endMin = startMin + dur;
      if (endMin > finMin) continue;

      // Constraint viernes: solo 1er curso, 1er cuatrimestre
      if (subject.year === 1 && subject.semester === 1) {
        if (subject.transversal && dia !== 4) continue;
        if (!subject.transversal && dia === 4) continue;
      }

      const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
      if (gk && !isSegmentFree([occupied.groups], gk, startMin, endMin)) continue;

      for (const aula of validAulas) {
        const ak = `${aula.id}-${dia}`;
        if (!isSegmentFree([occupied.aulas], ak, startMin, endMin)) continue;
        let ok = true;
        for (const tid of subject.teacherIds) {
          if (!isTeacherAvailable(tid, dia, startMin, endMin, teacherAvail)) { ok = false; break; }
          if (!isSegmentFree([occupied.teachers], `${tid}-${dia}`, startMin, endMin)) { ok = false; break; }
          if (countConsecBefore(tid, dia, startMin, teacherSessMap) >= MAX_CONSECUTIVE) { ok = false; break; }
        }
        if (!ok) continue;

        occupySegment(occupied.aulas, ak, startMin, endMin);
        subject.teacherIds.forEach(tid => {
          occupySegment(occupied.teachers, `${tid}-${dia}`, startMin, endMin);
          const key = `${tid}-${dia}`;
          const list = teacherSessMap.get(key) || [];
          list.push([startMin, endMin]);
          list.sort((a, b) => a[0] - b[0]);
          teacherSessMap.set(key, list);
        });
        if (gk) occupySegment(occupied.groups, gk, startMin, endMin);
        if (!subjectSessions[sid]) subjectSessions[sid] = [];
        subjectSessions[sid].push({ dia, startMin, endMin });
        result[idx] = { aulaId: aula.id, dia, startMin, dur, endMin };

        if (bt(idx + 1)) return true;

        freeSegment(occupied.aulas, ak, startMin, endMin);
        subject.teacherIds.forEach(tid => {
          freeSegment(occupied.teachers, `${tid}-${dia}`, startMin, endMin);
          const key = `${tid}-${dia}`;
          const list = teacherSessMap.get(key) || [];
          const i = list.findIndex(([s, e]) => s === startMin && e === endMin);
          if (i >= 0) list.splice(i, 1);
        });
        if (gk) freeSegment(occupied.groups, gk, startMin, endMin);
        const ssList = subjectSessions[sid];
        if (ssList) {
          const i = ssList.findIndex(p => p.dia === dia && p.startMin === startMin && p.endMin === endMin);
          if (i >= 0) ssList.splice(i, 1);
        }
        result[idx] = null;
      }
    }

    return false;
  }

  const solved = bt(0);
  if (solved) return { result, perfect: true };

  // Fallback: greedy rápido — siempre devuelve algo
  return { result: solveGreedy(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays), perfect: false };
}

// ── POST /api/v1/schedules/generate ──────────────
router.post("/generate", requireAuth, async (req, res) => {
  try {
    const { aulas, asignaturas, franjas, meta = {} } = req.body;
    const { dias, horaInicio, horaFin, duracion } = franjas;
    const finMin = timeToMin(horaFin);
    // Para 1º: asegurar que el viernes (día 4) existe en la rejilla (lo necesita Transversal)
    const effectiveDias = (meta.year === 1) ? [...new Set([...dias, 4])] : dias;

    // Cargar datos de la BD en paralelo
    const [availRows, stRows, subjectRows, teacherRows, classroomRows] = await Promise.all([
      dbAll("SELECT * FROM teacher_availability WHERE available=1"),
      dbAll("SELECT * FROM subject_teachers"),
      dbAll("SELECT id, name, degree, year, semester, room_type, bilingual FROM subjects"),
      dbAll("SELECT id, name FROM teachers"),
      dbAll("SELECT id, name, type FROM classrooms"),
    ]);

    // Mapas de búsqueda
    const teacherAvail = {};
    for (const r of availRows) {
      (teacherAvail[r.teacher_id] = teacherAvail[r.teacher_id] || [])
        .push({ day: r.day_of_week, start: r.slot_start, end: r.slot_end });
    }
    const subjectTeachersMap = {};
    for (const r of stRows) {
      (subjectTeachersMap[r.subject_id] = subjectTeachersMap[r.subject_id] || []).push(r.teacher_id);
    }
    const subjectMeta   = Object.fromEntries(subjectRows.map(r => [r.id, r]));
    const teacherMeta   = Object.fromEntries(teacherRows.map(r => [r.id, r.name]));
    const classroomMeta = Object.fromEntries(classroomRows.map(r => [r.id, r.name]));
    const classroomType = Object.fromEntries(classroomRows.map(r => [r.id, r.type]));

    // Rejilla anclada a los horarios preferentes (10:00 mañana, 15:00 tarde)
    // con paso = duracion. Garantiza slots no solapados 10-12, 12-14, 15-17, 17-19.
    // Un slot "fringe" a 60 min antes del primer slot principal acoge las sesiones de 1h.
    const ANCHORS   = [10 * 60, 15 * 60]; // 10:00 y 15:00
    const startMin0 = timeToMin(horaInicio);
    const endMin0   = timeToMin(horaFin);

    const mainSlots = [];
    for (const anchor of ANCHORS) {
      for (let m = anchor; m + duracion <= endMin0; m += duracion) {
        if (m < LUNCH_END && m + duracion > LUNCH_START) break; // solapa comida → parar este bloque
        if (m < startMin0) continue;                             // antes del inicio del usuario
        for (const d of effectiveDias) mainSlots.push({ dia: d, startMin: m });
      }
    }

    // Fringe A: 1h antes del primer main slot (si cae dentro del rango del usuario)
    const firstMain        = mainSlots.reduce((acc, t) => Math.min(acc, t.startMin), Infinity);
    const morningFringeMin = isFinite(firstMain) ? firstMain - 60 : startMin0;
    const morningFringeOK  = morningFringeMin >= startMin0 &&
                              !(morningFringeMin < LUNCH_END && morningFringeMin + 60 > LUNCH_START);

    // Fringe B: última hora del rango que cabe como 1h pero no como sesión completa
    // (cubre casos: 10-16 → fringe 15:00-16:00 / 10-18 → fringe 17:00-18:00 / etc.)
    // Fringe B: solo en horario de tarde (>= LUNCH_END=15:00) para no crear
    // slots fantasma por la mañana (ej. 13:00 en rango 08-14)
    let fringeBMin = -1;
    for (let m = endMin0 - 60; m >= Math.max(startMin0, LUNCH_END); m -= 60) {
      if (m + duracion > endMin0 && m + 60 <= endMin0 &&
          !mainSlots.some(t => t.startMin === m)) {
        fringeBMin = m;
        break;
      }
    }
    const afternoonFringeOK = fringeBMin >= 0;

    const partialSlots = [
      ...(morningFringeOK   ? effectiveDias.map(d => ({ dia: d, startMin: morningFringeMin })) : []),
      ...(afternoonFringeOK ? effectiveDias.map(d => ({ dia: d, startMin: fringeBMin }))       : []),
    ];
    const partialMins = new Set(partialSlots.map(t => t.startMin));

    // Slot extremo de mañana: bloque display completo (ej. 08:00-10:00) usado como último
    // recurso para sesiones de duración completa cuando los slots principales están llenos.
    // Solo se añade cuando morningDisplayMin != morningFringeMin (ej. rango 08-14 pero no 09-14).
    const morningDisplayMin = isFinite(firstMain)
      ? Math.max(startMin0, firstMain - duracion)
      : startMin0;
    const extremeMorningOK  = morningFringeOK &&
                               morningDisplayMin < morningFringeMin &&
                               morningDisplayMin + duracion <= endMin0;
    const extremeSlots = extremeMorningOK
      ? effectiveDias.map(d => ({ dia: d, startMin: morningDisplayMin, isExtreme: true }))
      : [];

    // Si no hay mainSlots (rango inusual), usar paso duracion desde horaInicio como fallback
    const allSlots = mainSlots.length > 0
      ? [...mainSlots, ...extremeSlots, ...partialSlots]
      : generateStartTimes(effectiveDias, horaInicio, horaFin, duracion);

    // Mañana primero, tarde después — dentro de cada bloque se barajan para variedad.
    // extremeSlots va DESPUÉS de los slots principales para que sea el último recurso.
    const morningMain  = shuffle(mainSlots.filter(t => t.startMin < LUNCH_START));
    const afternoonMain= shuffle(mainSlots.filter(t => t.startMin >= LUNCH_END));
    const startTimes   = [...morningMain, ...afternoonMain, ...shuffle(extremeSlots), ...partialSlots];

    // Preparar asignaturas con metadatos
    let subjects = asignaturas.map(s => {
      const subMeta  = subjectMeta[s.id] || {};
      const degree   = subMeta.degree || "";
      const year     = subMeta.year   ?? null;
      const roomType = subMeta.room_type || null;
      return {
        ...s,
        teacherIds:       subjectTeachersMap[s.id] || [],
        sessionDurations: getSessionDurations(s.hours, duracion),
        name:             subMeta.name || `Asignatura ${s.id}`,
        degree,
        year,
        roomType,
        semester:    subMeta.semester ?? null,
        bilingual:   subMeta.bilingual   || 0,
        transversal: (subMeta.name || "").trim().toLowerCase().startsWith("transversal"),
        groupKey: degree && year != null ? `${degree}|${year}` : null,
      };
    });

    // Grupo E: solo asignaturas bilingües
    if (meta.group_letter === 'E') {
      subjects = subjects.filter(s => s.bilingual);
    }

    // Aulas válidas por asignatura:
    // - Si la asignatura tiene room_type → solo aulas con ese type exacto
    // - Si no tiene room_type → solo aulas de tipo 'teoria' (evita ocupar salas especiales)
    const validAulasBySubject = {};
    for (const s of subjects) {
      const requiredType = s.roomType || "teoria";
      validAulasBySubject[s.id] = shuffle(
        aulas.filter(a =>
          a.capacity >= s.students &&
          (classroomType[a.id] || "teoria") === requiredType
        )
      );
    }

    // Calcular número de slots válidos por asignatura (heurística MRV)
    const validSlots = {};
    for (const s of subjects) {
      const dur = s.sessionDurations[0] || duracion;
      let count = 0;
      for (const { dia, startMin } of startTimes) {
        if (startMin + dur > finMin) continue;
        if (s.teacherIds.every(tid => isTeacherAvailable(tid, dia, startMin, startMin + dur, teacherAvail)))
          count++;
      }
      validSlots[s.id] = count;
    }

    // Construir lista plana de sesiones: una entrada por sesión individual
    // Ordenar las asignaturas más restringidas primero (MRV), luego
    // intercalar las sesiones de distintas asignaturas en round-robin
    // para evitar que una asignatura monopolice los primeros días.
    const subjSorted = [...subjects].sort((a, b) => {
      if (validSlots[a.id] !== validSlots[b.id]) return validSlots[a.id] - validSlots[b.id];
      if (b.sessionDurations.length !== a.sessionDurations.length) return b.sessionDurations.length - a.sessionDurations.length;
      return b.students - a.students;
    });

    // Orden: todas las sesiones de la asignatura más restringida primero,
    // luego todas las de la siguiente, etc. (MRV por asignatura completa).
    // Esto evita que otras disciplinas roben los slots únicos de profesores
    // con disponibilidad muy limitada antes de que esa asignatura los reserve.
    const allSessions = [];
    for (const s of subjSorted) {
      if (s.sessionDurations.length > 0 && validAulasBySubject[s.id].length > 0) {
        for (const dur of s.sessionDurations) {
          allSessions.push({ subject: s, dur });
        }
      }
    }
    // Sesiones completas (dur===duracion) primero; fringe (1h) al final.
    // Preserva el orden relativo de las asignaturas dentro de cada grupo (stable sort).
    allSessions.sort((a, b) => (a.dur < duracion ? 1 : 0) - (b.dur < duracion ? 1 : 0));

    // Asignaturas sin aula o sin sesiones (no entran en CSP)
    const noAsignadas = [];
    for (const s of subjects) {
      if (s.hours > 0 && (s.sessionDurations.length === 0 || validAulasBySubject[s.id].length === 0)) {
        noAsignadas.push(s.name);
      }
    }

    // Diversidad de días para grupo de tarde (F en 1º, D en 2º)
    // Diversidad entre grupos de mañana: A-B-C-D (1º) o A-B-C (2º).
    // E (bilingüe) y F/D (tarde) no participan — horario o alumnado distinto.
    const MORNING_GROUPS = meta.year === 1 ? ['A','B','C','D']
                         : meta.year === 2 ? ['A','B','C']
                         : [];
    const isMorningGroup = MORNING_GROUPS.includes(meta.group_letter);
    let avoidDays = {};
    if (isMorningGroup && meta.degree && meta.year != null && meta.semester != null) {
      const placeholders = MORNING_GROUPS.filter(g => g !== meta.group_letter).map(() => '?').join(',');
      const prevSchedules = await dbAll(`
        SELECT id FROM schedules
        WHERE degree=? AND year=? AND semester=?
          AND group_letter IN (${placeholders})
        ORDER BY id ASC
      `, [meta.degree, meta.year, meta.semester, ...MORNING_GROUPS.filter(g => g !== meta.group_letter)]);

      if (prevSchedules.length) {
        const ids = prevSchedules.map(s => s.id);
        const threshold = Math.min(2, prevSchedules.length);
        const avoidRows = await dbAll(`
          SELECT subject_id, day_of_week, COUNT(*) AS cnt
          FROM schedule_sessions
          WHERE schedule_id IN (${ids.map(() => '?').join(',')})
          GROUP BY subject_id, day_of_week
          HAVING cnt >= ?
        `, [...ids, threshold]);
        for (const r of avoidRows) {
          if (!avoidDays[r.subject_id]) avoidDays[r.subject_id] = new Set();
          avoidDays[r.subject_id].add(r.day_of_week);
        }
      }
    }

    // Ejecutar CSP (con fallback greedy si no converge)
    const { result, perfect } = solveCSP(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays);

    // Recopilar sesiones asignadas y no asignadas
    const sesiones = [];
    const assignedCount = {};  // subject_id → num sesiones asignadas

    for (let i = 0; i < allSessions.length; i++) {
      const sess    = allSessions[i];
      const subject = sess.subject;
      const sid     = subject.id;
      const a       = result[i];

      if (a) {
        (assignedCount[sid] = assignedCount[sid] || 0);
        assignedCount[sid]++;
        sesiones.push({
          subject_id:   sid,
          subject:      subject.name,
          degree:       subject.degree,
          classroom_id: a.aulaId,
          classroom:    classroomMeta[a.aulaId] || `Aula ${a.aulaId}`,
          teacher_ids:  subject.teacherIds,
          teacher:      subject.teacherIds.map(tid => teacherMeta[tid] || `Prof ${tid}`).join(", "),
          day:          a.dia,
          start:        minToTime(a.startMin),
          end:          minToTime(a.endMin),
        });
      }
    }

    // Detectar asignaturas parcialmente asignadas
    for (const s of subjects) {
      if (s.hours <= 0 || s.sessionDurations.length === 0) continue;
      const got = assignedCount[s.id] || 0;
      if (got < s.sessionDurations.length && !noAsignadas.includes(s.name)) {
        noAsignadas.push(`${s.name} (${got}/${s.sessionDurations.length} sesiones)`);
      }
    }

    // Guardar en BD
    const userId    = req.session?.userId || null;
    const metaDeg   = meta.degree   || null;
    const metaYear  = meta.year     || null;
    const metaSem   = meta.semester || null;
    const metaGroup = meta.group_letter || null;
    const semStr    = metaSem === 1 ? "1er cuatri" : metaSem === 2 ? "2do cuatri" : null;
    const groupStr  = metaGroup ? ` – Gr. ${metaGroup}` : "";
    const nameLabel = meta.label ||
      (metaDeg && metaYear
        ? `${metaDeg} – ${metaYear}º${semStr ? " – " + semStr : ""}${groupStr} – ${new Date().toLocaleDateString("es-ES")}`
        : `Horario ${new Date().toLocaleDateString("es-ES")}`);
    const sched  = await dbRun(
      "INSERT INTO schedules (name, created_by, status, degree, year, semester, group_letter) VALUES (?,?,?,?,?,?,?)",
      [nameLabel, userId, "active", metaDeg, metaYear, metaSem, metaGroup]
    );
    const scheduleId = sched.lastID;

    for (const s of sesiones) {
      const r = await dbRun(
        "INSERT INTO schedule_sessions (schedule_id, subject_id, teacher_id, classroom_id, day_of_week, slot_start, slot_end) VALUES (?,?,?,?,?,?,?)",
        [scheduleId, s.subject_id, s.teacher_ids[0] || null, s.classroom_id, s.day, s.start, s.end]
      );
      s.session_id = r.lastID;
    }

    const breaks = detectBreaks(availRows, dias, horaInicio, horaFin);

    // slotMins: tiempos de inicio de los bloques de DISPLAY (no los internos del scheduler).
    // El bloque previo a la mañana empieza en max(startMin0, firstMain-duracion) para que
    // sea exactamente un bloque de 2h y el card de 1h quede en la mitad inferior.
    const uniqueMainMins  = [...new Set(mainSlots.map(t => t.startMin))].sort((a,b)=>a-b);
    const displayMinsSet  = new Set(uniqueMainMins);
    if (morningFringeOK)   displayMinsSet.add(Math.max(startMin0, firstMain - duracion));
    // fringeBMin solo se añade como fila propia si NO cae dentro del span de un main slot.
    // Si cae dentro (ej. 18:00 en rango 10-19 con main slot 17:00-19:00), se posiciona
    // con topPx dentro de esa fila, igual que el fringe de mañana dentro del bloque 08-10.
    if (afternoonFringeOK) {
      const fringeWithinMain = mainSlots.some(t => t.startMin <= fringeBMin && t.startMin + duracion > fringeBMin);
      if (!fringeWithinMain) displayMinsSet.add(fringeBMin);
    }
    const slotMins = [...displayMinsSet].sort((a,b)=>a-b);
    await dbRun("UPDATE schedules SET slot_mins=?, duracion=? WHERE id=?", [JSON.stringify(slotMins), duracion, scheduleId]);

    res.json({ schedule_id: scheduleId, sesiones, no_asignadas: noAsignadas, breaks, perfect, total_needed: allSessions.length, slotMins });

  } catch (err) {
    console.error("Error generando horario:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/v1/schedules ────────────────────────
// Lista todos los horarios guardados. Acepta ?degree=GIT&year=3 para filtrar.
router.get("/", async (req, res) => {
  try {
    const { degree, year, semester, group_letter } = req.query;
    const params = [];
    let where = "";
    if (degree)       { where += (where ? " AND" : " WHERE") + " s.degree=?";        params.push(degree); }
    if (year)         { where += (where ? " AND" : " WHERE") + " s.year=?";          params.push(parseInt(year)); }
    if (semester)     { where += (where ? " AND" : " WHERE") + " s.semester=?";      params.push(parseInt(semester)); }
    if (group_letter) { where += (where ? " AND" : " WHERE") + " s.group_letter=?";  params.push(group_letter); }

    const rows = await dbAll(`
      SELECT s.id, s.name, s.created_at, s.status, s.degree, s.year,
             s.group_letter,
             u.username AS created_by,
             COUNT(ss.id) AS session_count
      FROM schedules s
      LEFT JOIN users u ON u.id = s.created_by
      LEFT JOIN schedule_sessions ss ON ss.schedule_id = s.id
      ${where}
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/v1/schedules/:id ─────────────────────
// Devuelve un horario completo con sus sesiones
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sched = await dbAll("SELECT * FROM schedules WHERE id=?", [id]);
    if (!sched.length) return res.status(404).json({ error: "Horario no encontrado" });

    const sessions = await dbAll(`
      SELECT ss.id AS session_id, ss.day_of_week AS day, ss.slot_start AS start, ss.slot_end AS end,
             sub.name AS subject, sub.degree, sub.id AS subject_id,
             c.name AS classroom, c.id AS classroom_id,
             t.name AS teacher
      FROM schedule_sessions ss
      LEFT JOIN subjects  sub ON sub.id = ss.subject_id
      LEFT JOIN classrooms c  ON c.id   = ss.classroom_id
      LEFT JOIN teachers   t  ON t.id   = ss.teacher_id
      WHERE ss.schedule_id = ?
      ORDER BY ss.day_of_week, ss.slot_start
    `, [id]);

    const schedule = sched[0];
    const slotMins = schedule.slot_mins ? JSON.parse(schedule.slot_mins) : null;
    res.json({ schedule, sesiones: sessions, slotMins, duracion: schedule.duracion || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/v1/schedules/:id ──────────────────
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await dbRun("DELETE FROM schedules WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/v1/schedules/validate ───────────────
// Comprueba inconsistencias en los datos antes de generar
router.get("/validate", requireAuth, async (req, res) => {
  try {
    const [subjects, classrooms, teachers, stRows, availRows] = await Promise.all([
      dbAll("SELECT * FROM subjects"),
      dbAll("SELECT * FROM classrooms"),
      dbAll("SELECT * FROM teachers"),
      dbAll("SELECT * FROM subject_teachers"),
      dbAll("SELECT * FROM teacher_availability WHERE available=1"),
    ]);

    const warnings = [];

    // Aulas por tipo
    const classroomsByType = {};
    for (const c of classrooms) {
      (classroomsByType[c.type] = classroomsByType[c.type] || []).push(c);
    }

    // Profesores asignados por asignatura
    const teachersBySubject = {};
    for (const r of stRows) {
      (teachersBySubject[r.subject_id] = teachersBySubject[r.subject_id] || []).push(r.teacher_id);
    }

    // Disponibilidad por profesor
    const availByTeacher = {};
    for (const r of availRows) {
      (availByTeacher[r.teacher_id] = availByTeacher[r.teacher_id] || []).push(r);
    }

    for (const s of subjects) {
      // Sin profesor asignado
      if (!teachersBySubject[s.id]?.length) {
        warnings.push({ type: "no_teacher", msg: `"${s.name}" no tiene profesor asignado.` });
      }
      // Sin aula compatible
      const required = s.room_type || "teoria";
      const compatible = (classroomsByType[required] || []).filter(c => c.capacity >= (s.students || 0));
      if (!compatible.length) {
        warnings.push({ type: "no_classroom", msg: `"${s.name}" necesita aula tipo "${required}" (≥${s.students} plazas) pero no hay ninguna disponible.` });
      }
    }

    for (const t of teachers) {
      // Sin disponibilidad definida
      if (!availByTeacher[t.id]?.length) {
        warnings.push({ type: "no_avail", msg: `"${t.name}" no tiene ningún horario de disponibilidad configurado.` });
        continue;
      }
      // Disponibilidad insuficiente para sus asignaturas
      const mySubjects = subjects.filter(s => teachersBySubject[s.id]?.includes(t.id));
      const totalHoursNeeded = mySubjects.reduce((sum, s) => sum + (s.hours_week || 0), 0);
      const slotsAvail = availByTeacher[t.id].length; // slots por semana disponibles
      if (slotsAvail < totalHoursNeeded) {
        warnings.push({ type: "low_avail", msg: `"${t.name}" tiene ${slotsAvail} franjas disponibles pero sus asignaturas requieren ~${totalHoursNeeded} h/sem.` });
      }
    }

    res.json({ warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/v1/schedules/:id/sessions ───────────
// Guarda los cambios manuales de arrastrar-y-soltar del resultado
router.put("/:id/sessions", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) return res.status(400).json({ error: "sessions must be array" });

    for (const s of sessions) {
      await dbRun(
        "UPDATE schedule_sessions SET day_of_week=?, slot_start=?, slot_end=?, classroom_id=? WHERE id=? AND schedule_id=?",
        [s.day, s.start, s.end, s.classroom_id, s.session_id, id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
