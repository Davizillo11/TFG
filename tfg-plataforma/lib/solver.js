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

function getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays = new Set()) {
  const isPref   = ({ startMin }) => !partialMins.has(startMin);
  const avoided  = avoidDays[subject.id] || new Set();
  const av       = t => avoided.has(t.dia);
  const used     = t => placedDays.has(t.dia);
  const mainPref = startTimes.filter(isPref);
  const fringe   = startTimes.filter(t => !isPref(t));

  if (dur < duracion) {
    const late         = mainPref.filter(t => t.startMin >= LUNCH_END && !t.isExtreme);
    const fringeMorn   = fringe.filter(t => t.startMin <  LUNCH_START);
    const fringeAfter  = fringe.filter(t => t.startMin >= LUNCH_END);
    // Prefer same day as subject's existing sessions (9:00 stacks onto the main session's day)
    return [
      ...fringeMorn.filter(t =>  used(t) && !av(t)),
      ...fringeMorn.filter(t =>  used(t) &&  av(t)),
      ...fringeMorn.filter(t => !used(t) && !av(t)),
      ...fringeMorn.filter(t => !used(t) &&  av(t)),
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

  const pref     = mainPref.filter(t => isPreferredTime(t) && !t.isExtreme && !t.isLate);
  const extr     = mainPref.filter(t => t.isExtreme);
  const late     = mainPref.filter(t => !isPreferredTime(t) && !t.isExtreme && !t.isLate);
  const veryLate = mainPref.filter(t => t.isLate);
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

function rescueExtremeSlots(result, allSessions, occupied, teacherSessMap, subjectSessions,
    startTimes, finMin, duracion, partialMins, avoidDays,
    preOccTeachers, preOccClassrooms, teacherAvail, validAulasBySubject) {
  const PREF_MIN = 10 * 60;
  const PREF_MAX = 14 * 60;

  for (let idx = 0; idx < result.length; idx++) {
    const assignment = result[idx];
    // Skip fringe slots (e.g. 9:00) — only rescue truly extreme slots (< fringe, e.g. 8:00)
    if (!assignment || assignment.startMin >= PREF_MIN || partialMins.has(assignment.startMin)) continue;

    const { subject, dur } = allSessions[idx];
    const sid = subject.id;
    const { dia, startMin, endMin, aulaId, teacherId } = assignment;

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
      const newGk = subject.groupKey ? `${subject.groupKey}-${nd}` : null;
      if (newGk && !isSegmentFree([occupied.groups], newGk, ns, ne)) continue;

      for (const aula of validAulasBySubject[sid]) {
        const nak = `${aula.id}-${nd}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], nak, ns, ne)) continue;

        const newTid = pickTeacher(subject.teacherIds, nd, ns, ne, teacherAvail,
          occupied.teachers, preOccTeachers, teacherSessMap);
        if (subject.teacherIds.length > 0 && newTid === null) continue;

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

function solveGreedy(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays = {}, preOccTeachers = new Set(), preOccClassrooms = new Set()) {
  const occupied        = { aulas: new Set(), teachers: new Set(), groups: new Set() };
  const teacherSessMap  = new Map();
  const subjectSessions = {};
  const result          = new Array(allSessions.length).fill(null);

  for (let idx = 0; idx < allSessions.length; idx++) {
    const { subject, dur } = allSessions[idx];
    const sid        = subject.id;
    const validAulas = validAulasBySubject[sid];
    const placedDays   = new Set((subjectSessions[sid] || []).map(s => s.dia));
    const orderedSlots = getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays);

    outer: for (const { dia, startMin } of orderedSlots) {
      const endMin = startMin + dur;
      if (endMin > finMin) continue;

      const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
      if (gk && !isSegmentFree([occupied.groups], gk, startMin, endMin)) continue;

      for (const aula of validAulas) {
        const ak = `${aula.id}-${dia}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], ak, startMin, endMin)) continue;

        const selectedTid = pickTeacher(subject.teacherIds, dia, startMin, endMin, teacherAvail,
          occupied.teachers, preOccTeachers, teacherSessMap);
        if (subject.teacherIds.length > 0 && selectedTid === null) continue;

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

  rescueExtremeSlots(result, allSessions, occupied, teacherSessMap, subjectSessions,
    startTimes, finMin, duracion, partialMins, avoidDays,
    preOccTeachers, preOccClassrooms, teacherAvail, validAulasBySubject);

  return result;
}

const MAX_OPS = 150_000;

function solveCSP(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays = {}, preOccTeachers = new Set(), preOccClassrooms = new Set()) {
  const n = allSessions.length;
  const occupied        = { aulas: new Set(), teachers: new Set(), groups: new Set() };
  const teacherSessMap  = new Map();
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
    const placedDays   = new Set((subjectSessions[sid] || []).map(s => s.dia));
    const orderedSlots = getOrderedSlots(startTimes, subject, dur, duracion, partialMins, avoidDays, placedDays);

    for (const { dia, startMin } of orderedSlots) {
      if (timedOut) return false;
      const endMin = startMin + dur;
      if (endMin > finMin) continue;

      const gk = subject.groupKey ? `${subject.groupKey}-${dia}` : null;
      if (gk && !isSegmentFree([occupied.groups], gk, startMin, endMin)) continue;

      for (const aula of validAulas) {
        const ak = `${aula.id}-${dia}`;
        if (!isSegmentFree([occupied.aulas, preOccClassrooms], ak, startMin, endMin)) continue;

        // Candidatos preferentes (respetan disponibilidad) primero; resto como fallback blando
        const preferred = subject.teacherIds.filter(tid =>
          isTeacherAvailable(tid, dia, startMin, endMin, teacherAvail) &&
          isSegmentFree([occupied.teachers, preOccTeachers], `${tid}-${dia}`, startMin, endMin) &&
          countConsecBefore(tid, dia, startMin, teacherSessMap) < MAX_CONSECUTIVE
        );
        const fallback = subject.teacherIds.filter(tid =>
          !preferred.includes(tid) &&
          isSegmentFree([occupied.teachers, preOccTeachers], `${tid}-${dia}`, startMin, endMin) &&
          countConsecBefore(tid, dia, startMin, teacherSessMap) < MAX_CONSECUTIVE
        );
        const teacherCandidates = subject.teacherIds.length === 0
          ? [null]
          : [...preferred, ...fallback];

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
    rescueExtremeSlots(result, allSessions, occupied, teacherSessMap, subjectSessions,
      startTimes, finMin, duracion, partialMins, avoidDays,
      preOccTeachers, preOccClassrooms, teacherAvail, validAulasBySubject);
    return { result, perfect: true };
  }

  return { result: solveGreedy(allSessions, validAulasBySubject, startTimes, finMin, teacherAvail, duracion, partialMins, avoidDays, preOccTeachers, preOccClassrooms), perfect: false };
}

module.exports = {
  timeToMin, minToTime,
  getSessionDurations,
  SLOT_STEP, isSegmentFree, occupySegment, freeSegment,
  isTeacherAvailable,
  LUNCH_START, LUNCH_END, PREF_RANGES,
  generateStartTimes, shuffle,
  detectBreaks,
  MAX_CONSECUTIVE, countConsecBefore,
  isPreferredTime, getOrderedSlots,
  rescueExtremeSlots,
  solveGreedy,
  MAX_OPS, solveCSP,
};
