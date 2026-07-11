import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'tracker.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS profile (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    name      TEXT,
    sex       TEXT,
    age       REAL,
    height_cm REAL,
    weight_kg REAL
  );
  CREATE TABLE IF NOT EXISTS settings (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    deficit_goal REAL,
    weight_goal  REAL
  );
  CREATE TABLE IF NOT EXISTS entries (
    date   TEXT PRIMARY KEY,
    intake REAL,
    active REAL,
    steps  REAL,
    weight REAL
  );
  CREATE TABLE IF NOT EXISTS meals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    name       TEXT,
    kcal       REAL,
    protein    REAL,
    carbs      REAL,
    fat        REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);
  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(date);
  CREATE TABLE IF NOT EXISTS journal (
    date       TEXT PRIMARY KEY,
    html       TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chat (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   TEXT DEFAULT (datetime('now')),
    day  TEXT NOT NULL,
    role TEXT,
    text TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_session (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    title   TEXT,
    created TEXT DEFAULT (datetime('now'))
  );
`);

function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('settings', 'weekly_loss_kg', 'REAL');
ensureColumn('settings', 'steps_goal', 'REAL');
ensureColumn('entries', 'protein', 'REAL');
ensureColumn('entries', 'carbs', 'REAL');
ensureColumn('entries', 'fat', 'REAL');
ensureColumn('chat', 'session_id', 'INTEGER');
// Backfill goals for databases created before these columns existed.
db.exec('UPDATE settings SET weekly_loss_kg = COALESCE(weekly_loss_kg, 1), steps_goal = COALESCE(steps_goal, 10000) WHERE id = 1');
// One-time: bundle any pre-sessions chat messages into a single legacy conversation.
{
  const orphan = db.prepare('SELECT COUNT(*) AS n FROM chat WHERE session_id IS NULL').get().n;
  if (orphan > 0) {
    const info = db.prepare('INSERT INTO chat_session (title) VALUES (?)').run('Earlier chats');
    db.prepare('UPDATE chat SET session_id = ? WHERE session_id IS NULL').run(info.lastInsertRowid);
  }
}

const numOrNull = v => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Weight sanity clamp: reject non-positive or absurd (>1000 kg) values so a typo
// can't poison BMR/interpolation. Out-of-range or blank -> null (ignored).
const weightOrNull = v => {
  const n = numOrNull(v);
  return n !== null && n > 0 && n <= 1000 ? n : null;
};

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
// Plain text from journal HTML — for word counts and the AI context.
const stripTags = html => String(html ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();
const countWords = html => { const t = stripTags(html); return t ? t.split(/\s+/).length : 0; };
// Defense-in-depth: drop scripts/styles/iframes and inline event handlers before storing.
const sanitizeHtml = html => String(html ?? '')
  .replace(/<\s*(script|style|iframe)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(/<\s*(script|style|iframe)[^>]*\/?\s*>/gi, '')
  .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
  .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
  .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');

export function getState() {
  const profile = db.prepare(
    'SELECT name, sex, age, height_cm AS heightCm, weight_kg AS weightKg FROM profile WHERE id = 1'
  ).get() || {};
  const settings = db.prepare(
    'SELECT weight_goal AS weightGoal, weekly_loss_kg AS weeklyLossKg, steps_goal AS stepsGoal FROM settings WHERE id = 1'
  ).get() || {};
  const entries = {};
  // active/steps/weight come from the entries table...
  for (const r of db.prepare('SELECT date, active, steps, weight FROM entries ORDER BY date').all()) {
    entries[r.date] = { intake: null, active: r.active, steps: r.steps, weight: r.weight, protein: null, carbs: null, fat: null };
  }
  // ...while intake + macros are the SUM of that day's meals (single source of truth).
  for (const r of db.prepare('SELECT date, SUM(kcal) AS intake, SUM(protein) AS protein, SUM(carbs) AS carbs, SUM(fat) AS fat FROM meals GROUP BY date').all()) {
    const e = entries[r.date] || (entries[r.date] = { intake: null, active: null, steps: null, weight: null, protein: null, carbs: null, fat: null });
    e.intake = r.intake; e.protein = r.protein; e.carbs = r.carbs; e.fat = r.fat;
  }
  const notes = {};
  for (const r of db.prepare('SELECT date, COUNT(*) AS count FROM notes GROUP BY date').all()) notes[r.date] = r.count;
  const journal = {};
  for (const r of db.prepare('SELECT date, html, updated_at AS updatedAt FROM journal').all()) {
    journal[r.date] = { words: countWords(r.html), updatedAt: r.updatedAt };
  }
  return { profile, settings, entries, notes, journal };
}

export function saveProfile(p = {}) {
  db.prepare(`
    INSERT INTO profile (id, name, sex, age, height_cm, weight_kg)
    VALUES (1, @name, @sex, @age, @heightCm, @weightKg)
    ON CONFLICT(id) DO UPDATE SET
      name = @name, sex = @sex, age = @age, height_cm = @heightCm, weight_kg = @weightKg
  `).run({
    name: p.name ?? null,
    sex: p.sex ?? null,
    age: numOrNull(p.age),
    heightCm: numOrNull(p.heightCm),
    weightKg: weightOrNull(p.weightKg)
  });
}

export function saveSettings(s = {}) {
  db.prepare(`
    INSERT INTO settings (id, weight_goal, weekly_loss_kg, steps_goal)
    VALUES (1, @weightGoal, @weeklyLossKg, @stepsGoal)
    ON CONFLICT(id) DO UPDATE SET
      weight_goal = @weightGoal, weekly_loss_kg = @weeklyLossKg, steps_goal = @stepsGoal
  `).run({
    weightGoal: numOrNull(s.weightGoal),
    weeklyLossKg: numOrNull(s.weeklyLossKg),
    stepsGoal: numOrNull(s.stepsGoal)
  });
}

export function upsertEntry(date, e = {}) {
  db.prepare(`
    INSERT INTO entries (date, intake, active, steps, weight, protein, carbs, fat)
    VALUES (@date, @intake, @active, @steps, @weight, @protein, @carbs, @fat)
    ON CONFLICT(date) DO UPDATE SET
      intake = @intake, active = @active, steps = @steps, weight = @weight,
      protein = @protein, carbs = @carbs, fat = @fat
  `).run({
    date,
    intake: numOrNull(e.intake),
    active: numOrNull(e.active),
    steps: numOrNull(e.steps),
    weight: weightOrNull(e.weight),
    protein: numOrNull(e.protein),
    carbs: numOrNull(e.carbs),
    fat: numOrNull(e.fat)
  });
}

// Update the entry for a date. A field is only touched when its key is present in
// `partial`: absent -> keep existing (the AI sends only changed keys); present but
// blank -> clear it (so the table can erase a value the user typed on the wrong day).
export function mergeEntry(date, partial = {}) {
  const cur = db.prepare('SELECT intake, active, steps, weight, protein, carbs, fat FROM entries WHERE date = ?').get(date) || {};
  const pick = k => k in partial ? numOrNull(partial[k]) : (cur[k] ?? null);
  const weight = !('weight' in partial)
    ? (cur.weight ?? null)                     // not provided -> keep
    : (partial.weight === '' || partial.weight === null || partial.weight === undefined)
      ? null                                   // explicitly cleared -> erase
      : (weightOrNull(partial.weight) ?? cur.weight ?? null); // out-of-range typo -> keep existing
  upsertEntry(date, {
    intake: pick('intake'), active: pick('active'), steps: pick('steps'), weight,
    protein: pick('protein'), carbs: pick('carbs'), fat: pick('fat')
  });
}

export function listMeals(date) {
  return db.prepare('SELECT id, name, kcal, protein, carbs, fat FROM meals WHERE date = ? ORDER BY id').all(date);
}

export function addMeal(m = {}) {
  const info = db.prepare(
    'INSERT INTO meals (date, name, kcal, protein, carbs, fat) VALUES (@date, @name, @kcal, @protein, @carbs, @fat)'
  ).run({
    date: m.date,
    name: (m.name && String(m.name).trim()) || 'Meal',
    kcal: numOrNull(m.kcal),
    protein: numOrNull(m.protein),
    carbs: numOrNull(m.carbs),
    fat: numOrNull(m.fat)
  });
  return db.prepare('SELECT id, date, name, kcal, protein, carbs, fat FROM meals WHERE id = ?').get(info.lastInsertRowid);
}

export function updateMeal(id, m = {}) {
  db.prepare(`
    UPDATE meals SET name = @name, kcal = @kcal, protein = @protein, carbs = @carbs, fat = @fat WHERE id = @id
  `).run({
    id,
    name: (m.name && String(m.name).trim()) || 'Meal',
    kcal: numOrNull(m.kcal),
    protein: numOrNull(m.protein),
    carbs: numOrNull(m.carbs),
    fat: numOrNull(m.fat)
  });
}

export function deleteMeal(id) {
  const meal = db.prepare('SELECT id, date, name, kcal, protein, carbs, fat FROM meals WHERE id = ?').get(id);
  if (meal) db.prepare('DELETE FROM meals WHERE id = ?').run(id);
  return meal;
}

export function listNotes(date) {
  return db.prepare('SELECT id, date, text, created_at AS createdAt FROM notes WHERE date = ? ORDER BY id').all(date);
}

export function allNotes() {
  return db.prepare('SELECT date, text FROM notes ORDER BY date, id').all();
}

export function addNote(n = {}) {
  const date = String(n.date || '').trim();
  const text = String(n.text || '').trim();
  if (!date || !text) return null;
  const info = db.prepare('INSERT INTO notes (date, text) VALUES (?, ?)').run(date, text);
  return db.prepare('SELECT id, date, text, created_at AS createdAt FROM notes WHERE id = ?').get(info.lastInsertRowid);
}

export function updateNote(id, n = {}) {
  const text = String(n.text || '').trim();
  if (!text) return deleteNote(id);
  db.prepare('UPDATE notes SET text = ? WHERE id = ?').run(text, id);
  return db.prepare('SELECT id, date, text, created_at AS createdAt FROM notes WHERE id = ?').get(id);
}

export function deleteNote(id) {
  const note = db.prepare('SELECT id, date, text, created_at AS createdAt FROM notes WHERE id = ?').get(id);
  if (note) db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  return note;
}

// --- Journal: one rich-HTML document per day ---

export function getJournal(date) {
  return db.prepare('SELECT date, html, updated_at AS updatedAt FROM journal WHERE date = ?').get(String(date || '')) || null;
}

export function saveJournal(date, html) {
  const d = String(date || '').trim();
  if (!d) return null;
  const clean = sanitizeHtml(html);
  // Blank page (no visible text) means "no entry" — delete rather than store an empty shell.
  if (!stripTags(clean)) { db.prepare('DELETE FROM journal WHERE date = ?').run(d); return null; }
  db.prepare(`
    INSERT INTO journal (date, html, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET html = excluded.html, updated_at = datetime('now')
  `).run(d, clean);
  return getJournal(d);
}

export function listJournal() {
  return db.prepare('SELECT date, html, updated_at AS updatedAt FROM journal ORDER BY date')
    .all().map(r => ({ date: r.date, updatedAt: r.updatedAt, words: countWords(r.html) }));
}

// Journal text per day for the AI — same {date, text} shape the prompt already expects.
export function journalForAI() {
  return db.prepare('SELECT date, html FROM journal ORDER BY date')
    .all().map(r => ({ date: r.date, text: stripTags(r.html) })).filter(r => r.text);
}

// One-time: fold legacy per-day notes into a journal document. Idempotent — skips
// any date that already has a journal entry, so it is safe to run on every boot.
export function migrateNotesToJournal() {
  const dates = db.prepare(`
    SELECT DISTINCT date FROM notes
    WHERE date NOT IN (SELECT date FROM journal)
  `).all().map(r => r.date);
  db.transaction(() => {
    for (const date of dates) {
      const html = db.prepare('SELECT text FROM notes WHERE date = ? ORDER BY id').all(date)
        .map(n => `<p>${escapeHtml(n.text)}</p>`).join('');
      db.prepare("INSERT INTO journal (date, html, updated_at) VALUES (?, ?, datetime('now'))").run(date, html);
    }
  })();
}

// Distinct past meals (most recent values per name) for type-ahead suggestions.
export function mealSuggestions() {
  return db.prepare(`
    SELECT name, kcal, protein, carbs, fat FROM meals
    WHERE id IN (SELECT MAX(id) FROM meals WHERE name IS NOT NULL AND TRIM(name) <> '' GROUP BY name COLLATE NOCASE)
    ORDER BY name COLLATE NOCASE
    LIMIT 200
  `).all();
}

// One-time cleanup: turn any stored intake/macros into a "Logged" meal (so meals
// become the single source of truth), then clear the stored columns. Idempotent.
export function migrateIntakeToMeals() {
  const orphans = db.prepare(`
    SELECT date, intake, protein, carbs, fat FROM entries
    WHERE (intake IS NOT NULL OR protein IS NOT NULL OR carbs IS NOT NULL OR fat IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM meals m WHERE m.date = entries.date)
  `).all();
  db.transaction(() => {
    for (const r of orphans) {
      addMeal({ date: r.date, name: 'Logged', kcal: r.intake, protein: r.protein, carbs: r.carbs, fat: r.fat });
    }
    db.prepare('UPDATE entries SET intake = NULL, protein = NULL, carbs = NULL, fat = NULL').run();
  })();
}

export function addChat(role, text, day, sessionId) {
  db.prepare('INSERT INTO chat (day, role, text, session_id) VALUES (?, ?, ?, ?)').run(day, role, String(text ?? ''), sessionId || null);
}

export function listChat(sessionId, limit = 800) {
  if (sessionId) return db.prepare('SELECT id, day, role, text FROM chat WHERE session_id = ? ORDER BY id ASC LIMIT ?').all(sessionId, limit);
  return db.prepare('SELECT id, day, role, text FROM chat ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

export function createSession(title = 'New chat') {
  const info = db.prepare('INSERT INTO chat_session (title) VALUES (?)').run(title);
  return { id: info.lastInsertRowid, title };
}

export function listSessions() {
  return db.prepare(`
    SELECT s.id, s.title,
      (SELECT COUNT(*) FROM chat c WHERE c.session_id = s.id) AS count,
      (SELECT MAX(c.id) FROM chat c WHERE c.session_id = s.id) AS lastMsg,
      (SELECT c.day FROM chat c WHERE c.session_id = s.id ORDER BY c.id DESC LIMIT 1) AS lastDay
    FROM chat_session s
    ORDER BY COALESCE(lastMsg, s.id) DESC
  `).all();
}

export function renameSession(id, title) {
  db.prepare('UPDATE chat_session SET title = ? WHERE id = ?').run(String(title || 'New chat').slice(0, 80), id);
}

// Name an untitled session from its first message.
export function titleSessionIfNew(id, text) {
  const s = db.prepare('SELECT title FROM chat_session WHERE id = ?').get(id);
  if (s && (!s.title || s.title === 'New chat')) renameSession(id, String(text || '').trim().slice(0, 60) || 'New chat');
}

export function deleteSession(id) {
  db.prepare('DELETE FROM chat WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM chat_session WHERE id = ?').run(id);
}

export default db;
