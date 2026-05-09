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
// teacherAvail es un mapa pre-fusionado: { [tid]: { [day]: [[startMin,endMin],…] } }
// Si un profesor no tiene entrada → completamente disponible (sin restricciones en BD).
// Si tiene entradas pero no en ese día → NO disponible ese día.
// Los intervalos ya están fusionados (adyacentes 10-11+11-12 → 10-12) para soportar
// el formato de franjas de 1h que usa el UI.
function isTeacherAvailable(teacherId, dia, startMin, endMin, teacherAvail) {
  const dayMap = teacherAvail[teacherId];
  if (!dayMap) return true;                      // sin restricciones → siempre disponible
  const intervals = dayMap[dia];
  if (!intervals || !intervals.length) return false; // tiene restricciones pero no hoy
  return intervals.some(([s, e]) => s <= startMin && e >= endMin);
}

// ── Franja de descanso (14:00–15:00) ──────────────
const LUNCH_START = 14 * 60; // 840 min
const LUNCH_END   = 15 * 60; // 900 min

// ── Franjas horarias preferentes (soft) ───────────
// Los slots dentro de estos rangos se intentan primero.
// Solo mañana como preferente. Tarde (15+) es fallback (late), extremo (08-10) va antes que tarde.
const PREF_RANGES = [
  [10 * 60, 14 * 60], // 10:00–14:00
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

function getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays = new Set()) {
  const isPref  = ({ startMin }) => !partialMins.has(startMin);
  const avoided = avoidDays[subject.id] || new Set();
  const av      = t => avoided.has(t.dia);
  const used    = t => placedDays.has(t.dia);
  const mainPref = startTimes.filter(isPref);
  const fringe   = startTimes.filter(t => !isPref(t));

  if (dur < duracion) {
    // Sesiones de 1h: fringe de mañana (09:00) → tarde main → fringe de tarde
    const late          = mainPref.filter(t => t.startMin >= LUNCH_END && !t.isExtreme);
    const fringe_morn   = fringe.filter(t => t.startMin <  LUNCH_START);
    const fringe_after  = fringe.filter(t => t.startMin >= LUNCH_END);
    return [
      ...fringe_morn,
      ...late.filter(t => !av(t) && !used(t)), ...late.filter(t => !av(t) && used(t)),
      ...late.filter(t =>  av(t) && !used(t)), ...late.filter(t =>  av(t) && used(t)),
      ...fringe_after,
    ];
  } else {
    // Transversal: MUST be on Friday → sort main slots before extreme, earlier times first.
    // Ensures sessions land at 10:00+12:00 (morning) or 15:00+17:00 (tarde), not 08:00.
    if (subject.transversal) {
      return [...mainPref].sort((a, b) => {
        if (!!a.isExtreme !== !!b.isExtreme) return a.isExtreme ? 1 : -1;
        return a.startMin !== b.startMin ? a.startMin - b.startMin : a.dia - b.dia;
      });
    }

    // Sesiones de duración completa:
    // Prioridad: mañana(10-14) → extremo(08-10) → tarde(15+)
    // Dentro de cada bloque: no-evitado+día-nuevo primero, luego mismo-día, luego evitado.
    const pref = mainPref.filter(t => isPreferredTime(t) && !t.isExtreme); // 10–14
    const extr = mainPref.filter(t => t.isExtreme);                        // 08–10
    const late = mainPref.filter(t => !isPreferredTime(t) && !t.isExtreme); // 15+
    return [
      ...pref.filter(t => !av(t) && !used(t)),
      ...pref.filter(t => !av(t) &&  used(t)),
      ...pref.filter(t =>  av(t) && !used(t)),
      ...pref.filter(t =>  av(t) &&  used(t)),
      ...extr.filter(t => !used(t)),
      ...extr.filter(t =>  used(t)),
      ...late.filter(t => !av(t) && !used(t)),
      ...late.filter(t => !av(t) &&  used(t)),
      ...late.filter(t =>  av(t) && !used(t)),
      ...late.filter(t =>  av(t) &&  used(t)),
    ];
  }
}

// ── Rescate post-solver: mueve sesiones en slot extremo (08:00) a slots preferentes ──
// Ejecutar después del solver. Intenta reubicar sesiones colocadas antes de las 10:00
// en slots 10:00-14:00 si hay disponibilidad. Si no encuentra slot mejor, deja el original.
function rescueExtremeSlots(result, allSessions, occupied, teacherSessMap, subjectSessions,
    startTimes, finMin, duracion, partialMins, avoidDays,
    preOccTeachers, preOccClassrooms, teacherAvail, validAulasBySubject) {
  const PREF_MIN = 10 * 60;
  const PREF_MAX = 14 * 60;

  for (let idx = 0; idx < result.length; idx++) {
    const assignment = result[idx];
    if (!assignment || assignment.startMin >= PREF_MIN) continue;

    const { subject, dur } = allSessions[idx];
    const sid = subject.id;
    const { dia, startMin, endMin, aulaId, teacherId } = assignment;

    // Liberar temporalmente el slot extremo
    const ak = `${aulaId}-${dia}`;
    freeSegment(occupied.aulas, ak, startMin, endMin);
    if (teacherId !== null) {
      freeSegment(occupied.teachers, `${teacherId}-${dia}`, startMin, endMin);
      const list = teacherSessMap.get(`${teacherId}-${dia}`) || [];
      const li = list.findIndex(([s, e]) => s === startMin && e === endMin);
      if (li >= 0) list.splice(li, 1);
    }
    const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
    if (gk) freeSegment(occupied.groups, gk, startMin, endMin);
    const ssList = subjectSessions[sid];
    if (ssList) {
      const si = ssList.findIndex(p => p.dia === dia && p.startMin === startMin);
      if (si >= 0) ssList.splice(si, 1);
    }

    // Ordenar los slots preferentes: no-evitado + día-nuevo primero, estable por startMin
    const avoided = avoidDays[sid] || new Set();
    const currentPlaced = new Set((subjectSessions[sid] || []).map(s => s.dia));
    const prefSlots = startTimes
      .filter(t => !t.isExtreme && t.startMin >= PREF_MIN && t.startMin < PREF_MAX && t.startMin + dur <= finMin)
      .slice()
      .sort((a, b) => {
        const aAv = avoided.has(a.dia) ? 1 : 0, bAv = avoided.has(b.dia) ? 1 : 0;
        if (aAv !== bAv) return aAv - bAv;
        const aU = currentPlaced.has(a.dia) ? 1 : 0, bU = currentPlaced.has(b.dia) ? 1 : 0;
        if (aU !== bU) return aU - bU;
        return a.startMin !== b.startMin ? a.startMin - b.startMin : a.dia - b.dia;
      });

    let relocated = false;
    outer: for (const { dia: nd, startMin: ns } of prefSlots) {
      const ne = ns + dur;
      if (subject.year === 1 && subject.semester === 1) {
        if (subject.transversal && nd !== 4) continue;
        if (!subject.transversal && nd === 4 && subject.groupLetter !== 'E') continue;
      }
      const newGk = subject.groupKey ? `${subject.groupKey}-${nd}` : null;
      if (newGk && !isSegmentFree([occupied.groups], newGk, ns, ne)) continue;

      for (const aula of validAulasBySubject[sid]) {
        const nak = `${aula.id}-${nd}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], nak, ns, ne)) continue;

        let newTid = null;
        if (subject.teacherIds.length > 0) {
          for (const tid of subject.teacherIds) {
            if (!isTeacherAvailable(tid, nd, ns, ne, teacherAvail)) continue;
            if (!isSegmentFree([occupied.teachers, preOccTeachers], `${tid}-${nd}`, ns, ne)) continue;
            if (countConsecBefore(tid, nd, ns, teacherSessMap) >= MAX_CONSECUTIVE) continue;
            newTid = tid;
            break;
          }
          if (newTid === null) continue;
        }

        occupySegment(occupied.aulas, nak, ns, ne);
        if (newTid !== null) {
          occupySegment(occupied.teachers, `${newTid}-${nd}`, ns, ne);
          const key = `${newTid}-${nd}`;
          const list = teacherSessMap.get(key) || [];
          list.push([ns, ne]);
          list.sort((a, b) => a[0] - b[0]);
          teacherSessMap.set(key, list);
        }
        if (newGk) occupySegment(occupied.groups, newGk, ns, ne);
        if (!subjectSessions[sid]) subjectSessions[sid] = [];
        subjectSessions[sid].push({ dia: nd, startMin: ns, endMin: ne });
        result[idx] = { aulaId: aula.id, dia: nd, startMin: ns, dur, endMin: ne, teacherId: newTid };
        relocated = true;
        break outer;
      }
    }

    if (!relocated) {
      // Restaurar el slot extremo original
      occupySegment(occupied.aulas, ak, startMin, endMin);
      if (teacherId !== null) {
        occupySegment(occupied.teachers, `${teacherId}-${dia}`, startMin, endMin);
        const key = `${teacherId}-${dia}`;
        const list = teacherSessMap.get(key) || [];
        list.push([startMin, endMin]);
        list.sort((a, b) => a[0] - b[0]);
        teacherSessMap.set(key, list);
      }
      if (gk) occupySegment(occupied.groups, gk, startMin, endMin);
      if (!subjectSessions[sid]) subjectSessions[sid] = [];
      subjectSessions[sid].push({ dia, startMin, endMin });
    }
  }
}

// ── Asignación greedy (sin backtracking) ─────────
// Primera opción válida para cada sesión; no deshace nada.
// Las sesiones de la misma asignatura prefieren slots consecutivos.
function solveGreedy(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays = {}, preOccTeachers = new Set(), preOccClassrooms = new Set()) {
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

    const placedDays = subject.transversal
      ? new Set()
      : new Set((subjectSessions[sid] || []).map(s => s.dia));
    const orderedSlots = getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays);

    outer: for (const { dia, startMin } of orderedSlots) {
      const endMin = startMin + dur;
      if (endMin > finMin) continue;

      // Constraint viernes: solo 1er curso, 1er cuatrimestre
      // Grupo E (bilingüe) puede usar viernes para asignaturas no-transversales; el resto no.
      if (subject.year === 1 && subject.semester === 1) {
        if (subject.transversal && dia !== 4) continue;
        if (!subject.transversal && dia === 4 && subject.groupLetter !== 'E') continue;
      }

      const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
      if (gk && !isSegmentFree([occupied.groups], gk, startMin, endMin)) continue;

      for (const aula of validAulas) {
        const ak = `${aula.id}-${dia}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], ak, startMin, endMin)) continue;

        // Pick ONE available teacher from the pool (any = valid)
        let selectedTid = null;
        if (subject.teacherIds.length > 0) {
          for (const tid of subject.teacherIds) {
            if (!isTeacherAvailable(tid, dia, startMin, endMin, teacherAvail)) continue;
            if (!isSegmentFree([occupied.teachers, preOccTeachers], `${tid}-${dia}`, startMin, endMin)) continue;
            if (countConsecBefore(tid, dia, startMin, teacherSessMap) >= MAX_CONSECUTIVE) continue;
            selectedTid = tid;
            break;
          }
          if (selectedTid === null) continue;
        }

        occupySegment(occupied.aulas, ak, startMin, endMin);
        if (selectedTid !== null) {
          occupySegment(occupied.teachers, `${selectedTid}-${dia}`, startMin, endMin);
          const key = `${selectedTid}-${dia}`;
          const list = teacherSessMap.get(key) || [];
          list.push([startMin, endMin]);
          list.sort((a, b) => a[0] - b[0]);
          teacherSessMap.set(key, list);
        }
        if (gk) occupySegment(occupied.groups, gk, startMin, endMin);
        if (!subjectSessions[sid]) subjectSessions[sid] = [];
        subjectSessions[sid].push({ dia, startMin, endMin });
        result[idx] = { aulaId: aula.id, dia, startMin, dur, endMin, teacherId: selectedTid };
        break outer;
      }
    }
  }

  // Rescate: mover sesiones en slot extremo (08:00) a slots preferentes si es posible.
  rescueExtremeSlots(result, allSessions, occupied, teacherSessMap, subjectSessions,
    startTimes, finMin, duracion, partialMins, avoidDays,
    preOccTeachers, preOccClassrooms, teacherAvail, validAulasBySubject);

  return result;
}

// ── CSP global con backtracking ───────────────────
// Intenta solución perfecta. Si agota MAX_OPS cae al greedy.
// Las sesiones de la misma asignatura prefieren slots consecutivos.
const MAX_OPS = 150_000;

function solveCSP(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays = {}, preOccTeachers = new Set(), preOccClassrooms = new Set()) {
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

    const placedDays = subject.transversal
      ? new Set()
      : new Set((subjectSessions[sid] || []).map(s => s.dia));
    const orderedSlots = getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays);

    for (const { dia, startMin } of orderedSlots) {
      if (timedOut) return false;
      const endMin = startMin + dur;
      if (endMin > finMin) continue;

      // Constraint viernes: solo 1er curso, 1er cuatrimestre
      // Grupo E (bilingüe) puede usar viernes para asignaturas no-transversales; el resto no.
      if (subject.year === 1 && subject.semester === 1) {
        if (subject.transversal && dia !== 4) continue;
        if (!subject.transversal && dia === 4 && subject.groupLetter !== 'E') continue;
      }

      const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
      if (gk && !isSegmentFree([occupied.groups], gk, startMin, endMin)) continue;

      for (const aula of validAulas) {
        const ak = `${aula.id}-${dia}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], ak, startMin, endMin)) continue;

        // Build teacher candidates: any available teacher from the pool (null = no teacher needed)
        const teacherCandidates = subject.teacherIds.length === 0
          ? [null]
          : subject.teacherIds.filter(tid =>
              isTeacherAvailable(tid, dia, startMin, endMin, teacherAvail) &&
              isSegmentFree([occupied.teachers, preOccTeachers], `${tid}-${dia}`, startMin, endMin) &&
              countConsecBefore(tid, dia, startMin, teacherSessMap) < MAX_CONSECUTIVE
            );

        for (const selectedTid of teacherCandidates) {
          occupySegment(occupied.aulas, ak, startMin, endMin);
          if (selectedTid !== null) {
            occupySegment(occupied.teachers, `${selectedTid}-${dia}`, startMin, endMin);
            const key = `${selectedTid}-${dia}`;
            const list = teacherSessMap.get(key) || [];
            list.push([startMin, endMin]);
            list.sort((a, b) => a[0] - b[0]);
            teacherSessMap.set(key, list);
          }
          if (gk) occupySegment(occupied.groups, gk, startMin, endMin);
          if (!subjectSessions[sid]) subjectSessions[sid] = [];
          subjectSessions[sid].push({ dia, startMin, endMin });
          result[idx] = { aulaId: aula.id, dia, startMin, dur, endMin, teacherId: selectedTid };

          if (bt(idx + 1)) return true;

          freeSegment(occupied.aulas, ak, startMin, endMin);
          if (selectedTid !== null) {
            freeSegment(occupied.teachers, `${selectedTid}-${dia}`, startMin, endMin);
            const key = `${selectedTid}-${dia}`;
            const list = teacherSessMap.get(key) || [];
            const i = list.findIndex(([s, e]) => s === startMin && e === endMin);
            if (i >= 0) list.splice(i, 1);
          }
          if (gk) freeSegment(occupied.groups, gk, startMin, endMin);
          const ssList = subjectSessions[sid];
          if (ssList) {
            const i = ssList.findIndex(p => p.dia === dia && p.startMin === startMin && p.endMin === endMin);
            if (i >= 0) ssList.splice(i, 1);
          }
          result[idx] = null;
        }
      }
    }

    return false;
  }

  const solved = bt(0);
  if (solved) {
    // Rescate post-CSP: aunque el CSP tuvo éxito, puede haber usado slots extremos
    // por orden de exploración. Intenta moverlos a slots preferentes.
    rescueExtremeSlots(result, allSessions, occupied, teacherSessMap, subjectSessions,
      startTimes, finMin, duracion, partialMins, avoidDays,
      preOccTeachers, preOccClassrooms, teacherAvail, validAulasBySubject);
    return { result, perfect: true };
  }

  // Fallback: greedy rápido — siempre devuelve algo (el greedy ya incluye su propio rescate)
  return { result: solveGreedy(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays, preOccTeachers, preOccClassrooms), perfect: false };
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

    // Mapa de disponibilidad pre-fusionado: { [tid]: { [day]: [[startMin,endMin],…] } }
    // Fusiona franjas adyacentes (ej. 10-11 + 11-12 → 10-12) una sola vez aquí para que
    // isTeacherAvailable sea O(k) en vez de hacer sort+merge en cada llamada del CSP.
    const teacherAvailRaw = {};
    for (const r of availRows) {
      if (!teacherAvailRaw[r.teacher_id]) teacherAvailRaw[r.teacher_id] = {};
      const d = teacherAvailRaw[r.teacher_id];
      if (!d[r.day_of_week]) d[r.day_of_week] = [];
      d[r.day_of_week].push([timeToMin(r.slot_start), timeToMin(r.slot_end)]);
    }
    const teacherAvail = {};
    for (const [tid, byDay] of Object.entries(teacherAvailRaw)) {
      teacherAvail[+tid] = {};
      for (const [day, intervals] of Object.entries(byDay)) {
        intervals.sort((a, b) => a[0] - b[0]);
        const merged = [intervals[0].slice()];
        for (let i = 1; i < intervals.length; i++) {
          const last = merged[merged.length - 1];
          if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
          else merged.push(intervals[i].slice());
        }
        teacherAvail[tid][+day] = merged;  // +day converts string key → number to match dia param
      }
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
      const roomType    = subMeta.room_type || null;
      const isTransversal = (subMeta.name || "").trim().toLowerCase().startsWith("transversal");
      return {
        ...s,
        teacherIds:       isTransversal ? [] : (subjectTeachersMap[s.id] || []),
        sessionDurations: getSessionDurations(s.hours, duracion),
        name:             subMeta.name || `Asignatura ${s.id}`,
        degree,
        year,
        roomType,
        semester:    subMeta.semester ?? null,
        bilingual:   subMeta.bilingual   || 0,
        transversal: isTransversal,
        groupLetter: meta.group_letter || null,
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

    // Diversidad de días entre grupos de mañana: A-E (1º) o A-C (2º).
    // Grupo E incluido para que sus asignaturas bilingües eviten los días ya usados por A-D.
    const MORNING_GROUPS = meta.year === 1 ? ['A','B','C','D','E']
                         : meta.year === 2 ? ['A','B','C']
                         : [];
    const isMorningGroup = MORNING_GROUPS.includes(meta.group_letter);
    let avoidDays = {};
    if (isMorningGroup && meta.degree && meta.year != null && meta.semester != null) {
      const placeholders = MORNING_GROUPS.filter(g => g !== meta.group_letter).map(() => '?').join(',');
      // Solo el horario más reciente por grupo (simétrico con preOcc).
      // Usar todos los históricos infla el threshold y marca todos los días como "evitados".
      const prevSchedules = await dbAll(`
        SELECT MAX(id) AS id FROM schedules
        WHERE degree=? AND year=? AND semester=?
          AND group_letter IN (${placeholders})
        GROUP BY group_letter
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

    // Pre-ocupar slots ya asignados a otros grupos del mismo cuatrimestre.
    // Construido ANTES del MRV para que el conteo de slots refleje la ocupación real.
    const preOccTeachers   = new Set();
    const preOccClassrooms = new Set();
    if (meta.group_letter != null && meta.degree && meta.year != null && meta.semester != null) {
      const crossRows = await dbAll(`
        SELECT ss.teacher_id, ss.classroom_id, ss.day_of_week, ss.slot_start, ss.slot_end
        FROM schedule_sessions ss
        JOIN schedules sc ON sc.id = ss.schedule_id
        WHERE sc.degree   = ?
          AND sc.year     = ?
          AND sc.semester = ?
          AND sc.group_letter IS NOT NULL
          AND sc.group_letter != ?
          AND sc.id IN (
            SELECT MAX(sc2.id) FROM schedules sc2
            WHERE sc2.degree   = ?
              AND sc2.year     = ?
              AND sc2.semester = ?
              AND sc2.group_letter IS NOT NULL
              AND sc2.group_letter != ?
            GROUP BY sc2.group_letter
          )
      `, [meta.degree, meta.year, meta.semester, meta.group_letter,
          meta.degree, meta.year, meta.semester, meta.group_letter]);

      for (const r of crossRows) {
        const sMin = timeToMin(r.slot_start);
        const eMin = timeToMin(r.slot_end);
        if (r.teacher_id)   occupySegment(preOccTeachers,   `${r.teacher_id}-${r.day_of_week}`,   sMin, eMin);
        if (r.classroom_id) occupySegment(preOccClassrooms, `${r.classroom_id}-${r.day_of_week}`, sMin, eMin);
      }
    }

    // Calcular número de slots válidos por asignatura (heurística MRV).
    // Incluye preOcc para que asignaturas con profesor ya muy ocupado entre grupos
    // se consideren más restringidas y se prioricen antes que las demás.
    const validSlots = {};
    for (const s of subjects) {
      const checkDur = Math.max(...s.sessionDurations, duracion);
      let count = 0;
      for (const { dia, startMin } of startTimes) {
        if (startMin + checkDur > finMin) continue;
        const teacherOK = s.teacherIds.length === 0 || s.teacherIds.some(tid =>
          isTeacherAvailable(tid, dia, startMin, startMin + checkDur, teacherAvail) &&
          isSegmentFree([preOccTeachers], `${tid}-${dia}`, startMin, startMin + checkDur)
        );
        if (teacherOK) count++;
      }
      validSlots[s.id] = s.sessionDurations.length > 0 ? count / s.sessionDurations.length : count;
    }

    // Construir lista plana de sesiones: una entrada por sesión individual
    // Ordenar las asignaturas más restringidas primero (MRV), luego
    // intercalar las sesiones de distintas asignaturas en round-robin.
    const subjSorted = [...subjects].sort((a, b) => {
      if (validSlots[a.id] !== validSlots[b.id]) return validSlots[a.id] - validSlots[b.id];
      if (b.sessionDurations.length !== a.sessionDurations.length) return b.sessionDurations.length - a.sessionDurations.length;
      return b.students - a.students;
    });

    // Round-robin: primera sesión de cada asignatura (MRV order), luego segunda, etc.
    const eligibleSubjs = subjSorted.filter(s => s.sessionDurations.length > 0 && validAulasBySubject[s.id].length > 0);
    const maxRounds = Math.max(0, ...eligibleSubjs.map(s => s.sessionDurations.length));
    const allSessions = [];
    for (let round = 0; round < maxRounds; round++) {
      for (const s of eligibleSubjs) {
        if (s.sessionDurations[round] !== undefined) {
          allSessions.push({ subject: s, dur: s.sessionDurations[round] });
        }
      }
    }
    // Sesiones completas primero; fringe (1h) al final (stable dentro de cada round).
    allSessions.sort((a, b) => (a.dur < duracion ? 1 : 0) - (b.dur < duracion ? 1 : 0));

    // Asignaturas sin aula o sin sesiones (no entran en CSP)
    const noAsignadas = [];
    for (const s of subjects) {
      if (s.hours > 0 && (s.sessionDurations.length === 0 || validAulasBySubject[s.id].length === 0)) {
        noAsignadas.push(s.name);
      }
    }

    // Ejecutar CSP (con fallback greedy si no converge)
    const { result, perfect } = solveCSP(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays, preOccTeachers, preOccClassrooms);

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
          teacher_ids:  a.teacherId != null ? [a.teacherId] : [],
          teacher:      a.teacherId != null ? (teacherMeta[a.teacherId] || `Prof ${a.teacherId}`) : "",
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

// ── GET /api/v1/schedules/conflicts ──────────────
// Detecta solapamientos de profesor o aula entre grupos del mismo cuatrimestre.
router.get("/conflicts", requireAuth, async (req, res) => {
  try {
    const { degree, year, semester } = req.query;
    if (!degree || !year || !semester)
      return res.status(400).json({ error: "degree, year y semester son obligatorios" });

    const teacherConflicts = await dbAll(`
      SELECT t.name AS entity,
             a.day_of_week, a.slot_start, a.slot_end,
             sca.group_letter AS group_a, sa.name AS subject_a,
             scb.group_letter AS group_b, sb.name AS subject_b
      FROM   schedule_sessions a
      JOIN   schedule_sessions b
             ON  a.teacher_id   = b.teacher_id
             AND a.day_of_week  = b.day_of_week
             AND a.id < b.id
             AND a.slot_start   < b.slot_end
             AND a.slot_end     > b.slot_start
      JOIN   schedules sca ON sca.id = a.schedule_id
      JOIN   schedules scb ON scb.id = b.schedule_id
      JOIN   subjects  sa  ON  sa.id = a.subject_id
      JOIN   subjects  sb  ON  sb.id = b.subject_id
      JOIN   teachers  t   ON   t.id = a.teacher_id
      WHERE  sca.degree=? AND sca.year=? AND sca.semester=?
        AND  scb.degree=? AND scb.year=? AND scb.semester=?
        AND  a.teacher_id IS NOT NULL
    `, [degree, year, semester, degree, year, semester]);

    const classroomConflicts = await dbAll(`
      SELECT c.name AS entity,
             a.day_of_week, a.slot_start, a.slot_end,
             sca.group_letter AS group_a, sa.name AS subject_a,
             scb.group_letter AS group_b, sb.name AS subject_b
      FROM   schedule_sessions a
      JOIN   schedule_sessions b
             ON  a.classroom_id = b.classroom_id
             AND a.day_of_week  = b.day_of_week
             AND a.id < b.id
             AND a.slot_start   < b.slot_end
             AND a.slot_end     > b.slot_start
      JOIN   schedules sca ON sca.id = a.schedule_id
      JOIN   schedules scb ON scb.id = b.schedule_id
      JOIN   subjects  sa  ON  sa.id = a.subject_id
      JOIN   subjects  sb  ON  sb.id = b.subject_id
      JOIN   classrooms c  ON   c.id = a.classroom_id
      WHERE  sca.degree=? AND sca.year=? AND sca.semester=?
        AND  scb.degree=? AND scb.year=? AND scb.semester=?
    `, [degree, year, semester, degree, year, semester]);

    res.json({ teachers: teacherConflicts, classrooms: classroomConflicts });
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
