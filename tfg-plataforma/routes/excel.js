const express      = require("express");
const multer       = require("multer");
const xlsx         = require("xlsx");
const db           = require("../database/db");
const requireAuth  = require("../middleware/auth");
const requireAdmin = require("../middleware/adminOnly");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

function dbAll(sql, p = []) { return new Promise((ok, ko) => db.all(sql, p, (e, r) => e ? ko(e) : ok(r))); }
function dbGet(sql, p = []) { return new Promise((ok, ko) => db.get(sql, p, (e, r) => e ? ko(e) : ok(r))); }
function dbRun(sql, p = []) { return new Promise((ok, ko) => db.run(sql, p, function(e) { e ? ko(e) : ok(this); })); }

const DAY_COLS    = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"];
const DAY_COLS_C1 = DAY_COLS.map(d => `C1 ${d}`);
const DAY_COLS_C2 = DAY_COLS.map(d => `C2 ${d}`);

const toMin    = t => t.split(":").reduce((h, m) => h * 60 + +m, 0);
const minToTime = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

function mergeIntervals(rows) {
  // convierte [{slot_start, slot_end}] en ["HH:MM-HH:MM", ...]
  if (!rows.length) return [];
  const ivs = rows.map(r => [toMin(r.slot_start), toMin(r.slot_end)]);
  ivs.sort((a, b) => a[0] - b[0]);
  const merged = [[...ivs[0]]];
  for (let i = 1; i < ivs.length; i++) {
    const last = merged[merged.length - 1];
    if (ivs[i][0] <= last[1]) last[1] = Math.max(last[1], ivs[i][1]);
    else merged.push([...ivs[i]]);
  }
  return merged.map(([s, e]) => `${minToTime(s)}-${minToTime(e)}`);
}

function buildRows(teachers, availMap) {
  return teachers.map(t => {
    const bySem = availMap[t.id] || {};
    const entry = {
      Nombre:       t.name       || "",
      Departamento: t.department || "",
      Email:        t.email      || "",
    };
    DAY_COLS.forEach((col, i) => {
      entry[col]         = ((bySem[null] || {})[i] || []).join(", ");
      entry[`C1 ${col}`] = ((bySem[1]   || {})[i] || []).join(", ");
      entry[`C2 ${col}`] = ((bySem[2]   || {})[i] || []).join(", ");
    });
    return entry;
  });
}

function buildWorkbook(rows) {
  const ws = xlsx.utils.json_to_sheet(rows);
  // Ancho automático: máximo de cabecera y contenido de cada columna
  const headers = Object.keys(rows[0] || {});
  ws["!cols"] = headers.map((h, c) => {
    let max = h.length;
    for (const row of rows) {
      const val = String(row[h] ?? "");
      if (val.length > max) max = val.length;
    }
    return { wch: max + 2 };
  });
  // Forzar formato texto en columnas de disponibilidad para que Excel
  // no interprete "08:00-12:00" como fórmula al editar
  const range = xlsx.utils.decode_range(ws["!ref"] || "A1");
  for (let R = range.s.r + 1; R <= range.e.r; R++) {
    for (let C = 3; C <= range.e.c; C++) {
      const addr = xlsx.utils.encode_cell({ r: R, c: C });
      if (ws[addr]) { ws[addr].t = "s"; ws[addr].z = "@"; }
    }
  }
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Profesores");
  return wb;
}

async function fetchAvailMap(teacherIds) {
  let avail;
  if (teacherIds.length) {
    const ph = teacherIds.map(() => "?").join(",");
    avail = await dbAll(
      `SELECT teacher_id, day_of_week, slot_start, slot_end, semester FROM teacher_availability WHERE available=1 AND teacher_id IN (${ph}) ORDER BY teacher_id, semester, day_of_week, slot_start`,
      teacherIds
    );
  } else {
    avail = await dbAll(
      "SELECT teacher_id, day_of_week, slot_start, slot_end, semester FROM teacher_availability WHERE available=1 ORDER BY teacher_id, semester, day_of_week, slot_start"
    );
  }
  // raw[teacherId][semester][day] = [{slot_start, slot_end}]
  const raw = {};
  for (const r of avail) {
    const sem = r.semester ?? null;
    if (!raw[r.teacher_id]) raw[r.teacher_id] = {};
    if (!raw[r.teacher_id][sem]) raw[r.teacher_id][sem] = {};
    if (!raw[r.teacher_id][sem][r.day_of_week]) raw[r.teacher_id][sem][r.day_of_week] = [];
    raw[r.teacher_id][sem][r.day_of_week].push(r);
  }
  // Fusionar intervalos adyacentes por día
  const map = {};
  for (const [tid, bySem] of Object.entries(raw)) {
    map[tid] = {};
    for (const [sem, byDay] of Object.entries(bySem)) {
      const semKey = sem === "null" || sem === null ? null : Number(sem);
      map[tid][semKey] = {};
      for (const [day, rows] of Object.entries(byDay)) {
        map[tid][semKey][day] = mergeIntervals(rows);
      }
    }
  }
  return map;
}

// descarga el Excel con todos los profesores y su disponibilidad
router.get("/professors", requireAuth, async (req, res) => {
  try {
    const teachers = await dbAll(
      "SELECT id, name, department, email FROM teachers ORDER BY name"
    );
    const availMap = await fetchAvailMap([]);
    const wb = buildWorkbook(buildRows(teachers, availMap));
    res.setHeader("Content-Disposition", 'attachment; filename="profesores.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// descarga el Excel de un profesor concreto
router.get("/professors/:id", requireAuth, async (req, res) => {
  try {
    const teacher = await dbGet(
      "SELECT id, name, department, email FROM teachers WHERE id=?",
      [req.params.id]
    );
    if (!teacher) return res.status(404).json({ error: "Profesor no encontrado" });

    const availMap = await fetchAvailMap([teacher.id]);
    const wb = buildWorkbook(buildRows([teacher], availMap));
    const filename = teacher.name.replace(/[^a-z0-9áéíóúñ ]/gi, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// aplica los datos de una fila Excel a un profesor existente
async function applyRowToTeacher(tid, row) {
  const nombre = (row["Nombre"] || "").trim();
  if (nombre) {
    const t = await dbGet("SELECT name FROM teachers WHERE id=?", [tid]);
    if (t && nombre !== t.name) {
      await dbRun("UPDATE teachers SET name=? WHERE id=?", [nombre, tid]);
    }
  }

  const dept  = (row["Departamento"] || "").trim();
  const email = (row["Email"]        || "").trim();
  if (dept || email) {
    const sets = [], vals = [];
    if (dept)  { sets.push("department=?"); vals.push(dept);  }
    if (email) { sets.push("email=?");      vals.push(email); }
    vals.push(tid);
    await dbRun(`UPDATE teachers SET ${sets.join(",")} WHERE id=?`, vals);
  }

  // Importar disponibilidad: General (semester=NULL), C1 (semester=1), C2 (semester=2)
  const semConfig = [
    { cols: DAY_COLS,    semester: null },
    { cols: DAY_COLS_C1, semester: 1    },
    { cols: DAY_COLS_C2, semester: 2    },
  ];
  for (const { cols, semester } of semConfig) {
    const delSql    = semester == null
      ? "DELETE FROM teacher_availability WHERE teacher_id=? AND semester IS NULL"
      : "DELETE FROM teacher_availability WHERE teacher_id=? AND semester=?";
    const delParams = semester == null ? [tid] : [tid, semester];
    await dbRun(delSql, delParams);

    const timeRe = /^\d{1,2}:\d{2}$/;
    for (let i = 0; i < cols.length; i++) {
      const cell = String(row[cols[i]] ?? "").trim();
      if (!cell) continue;
      for (const slot of cell.split(",").map(s => s.trim()).filter(Boolean)) {
        const dash = slot.indexOf("-", 3); // saltar el posible guión en HH
        if (dash < 1) continue;
        const slot_start = slot.slice(0, dash).trim();
        const slot_end   = slot.slice(dash + 1).trim();
        if (!timeRe.test(slot_start) || !timeRe.test(slot_end)) continue;
        await dbRun(
          "INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available, semester) VALUES (?,?,?,?,1,?)",
          [tid, i, slot_start, slot_end, semester]
        );
      }
    }
  }

  const asigCell = (row["Asignaturas"] || "").trim();
  if (asigCell) {
    await dbRun("DELETE FROM subject_teachers WHERE teacher_id=?", [tid]);
    for (const code of asigCell.split(";").map(s => s.trim()).filter(Boolean)) {
      const subj = await dbGet("SELECT id FROM subjects WHERE code=?", [code]);
      if (subj) {
        await dbRun(
          "INSERT OR IGNORE INTO subject_teachers (subject_id, teacher_id) VALUES (?,?)",
          [subj.id, tid]
        );
      }
    }
  }
}

// importación global: actualiza si el nombre coincide, crea si no existe
router.post("/upload", requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió fichero" });

  try {
    const wb   = xlsx.read(req.file.buffer, { type: "buffer" });
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

    let updated = 0, created = 0;
    const skipped = [];

    await dbRun("BEGIN TRANSACTION");
    try {
      for (const row of rows) {
        const nombre = (row["Nombre"] || "").trim();
        const email  = (row["Email"]  || "").trim();
        if (!nombre && !email) continue;

        // Solo el nombre determina si el profesor existe; el email no se usa como clave
        let teacher = null;
        if (nombre) {
          teacher = await dbGet("SELECT id, name FROM teachers WHERE LOWER(name)=LOWER(?)", [nombre]);
        }

        if (teacher) {
          await applyRowToTeacher(teacher.id, row);
          updated++;
        } else {
          if (!nombre) { skipped.push(email || "(sin nombre)"); continue; }
          const dept = (row["Departamento"] || "").trim();
          const r = await dbRun(
            "INSERT INTO teachers (name, department, email) VALUES (?,?,?)",
            [nombre, dept || null, email || null]
          );
          await applyRowToTeacher(r.lastID, row);
          created++;
        }
      }
      await dbRun("COMMIT");
    } catch (e) {
      await dbRun("ROLLBACK");
      throw e;
    }

    res.json({ updated, created, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// importación individual: sobreescribe disponibilidad de un profesor concreto
router.post("/upload/:id", requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió fichero" });

  try {
    const teacher = await dbGet("SELECT id FROM teachers WHERE id=?", [req.params.id]);
    if (!teacher) return res.status(404).json({ error: "Profesor no encontrado" });

    const wb   = xlsx.read(req.file.buffer, { type: "buffer" });
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    if (!rows.length) return res.status(400).json({ error: "El fichero está vacío" });

    await dbRun("BEGIN TRANSACTION");
    try {
      await applyRowToTeacher(teacher.id, rows[0]);
      await dbRun("COMMIT");
    } catch (e) {
      await dbRun("ROLLBACK");
      throw e;
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
