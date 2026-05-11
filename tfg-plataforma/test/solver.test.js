'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getSessionDurations,
  solveGreedy,
  rescueExtremeSlots,
  occupySegment,
} = require('../lib/solver');

// ── Helpers ───────────────────────────────────────

function makeSubject(id, overrides = {}) {
  return {
    id,
    teacherIds: [],
    groupKey: null,
    transversal: false,
    year: 2,
    semester: 1,
    groupLetter: null,
    ...overrides,
  };
}

// Mon–Thu (days 0–3): pref 10:00, 12:00 | late 15:00, 17:00 | extreme 08:00
const DURACION = 120;
const FIN_MIN  = 19 * 60;
const DIAS     = [0, 1, 2, 3];
const startTimes = DIAS.flatMap(d => [
  { dia: d, startMin: 10 * 60 },
  { dia: d, startMin: 12 * 60 },
  { dia: d, startMin: 15 * 60 },
  { dia: d, startMin: 17 * 60 },
  { dia: d, startMin:  8 * 60, isExtreme: true },
]);
const partialMins = new Set();
const teacherAvail = {};

// ── Tests ─────────────────────────────────────────

test('getSessionDurations splits weekly hours into sessions', () => {
  assert.deepStrictEqual(getSessionDurations(2, 120), [120]);
  assert.deepStrictEqual(getSessionDurations(3, 120), [120, 60]);
  assert.deepStrictEqual(getSessionDurations(4, 120), [120, 120]);
  assert.deepStrictEqual(getSessionDurations(5, 120), [120, 120, 60]);
  assert.deepStrictEqual(getSessionDurations(6, 120), [120, 120, 120]);
  assert.deepStrictEqual(getSessionDurations(1, 120), [60]);
});

test('solver places all sessions when resources are sufficient', () => {
  const subjects = [1, 2, 3].map(id => makeSubject(id));
  const aula = { id: 10 };
  const allSessions = subjects.map(s => ({ subject: s, dur: DURACION }));
  const validAulas  = Object.fromEntries(subjects.map(s => [s.id, [aula]]));

  const result = solveGreedy(allSessions, validAulas, startTimes, FIN_MIN, teacherAvail, DURACION, partialMins);
  assert.strictEqual(result.filter(r => r !== null).length, 3);
});

test('no teacher double-booking in greedy output', () => {
  const subjects = [1, 2, 3, 4].map(id => makeSubject(id, { teacherIds: [1] }));
  const aula = { id: 10 };
  const allSessions = subjects.map(s => ({ subject: s, dur: DURACION }));
  const validAulas  = Object.fromEntries(subjects.map(s => [s.id, [aula]]));

  const result = solveGreedy(allSessions, validAulas, startTimes, FIN_MIN, teacherAvail, DURACION, partialMins);
  const placed = result.filter(Boolean);

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.teacherId === b.teacherId && a.teacherId !== null && a.dia === b.dia) {
        assert.ok(
          a.endMin <= b.startMin || b.endMin <= a.startMin,
          `teacher ${a.teacherId} double-booked day ${a.dia}: ${a.startMin}–${a.endMin} vs ${b.startMin}–${b.endMin}`
        );
      }
    }
  }
});

test('no classroom double-booking in greedy output', () => {
  const aula = { id: 10 };
  const subjects = [1, 2, 3, 4].map(id => makeSubject(id));
  const allSessions = subjects.map(s => ({ subject: s, dur: DURACION }));
  const validAulas  = Object.fromEntries(subjects.map(s => [s.id, [aula]]));

  const result = solveGreedy(allSessions, validAulas, startTimes, FIN_MIN, teacherAvail, DURACION, partialMins);
  const placed = result.filter(Boolean);

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.aulaId === b.aulaId && a.dia === b.dia) {
        assert.ok(
          a.endMin <= b.startMin || b.endMin <= a.startMin,
          `classroom ${a.aulaId} double-booked day ${a.dia}`
        );
      }
    }
  }
});

test('no group time overlap in greedy output', () => {
  const GK = 'GIT|2';
  const subjects = [1, 2, 3, 4].map(id => makeSubject(id, { groupKey: GK }));
  const aula = { id: 10 };
  const allSessions = subjects.map(s => ({ subject: s, dur: DURACION }));
  const validAulas  = Object.fromEntries(subjects.map(s => [s.id, [aula]]));

  const result = solveGreedy(allSessions, validAulas, startTimes, FIN_MIN, teacherAvail, DURACION, partialMins);
  const placed = result.filter(Boolean);

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.dia === b.dia) {
        assert.ok(
          a.endMin <= b.startMin || b.endMin <= a.startMin,
          `group ${GK} overlap day ${a.dia}: ${a.startMin}–${a.endMin} vs ${b.startMin}–${b.endMin}`
        );
      }
    }
  }
});

test('rescueExtremeSlots moves session from 08:00 to preferred slot when one is free', () => {
  const subject = makeSubject(1);
  const aula    = { id: 1 };
  const dur     = DURACION;
  const extremeStart = 8 * 60;
  const extremeEnd   = extremeStart + dur;

  const result      = [{ aulaId: 1, dia: 0, startMin: extremeStart, dur, endMin: extremeEnd, teacherId: null }];
  const allSessions = [{ subject, dur }];

  const occupied = { aulas: new Set(), teachers: new Set(), groups: new Set() };
  occupySegment(occupied.aulas, '1-0', extremeStart, extremeEnd);

  const subjectSessions = { 1: [{ dia: 0, startMin: extremeStart, endMin: extremeEnd }] };
  const localStartTimes = [
    { dia: 0, startMin: 10 * 60 },
    { dia: 0, startMin: 12 * 60 },
    { dia: 0, startMin: extremeStart, isExtreme: true },
  ];

  rescueExtremeSlots(
    result, allSessions, occupied, new Map(), subjectSessions,
    localStartTimes, FIN_MIN, dur, new Set(), {},
    new Set(), new Set(), {}, { 1: [aula] }
  );

  assert.ok(result[0] !== null, 'session still placed after rescue');
  assert.ok(
    result[0].startMin >= 10 * 60 && result[0].startMin < 14 * 60,
    `expected pref slot (600–840), got ${result[0].startMin}`
  );
});

test('transversal sessions are placed on Friday (day 4) only', () => {
  const diasFriday = [0, 1, 2, 3, 4];
  const stFriday   = diasFriday.flatMap(d => [
    { dia: d, startMin: 10 * 60 },
    { dia: d, startMin: 12 * 60 },
    { dia: d, startMin:  8 * 60, isExtreme: true },
  ]);

  const subject     = makeSubject(1, { transversal: true, year: 1, semester: 1 });
  const aula        = { id: 1 };
  const allSessions = [{ subject, dur: DURACION }, { subject, dur: DURACION }];
  const validAulas  = { 1: [aula] };

  const result = solveGreedy(allSessions, validAulas, stFriday, FIN_MIN, teacherAvail, DURACION, new Set());
  const placed = result.filter(Boolean);

  assert.ok(placed.length > 0, 'at least one session placed');
  for (const r of placed) {
    assert.strictEqual(r.dia, 4, `transversal must be on Friday (day 4), got day ${r.dia}`);
  }
});
