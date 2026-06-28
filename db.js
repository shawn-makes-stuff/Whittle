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
  return { profile, settings, entries };
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
    weightKg: numOrNull(p.weightKg)
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
    weight: numOrNull(e.weight),
    protein: numOrNull(e.protein),
    carbs: numOrNull(e.carbs),
    fat: numOrNull(e.fat)
  });
}

// Update only the provided (finite) fields for a date, keeping the rest. Used by the AI.
export function mergeEntry(date, partial = {}) {
  const cur = db.prepare('SELECT intake, active, steps, weight, protein, carbs, fat FROM entries WHERE date = ?').get(date) || {};
  const pick = k => { const v = numOrNull(partial[k]); return v !== null ? v : (cur[k] ?? null); };
  upsertEntry(date, {
    intake: pick('intake'), active: pick('active'), steps: pick('steps'), weight: pick('weight'),
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
      (SELECT MAX(c.id) FROM chat c WHERE c.session_id = s.id) AS lastMsg
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
