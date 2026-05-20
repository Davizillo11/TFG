'use strict';

function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

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

// No entry in teacherAvail → no restrictions (always available).
// Entry present but day absent → unavailable that day.
function isTeacherAvailable(teacherId, dia, startMin, endMin, teacherAvail) {
  const dayMap = teacherAvail[teacherId];
  if (!dayMap) return true;
  const intervals = dayMap[dia];
  if (!intervals || !intervals.length) return false;
  return intervals.some(([s, e]) => s <= startMin && e >= endMin);
}

const LUNCH_START = 14 * 60;
const LUNCH_END   = 15 * 60;
const PREF_RANGES = [[10 * 60, 14 * 60]];

function generateStartTimes(dias, horaInicio, horaFin, step = SLOT_STEP) {
  const times  = [];
  const finMin = timeToMin(horaFin);
  let m = timeToMin(horaInicio);
  while (m + step <= finMin) {
    if (!(m < LUNCH_END && m + step > LUNCH_START)) {
      for (const dia of dias) times.push({ dia, startMin: m });
    }
    m += step;
  }
  return times;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

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

const MAX_CONSECUTIVE = 3;

function countConsecBefore(tid, dia, startMin, teacherSessMap) {
  const sessions = teacherSessMap.get(`${tid}-${dia}`);
  if (!sessions || !sessions.length) return 0;
  let count = 0;
  let cur = startMin;
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i][1] === cur) { count++; cur = sessions[i][0]; }
    else break;
  }
  return count;
}

const isPreferredTime = (t) => PREF_RANGES.some(([s, e]) => t.startMin >= s && t.startMin < e);

function getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays = new Set(), placedByDay = {}) {
  const isPref   = ({ startMin }) => !partialMins.has(startMin);
  const avoided  = avoidDays[subject.id] || new Set();
  const av       = t => avoided.has(t.dia);
  const used     = t => placedDays.has(t.dia);
  const mainPref = startTimes.filter(isPref);
  const fringe   = startTimes.filter(t => !isPref(t));

  if (dur < duracion) {
    const late         = mainPref.filter(t => t.startMin >= LUNCH_END && !t.isExtreme);
    const fringeMorn   = fringe.filter(t => t.startMin <  LUNCH_END);   // incluye 14:00 para grupos de tarde
    const fringeAfter  = fringe.filter(t => t.startMin >= LUNCH_END);
    // Días donde la sesión larga ya está en el slot adyacente (9:00+dur = 10:00 cuando dur=60)
    const fringeMornStarts = [...new Set(fringeMorn.map(t => t.startMin))];
    const adjStarts = new Set(fringeMornStarts.map(s => s + dur));
    const adjDays   = new Set(fringeMorn
      .filter(t => (placedByDay[t.dia] || []).some(s => adjStarts.has(s)))
      .map(t => t.dia));
    return [
      ...fringeMorn.filter(t => adjDays.has(t.dia) && !av(t)),             // adyacente, no evitado
      ...fringeMorn.filter(t => adjDays.has(t.dia) &&  av(t)),             // adyacente, evitado
      ...fringeMorn.filter(t => !used(t) && !av(t)),                       // día nuevo, no evitado
      ...fringeMorn.filter(t => !used(t) &&  av(t)),                       // día nuevo, evitado
      ...fringeMorn.filter(t => used(t) && !adjDays.has(t.dia) && !av(t)), // hueco, no evitado
      ...fringeMorn.filter(t => used(t) && !adjDays.has(t.dia) &&  av(t)), // hueco, evitado
      ...late.filter(t => !av(t) && !used(t)), ...late.filter(t => !av(t) && used(t)),
      ...late.filter(t =>  av(t) && !used(t)), ...late.filter(t =>  av(t) && used(t)),
      ...fringeAfter,
    ];
  }

  // Transversal subjects are restricted to Friday (day 4) for year 1 / semester 1.
  if (subject.transversal) {
    return [...mainPref].sort((a, b) => {
      if (!!a.isExtreme !== !!b.isExtreme) return a.isExtreme ? 1 : -1;
      return a.startMin !== b.startMin ? a.startMin - b.startMin : a.dia - b.dia;
    });
  }

  // Solo ordenar pref/late (10:00 antes 12:00, 15:00 antes 17:00) cuando la asignatura tiene horas mixtas
  // (ej. 3h → [120,60]) — así la sesión larga cae en el anchor y la corta puede ir al fringe adyacente.
  // Para asignaturas con duraciones uniformes, mantener el orden aleatorio de startTimes.
  const hasMixed     = subject.sessionDurations && subject.sessionDurations.some(d => d < duracion);
  const needsAdjSort = hasMixed && dur >= duracion;

  const pref = mainPref.filter(t => isPreferredTime(t) && !t.isExtreme && !t.isLate);
  if (needsAdjSort) pref.sort((a, b) => a.startMin - b.startMin);
  const extr     = mainPref.filter(t => t.isExtreme);
  const late     = mainPref.filter(t => !isPreferredTime(t) && !t.isExtreme && !t.isLate);
  if (needsAdjSort) late.sort((a, b) => a.startMin - b.startMin);
  const veryLate = mainPref.filter(t => t.isLate);
  // Morning groups: pref (10-14) → extreme (8:00) → late (15:00+, only if 8:00 also unavailable)
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
    ...veryLate.filter(t => !av(t) && !used(t)),
    ...veryLate.filter(t => !av(t) &&  used(t)),
    ...veryLate.filter(t =>  av(t) && !used(t)),
    ...veryLate.filter(t =>  av(t) &&  used(t)),
  ];
}

// Selecciona el mejor profesor disponible para un slot dado.
// Primero respeta la disponibilidad (restricción blanda), luego acepta cualquier
// profesor que no esté ya ocupado físicamente en ese slot.
function pickTeacher(teacherIds, dia, startMin, endMin, teacherAvail, occupiedTeachers, preOccTeachers, teacherSessMap) {
  if (teacherIds.length === 0) return null;

  // primera pasada: respetar disponibilidad
  for (const tid of teacherIds) {
    if (!isTeacherAvailable(tid, dia, startMin, endMin, teacherAvail)) continue;
    if (!isSegmentFree([occupiedTeachers, preOccTeachers], `${tid}-${dia}`, startMin, endMin)) continue;
    if (countConsecBefore(tid, dia, startMin, teacherSessMap) >= MAX_CONSECUTIVE) continue;
    return tid;
  }

  // segunda pasada (restricción blanda): cualquier profesor no ocupado físicamente
  for (const tid of teacherIds) {
    if (!isSegmentFree([occupiedTeachers, preOccTeachers], `${tid}-${dia}`, startMin, endMin)) continue;
    if (countConsecBefore(tid, dia, startMin, teacherSessMap) >= MAX_CONSECUTIVE) continue;
    return tid;
  }

  return null; // todos los profesores están físicamente ocupados
}

// ── Fase 1: asignar (aula, franja) sin restricciones de profesor ──

function rescueExtremeSlots(result, allSessions, occupied, subjectSessions,
    startTimes, finMin, duracion, partialMins, avoidDays,
    preOccClassrooms, validAulasBySubject, maxParallel = 2) {
  const PREF_MIN = 10 * 60;
  const PREF_MAX = 14 * 60;

  for (let idx = 0; idx < result.length; idx++) {
    const assignment = result[idx];
    if (!assignment || assignment.startMin >= PREF_MIN || partialMins.has(assignment.startMin)) continue;

    const { subject, dur } = allSessions[idx];
    const sid = subject.id;
    const { dia, startMin, endMin, aulaId } = assignment;

    const ak = `${aulaId}-${dia}`;
    freeSegment(occupied.aulas, ak, startMin, endMin);
    const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
    if (gk) freeSegment(occupied.groups, gk, startMin, endMin);
    const ssList = subjectSessions[sid];
    if (ssList) {
      const si = ssList.findIndex(p => p.dia === dia && p.startMin === startMin);
      if (si >= 0) ssList.splice(si, 1);
    }
    const origSlotKey = `${dia}-${startMin}`;
    occupied.slotCount.set(origSlotKey, Math.max(0, (occupied.slotCount.get(origSlotKey) || 1) - 1));

    const avoided = avoidDays[sid] || new Set();
    const currentPlaced = new Set((subjectSessions[sid] || []).map(s => s.dia));

    const fringeRescue = dur < duracion
      ? startTimes
          .filter(t => partialMins.has(t.startMin) && t.startMin + dur <= finMin)
          .sort((a, b) => {
            const aU = currentPlaced.has(a.dia) ? 0 : 1;
            const bU = currentPlaced.has(b.dia) ? 0 : 1;
            return aU - bU || a.dia - b.dia;
          })
      : [];

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
    outer: for (const { dia: nd, startMin: ns } of [...fringeRescue, ...prefSlots]) {
      const ne = ns + dur;
      const newGk = subject.groupKey ? `${subject.groupKey}-${nd}` : null;
      if (newGk && !isSegmentFree([occupied.groups], newGk, ns, ne)) continue;

      const newSlotKey = `${nd}-${ns}`;
      if ((occupied.slotCount.get(newSlotKey) || 0) >= maxParallel) continue;

      for (const aula of validAulasBySubject[sid]) {
        const nak = `${aula.id}-${nd}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], nak, ns, ne)) continue;

        occupySegment(occupied.aulas, nak, ns, ne);
        if (newGk) occupySegment(occupied.groups, newGk, ns, ne);
        occupied.slotCount.set(newSlotKey, (occupied.slotCount.get(newSlotKey) || 0) + 1);
        if (!subjectSessions[sid]) subjectSessions[sid] = [];
        subjectSessions[sid].push({ dia: nd, startMin: ns, endMin: ne });
        result[idx] = { aulaId: aula.id, dia: nd, startMin: ns, dur, endMin: ne, teacherId: null };
        relocated = true;
        break outer;
      }
    }

    if (!relocated) {
      occupySegment(occupied.aulas, ak, startMin, endMin);
      if (gk) occupySegment(occupied.groups, gk, startMin, endMin);
      occupied.slotCount.set(origSlotKey, (occupied.slotCount.get(origSlotKey) || 0) + 1);
      if (!subjectSessions[sid]) subjectSessions[sid] = [];
      subjectSessions[sid].push({ dia, startMin, endMin });
    }
  }
}

function solveGreedy(allSessions, validAulasBySubject, startTimes, finMin, duracion, partialMins, avoidDays = {}, preOccClassrooms = new Set(), maxParallel = 2) {
  const occupied        = { aulas: new Set(), groups: new Set(), slotCount: new Map() };
  const subjectSessions = {};
  const result          = new Array(allSessions.length).fill(null);

  for (let idx = 0; idx < allSessions.length; idx++) {
    const { subject, dur } = allSessions[idx];
    const sid        = subject.id;
    const validAulas = validAulasBySubject[sid];
    const subjectSess  = subjectSessions[sid] || [];
    const placedDays   = new Set(subjectSess.map(s => s.dia));
    const placedByDay  = {};
    for (const p of subjectSess) (placedByDay[p.dia] = placedByDay[p.dia] || []).push(p.startMin);
    const orderedSlots = getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays, placedByDay);

    outer: for (const { dia, startMin } of orderedSlots) {
      const endMin = startMin + dur;
      if (endMin > finMin) continue;

      const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
      if (gk && !isSegmentFree([occupied.groups], gk, startMin, endMin)) continue;

      const slotKey = `${dia}-${startMin}`;
      if ((occupied.slotCount.get(slotKey) || 0) >= maxParallel) continue;

      for (const aula of validAulas) {
        const ak = `${aula.id}-${dia}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], ak, startMin, endMin)) continue;

        occupySegment(occupied.aulas, ak, startMin, endMin);
        if (gk) occupySegment(occupied.groups, gk, startMin, endMin);
        occupied.slotCount.set(slotKey, (occupied.slotCount.get(slotKey) || 0) + 1);
        if (!subjectSessions[sid]) subjectSessions[sid] = [];
        subjectSessions[sid].push({ dia, startMin, endMin });
        result[idx] = { aulaId: aula.id, dia, startMin, dur, endMin, teacherId: null };
        break outer;
      }
    }
  }

  rescueExtremeSlots(result, allSessions, occupied, subjectSessions,
    startTimes, finMin, duracion, partialMins, avoidDays,
    preOccClassrooms, validAulasBySubject, maxParallel);

  return result;
}

const MAX_OPS = 150_000;

function solveCSP(allSessions, validAulasBySubject, startTimes, finMin, duracion, partialMins, avoidDays = {}, preOccClassrooms = new Set(), maxParallel = 2) {
  const n = allSessions.length;
  const occupied        = { aulas: new Set(), groups: new Set(), slotCount: new Map() };
  const subjectSessions = {};
  const result          = new Array(n).fill(null);
  let ops = 0;
  let timedOut = false;

  function bt(idx) {
    if (idx === n) return true;
    if (ops++ > MAX_OPS) { timedOut = true; return false; }

    const { subject, dur } = allSessions[idx];
    const sid = subject.id;
    const validAulas = validAulasBySubject[sid];
    const subjectSess  = subjectSessions[sid] || [];
    const placedDays   = new Set(subjectSess.map(s => s.dia));
    const placedByDay  = {};
    for (const p of subjectSess) (placedByDay[p.dia] = placedByDay[p.dia] || []).push(p.startMin);
    const orderedSlots = getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays, placedByDay);

    for (const { dia, startMin } of orderedSlots) {
      if (timedOut) return false;
      const endMin = startMin + dur;
      if (endMin > finMin) continue;

      const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
      if (gk && !isSegmentFree([occupied.groups], gk, startMin, endMin)) continue;

      const slotKey = `${dia}-${startMin}`;
      if ((occupied.slotCount.get(slotKey) || 0) >= maxParallel) continue;

      for (const aula of validAulas) {
        const ak = `${aula.id}-${dia}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], ak, startMin, endMin)) continue;

        occupySegment(occupied.aulas, ak, startMin, endMin);
        if (gk) occupySegment(occupied.groups, gk, startMin, endMin);
        if (!subjectSessions[sid]) subjectSessions[sid] = [];
        subjectSessions[sid].push({ dia, startMin, endMin });
        result[idx] = { aulaId: aula.id, dia, startMin, dur, endMin, teacherId: null };
        occupied.slotCount.set(slotKey, (occupied.slotCount.get(slotKey) || 0) + 1);

        if (bt(idx + 1)) return true;

        occupied.slotCount.set(slotKey, (occupied.slotCount.get(slotKey) || 0) - 1);
        freeSegment(occupied.aulas, ak, startMin, endMin);
        if (gk) freeSegment(occupied.groups, gk, startMin, endMin);
        const ssList = subjectSessions[sid];
        if (ssList) {
          const i = ssList.findIndex(p => p.dia === dia && p.startMin === startMin && p.endMin === endMin);
          if (i >= 0) ssList.splice(i, 1);
        }
        result[idx] = null;
        break; // una sola aula candidata por slot (sin iteración de profesores)
      }
    }

    return false;
  }

  const solved = bt(0);
  if (solved) {
    rescueExtremeSlots(result, allSessions, occupied, subjectSessions,
      startTimes, finMin, duracion, partialMins, avoidDays,
      preOccClassrooms, validAulasBySubject, maxParallel);
    return { result, perfect: true };
  }

  return { result: solveGreedy(allSessions, validAulasBySubject, startTimes, finMin, duracion, partialMins, avoidDays, preOccClassrooms, maxParallel), perfect: false };
}

// ── Fase 2: asignar profesores a sesiones ya colocadas ──
// sessions: array de { subject_id, day, start, end, subgroup, teacherCandidates }
// teacherCandidates: IDs de profesores candidatos para esa sesión
// Devuelve: sessions con teacher_id relleno + lista de las que no pudieron asignarse
function assignTeachers(sessions, teacherAvail, preOccTeachers) {
  const teacherOcc    = new Set();   // ocupación dentro de este horario
  const teacherSessMap = new Map();  // para consecutive check

  // MRV: asignar primero las sesiones con menos candidatos disponibles
  const idxs = sessions.map((_, i) => i);
  idxs.sort((a, b) => (sessions[a].teacherCandidates.length || 0) - (sessions[b].teacherCandidates.length || 0));

  const noTeacher = [];

  for (const i of idxs) {
    const sess = sessions[i];
    const sMin = timeToMin(sess.start);
    const eMin = timeToMin(sess.end);
    const candidates = sess.teacherCandidates || [];

    if (candidates.length === 0) continue; // asignatura sin profesores → OK

    const tid = pickTeacher(candidates, sess.day, sMin, eMin, teacherAvail,
      teacherOcc, preOccTeachers, teacherSessMap);

    if (tid !== null) {
      sess.teacher_id = tid;
      occupySegment(teacherOcc, `${tid}-${sess.day}`, sMin, eMin);
      const key = `${tid}-${sess.day}`;
      const list = teacherSessMap.get(key) || [];
      list.push([sMin, eMin]);
      list.sort((a, b) => a[0] - b[0]);
      teacherSessMap.set(key, list);
    } else {
      sess.teacher_id = null;
      noTeacher.push(sess);
    }
  }

  return { sessions, noTeacher };
}

module.exports = {
  timeToMin, minToTime,
  getSessionDurations,
  SLOT_STEP, isSegmentFree, occupySegment, freeSegment,
  isTeacherAvailable,
  LUNCH_START, LUNCH_END, PREF_RANGES,
  generateStartTimes, shuffle,
  detectBreaks,
  MAX_CONSECUTIVE, countConsecBefore, pickTeacher,
  isPreferredTime, getOrderedSlots,
  rescueExtremeSlots,
  solveGreedy,
  MAX_OPS, solveCSP,
  assignTeachers,
};
