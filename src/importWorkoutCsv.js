const REQUIRED_COLUMNS = ["workout", "start", "exercise"];

function parseCsvRows(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(values => values.some(value => String(value).trim() !== ""));
}

function localDateFromMillis(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationSeconds(value) {
  if (!value) return null;
  const parts = String(value).split(":").map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function booleanValue(value) { return String(value).toLowerCase() === "true"; }

function inferWorkoutType(name) {
  const title = String(name || "").toLowerCase();
  if (/posterior|quad|glute|\bleg/.test(title)) return "Legs";
  if (/chest|tricep/.test(title)) return "Push";
  if (/back|bicep/.test(title)) return "Pull";
  return "Other";
}

function importedWeight(record) {
  const assistance = numberOrNull(record.assistingWeight);
  if (assistance !== null && assistance !== 0) return -Math.abs(assistance);
  const bodyweight = numberOrNull(record.bodyweight);
  if (bodyweight !== null) {
    const extra = numberOrNull(record.extraWeight);
    return extra && extra > 0 ? extra : 0;
  }
  return numberOrNull(record.weight);
}

export function parseWorkoutCsv(text) {
  const rows = parseCsvRows(String(text || ""));
  if (rows.length < 2) throw new Error("The CSV has no workout rows.");
  const headers = rows[0].map((value, index) => String(value).replace(index === 0 ? /^\uFEFF/ : /$^/, "").trim());
  const missing = REQUIRED_COLUMNS.filter(column => !headers.includes(column));
  if (missing.length) throw new Error(`Unsupported CSV format. Missing: ${missing.join(", ")}.`);

  const records = rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  const groups = new Map();
  let skippedRows = 0;
  records.forEach(record => {
    const start = numberOrNull(record.start);
    const date = localDateFromMillis(start);
    const exercise = String(record.exercise || "").trim();
    const reps = numberOrNull(record.reps);
    const duration = durationSeconds(record.time);
    if (!start || !date || !exercise || (reps === null && duration === null)) { skippedRows++; return; }
    const key = String(start);
    if (!groups.has(key)) groups.set(key, { record, date, exercises: new Map() });
    const group = groups.get(key);
    if (!group.exercises.has(exercise)) group.exercises.set(exercise, []);
    const set = { reps: reps ?? 0, weight: importedWeight(record) };
    if (duration !== null) set.duration_sec = duration;
    if (booleanValue(record.warmup)) set.warmup = true;
    if (booleanValue(record.max)) set.max = true;
    if (booleanValue(record.fail)) set.fail = true;
    const comment = String(record.setComment || "").trim();
    if (comment) set.note = comment;
    group.exercises.get(exercise).push(set);
  });

  const entries = [...groups.entries()].map(([start, group]) => {
    const source = group.record;
    const entry = {
      kind: "strength",
      date: group.date,
      type: inferWorkoutType(source.workout),
      name: String(source.workout || "Imported workout").trim(),
      importId: `workout-csv:${start}`,
      startedAt: Number(start),
      exercises: [...group.exercises.entries()].map(([name, sets]) => ({ name, sets })),
    };
    const end = numberOrNull(source.end);
    if (end !== null) entry.endedAt = end;
    const note = String(source.workoutComment || "").trim();
    if (note) entry.note = note;
    return entry;
  });
  if (!entries.length) throw new Error("No supported workouts were found in this CSV.");
  return { entries, rowCount: records.length, skippedRows };
}
