const express     = require("express");
const db          = require("../database/db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

// helpers para usar la BD con async/await
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

const {
  timeToMin, minToTime,
  getSessionDurations,
  isSegmentFree, occupySegment,
  isTeacherAvailable,
  LUNCH_START, LUNCH_END,
  generateStartTimes, shuffle,
  detectBreaks,
  solveCSP,
} = require('../lib/solver');


// Asigna sesiones de prácticas (subgrupos) de forma greedy después del CSP de teoría.
// Reglas: máx 2 labs por slot, intercala subgrupos de distintas asignaturas,
// prioriza mañana (rejilla 10:00 / 12:00) igual que el solver de teoría.
function solveLabSessions({ subjects, classroomRows, classroomType, classroomCapacity,
                             classroomMeta, preOccClassrooms, theoryDayBySubject,
                             effectiveDias, startMin0, finMin, theorySessions = [],
                             transversalDay = 4, classroomZone = {}, zonePrefMap = {},
                             subjectLabTeachersMap = {}, teacherMeta = {}, teacherAvail = {},
                             preOccTeachers = new Set() }) {
  const LAB_DUR = 120;
  const labSessions = [];
  const noAsig = [];
  const roomOcc = new Set();

  // Ocupación de teoría → bloquea labs en esos huecos
  const theoryTimeOcc = new Set();
  for (const ts of theorySessions) {
    const s = timeToMin(ts.start), e = timeToMin(ts.end);
    for (let m = s; m < e; m += 5) theoryTimeOcc.add(`${ts.day}-${m}`);
  }

  const ANCHORS = [10 * 60, 15 * 60];
  const candidateSlots = [];
  // Fase 1: franja 10:00-14:00 — primera opción para grupos de mañana
  for (let m = ANCHORS[0]; m + LAB_DUR <= LUNCH_START; m += LAB_DUR) {
    if (m < startMin0) continue; // grupos de tarde (F): omitir mañana
    for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
  }
  // Fase 2: franja 8:00-10:00 — fallback si la mañana está saturada
  for (let m = startMin0; m + LAB_DUR <= ANCHORS[0]; m += LAB_DUR) {
    for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
  }
  // Fase 3: tarde 15:00-21:00 — prioridad para grupos de tarde, último recurso para grupos de mañana
  for (let m = Math.max(ANCHORS[1], startMin0); m + LAB_DUR <= finMin; m += LAB_DUR) {
    if (m >= LUNCH_START && m < LUNCH_END) continue;
    for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
  }

  // Preparar metadatos por asignatura lab
  const labSubjects = [];
  for (const subj of subjects) {
    if (!subj.labHours || subj.transversal) continue;
    const labType = subj.roomType || 'laboratorio';
    const eligible = classroomRows.filter(r => (classroomType[r.id] || 'teoria') === labType);
    if (!eligible.length) { noAsig.push(`${subj.name} (sin aulas ${labType})`); continue; }
    const prefZone = zonePrefMap[`${subj.degree}|${subj.year}`] || null;
    const eligibleSorted = [
      ...shuffle(eligible.filter(r => prefZone && classroomZone[r.id] === prefZone)),
      ...shuffle(eligible.filter(r => !prefZone || classroomZone[r.id] !== prefZone)),
    ];
    const maxCap = Math.max(...eligible.map(r => classroomCapacity[r.id]));
    // Year 3+ → always 1 subgroup (branch-specific small groups, no subdivision needed)
    const N = (subj.year >= 3) ? 1 : Math.max(1, Math.ceil((subj.students || 1) / maxCap));
    const subgroupSize = Math.ceil((subj.students || 1) / N);
    labSubjects.push({ subj, labType, eligible: eligibleSorted, N, subgroupSize });
  }

  // Orden de tareas: k=1 de todas las asignaturas primero, luego k=2, luego k=3, ...
  // Así los subgrupos "primeros" (A1) llenan los slots prioritarios (10-14) antes que A2 o A3.
  const maxN = labSubjects.length ? Math.max(...labSubjects.map(s => s.N)) : 0;
  const tasks = [];
  for (let k = 1; k <= maxN; k++) {
    for (const ls of labSubjects) {
      if (k > ls.N) continue;
      tasks.push({ ...ls, k });
    }
  }

  // Máx 2 labs por slot (de cualquier asignatura)
  const slotLabCount = new Map();
  // Por subgrupo k: slots ya ocupados → evita que sg1 de dos asignaturas coincidan en el mismo horario
  const subgroupSlotOcc = new Map();
  // Por asignatura: slots ya ocupados → evita que dos subgrupos de la misma asignatura coincidan
  const subjectSlotOcc = new Map();

  for (const { subj, labType, eligible, subgroupSize, k } of tasks) {
    const theoryDay = theoryDayBySubject[subj.id] ?? null;
    let assigned = false;

    if (!subgroupSlotOcc.has(k)) subgroupSlotOcc.set(k, new Set());
    const sgOcc = subgroupSlotOcc.get(k);
    if (!subjectSlotOcc.has(subj.id)) subjectSlotOcc.set(subj.id, new Set());
    const subjOcc = subjectSlotOcc.get(subj.id);

    for (const slot of candidateSlots) {
      if (transversalDay >= 0 && slot.dia === transversalDay) continue; // día transversal reservado
      if (slot.dia === theoryDay) continue;
      if (!isSegmentFree([theoryTimeOcc], `${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR)) continue;
      const slotKey = `${slot.dia}-${slot.startMin}`;
      if ((slotLabCount.get(slotKey) || 0) >= 2) continue; // máx 2 simultáneos
      if (sgOcc.has(slotKey)) continue; // este subgrupo k ya tiene lab en este horario
      if (subjOcc.has(slotKey)) continue; // otro subgrupo de esta misma asignatura ya está aquí

      const freeRoom = eligible.find(r => {
        if (classroomCapacity[r.id] < subgroupSize) return false;
        const rKey = `${r.id}-${slot.dia}`;
        return isSegmentFree([preOccClassrooms, roomOcc], rKey, slot.startMin, slot.startMin + LAB_DUR);
      });

      if (freeRoom) {
        occupySegment(roomOcc, `${freeRoom.id}-${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR);
        slotLabCount.set(slotKey, (slotLabCount.get(slotKey) || 0) + 1);
        sgOcc.add(slotKey);
        subjOcc.add(slotKey);

        // Asignar profesor de lab disponible para este subgrupo
        const labTeachers = subjectLabTeachersMap[subj.id] || [];
        let labTeacherId = null;
        for (const tid of labTeachers) {
          const avail = teacherAvail[tid];
          if (avail) {
            const dayAvail = avail[slot.dia] || [];
            const free = dayAvail.some(([s, e]) => s <= slot.startMin && e >= slot.startMin + LAB_DUR);
            if (!free) continue;
          }
          const tKey = `${tid}-${slot.dia}`;
          if (!isSegmentFree([preOccTeachers], tKey, slot.startMin, slot.startMin + LAB_DUR)) continue;
          labTeacherId = tid;
          break;
        }
        if (labTeacherId) occupySegment(preOccTeachers, `${labTeacherId}-${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR);

        labSessions.push({
          subject_id:   subj.id,
          subject:      subj.name,
          degree:       subj.degree,
          classroom_id: freeRoom.id,
          classroom:    classroomMeta[freeRoom.id] || `Lab ${freeRoom.id}`,
          teacher_ids:  labTeacherId ? [labTeacherId] : [],
          teacher:      labTeacherId ? (teacherMeta[labTeacherId] || "") : "",
          day:          slot.dia,
          start:        minToTime(slot.startMin),
          end:          minToTime(slot.startMin + LAB_DUR),
          subgroup:     k,
        });
        assigned = true;
        break;
      }
    }
    if (!assigned) noAsig.push(`${subj.name} (práct. sg${k})`);
  }

  return { labSessions, noAsig };
}

// genera el horario para un grupo/cuatrimestre y lo guarda en BD
router.post("/generate", requireAuth, async (req, res) => {
  try {
    const { aulas, asignaturas, franjas, meta = {}, transversalDay = -1 } = req.body;
    const { dias, horaInicio, horaFin, duracion } = franjas;
    const finMin = timeToMin(horaFin);

    const [availRows, stRows, subjectRows, teacherRows, classroomRows, zonePrefRows] = await Promise.all([
      dbAll("SELECT * FROM teacher_availability WHERE available=1"),
      dbAll("SELECT * FROM subject_teachers"),
      dbAll("SELECT id, name, degree, year, semester, room_type, bilingual, session_type, theory_hours, lab_hours FROM subjects"),
      dbAll("SELECT id, name, session_type FROM teachers"),
      dbAll("SELECT id, name, type, capacity, zone FROM classrooms"),
      dbAll("SELECT degree, year, zone FROM zone_preferences"),
    ]);

    // disponibilidad de cada profesor: fusionar intervalos adyacentes una sola vez aquí
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
        teacherAvail[tid][+day] = merged; // +day: string key → number
      }
    }
    const subjectMeta        = Object.fromEntries(subjectRows.map(r => [r.id, r]));
    const teacherMeta        = Object.fromEntries(teacherRows.map(r => [r.id, r.name]));
    const teacherSessionType = Object.fromEntries(teacherRows.map(r => [r.id, r.session_type || 'ambos']));
    const subjectTeachersMap    = {}; // para teoría: solo profes de tipo 'teoria' o 'ambos'
    const subjectLabTeachersMap = {}; // para labs: solo profes de tipo 'laboratorio' o 'ambos'
    for (const r of stRows) {
      const st = teacherSessionType[r.teacher_id] || 'ambos';
      if (st === 'teoria' || st === 'ambos')
        (subjectTeachersMap[r.subject_id] = subjectTeachersMap[r.subject_id] || []).push(r.teacher_id);
      if (st === 'laboratorio' || st === 'ambos')
        (subjectLabTeachersMap[r.subject_id] = subjectLabTeachersMap[r.subject_id] || []).push(r.teacher_id);
    }
    const classroomMeta      = Object.fromEntries(classroomRows.map(r => [r.id, r.name]));
    const classroomType      = Object.fromEntries(classroomRows.map(r => [r.id, r.type]));
    const classroomCapacity  = Object.fromEntries(classroomRows.map(r => [r.id, r.capacity]));
    const classroomZone      = Object.fromEntries(classroomRows.map(r => [r.id, r.zone || null]));
    const zonePrefMap        = Object.fromEntries(zonePrefRows.map(r => [`${r.degree}|${r.year}`, r.zone || null]));

    // effectiveDias: excluye el día transversal si hay asignaturas transversales y hay día reservado
    const hasTransversal = asignaturas.some(a =>
      (subjectMeta[a.id]?.name || '').trim().toLowerCase().startsWith('transversal')
    );
    const effectiveDias = (hasTransversal && transversalDay >= 0)
      ? dias.filter(d => d !== transversalDay)
      : dias;

    // rejilla de slots anclada en 10:00 y 15:00 con paso = duracion
    const ANCHORS   = [10 * 60, 15 * 60];
    const startMin0 = timeToMin(horaInicio);
    const endMin0   = timeToMin(horaFin);

    const mainSlots = [];
    for (const anchor of ANCHORS) {
      for (let m = anchor; m + duracion <= endMin0; m += duracion) {
        if (m < LUNCH_END && m + duracion > LUNCH_START) break; // solaparía la comida
        if (m < startMin0) continue;
        for (const d of effectiveDias) mainSlots.push({ dia: d, startMin: m, isLate: m >= 19 * 60 });
      }
    }

    // slots de 1h para sesiones fringe (antes del primer slot principal y al final de la tarde)
    const firstMain        = mainSlots.reduce((acc, t) => Math.min(acc, t.startMin), Infinity);
    const morningFringeMin = isFinite(firstMain) ? firstMain - 60 : startMin0;
    const morningFringeOK  = morningFringeMin >= startMin0 &&
                              !(morningFringeMin < LUNCH_END && morningFringeMin + 60 > LUNCH_START);

    // fringe de tarde: solo a partir de LUNCH_END para no crear slots fantasma por la mañana
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

    // slot extremo de mañana (ej. 08:00-10:00), último recurso cuando todo lo demás está lleno
    const morningDisplayMin = isFinite(firstMain)
      ? Math.max(startMin0, firstMain - duracion)
      : startMin0;
    const extremeMorningOK  = morningFringeOK &&
                               morningDisplayMin < morningFringeMin &&
                               morningDisplayMin + duracion <= endMin0;
    const extremeSlots = extremeMorningOK
      ? effectiveDias.map(d => ({ dia: d, startMin: morningDisplayMin, isExtreme: true }))
      : [];

    // orden de prioridad: mañana → tarde → extremo → fringe
    const morningMain   = shuffle(mainSlots.filter(t => t.startMin < LUNCH_START));
    const afternoonMain = shuffle(mainSlots.filter(t => t.startMin >= LUNCH_END));
    const startTimes    = [...morningMain, ...afternoonMain, ...shuffle(extremeSlots), ...partialSlots];

    // enriquecer asignaturas con metadatos de BD
    let subjects = asignaturas.map(s => {
      const subMeta       = subjectMeta[s.id] || {};
      const degree        = subMeta.degree || "";
      const year          = subMeta.year   ?? null;
      const roomType      = subMeta.room_type || null;
      const isTransversal = (subMeta.name || "").trim().toLowerCase().startsWith("transversal");
      const theoryHours   = subMeta.theory_hours ?? Math.max(2, (s.hours || 4) - 2);
      const labHours      = subMeta.lab_hours    ?? (isTransversal ? 0 : 2);
      return {
        ...s,
        teacherIds:       isTransversal ? [] : (subjectTeachersMap[s.id] || []),
        sessionDurations: getSessionDurations(theoryHours || 2, duracion),
        name:             subMeta.name || `Asignatura ${s.id}`,
        degree,
        year,
        roomType,
        labHours,
        semester:     subMeta.semester    ?? null,
        bilingual:    subMeta.bilingual   || 0,
        session_type: subMeta.session_type || 'teoria',
        transversal:  isTransversal,
        groupLetter:  meta.group_letter || null,
        groupKey: degree && year != null ? `${degree}|${year}` : null,
      };
    });

    if (meta.group_letter === 'E') {
      subjects = subjects.filter(s => s.bilingual);
    }

    // Teoría siempre en aulas de tipo 'teoria' con aforo >= alumnos; zona preferida primero
    const validAulasBySubject = {};
    for (const s of subjects) {
      const prefZone = zonePrefMap[`${s.degree}|${s.year}`] || null;
      const filtered = aulas.filter(a =>
        a.capacity >= s.students &&
        (classroomType[a.id] || "teoria") === "teoria"
      );
      const preferred = shuffle(filtered.filter(a => prefZone && classroomZone[a.id] === prefZone));
      const others    = shuffle(filtered.filter(a => !prefZone || classroomZone[a.id] !== prefZone));
      validAulasBySubject[s.id] = [...preferred, ...others];
    }

    // días a evitar por asignatura según los horarios ya generados de otros grupos
    const MORNING_GROUPS = meta.year === 1 ? ['A','B','C','D','E']
                         : meta.year === 2 ? ['A','B','C']
                         : [];
    const isMorningGroup = MORNING_GROUPS.includes(meta.group_letter);
    let avoidDays = {};
    if (isMorningGroup && meta.degree && meta.year != null && meta.semester != null) {
      const placeholders = MORNING_GROUPS.filter(g => g !== meta.group_letter).map(() => '?').join(',');
      // solo el horario más reciente por grupo para no acumular históricos
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

    // marcar como ocupados los slots ya usados por otros grupos (mismo profe/aula)
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

    // MRV: contar slots por asignatura (restricción de aula, no de profesor — profesor es soft)
    const validSlots = {};
    for (const s of subjects) {
      const checkDur = Math.max(...s.sessionDurations, duracion);
      const count = startTimes.filter(({ startMin }) => startMin + checkDur <= finMin).length;
      validSlots[s.id] = s.sessionDurations.length > 0 ? count / s.sessionDurations.length : count;
    }

    const subjSorted = [...subjects].sort((a, b) => {
      // sin reserva: transversal primero para que no quede al final con slots agotados
      if (transversalDay < 0) {
        if (a.transversal && !b.transversal) return -1;
        if (!a.transversal && b.transversal) return 1;
      }
      if (validSlots[a.id] !== validSlots[b.id]) return validSlots[a.id] - validSlots[b.id];
      if (b.sessionDurations.length !== a.sessionDurations.length) return b.sessionDurations.length - a.sessionDurations.length;
      return b.students - a.students;
    });

    // interleave de sesiones en round-robin para no poner dos del mismo en el mismo día
    // Sin día reservado (transversalDay < 0): las transversales entran al CSP como teoría normal
    const eligibleSubjs = subjSorted.filter(s =>
      (transversalDay >= 0 ? !s.transversal : true) &&
      s.sessionDurations.length > 0 &&
      validAulasBySubject[s.id].length > 0
    );
    const maxRounds = Math.max(0, ...eligibleSubjs.map(s => s.sessionDurations.length));
    const allSessions = [];
    for (let round = 0; round < maxRounds; round++) {
      for (const s of eligibleSubjs) {
        if (s.sessionDurations[round] !== undefined) {
          allSessions.push({ subject: s, dur: s.sessionDurations[round] });
        }
      }
    }
    allSessions.sort((a, b) => (a.dur < duracion ? 1 : 0) - (b.dur < duracion ? 1 : 0));

    const noAsignadas = [];
    for (const s of subjects) {
      if (s.hours > 0 && (s.sessionDurations.length === 0 || validAulasBySubject[s.id].length === 0)) {
        noAsignadas.push(s.name);
      }
    }

    // bases no barajadas para poder volver a barajar en cada iteración
    const morningMainBase   = mainSlots.filter(t => t.startMin < LUNCH_START);
    const afternoonMainBase = mainSlots.filter(t => t.startMin >= LUNCH_END);
    const validAulasBase    = {};
    for (const s of subjects) {
      validAulasBase[s.id] = aulas.filter(a =>
        a.capacity >= s.students &&
        (classroomType[a.id] || "teoria") === "teoria"
      );
    }

    const scoreResult = (res) => {
      let fit = 0, n = 0;
      for (let i = 0; i < res.length; i++) {
        const a = res[i]; if (!a) continue;
        n++;
        fit += Math.min((allSessions[i].subject.students || 1) / (classroomCapacity[a.aulaId] || 1), 1);
      }
      return n * 1000 + (n > 0 ? fit / n : 0); // primero maximizar asignadas, luego ajuste de aforo
    };

    const MAX_ITER = 5;
    let bestResult = null, bestPerfect = false, bestScore = -1;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const stIter = [
        ...shuffle([...morningMainBase]),
        ...shuffle([...afternoonMainBase]),
        ...shuffle([...extremeSlots]),
        ...partialSlots,
      ];
      const validIter = Object.fromEntries(
        subjects.map(s => {
          const prefZone = zonePrefMap[`${s.degree}|${s.year}`] || null;
          const base = validAulasBase[s.id] || [];
          const pref   = shuffle(base.filter(a => prefZone && classroomZone[a.id] === prefZone));
          const others = shuffle(base.filter(a => !prefZone || classroomZone[a.id] !== prefZone));
          return [s.id, [...pref, ...others]];
        })
      );
      const { result: r, perfect: p } = solveCSP(allSessions, validIter, stIter, finMin, teacherAvail, duracion, partialMins, avoidDays, preOccTeachers, preOccClassrooms);
      const sc = scoreResult(r);
      if (sc > bestScore) { bestScore = sc; bestResult = r; bestPerfect = p; }
      if (p) break; // resultado perfecto: no seguir iterando
    }

    const result = bestResult;
    const perfect = bestPerfect;

    // recopilar sesiones de teoría asignadas
    const sesiones = [];
    const assignedCount = {};
    const theoryDayBySubject = {};

    for (let i = 0; i < allSessions.length; i++) {
      const sess    = allSessions[i];
      const subject = sess.subject;
      const sid     = subject.id;
      const a       = result[i];

      if (a) {
        assignedCount[sid] = (assignedCount[sid] || 0) + 1;
        theoryDayBySubject[sid] = a.dia;
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
          subgroup:     null,
        });
      }
    }

    // Sesiones transversales: solo si hay día reservado (transversalDay >= 0)
    // Sin día reservado, ya fueron al CSP como teoría normal
    const transversalSubjs = transversalDay >= 0 ? subjects.filter(s => s.transversal) : [];
    for (const tSubj of transversalSubjs) {
      const transvSlots = [];
      for (const anchor of ANCHORS) {
        for (let m = anchor; m + duracion <= finMin; m += duracion) {
          if (m < LUNCH_END && m + duracion > LUNCH_START) break; // same break as mainSlots
          if (m < startMin0) continue;
          if (m >= LUNCH_START && m < LUNCH_END) continue;
          transvSlots.push(m);
        }
      }
      for (const dur of tSubj.sessionDurations) {
        let placed = false;
        for (const m of transvSlots) {
          const freeAula = validAulasBySubject[tSubj.id].find(a => {
            const rKey = `${a.id}-${transversalDay}`;
            return isSegmentFree([preOccClassrooms], rKey, m, m + dur);
          });
          if (freeAula) {
            occupySegment(preOccClassrooms, `${freeAula.id}-${transversalDay}`, m, m + dur);
            transvSlots.splice(transvSlots.indexOf(m), 1);
            sesiones.push({
              subject_id:   tSubj.id,
              subject:      tSubj.name,
              degree:       tSubj.degree,
              classroom_id: freeAula.id,
              classroom:    classroomMeta[freeAula.id] || `Aula ${freeAula.id}`,
              teacher_ids:  [],
              teacher:      "",
              day:          transversalDay,
              start:        minToTime(m),
              end:          minToTime(m + dur),
              subgroup:     null,
            });
            assignedCount[tSubj.id] = (assignedCount[tSubj.id] || 0) + 1;
            placed = true;
            break;
          }
        }
        if (!placed) noAsignadas.push(`${tSubj.name} (sin aula libre el día transversal)`);
      }
    }

    // sesiones de prácticas (subgrupos)
    const { labSessions, noAsig: noLab } = solveLabSessions({
      subjects, classroomRows, classroomType, classroomCapacity, classroomMeta,
      preOccClassrooms, theoryDayBySubject, effectiveDias,
      startMin0: timeToMin(horaInicio), finMin,
      theorySessions: sesiones, transversalDay,
      classroomZone, zonePrefMap,
      subjectLabTeachersMap, teacherMeta, teacherAvail, preOccTeachers,
    });
    noAsignadas.push(...noLab);

    // asignaturas de teoría con sesiones parciales o sin asignar
    for (const s of subjects) {
      if (s.sessionDurations.length === 0) continue;
      const got = assignedCount[s.id] || 0;
      if (got < s.sessionDurations.length && !noAsignadas.includes(s.name)) {
        noAsignadas.push(`${s.name} (${got}/${s.sessionDurations.length} sesiones)`);
      }
    }

    // guardar horario y sesiones en BD
    const userId    = req.session?.user?.id || null;
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
    const sched = await dbRun(
      "INSERT INTO schedules (name, created_by, status, degree, year, semester, group_letter) VALUES (?,?,?,?,?,?,?)",
      [nameLabel, userId, "active", metaDeg, metaYear, metaSem, metaGroup]
    );
    const scheduleId = sched.lastID;

    for (const s of sesiones) {
      const r = await dbRun(
        "INSERT INTO schedule_sessions (schedule_id, subject_id, teacher_id, classroom_id, day_of_week, slot_start, slot_end, subgroup) VALUES (?,?,?,?,?,?,?,?)",
        [scheduleId, s.subject_id, s.teacher_ids[0] || null, s.classroom_id, s.day, s.start, s.end, null]
      );
      s.session_id = r.lastID;
    }
    for (const s of labSessions) {
      const r = await dbRun(
        "INSERT INTO schedule_sessions (schedule_id, subject_id, teacher_id, classroom_id, day_of_week, slot_start, slot_end, subgroup) VALUES (?,?,?,?,?,?,?,?)",
        [scheduleId, s.subject_id, s.teacher_ids[0] || null, s.classroom_id, s.day, s.start, s.end, s.subgroup]
      );
      s.session_id = r.lastID;
    }
    sesiones.push(...labSessions);

    const breaks = detectBreaks(availRows, dias, horaInicio, horaFin);

    // calcular slotMins para el display de la tabla
    const uniqueMainMins = [...new Set(mainSlots.map(t => t.startMin))].sort((a, b) => a - b);
    const displayMinsSet = new Set(uniqueMainMins);
    if (morningFringeOK) displayMinsSet.add(Math.max(startMin0, firstMain - duracion));
    if (afternoonFringeOK) {
      // solo añadir fringeBMin como fila propia si no cae dentro de un slot principal
      const fringeWithinMain = mainSlots.some(t => t.startMin <= fringeBMin && t.startMin + duracion > fringeBMin);
      if (!fringeWithinMain) displayMinsSet.add(fringeBMin);
    }
    const slotMins = [...displayMinsSet].sort((a, b) => a - b);
    await dbRun("UPDATE schedules SET slot_mins=?, duracion=? WHERE id=?", [JSON.stringify(slotMins), duracion, scheduleId]);

    const totalNeeded = allSessions.length + transversalSubjs.reduce((acc, s) => acc + s.sessionDurations.length, 0);
    res.json({ schedule_id: scheduleId, sesiones, no_asignadas: noAsignadas, breaks, perfect, total_needed: totalNeeded, slotMins });

  } catch (err) {
    console.error("Error generando horario:", err);
    res.status(500).json({ error: err.message });
  }
});

// lista de horarios guardados, con filtros opcionales por titulación/año/cuatrimestre
router.get("/", async (req, res) => {
  try {
    const { degree, year, semester, group_letter } = req.query;
    const params = [];
    let where = "";
    if (degree)       { where += (where ? " AND" : " WHERE") + " s.degree=?";       params.push(degree); }
    if (year)         { where += (where ? " AND" : " WHERE") + " s.year=?";         params.push(parseInt(year)); }
    if (semester)     { where += (where ? " AND" : " WHERE") + " s.semester=?";     params.push(parseInt(semester)); }
    if (group_letter) { where += (where ? " AND" : " WHERE") + " s.group_letter=?"; params.push(group_letter); }

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

// detecta solapamientos de profesor o aula entre grupos del mismo cuatrimestre
router.get("/conflicts", requireAuth, async (req, res) => {
  try {
    const { degree, year, semester } = req.query;
    if (!degree || !year || !semester)
      return res.status(400).json({ error: "degree, year y semester son obligatorios" });

    const latestPerGroup = `
      SELECT MAX(id) FROM schedules
      WHERE degree=? AND year=? AND semester=?
      GROUP BY COALESCE(group_letter, 'NULL')
    `;

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
        AND  a.schedule_id IN (${latestPerGroup})
        AND  b.schedule_id IN (${latestPerGroup})
    `, [degree, year, semester, degree, year, semester,
        degree, year, semester, degree, year, semester]);

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
        AND  a.schedule_id IN (${latestPerGroup})
        AND  b.schedule_id IN (${latestPerGroup})
    `, [degree, year, semester, degree, year, semester,
        degree, year, semester, degree, year, semester]);

    res.json({ teachers: teacherConflicts, classrooms: classroomConflicts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// horario completo con todas sus sesiones
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sched = await dbAll("SELECT * FROM schedules WHERE id=?", [id]);
    if (!sched.length) return res.status(404).json({ error: "Horario no encontrado" });

    const sessions = await dbAll(`
      SELECT ss.id AS session_id, ss.day_of_week AS day, ss.slot_start AS start, ss.slot_end AS end,
             ss.subgroup,
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

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await dbRun("DELETE FROM schedules WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// comprueba posibles problemas antes de generar (profesores sin disponibilidad, aulas insuficientes…)
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

    const classroomsByType = {};
    for (const c of classrooms) {
      (classroomsByType[c.type] = classroomsByType[c.type] || []).push(c);
    }
    const teachersBySubject = {};
    for (const r of stRows) {
      (teachersBySubject[r.subject_id] = teachersBySubject[r.subject_id] || []).push(r.teacher_id);
    }
    const availByTeacher = {};
    for (const r of availRows) {
      (availByTeacher[r.teacher_id] = availByTeacher[r.teacher_id] || []).push(r);
    }

    for (const s of subjects) {
      if (!teachersBySubject[s.id]?.length) {
        warnings.push({ type: "no_teacher", msg: `"${s.name}" no tiene profesor asignado.` });
      }
      // Teoría necesita aula tipo 'teoria' con aforo suficiente
      const compatible = (classroomsByType["teoria"] || []).filter(c => c.capacity >= (s.students || 0));
      if (!compatible.length) {
        warnings.push({ type: "no_classroom", msg: `"${s.name}" necesita aula teoría ≥${s.students} plazas pero no hay ninguna disponible.` });
      }
    }

    for (const t of teachers) {
      if (!availByTeacher[t.id]?.length) {
        warnings.push({ type: "no_avail", msg: `"${t.name}" no tiene ningún horario de disponibilidad configurado.` });
        continue;
      }
      const mySubjects = subjects.filter(s => teachersBySubject[s.id]?.includes(t.id));
      const totalHoursNeeded = mySubjects.reduce((sum, s) => sum + (s.hours_week || 0), 0);
      const slotsAvail = availByTeacher[t.id].length;
      if (slotsAvail < totalHoursNeeded) {
        warnings.push({ type: "low_avail", msg: `"${t.name}" tiene ${slotsAvail} franjas disponibles pero sus asignaturas requieren ~${totalHoursNeeded} h/sem.` });
      }
    }

    res.json({ warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// guarda los cambios manuales del drag & drop
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
