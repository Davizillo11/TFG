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

const DAY_COLS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"];

function buildRows(teachers, availMap) {
  return teachers.map(t => {
    const dayMap = availMap[t.id] || {};
    const entry  = {
      Nombre:       t.name          || "",
      Departamento: t.department    || "",
      Email:        t.email         || "",
      Asignaturas:  t.subject_codes || "",
    };
    DAY_COLS.forEach((col, i) => {
      entry[col] = (dayMap[i] || []).join(", ");
    });
    return entry;
  });
}

function buildWorkbook(rows) {
  const ws = xlsx.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 28 }, { wch: 20 }, { wch: 28 }, { wch: 35 },
    { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 },
  ];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Profesores");
  return wb;
}

async function fetchAvailMap(teacherIds) {
  let avail;
  if (teacherIds.length) {
    const ph = teacherIds.map(() => "?").join(",");
    avail = await dbAll(
      `SELECT teacher_id, day_of_week, slot_start, slot_end FROM teacher_availability WHERE available=1 AND teacher_id IN (${ph}) ORDER BY teacher_id, day_of_week, slot_start`,
      teacherIds
    );
  } else {
    avail = await dbAll(
      "SELECT teacher_id, day_of_week, slot_start, slot_end FROM teacher_availability WHERE available=1 ORDER BY teacher_id, day_of_week, slot_start"
    );
  }
  const map = {};
  for (const r of avail) {
    if (!map[r.teacher_id]) map[r.teacher_id] = {};
    if (!map[r.teacher_id][r.day_of_week]) map[r.teacher_id][r.day_of_week] = [];
    map[r.teacher_id][r.day_of_week].push(`${r.slot_start}-${r.slot_end}`);
  }
  return map;
}

// ── GET /api/v1/excel/professors — todos los profesores ──
router.get("/professors", requireAuth, async (req, res) => {
  try {
    const teachers = await dbAll(`
      SELECT t.id, t.name, t.department, t.email,
             GROUP_CONCAT(sub.code, '; ') AS subject_codes
      FROM teachers t
      LEFT JOIN subject_teachers st ON st.teacher_id = t.id
      LEFT JOIN subjects sub ON sub.id = st.subject_id
      GROUP BY t.id ORDER BY t.name
    `);
    const availMap = await fetchAvailMap([]);
    const wb = buildWorkbook(buildRows(teachers, availMap));
    res.setHeader("Content-Disposition", 'attachment; filename="profesores.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/v1/excel/professors/:id — un profesor ──
router.get("/professors/:id", requireAuth, async (req, res) => {
  try {
    const teacher = await dbGet(`
      SELECT t.id, t.name, t.department, t.email,
             GROUP_CONCAT(sub.code, '; ') AS subject_codes
      FROM teachers t
      LEFT JOIN subject_teachers st ON st.teacher_id = t.id
      LEFT JOIN subjects sub ON sub.id = st.subject_id
      WHERE t.id=?
      GROUP BY t.id
    `, [req.params.id]);
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

// Aplica los datos de una fila Excel a un teacher existente
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

  for (let i = 0; i < DAY_COLS.length; i++) {
    await dbRun("DELETE FROM teacher_availability WHERE teacher_id=? AND day_of_week=?", [tid, i]);
    const cell = (row[DAY_COLS[i]] || "").trim();
    if (!cell) continue;
    for (const slot of cell.split(",").map(s => s.trim()).filter(Boolean)) {
      const dash = slot.lastIndexOf("-");
      if (dash < 1) continue;
      const slot_start = slot.slice(0, dash).trim();
      const slot_end   = slot.slice(dash + 1).trim();
      if (!slot_start || !slot_end) continue;
      await dbRun(
        "INSERT INTO teacher_availability (teacher_id, day_of_week, slot_start, slot_end, available) VALUES (?,?,?,?,1)",
        [tid, i, slot_start, slot_end]
      );
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

// ── POST /api/v1/excel/upload — subida global ──
// Actualiza si nombre/email coincide; crea nuevo profesor si no existe.
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

// ── POST /api/v1/excel/upload/:id — subida individual ──
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
