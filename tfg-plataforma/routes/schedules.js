const express      = require("express");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();

// funciones auxiliares para usar la BD con async/await
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
  isSegmentFree, occupySegment, freeSegment,
  isTeacherAvailable,
  LUNCH_START, LUNCH_END,
  generateStartTimes, shuffle,
  detectBreaks,
  solveCSP,
  assignTeachers,
} = require('../lib/solver');


// Asigna sesiones de prácticas (subgrupos) de forma greedy después del CSP de teoría.
// Reglas: máx 2 labs por slot, intercala subgrupos de distintas asignaturas,
// prioriza mañana (rejilla 10:00 / 12:00) igual que el solver de teoría.
function solveLabSessions({ subjects, classroomRows, classroomType, classroomCapacity,
                             classroomMeta, preOccClassrooms, theoryDayBySubject,
                             effectiveDias, startMin0, finMin, theorySessions = [],
                             transversalDay = 4, classroomZone = {}, zonePrefMap = {},
                             maxParallel = 2, subjectBranchMap = {}, subjectLabTeachersMap = {} }) {
  const LAB_DUR = 120;
  const labSessions = [];
  const noAsig = [];
  const roomOcc = new Set();
  // branchOcc: slotKey -> Set<rama>, impide que dos labs de la misma rama coincidan
  const branchOcc = new Map();

  // Ocupación de teoría: bloquea labs en esos huecos
  // theoryTimeOcc: global (para maxParallel<=2 grupos compartidos)
  // subjectTheoryTimeOcc: per-asignatura (para maxParallel>2 ramas/especialización)
  const theoryTimeOcc = new Set();
  const subjectTheoryTimeOcc = new Map();
  for (const ts of theorySessions) {
    const s = timeToMin(ts.start), e = timeToMin(ts.end);
    for (let m = s; m < e; m += 5) {
      theoryTimeOcc.add(`${ts.day}-${m}`);
      if (!subjectTheoryTimeOcc.has(ts.subject_id))
        subjectTheoryTimeOcc.set(ts.subject_id, new Set());
      subjectTheoryTimeOcc.get(ts.subject_id).add(`${ts.day}-${m}`);
    }
  }

  const MORNING_START = 10 * 60;
  const AFT_START     = 15 * 60;
  const LATE_THRESH   = 19 * 60;
  const candidateSlots = [];
  const isMorning = startMin0 < AFT_START;

  if (isMorning) {
    // Si hay teoría de tarde, poner labs a las 12:00 primero para evitar hueco muerto (12-14 vacío)
    const hasAfternoonTheory = theorySessions.some(ts => timeToMin(ts.start) >= 15 * 60);
    if (hasAfternoonTheory) {
      for (let m = 12 * 60; m + LAB_DUR <= LUNCH_START; m += LAB_DUR)
        for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
      for (let m = MORNING_START; m + LAB_DUR <= 12 * 60; m += LAB_DUR)
        for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
    } else {
      for (let m = MORNING_START; m + LAB_DUR <= LUNCH_START; m += LAB_DUR)
        for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
    }
    for (let m = startMin0; m + LAB_DUR <= MORNING_START; m += LAB_DUR)
      for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
    for (let m = AFT_START; m + LAB_DUR <= finMin; m += LAB_DUR) {
      if (m >= LUNCH_START && m < LUNCH_END) continue;
      for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
    }
  } else {
    // Grupos de tarde: solo tarde, nunca mañana para labs de grupo de tarde
    for (let m = AFT_START; m + LAB_DUR <= LATE_THRESH; m += LAB_DUR)
      for (const d of effectiveDias) candidateSlots.push({ dia: d, startMin: m });
    for (let m = LATE_THRESH; m + LAB_DUR <= finMin; m += LAB_DUR)
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
    const caps = [...new Set(eligible.map(r => classroomCapacity[r.id]))].sort((a, b) => b - a);
    const maxCap = caps[0];
    const N = Math.max(1, Math.ceil((subj.students || 1) / maxCap));
    const subgroupSize = Math.ceil((subj.students || 1) / N);
    // Tier extra: si existen aulas más pequeñas, permitir un subgrupo adicional con ellas
    let N_extra = N, subgroupSizeExtra = subgroupSize, eligibleExtra = eligibleSorted;
    for (let ci = 1; ci < caps.length; ci++) {
      const smallCap = caps[ci];
      const Ne = Math.max(1, Math.ceil((subj.students || 1) / smallCap));
      if (Ne > N) {
        N_extra = Ne;
        subgroupSizeExtra = Math.ceil((subj.students || 1) / Ne);
        eligibleExtra = [
          ...shuffle(eligible.filter(r => classroomCapacity[r.id] >= subgroupSizeExtra && prefZone && classroomZone[r.id] === prefZone)),
          ...shuffle(eligible.filter(r => classroomCapacity[r.id] >= subgroupSizeExtra && (!prefZone || classroomZone[r.id] !== prefZone))),
        ];
        break;
      }
    }
    labSubjects.push({ subj, labType, eligible: eligibleSorted, N, subgroupSize, N_extra, subgroupSizeExtra, eligibleExtra });
  }

  // Orden de tareas: k=1 de todas las asignaturas primero, luego k=2, luego k=3, ...
  // Tras los subgrupos primarios, se añaden los subgrupos extra (tier de aulas más pequeñas).
  const maxN = labSubjects.length ? Math.max(...labSubjects.map(s => s.N)) : 0;
  const tasks = [];
  for (let k = 1; k <= maxN; k++) {
    for (const ls of labSubjects) {
      if (k > ls.N) continue;
      tasks.push({ ...ls, k });
    }
  }
  // Subgrupos extra (tier de aulas pequeñas): se intentan después de todos los primarios
  for (const ls of labSubjects) {
    for (let k = ls.N + 1; k <= ls.N_extra; k++) {
      tasks.push({ ...ls, k, subgroupSize: ls.subgroupSizeExtra, eligible: ls.eligibleExtra });
    }
  }

  // Máx maxParallel sesiones por slot en total (teoría + labs).
  // Inicializar con la teoría ya colocada para que el contador sea global.
  const slotLabCount = new Map();
  for (const ts of theorySessions) {
    const key = `${ts.day}-${timeToMin(ts.start)}`;
    slotLabCount.set(key, (slotLabCount.get(key) || 0) + 1);
  }
  // Por asignatura: slots ya ocupados, evita que dos subgrupos de la misma asignatura coincidan
  const subjectSlotOcc = new Map();
  // Por número de subgrupo: slots ocupados, prefiere que sg1 de distintas asignaturas no coincidan
  const subgroupSlotOcc = new Map();

  // Baraja los días dentro de cada franja horaria para que cada tarea pruebe los días en
  // distinto orden y las asignaturas no compitan todas por el mismo primer slot.
  const shuffleDays = (slots) => {
    const byTime = new Map();
    const timeOrder = [];
    for (const s of slots) {
      if (!byTime.has(s.startMin)) { byTime.set(s.startMin, []); timeOrder.push(s.startMin); }
      byTime.get(s.startMin).push(s);
    }
    return timeOrder.flatMap(t => shuffle([...byTime.get(t)]));
  };

  const primaryFailed = new Set(); // asignaturas con algún subgrupo primario sin asignar

  for (const { subj, labType, eligible, subgroupSize, k, N } of tasks) {
    const isExtra = k > N;
    // Subgrupo extra: solo intentar si falló algún primario de esta asignatura
    if (isExtra && !primaryFailed.has(subj.id)) continue;

    const theoryDay = theoryDayBySubject[subj.id] ?? null;
    let assigned = false;

    if (!subjectSlotOcc.has(subj.id)) subjectSlotOcc.set(subj.id, new Set());
    const subjOcc = subjectSlotOcc.get(subj.id);
    if (!subgroupSlotOcc.has(k)) subgroupSlotOcc.set(k, new Set());
    const sgOcc = subgroupSlotOcc.get(k);
    // Ordenar candidatos: primero los que no tienen aún otro sg-k colocado (soft constraint)
    const _shuffled = shuffleDays(candidateSlots);
    const _orderedSlots = [
      ..._shuffled.filter(s => !sgOcc.has(`${s.dia}-${s.startMin}`)),
      ..._shuffled.filter(s =>  sgOcc.has(`${s.dia}-${s.startMin}`)),
    ];

    for (const slot of _orderedSlots) {
      if (slot.dia === theoryDay) continue;
      const theoryOcc = maxParallel > 2
        ? (subjectTheoryTimeOcc.get(subj.id) || new Set())
        : theoryTimeOcc;
      if (!isSegmentFree([theoryOcc], `${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR)) continue;
      const slotKey = `${slot.dia}-${slot.startMin}`;
      if ((slotLabCount.get(slotKey) || 0) >= maxParallel) continue;
      if (subjOcc.has(slotKey)) continue;
      // misma rama no puede coincidir en el mismo slot (ramas distintas sí pueden)
      const branch = subjectBranchMap[subj.id] || null;
      if (branch && maxParallel > 2 && (branchOcc.get(slotKey) || new Set()).has(branch)) continue;

      let effectiveSubgroupSize = subgroupSize;
      let freeRoom = eligible.find(r => {
        if (classroomCapacity[r.id] < subgroupSize) return false;
        const rKey = `${r.id}-${slot.dia}`;
        return isSegmentFree([preOccClassrooms, roomOcc], rKey, slot.startMin, slot.startMin + LAB_DUR);
      });

      // Si es franja preferida (10-14) y no hay aula grande libre, intentar aulas más pequeñas
      // antes de caer al 8:00. Solo si existe tier extra para esta asignatura.
      if (!freeRoom && slot.startMin >= MORNING_START && slot.startMin < LUNCH_START && !isExtra) {
        const lsEntry = labSubjects.find(ls => ls.subj.id === subj.id);
        if (lsEntry && lsEntry.N_extra > lsEntry.N) {
          const smallRoom = lsEntry.eligibleExtra.find(r => {
            if (classroomCapacity[r.id] < lsEntry.subgroupSizeExtra) return false;
            if (classroomCapacity[r.id] >= subgroupSize) return false; // ya probado arriba
            const rKey = `${r.id}-${slot.dia}`;
            return isSegmentFree([preOccClassrooms, roomOcc], rKey, slot.startMin, slot.startMin + LAB_DUR);
          });
          if (smallRoom) {
            freeRoom = smallRoom;
            effectiveSubgroupSize = lsEntry.subgroupSizeExtra;
          }
        }
      }

      if (freeRoom) {
        occupySegment(roomOcc, `${freeRoom.id}-${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR);
        slotLabCount.set(slotKey, (slotLabCount.get(slotKey) || 0) + 1);
        subjOcc.add(slotKey);
        sgOcc.add(slotKey);
        if (branch && maxParallel > 2) {
          if (!branchOcc.has(slotKey)) branchOcc.set(slotKey, new Set());
          branchOcc.get(slotKey).add(branch);
        }

        labSessions.push({
          subject_id:       subj.id,
          subject:          subj.name,
          degree:           subj.degree,
          classroom_id:     freeRoom.id,
          classroom:        classroomMeta[freeRoom.id] || `Lab ${freeRoom.id}`,
          teacher_ids:      [],
          teacher:          "",
          teacherCandidates: subjectLabTeachersMap[subj.id] || [],
          day:              slot.dia,
          start:            minToTime(slot.startMin),
          end:              minToTime(slot.startMin + LAB_DUR),
          subgroup:         k,
          _eligible:     freeRoom && effectiveSubgroupSize < subgroupSize
                           ? labSubjects.find(ls => ls.subj.id === subj.id)?.eligibleExtra || eligible
                           : eligible,
          _subgroupSize: effectiveSubgroupSize,
        });
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      noAsig.push(`${subj.name} (práct. sg${k})`);
      if (!isExtra) primaryFailed.add(subj.id);
    }
  }

  // Pase de rescate: mover sesiones de lab en slots tardíos (>=19:00) a slots anteriores
  const LATE_START = 19 * 60;
  for (const sess of labSessions) {
    const sessStartMin = timeToMin(sess.start);
    if (sessStartMin < LATE_START) continue; // ya está en buen slot

    const slotKey = `${sess.day}-${sessStartMin}`;
    const subjOcc = subjectSlotOcc.get(sess.subject_id);
    const theoryDay = theoryDayBySubject[sess.subject_id] ?? null;
    const labEntry  = labSubjects.find(ls => ls.subj.id === sess.subject_id);
    if (!labEntry) continue;
    const subj        = labEntry.subj;
    const eligible    = sess._eligible    || labEntry.eligible;
    const subgroupSize = sess._subgroupSize || labEntry.subgroupSize;

    const resBranch = subjectBranchMap[sess.subject_id] || null;

    // Liberar ocupación actual temporalmente
    freeSegment(roomOcc,    `${sess.classroom_id}-${sess.day}`, sessStartMin, sessStartMin + LAB_DUR);
    slotLabCount.set(slotKey, (slotLabCount.get(slotKey) || 1) - 1);
    subjOcc?.delete(slotKey);
    if (resBranch && maxParallel > 2) branchOcc.get(slotKey)?.delete(resBranch);

    let moved = false;
    for (const slot of candidateSlots) {
      if (slot.startMin >= sessStartMin) continue; // solo slots anteriores
      if (slot.dia === theoryDay) continue;
      const theoryOcc = maxParallel > 2
        ? (subjectTheoryTimeOcc.get(sess.subject_id) || new Set())
        : theoryTimeOcc;
      if (!isSegmentFree([theoryOcc], `${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR)) continue;
      const newKey = `${slot.dia}-${slot.startMin}`;
      if ((slotLabCount.get(newKey) || 0) >= maxParallel) continue;
      if (subjOcc?.has(newKey)) continue;
      if (resBranch && maxParallel > 2 && (branchOcc.get(newKey) || new Set()).has(resBranch)) continue;

      const freeRoom = eligible.find(r => {
        if (classroomCapacity[r.id] < subgroupSize) return false;
        return isSegmentFree([preOccClassrooms, roomOcc], `${r.id}-${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR);
      });

      if (freeRoom) {
        occupySegment(roomOcc, `${freeRoom.id}-${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR);
        slotLabCount.set(newKey, (slotLabCount.get(newKey) || 0) + 1);
        subjOcc?.add(newKey);
        if (resBranch && maxParallel > 2) {
          if (!branchOcc.has(newKey)) branchOcc.set(newKey, new Set());
          branchOcc.get(newKey).add(resBranch);
        }
        sess.classroom_id = freeRoom.id;
        sess.classroom    = classroomMeta[freeRoom.id] || `Lab ${freeRoom.id}`;
        sess.day          = slot.dia;
        sess.start        = minToTime(slot.startMin);
        sess.end          = minToTime(slot.startMin + LAB_DUR);
        moved = true;
        break;
      }
    }

    if (!moved) {
      // Restaurar ocupación original
      occupySegment(roomOcc, `${sess.classroom_id}-${sess.day}`, sessStartMin, sessStartMin + LAB_DUR);
      slotLabCount.set(slotKey, (slotLabCount.get(slotKey) || 0) + 1);
      subjOcc?.add(slotKey);
      if (resBranch && maxParallel > 2) {
        if (!branchOcc.has(slotKey)) branchOcc.set(slotKey, new Set());
        branchOcc.get(slotKey).add(resBranch);
      }
    }
  }

  // Pase de mejora: mover labs de slots extremos (<10:00) a preferidos (10-14h)
  const PREF_LAB_MIN = 10 * 60;
  const PREF_LAB_MAX = 14 * 60;
  let labAnyMoved = true;
  for (let labPass = 0; labPass < 5 && labAnyMoved; labPass++) {
  labAnyMoved = false;
  for (const sess of labSessions) {
    const sessStartMin = timeToMin(sess.start);
    if (sessStartMin >= PREF_LAB_MIN) continue;

    const slotKey      = `${sess.day}-${sessStartMin}`;
    const subjOcc      = subjectSlotOcc.get(sess.subject_id);
    const theoryDay    = theoryDayBySubject[sess.subject_id] ?? null;
    const labEntry     = labSubjects.find(ls => ls.subj.id === sess.subject_id);
    if (!labEntry) continue;
    const eligible    = sess._eligible    || labEntry.eligible;
    const subgroupSize = sess._subgroupSize || labEntry.subgroupSize;
    const resBranch = subjectBranchMap[sess.subject_id] || null;

    freeSegment(roomOcc, `${sess.classroom_id}-${sess.day}`, sessStartMin, sessStartMin + LAB_DUR);
    slotLabCount.set(slotKey, (slotLabCount.get(slotKey) || 1) - 1);
    subjOcc?.delete(slotKey);
    if (resBranch && maxParallel > 2) branchOcc.get(slotKey)?.delete(resBranch);

    let moved = false;
    for (const slot of candidateSlots) {
      if (slot.startMin < PREF_LAB_MIN || slot.startMin >= PREF_LAB_MAX) continue;
      // No bloqueamos el día de teoría entero, solo comprobamos solapamiento horario
      const theoryOcc = maxParallel > 2
        ? (subjectTheoryTimeOcc.get(sess.subject_id) || new Set())
        : theoryTimeOcc;
      if (!isSegmentFree([theoryOcc], `${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR)) continue;
      const newKey = `${slot.dia}-${slot.startMin}`;
      if ((slotLabCount.get(newKey) || 0) >= maxParallel) continue;
      // subjOcc no se comprueba aquí: distintos subgrupos de la misma asignatura pueden compartir slot
      if (resBranch && maxParallel > 2 && (branchOcc.get(newKey) || new Set()).has(resBranch)) continue;

      const freeRoom = eligible.find(r => {
        if (classroomCapacity[r.id] < subgroupSize) return false;
        return isSegmentFree([preOccClassrooms, roomOcc], `${r.id}-${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR);
      });
      if (!freeRoom) continue;

      occupySegment(roomOcc, `${freeRoom.id}-${slot.dia}`, slot.startMin, slot.startMin + LAB_DUR);
      slotLabCount.set(newKey, (slotLabCount.get(newKey) || 0) + 1);
      subjOcc?.add(newKey);
      if (resBranch && maxParallel > 2) {
        if (!branchOcc.has(newKey)) branchOcc.set(newKey, new Set());
        branchOcc.get(newKey).add(resBranch);
      }
      sess.classroom_id = freeRoom.id;
      sess.classroom    = classroomMeta[freeRoom.id] || `Lab ${freeRoom.id}`;
      sess.day          = slot.dia;
      sess.start        = minToTime(slot.startMin);
      sess.end          = minToTime(slot.startMin + LAB_DUR);
      moved = true;
      labAnyMoved = true;
      break;
    }

    if (!moved) {
      occupySegment(roomOcc, `${sess.classroom_id}-${sess.day}`, sessStartMin, sessStartMin + LAB_DUR);
      slotLabCount.set(slotKey, (slotLabCount.get(slotKey) || 0) + 1);
      subjOcc?.add(slotKey);
      if (resBranch && maxParallel > 2) {
        if (!branchOcc.has(slotKey)) branchOcc.set(slotKey, new Set());
        branchOcc.get(slotKey).add(resBranch);
      }
    }
  }
  } // fin bucle de pasadas de mejora de labs

  const labNeeded = labSubjects.reduce((sum, ls) => sum + ls.N, 0);
  return { labSessions, noAsig, labNeeded };
}

// genera el horario para un grupo/cuatrimestre y lo guarda en BD
router.post("/generate", requireAuth, async (req, res) => {
  try {
    const { aulas, asignaturas, franjas, meta = {}, transversalDay = -1, baseScheduleId = 0, generation_id = null } = req.body;
    const { dias, horaInicio, horaFin, duracion } = franjas;
    const finMin = timeToMin(horaFin);

    const [availRows, stRows, subjectRows, teacherRows, classroomRows, zonePrefRows, slotLimitRows, groupCfgRows] = await Promise.all([
      dbAll("SELECT * FROM teacher_availability WHERE available=1"),
      dbAll("SELECT * FROM subject_teachers"),
      dbAll("SELECT id, name, degree, year, semester, room_type, bilingual, session_type, theory_hours, lab_hours FROM subjects"),
      dbAll("SELECT id, name, session_type FROM teachers"),
      dbAll("SELECT id, name, type, capacity, zone FROM classrooms"),
      dbAll("SELECT degree, year, zone FROM zone_preferences"),
      dbAll("SELECT degree, year, semester, max_parallel FROM slot_limits"),
      dbAll("SELECT degree, year, group_letter, afternoon FROM group_config"),
    ]);

    // aplicar fallback de cuatrimestre: usar filas específicas del C si existen, si no las generales
    const _semRows  = availRows.filter(r => r.semester === (meta.semester ?? null));
    const _nullRows = availRows.filter(r => r.semester == null);
    const _withSpec = new Set(_semRows.map(r => r.teacher_id));
    const effectiveAvailRows = meta.semester != null
      ? [..._semRows, ..._nullRows.filter(r => !_withSpec.has(r.teacher_id))]
      : _nullRows;

    // disponibilidad de cada profesor: fusionar intervalos adyacentes una sola vez aquí
    const teacherAvailRaw = {};
    for (const r of effectiveAvailRows) {
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
        teacherAvail[tid][+day] = merged; // +day: convierte la clave de texto a número
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
    const slotLimitMap       = Object.fromEntries(slotLimitRows.map(r => [`${r.degree}|${r.year}|${r.semester}`, r.max_parallel]));
    const maxParallel        = slotLimitMap[`${meta.degree}|${meta.year}|${meta.semester}`] ?? 2;

    // Para grados multi-rama (maxParallel > 2): detectar la rama de cada asignatura
    // comparando su nombre con asignaturas de los grados componentes (GIT, GIEC, GIST)
    // del mismo año y cuatrimestre. Si no hay coincidencia, es asignatura común (null).
    const BRANCH_DEGREES = ['GIT', 'GIEC', 'GIST'];
    const subjectBranchMap = {}; // subjectId -> 'git'|'giec'|'gist'|null
    if (maxParallel > 2) {
      const branchSubjects = subjectRows.filter(s =>
        BRANCH_DEGREES.includes(s.degree) && s.year === meta.year && s.semester === meta.semester
      );
      for (const s of asignaturas) {
        const name = (subjectMeta[s.id]?.name || '').trim().toLowerCase();
        const match = branchSubjects.find(bs => bs.name.trim().toLowerCase() === name);
        subjectBranchMap[s.id] = match ? match.degree.toLowerCase() : null;
      }
    }

    // effectiveDias: excluye el día transversal si hay asignaturas transversales y hay día reservado
    const hasTransversal = asignaturas.some(a =>
      (subjectMeta[a.id]?.name || '').trim().toLowerCase().startsWith('transversal')
    );
    const effectiveDias = (hasTransversal && transversalDay >= 0)
      ? dias.filter(d => d !== transversalDay)
      : dias;

    // rejilla de slots anclada en 10:00 y 15:00 con paso = duracion
    const ANCHORS         = [10 * 60, 15 * 60];
    const startMin0       = timeToMin(horaInicio);
    const endMin0         = timeToMin(horaFin);
    const isAfternoonGroup = startMin0 >= 15 * 60;
    // grupos de tarde: cap de mainSlots en 19:00 (19:00+ se añade por separado como último recurso)
    const mainSlotCap     = isAfternoonGroup ? 19 * 60 : endMin0;

    const mainSlots = [];
    for (const anchor of ANCHORS) {
      for (let m = anchor; m + duracion <= mainSlotCap; m += duracion) {
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

    // fringe especial de grupo de tarde: 14:00-15:00 (antes del anchor de 15:00)
    const aftnGroupFringeOK  = isAfternoonGroup && LUNCH_START + 60 <= finMin;
    const aftnGroupFringeMin = LUNCH_START; // 14:00

    const partialSlots = [
      ...(morningFringeOK     ? effectiveDias.map(d => ({ dia: d, startMin: morningFringeMin }))  : []),
      ...(afternoonFringeOK   ? effectiveDias.map(d => ({ dia: d, startMin: fringeBMin }))         : []),
      ...(aftnGroupFringeOK   ? effectiveDias.map(d => ({ dia: d, startMin: aftnGroupFringeMin })) : []),
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

    // grupos de tarde: 12:00-14:00 como fallback y 19:00 como último recurso (ambos con isLate para que
    // el solver los intente DESPUÉS de 15:00-17:00, que van a "late"; 12:00 antes de 19:00 en stIter)
    const morningFallbackSlots = (isAfternoonGroup && 12 * 60 + duracion <= LUNCH_START)
      ? effectiveDias.map(d => ({ dia: d, startMin: 12 * 60, isLate: true }))
      : [];
    const eveningExtremeSlots  = (isAfternoonGroup && 19 * 60 + duracion <= endMin0)
      ? effectiveDias.map(d => ({ dia: d, startMin: 19 * 60, isLate: true }))
      : [];

    // orden de prioridad: mañana, luego tarde, después extremo y por último fringe
    // Con duracion=60 todos los slots son de 1h, los fringe/extreme antes de las 10:00 no son necesarios
    const useFringe     = duracion > 60;
    const morningMain   = shuffle(mainSlots.filter(t => t.startMin < LUNCH_START));
    const afternoonMain = shuffle(mainSlots.filter(t => t.startMin >= LUNCH_END));
    const startTimes    = [...morningMain, ...afternoonMain, ...(useFringe ? shuffle(extremeSlots) : []), ...morningFallbackSlots, ...eveningExtremeSlots, ...(useFringe ? partialSlots : [])];

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
        groupKey: degree && year != null
          ? (subjectBranchMap[s.id] ? `${degree}|${year}|${subjectBranchMap[s.id]}` : `${degree}|${year}`)
          : null,
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
    // grupos de mañana = todos los que NO tienen afternoon=1 en group_config para este degree/year
    const afternoonSet = new Set(
      groupCfgRows
        .filter(r => r.degree === meta.degree && r.year === meta.year && r.afternoon)
        .map(r => r.group_letter)
    );
    const knownGroups = groupCfgRows
      .filter(r => r.degree === meta.degree && r.year === meta.year)
      .map(r => r.group_letter);
    // si el grupo actual no está en group_config, se considera de mañana por defecto
    const isMorningGroup = meta.group_letter != null && !afternoonSet.has(meta.group_letter);
    // MORNING_GROUPS = todos los grupos conocidos que no son de tarde, excluyendo el actual
    const MORNING_GROUPS = knownGroups.filter(g => !afternoonSet.has(g));
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
            AND subgroup IS NULL
          GROUP BY subject_id, day_of_week
          HAVING cnt >= ?
        `, [...ids, threshold]);
        for (const r of avoidRows) {
          if (!avoidDays[r.subject_id]) avoidDays[r.subject_id] = new Set();
          avoidDays[r.subject_id].add(r.day_of_week);
        }
      }
    }

    // marcar como ocupados los slots ya usados por cualquier otro grupo (cualquier grado/año/cuatrimestre)
    const preOccTeachers   = new Set();
    const preOccClassrooms = new Set();
    {
      const curDegree = meta.degree     || '';
      const curYear   = String(meta.year   ?? '');
      const curSem    = String(meta.semester ?? '');
      const curGroup  = meta.group_letter ?? '';

      const crossRows = await dbAll(`
        SELECT ss.teacher_id, ss.classroom_id, ss.day_of_week, ss.slot_start, ss.slot_end
        FROM schedule_sessions ss
        JOIN schedules sc ON sc.id = ss.schedule_id
        WHERE sc.semester = ?
          AND sc.id > ?
          AND sc.id IN (
            SELECT MAX(sc2.id) FROM schedules sc2
            WHERE sc2.semester = ?
              AND sc2.id > ?
            GROUP BY sc2.degree, sc2.year, sc2.semester, COALESCE(sc2.group_letter, '')
          )
          AND NOT (
            sc.degree   = ?
            AND sc.year     = ?
            AND sc.semester = ?
            AND COALESCE(sc.group_letter, '') = ?
          )
      `, [curSem, baseScheduleId, curSem, baseScheduleId, curDegree, curYear, curSem, curGroup]);

      for (const r of crossRows) {
        const sMin = timeToMin(r.slot_start);
        const eMin = timeToMin(r.slot_end);
        if (r.teacher_id)   occupySegment(preOccTeachers,   `${r.teacher_id}-${r.day_of_week}`,   sMin, eMin);
        if (r.classroom_id) occupySegment(preOccClassrooms, `${r.classroom_id}-${r.day_of_week}`, sMin, eMin);
      }
    }

    // MRV: contar slots por asignatura (restricción de aula, no de profesor; el profesor es restricción blanda)
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
    // Para grupos de tarde sin día transversal fijo: sacar las transversales del CSP y colocarlas
    // aparte en slots de tarde (igual que cuando transversalDay >= 0 pero en todos los días).
    const handleTransversalSeparately = isAfternoonGroup && transversalDay < 0;
    const eligibleSubjs = subjSorted.filter(s =>
      ((transversalDay >= 0 || handleTransversalSeparately) ? !s.transversal : true) &&
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
    // Prioridad en el CSP: 0 = sesión larga de asignatura con sesión corta (necesita 10:00 para adyacencia)
    //                       1 = sesión larga normal   2 = sesión corta (siempre al final)
    const hasMixedDur = new Set(
      eligibleSubjs.filter(s => s.sessionDurations.some(d => d < duracion)).map(s => s.id)
    );
    allSessions.sort((a, b) => {
      const ap = a.dur < duracion ? 2 : hasMixedDur.has(a.subject.id) ? 0 : 1;
      const bp = b.dur < duracion ? 2 : hasMixedDur.has(b.subject.id) ? 0 : 1;
      return ap - bp;
    });

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
      let fit = 0, n = 0, extremePenalty = 0;
      for (let i = 0; i < res.length; i++) {
        const a = res[i]; if (!a) continue;
        n++;
        fit += Math.min((allSessions[i].subject.students || 1) / (classroomCapacity[a.aulaId] || 1), 1);
        if (a.startMin < 10 * 60) extremePenalty++;
      }
      // primero maximizar asignadas, luego penalizar slots extremos (<10:00), luego ajuste de aforo
      return n * 1000 - extremePenalty + (n > 0 ? fit / n : 0);
    };

    const MAX_ITER = 5;
    let bestResult = null, bestPerfect = false, bestScore = -1;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const stIter = [
        ...shuffle([...morningMainBase]),
        ...shuffle([...afternoonMainBase]),
        ...shuffle([...morningFallbackSlots]),
        ...shuffle([...extremeSlots]),
        ...shuffle([...eveningExtremeSlots]),
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
      const { result: r, perfect: p } = solveCSP(allSessions, validIter, stIter, finMin, duracion, partialMins, avoidDays, preOccClassrooms, maxParallel);
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
          teacher_ids:  [],
          teacher:      "",
          teacherCandidates: subject.teacherIds || [],
          day:          a.dia,
          start:        minToTime(a.startMin),
          end:          minToTime(a.endMin),
          subgroup:     null,
        });
      }
    }

    // Pase de mejora: mover sesiones de teoría de slots extremos (<10:00) a preferidos (10-14h)
    {
      const PREF_MIN = 10 * 60;
      const prefMins = [...new Set(morningMain.map(t => t.startMin))]
        .filter(m => m >= PREF_MIN && m < LUNCH_START)
        .sort((a, b) => a - b);

      if (prefMins.length > 0) {
        // Ocupación de aulas/profesores de las sesiones de teoría ya colocadas
        const thRoomOcc  = new Map();
        const thTeachOcc = new Map();
        const occTh = (occ, key, s, e) => {
          if (!occ.has(key)) occ.set(key, new Set());
          for (let m = s; m < e; m += 5) occ.get(key).add(m);
        };
        const freeTh = (occ, key, s, e) => {
          const set = occ.get(key); if (set) for (let m = s; m < e; m += 5) set.delete(m);
        };
        const isThFree = (occ, key, s, e) => {
          const set = occ.get(key); if (!set) return true;
          for (let m = s; m < e; m += 5) if (set.has(m)) return false;
          return true;
        };

        for (const sess of sesiones) {
          const s0 = timeToMin(sess.start), e0 = timeToMin(sess.end);
          occTh(thRoomOcc, `${sess.classroom_id}-${sess.day}`, s0, e0);
          for (const tid of (sess.teacher_ids || [])) occTh(thTeachOcc, `${tid}-${sess.day}`, s0, e0);
        }

        // días usados por asignatura y contador de sesiones por slot
        const subjDays = {};
        const slotCnt  = {};
        for (const s of sesiones) {
          (subjDays[s.subject_id] || (subjDays[s.subject_id] = new Set())).add(s.day);
          const k = `${s.day}-${timeToMin(s.start)}`;
          slotCnt[k] = (slotCnt[k] || 0) + 1;
        }

        let anyMoved = true;
        for (let pass = 0; pass < 5 && anyMoved; pass++) {
          anyMoved = false;
          for (let i = 0; i < sesiones.length; i++) {
            const sess = sesiones[i];
            const sMin = timeToMin(sess.start);
            if (sMin >= PREF_MIN) continue; // ya en rango preferido o tarde

            const dur     = timeToMin(sess.end) - sMin;
            // 1h en slot fringe (9:00) ya está en su posición óptima, no se mueve
            if (dur < duracion && partialMins.has(sMin)) continue;
            const sid     = sess.subject_id;
            const usedays = subjDays[sid] || new Set();

            outer: for (const d of effectiveDias) {
              if (usedays.has(d)) continue;
              for (const m of prefMins) {
                if (m + dur > LUNCH_START) continue;
                const newKey = `${d}-${m}`;
                if ((slotCnt[newKey] || 0) >= maxParallel) continue;

                const freeAula = (validAulasBySubject[sid] || []).find(a => {
                  const rk = `${a.id}-${d}`;
                  return isSegmentFree([preOccClassrooms], rk, m, m + dur)
                    && isThFree(thRoomOcc, rk, m, m + dur);
                });
                if (!freeAula) continue;

                const tid = sess.teacher_ids?.[0] ?? null;
                if (tid != null) {
                  if (!isSegmentFree([preOccTeachers], `${tid}-${d}`, m, m + dur)) continue;
                  if (!isThFree(thTeachOcc, `${tid}-${d}`, m, m + dur)) continue;
                  if (!isTeacherAvailable(tid, d, m, m + dur, teacherAvail)) continue;
                }

                freeTh(thRoomOcc,  `${sess.classroom_id}-${sess.day}`, sMin, sMin + dur);
                occTh (thRoomOcc,  `${freeAula.id}-${d}`, m, m + dur);
                if (tid != null) {
                  freeTh(thTeachOcc, `${tid}-${sess.day}`, sMin, sMin + dur);
                  occTh (thTeachOcc, `${tid}-${d}`,        m, m + dur);
                }

                const oldKey = `${sess.day}-${sMin}`;
                slotCnt[oldKey] = Math.max(0, (slotCnt[oldKey] || 1) - 1);
                slotCnt[newKey] = (slotCnt[newKey] || 0) + 1;
                usedays.delete(sess.day);
                usedays.add(d);

                sesiones[i] = {
                  ...sess,
                  classroom_id: freeAula.id,
                  classroom:    classroomMeta[freeAula.id] || `Aula ${freeAula.id}`,
                  day:          d,
                  start:        minToTime(m),
                  end:          minToTime(m + dur),
                };
                theoryDayBySubject[sid] = d;
                anyMoved = true;
                break outer;
              }
            }
          }
        }

        // Sub-pase de adyacencia: mover sesión corta (1h) al fringe justo antes de la sesión larga
        if (morningFringeOK || aftnGroupFringeOK) {
          const bySubj = {};
          for (let i = 0; i < sesiones.length; i++) {
            const s = sesiones[i];
            const dur = timeToMin(s.end) - timeToMin(s.start);
            if (!bySubj[s.subject_id]) bySubj[s.subject_id] = [];
            bySubj[s.subject_id].push({ i, s, dur });
          }
          for (const [sid, items] of Object.entries(bySubj)) {
            if (items.length < 2) continue;
            const shorts = items.filter(x => x.dur < duracion);
            const longs  = items.filter(x => x.dur >= duracion);
            if (!shorts.length || !longs.length) continue;
            for (const { i: si, s: shortSess, dur: shortDur } of shorts) {
              const shortStart = timeToMin(shortSess.start);
              for (const { s: longSess } of longs) {
                const longStart = timeToMin(longSess.start);
                // Buscar si la sesión larga está justo después de algún fringe disponible
                const possibleFringes = [
                  ...(morningFringeOK   ? [morningFringeMin]  : []),
                  ...(aftnGroupFringeOK ? [aftnGroupFringeMin] : []),
                ];
                const matchedFringe = possibleFringes.find(fm => longStart === fm + shortDur);
                if (matchedFringe === undefined) continue; // long no está en el slot adyacente
                const targetDay   = longSess.day;
                const targetStart = matchedFringe;
                const curKey      = `${shortSess.day}-${shortStart}`;
                const newKey      = `${targetDay}-${targetStart}`;
                if (curKey === newKey) break; // ya está en su sitio
                if ((slotCnt[newKey] || 0) >= maxParallel) continue;
                // Preferir el aula de la sesión larga (misma clase, no hace falta moverse)
                const longRoomId = longSess.classroom_id;
                const longRk = `${longRoomId}-${targetDay}`;
                const sameRoomFree = (validAulasBySubject[+sid] || []).some(a => a.id === longRoomId)
                  && isSegmentFree([preOccClassrooms], longRk, targetStart, targetStart + shortDur)
                  && isThFree(thRoomOcc, longRk, targetStart, targetStart + shortDur);
                const freeAula = sameRoomFree
                  ? { id: longRoomId }
                  : (validAulasBySubject[+sid] || []).find(a => {
                      const rk = `${a.id}-${targetDay}`;
                      return isSegmentFree([preOccClassrooms], rk, targetStart, targetStart + shortDur)
                        && isThFree(thRoomOcc, rk, targetStart, targetStart + shortDur);
                    });
                if (!freeAula) continue;
                const tid = shortSess.teacher_ids?.[0] ?? null;
                if (tid != null) {
                  if (!isSegmentFree([preOccTeachers], `${tid}-${targetDay}`, targetStart, targetStart + shortDur)) continue;
                  if (!isThFree(thTeachOcc, `${tid}-${targetDay}`, targetStart, targetStart + shortDur)) continue;
                  if (!isTeacherAvailable(tid, targetDay, targetStart, targetStart + shortDur, teacherAvail)) continue;
                }
                freeTh(thRoomOcc,  `${shortSess.classroom_id}-${shortSess.day}`, shortStart, shortStart + shortDur);
                occTh (thRoomOcc,  `${freeAula.id}-${targetDay}`, targetStart, targetStart + shortDur);
                if (tid != null) {
                  freeTh(thTeachOcc, `${tid}-${shortSess.day}`, shortStart, shortStart + shortDur);
                  occTh (thTeachOcc, `${tid}-${targetDay}`,      targetStart, targetStart + shortDur);
                }
                slotCnt[curKey] = Math.max(0, (slotCnt[curKey] || 1) - 1);
                slotCnt[newKey] = (slotCnt[newKey] || 0) + 1;
                sesiones[si] = {
                  ...shortSess,
                  classroom_id: freeAula.id,
                  classroom:    classroomMeta[freeAula.id] || `Aula ${freeAula.id}`,
                  day:          targetDay,
                  start:        minToTime(targetStart),
                  end:          minToTime(targetStart + shortDur),
                };
                theoryDayBySubject[+sid] = targetDay;
                break;
              }
            }
          }
        }
      }
    }

    // Sesiones transversales: con día reservado O grupo de tarde (se colocan fuera del CSP)
    // Se colocan ANTES del pase de dispersión para que la transversal se incluya en él.
    const transversalSubjs = (transversalDay >= 0 || handleTransversalSeparately)
      ? subjects.filter(s => s.transversal)
      : [];

    // Mapa de minutos ocupados por teoría ya colocada para que las transversales no se solapen
    const theorySlotOcc = new Set();
    for (const s of sesiones) {
      const s0 = timeToMin(s.start), e0 = timeToMin(s.end);
      for (let t = s0; t < e0; t += 5) theorySlotOcc.add(`${s.day}-${t}`);
    }

    for (const tSubj of transversalSubjs) {
      const daysForTransv = transversalDay >= 0 ? [transversalDay] : effectiveDias;
      const transvCandidates = [];
      for (const anchor of ANCHORS) {
        for (let m = anchor; m + duracion <= finMin; m += duracion) {
          if (m < LUNCH_END && m + duracion > LUNCH_START) break;
          if (m < startMin0) continue;
          if (m >= LUNCH_START && m < LUNCH_END) continue;
          for (const d of daysForTransv) transvCandidates.push({ m, d });
        }
      }
      const usedDays = new Set();
      for (const dur of tSubj.sessionDurations) {
        let placed = false;
        for (const tryUsed of [false, true]) {
          for (const { m, d } of transvCandidates) {
            if (!tryUsed && usedDays.has(d)) continue;
            if (tryUsed && !usedDays.has(d)) continue;
            // No colocar donde ya hay teoría del grupo (la transversal cuenta como teoría)
            let slotBusy = false;
            for (let t = m; t < m + dur; t += 5) if (theorySlotOcc.has(`${d}-${t}`)) { slotBusy = true; break; }
            if (slotBusy) continue;
            const freeAula = validAulasBySubject[tSubj.id].find(a => {
              const rKey = `${a.id}-${d}`;
              return isSegmentFree([preOccClassrooms], rKey, m, m + dur);
            });
            if (freeAula) {
              occupySegment(preOccClassrooms, `${freeAula.id}-${d}`, m, m + dur);
              for (let t = m; t < m + dur; t += 5) theorySlotOcc.add(`${d}-${t}`);
              const ci = transvCandidates.findIndex(c => c.m === m && c.d === d);
              if (ci >= 0) transvCandidates.splice(ci, 1);
              usedDays.add(d);
              sesiones.push({
                subject_id:        tSubj.id,
                subject:           tSubj.name,
                degree:            tSubj.degree,
                classroom_id:      freeAula.id,
                classroom:         classroomMeta[freeAula.id] || `Aula ${freeAula.id}`,
                teacher_ids:       [],
                teacher:           "",
                teacherCandidates: tSubj.teacherIds || [],
                day:               d,
                start:             minToTime(m),
                end:               minToTime(m + dur),
                subgroup:          null,
              });
              assignedCount[tSubj.id] = (assignedCount[tSubj.id] || 0) + 1;
              placed = true;
              break;
            }
          }
          if (placed) break;
        }
        if (!placed) noAsignadas.push(`${tSubj.name} (sin aula libre para transversal)`);
      }
    }

    // Pase de dispersión de teoría (incluye transversales)
    // Redistribuye sesiones que coinciden en el mismo slot a slots vacíos.
    // Grupos de mañana: solo dispersión horizontal (mismo horario, distinto día).
    // Grupos de tarde: dispersión libre en cualquier slot vacío.
    if (maxParallel > 1 && sesiones.length > 0) {
      const transversalIds = new Set(subjects.filter(s => s.transversal).map(s => s.id));
      const spRoomOcc  = new Map();
      const spTeachOcc = new Map();
      const occSp  = (occ, key, s, e) => { if (!occ.has(key)) occ.set(key, new Set()); for (let m = s; m < e; m += 5) occ.get(key).add(m); };
      const freeSp = (occ, key, s, e) => { const set = occ.get(key); if (!set) return; for (let m = s; m < e; m += 5) set.delete(m); };
      const isSpFree = (occ, key, s, e) => { const set = occ.get(key); if (!set) return true; for (let m = s; m < e; m += 5) if (set.has(m)) return false; return true; };

      for (const sess of sesiones) {
        const s0 = timeToMin(sess.start), e0 = timeToMin(sess.end);
        occSp(spRoomOcc,  `${sess.classroom_id}-${sess.day}`, s0, e0);
        for (const tid of (sess.teacher_ids || [])) occSp(spTeachOcc, `${tid}-${sess.day}`, s0, e0);
      }

      const spSlotMap = {};
      const spSlotCnt = {};
      for (let i = 0; i < sesiones.length; i++) {
        const key = `${sesiones[i].day}-${timeToMin(sesiones[i].start)}`;
        if (!spSlotMap[key]) spSlotMap[key] = [];
        spSlotMap[key].push(i);
        spSlotCnt[key] = (spSlotCnt[key] || 0) + 1;
      }

      // Usar solo mainSlots como targets: evita que el bucle de anchors genere 16:00
      // (anchor=10:00 con paso=120 produce 16:00 cuando startMin0=15:00, que no es slot válido)
      const spreadTargets = mainSlots.map(t => ({ d: t.dia, m: t.startMin }));

      let anySpread = true;
      while (anySpread) {
        anySpread = false;
        const overcrowded = Object.entries(spSlotMap)
          .filter(([, idxs]) => idxs.length > 1)
          .sort((a, b) => b[1].length - a[1].length);
        for (const [crowdKey, idxs] of overcrowded) {
          // Para maxParallel>2: si el slot tiene sesiones de distintas ramas (o common+rama),
          // la concurrencia es intencional, no se dispersa este slot
          if (maxParallel > 2) {
            const slotBranches = idxs.map(idx => subjectBranchMap[sesiones[idx].subject_id] || 'common');
            const uniqueBranches = new Set(slotBranches);
            if (uniqueBranches.size > 1) continue;
          }
          let moved = false;
          for (const i of [...idxs]) {
            const sess = sesiones[i];
            // Transversales con día reservado no se mueven (están fijas en ese día)
            if (transversalDay >= 0 && transversalIds.has(sess.subject_id)) continue;
            const sid  = sess.subject_id;
            const dur  = timeToMin(sess.end) - timeToMin(sess.start);
            const sMin = timeToMin(sess.start);
            for (const { d, m } of spreadTargets) {
              const newKey = `${d}-${m}`;
              if (newKey === crowdKey) continue;
              if ((spSlotMap[newKey] || []).length >= 1) continue;
              if ((spSlotCnt[newKey] || 0) >= maxParallel) continue;
              if (!isAfternoonGroup && m !== sMin) continue;
              const freeAula = (validAulasBySubject[sid] || []).find(a => {
                const rk = `${a.id}-${d}`;
                return isSegmentFree([preOccClassrooms], rk, m, m + dur)
                  && isSpFree(spRoomOcc, rk, m, m + dur);
              });
              if (!freeAula) continue;
              const tid = sess.teacher_ids?.[0] ?? null;
              if (tid != null) {
                if (!isSegmentFree([preOccTeachers], `${tid}-${d}`, m, m + dur)) continue;
                if (!isSpFree(spTeachOcc, `${tid}-${d}`, m, m + dur)) continue;
                if (!isTeacherAvailable(tid, d, m, m + dur, teacherAvail)) continue;
              }
              freeSp(spRoomOcc,  `${sess.classroom_id}-${sess.day}`, sMin, sMin + dur);
              occSp (spRoomOcc,  `${freeAula.id}-${d}`, m, m + dur);
              if (tid != null) {
                freeSp(spTeachOcc, `${tid}-${sess.day}`, sMin, sMin + dur);
                occSp (spTeachOcc, `${tid}-${d}`, m, m + dur);
              }
              spSlotMap[crowdKey] = spSlotMap[crowdKey].filter(x => x !== i);
              spSlotCnt[crowdKey] = Math.max(0, (spSlotCnt[crowdKey] || 1) - 1);
              if (!spSlotMap[newKey]) spSlotMap[newKey] = [];
              spSlotMap[newKey].push(i);
              spSlotCnt[newKey] = (spSlotCnt[newKey] || 0) + 1;
              sesiones[i] = {
                ...sess,
                classroom_id: freeAula.id,
                classroom:    classroomMeta[freeAula.id] || `Aula ${freeAula.id}`,
                day: d, start: minToTime(m), end: minToTime(m + dur),
              };
              theoryDayBySubject[sid] = d;
              moved = true; anySpread = true;
              break;
            }
            if (moved) break;
          }
        }
      }
    }

    // sesiones de prácticas (subgrupos): hasta 5 intentos para minimizar labs fuera de franja preferida
    const labArgs = {
      subjects, classroomRows, classroomType, classroomCapacity, classroomMeta,
      preOccClassrooms, theoryDayBySubject, effectiveDias,
      startMin0: timeToMin(horaInicio), finMin,
      theorySessions: sesiones, transversalDay,
      classroomZone, zonePrefMap,
      subjectLabTeachersMap,
      maxParallel, subjectBranchMap,
    };
    let labSessions = [], noLab = [], labNeeded = 0;
    for (let li = 0; li < 5; li++) {
      const attempt = solveLabSessions(labArgs);
      const badCount = attempt.labSessions.filter(s => timeToMin(s.start) < 10 * 60).length;
      const prevBad  = labSessions.filter(s => timeToMin(s.start) < 10 * 60).length;
      if (li === 0 || attempt.noAsig.length < noLab.length ||
          (attempt.noAsig.length === noLab.length && badCount < prevBad)) {
        labSessions = attempt.labSessions;
        noLab = attempt.noAsig;
        labNeeded = attempt.labNeeded;
      }
      if (noLab.length === 0 && labSessions.filter(s => timeToMin(s.start) < 10 * 60).length === 0) break;
    }
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
    await dbRun(
      `UPDATE schedules SET status='inactive'
       WHERE status='active'
         AND degree IS ? AND year IS ? AND semester IS ? AND group_letter IS ?`,
      [metaDeg, metaYear, metaSem, metaGroup]
    );
    const sched = await dbRun(
      "INSERT INTO schedules (name, created_by, status, degree, year, semester, group_letter, generation_id) VALUES (?,?,?,?,?,?,?,?)",
      [nameLabel, userId, "active", metaDeg, metaYear, metaSem, metaGroup, generation_id]
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
    if (morningFringeOK && duracion > 60) displayMinsSet.add(Math.max(startMin0, firstMain - duracion));
    if (afternoonFringeOK && !isAfternoonGroup) {
      // Para grupos de tarde no añadir fringeBMin=20:00, crea un hueco 19:00-20:00 en el display.
      // El slot 19:00 se añade más abajo como eveningExtremeSlot.
      const fringeWithinMain = mainSlots.some(t => t.startMin <= fringeBMin && t.startMin + duracion > fringeBMin);
      if (!fringeWithinMain) displayMinsSet.add(fringeBMin);
    }
    // Grupos de tarde: añadir al grid los slots de fallback/extremo para continuidad visual
    if (morningFallbackSlots.length > 0) displayMinsSet.add(12 * 60);
    if (eveningExtremeSlots.length > 0)  displayMinsSet.add(19 * 60);
    const slotMins = [...displayMinsSet].sort((a, b) => a - b);
    await dbRun("UPDATE schedules SET slot_mins=?, duracion=? WHERE id=?", [JSON.stringify(slotMins), duracion, scheduleId]);

    const totalNeeded = allSessions.length + transversalSubjs.reduce((acc, s) => acc + s.sessionDurations.length, 0) + labNeeded;
    res.json({ schedule_id: scheduleId, sesiones, no_asignadas: noAsignadas, breaks, perfect, total_needed: totalNeeded, slotMins, maxParallel });

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
             s.semester, s.group_letter,
             u.username AS created_by,
             COUNT(ss.id) AS session_count,
             COUNT(CASE WHEN ss.teacher_id IS NOT NULL THEN 1 END) AS teacher_count
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
// Lista de generaciones
router.get("/generations", requireAuth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT generation_id, COUNT(*) AS count, MIN(created_at) AS created_at
      FROM schedules
      WHERE generation_id IS NOT NULL
      GROUP BY generation_id
      ORDER BY MIN(created_at) DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Restaurar una generación: re-activa in-place los horarios originales (sin crear copias)
router.post("/generations/:genId/restore", requireAuth, async (req, res) => {
  try {
    const { genId } = req.params;
    const schedules = await dbAll(`SELECT * FROM schedules WHERE generation_id = ?`, [genId]);
    if (!schedules.length) return res.status(404).json({ error: "Generación no encontrada" });

    for (const sc of schedules) {
      await dbRun(
        `UPDATE schedules SET status='inactive'
         WHERE status='active' AND id != ?
           AND degree IS ? AND year IS ? AND semester IS ? AND group_letter IS ?`,
        [sc.id, sc.degree, sc.year, sc.semester, sc.group_letter]
      );
      await dbRun(`UPDATE schedules SET status='active' WHERE id = ?`, [sc.id]);
    }
    res.json({ ok: true, restored: schedules.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/conflicts", requireAuth, async (req, res) => {
  try {
    // Último horario generado por cada combinación única (titulación, año, cuatrimestre, grupo)
    const conflicts = await dbAll(`
      SELECT c.name  AS classroom,
             a.day_of_week,
             a.slot_start, a.slot_end,
             sca.degree AS degree_a, sca.year AS year_a, sca.semester AS sem_a, sca.group_letter AS group_a, sa.name AS subject_a,
             scb.degree AS degree_b, scb.year AS year_b, scb.semester AS sem_b, scb.group_letter AS group_b, sb.name AS subject_b
      FROM   schedule_sessions a
      JOIN   schedule_sessions b
               ON  a.classroom_id = b.classroom_id
               AND a.day_of_week  = b.day_of_week
               AND a.id < b.id
               AND a.slot_start   < b.slot_end
               AND a.slot_end     > b.slot_start
      JOIN   schedules  sca ON sca.id = a.schedule_id AND sca.status = 'active'
      JOIN   schedules  scb ON scb.id = b.schedule_id AND scb.status = 'active'
      JOIN   subjects   sa  ON  sa.id = a.subject_id
      JOIN   subjects   sb  ON  sb.id = b.subject_id
      JOIN   classrooms c   ON   c.id = a.classroom_id
      WHERE  sca.semester = scb.semester
      ORDER  BY c.name, a.day_of_week, a.slot_start
    `);
    res.json(conflicts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// función interna reutilizable: asigna profesores a un horario concreto
async function assignTeachersForSchedule(schedId) {
  const schedRows = await dbAll("SELECT * FROM schedules WHERE id=?", [schedId]);
  if (!schedRows.length) throw new Error("Horario no encontrado");
  const sched = schedRows[0];

  const sessRows = await dbAll("SELECT * FROM schedule_sessions WHERE schedule_id=?", [schedId]);
  if (!sessRows.length) return { assigned: 0, total: 0 };

  const [teacherRows, stRows, availRows] = await Promise.all([
    dbAll("SELECT id, session_type FROM teachers"),
    dbAll("SELECT subject_id, teacher_id FROM subject_teachers"),
    dbAll("SELECT teacher_id, day_of_week, slot_start, slot_end, semester FROM teacher_availability WHERE available=1"),
  ]);

  const teacherSessionType = Object.fromEntries(teacherRows.map(r => [r.id, r.session_type || 'ambos']));
  const subjectTheoryTeachers = {};
  const subjectLabTeachers    = {};
  for (const r of stRows) {
    const st = teacherSessionType[r.teacher_id] || 'ambos';
    if (st === 'ambos' || st === 'teoria')
      (subjectTheoryTeachers[r.subject_id] = subjectTheoryTeachers[r.subject_id] || []).push(r.teacher_id);
    if (st === 'ambos' || st === 'laboratorio')
      (subjectLabTeachers[r.subject_id] = subjectLabTeachers[r.subject_id] || []).push(r.teacher_id);
  }

  // aplicar fallback de cuatrimestre
  const _semR  = availRows.filter(r => r.semester === (sched.semester ?? null));
  const _nullR = availRows.filter(r => r.semester == null);
  const _ws    = new Set(_semR.map(r => r.teacher_id));
  const effRows = sched.semester != null
    ? [..._semR, ..._nullR.filter(r => !_ws.has(r.teacher_id))]
    : _nullR;

  const teacherAvailRaw2 = {};
  for (const r of effRows) {
    if (!teacherAvailRaw2[r.teacher_id]) teacherAvailRaw2[r.teacher_id] = {};
    if (!teacherAvailRaw2[r.teacher_id][r.day_of_week]) teacherAvailRaw2[r.teacher_id][r.day_of_week] = [];
    teacherAvailRaw2[r.teacher_id][r.day_of_week].push([timeToMin(r.slot_start), timeToMin(r.slot_end)]);
  }
  const teacherAvail = {};
  for (const [tid, byDay] of Object.entries(teacherAvailRaw2)) {
    teacherAvail[+tid] = {};
    for (const [day, intervals] of Object.entries(byDay)) {
      intervals.sort((a, b) => a[0] - b[0]);
      const merged = [intervals[0].slice()];
      for (let i = 1; i < intervals.length; i++) {
        const last = merged[merged.length - 1];
        if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
        else merged.push(intervals[i].slice());
      }
      teacherAvail[+tid][+day] = merged;
    }
  }

  const preOccTeachers = new Set();
  if (sched.semester != null) {
    const crossRows = await dbAll(`
      SELECT ss.teacher_id, ss.day_of_week, ss.slot_start, ss.slot_end
      FROM schedule_sessions ss
      JOIN schedules sc ON sc.id = ss.schedule_id
      WHERE sc.semester = ? AND sc.id != ? AND ss.teacher_id IS NOT NULL
        AND sc.id IN (
          SELECT MAX(sc2.id) FROM schedules sc2
          WHERE sc2.semester = ? AND sc2.id != ?
          GROUP BY sc2.degree, sc2.year, sc2.semester, COALESCE(sc2.group_letter,'')
        )
    `, [sched.semester, schedId, sched.semester, schedId]);
    for (const r of crossRows) {
      const sMin = timeToMin(r.slot_start), eMin = timeToMin(r.slot_end);
      occupySegment(preOccTeachers, `${r.teacher_id}-${r.day_of_week}`, sMin, eMin);
    }
  }

  const sessions = sessRows.map(r => ({
    session_id:        r.id,
    subject_id:        r.subject_id,
    day:               r.day_of_week,
    start:             r.slot_start,
    end:               r.slot_end,
    subgroup:          r.subgroup,
    teacherCandidates: r.subgroup != null
      ? (subjectLabTeachers[r.subject_id]    || [])
      : (subjectTheoryTeachers[r.subject_id] || []),
  }));

  await dbRun("UPDATE schedule_sessions SET teacher_id=NULL WHERE schedule_id=?", [schedId]);
  assignTeachers(sessions, teacherAvail, preOccTeachers);

  let assigned = 0;
  for (const s of sessions) {
    if (s.teacher_id != null) {
      await dbRun("UPDATE schedule_sessions SET teacher_id=? WHERE id=?", [s.teacher_id, s.session_id]);
      assigned++;
    }
  }
  return { assigned, total: sessions.length };
}

// asignar profesores a todos los horarios activos de un cuatrimestre
router.post("/assign-semester", requireAuth, async (req, res) => {
  try {
    const { semester } = req.body;
    if (semester == null) return res.status(400).json({ error: "semester requerido" });
    const schedules = await dbAll(
      "SELECT id FROM schedules WHERE status='active' AND semester=?", [parseInt(semester)]
    );
    if (!schedules.length) return res.json({ ok: true, assigned: 0, total: 0, count: 0 });
    let totalAssigned = 0, totalSessions = 0;
    for (const sc of schedules) {
      const r = await assignTeachersForSchedule(sc.id);
      totalAssigned += r.assigned;
      totalSessions += r.total;
    }
    res.json({ ok: true, assigned: totalAssigned, total: totalSessions, count: schedules.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// editar el profesor de una sesión concreta
router.patch("/sessions/:id/teacher", requireAdmin, async (req, res) => {
  try {
    const { teacher_id } = req.body;
    await dbRun(
      "UPDATE schedule_sessions SET teacher_id=? WHERE id=?",
      [teacher_id ?? null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// asignar profesores a un horario ya generado (acción manual desde admin)
router.post("/:id/assign-teachers", requireAuth, async (req, res) => {
  try {
    const schedId = parseInt(req.params.id);
    const result  = await assignTeachersForSchedule(schedId);
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.message === "Horario no encontrado" ? 404 : 500;
    res.status(status).json({ error: err.message });
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
             ss.subgroup, ss.teacher_id,
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

// guarda los cambios manuales de arrastrar y soltar
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
