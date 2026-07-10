import { pathToFileURL } from 'node:url';
import db, { saveProfile, saveSettings, upsertEntry } from './db.js';

// The data that previously lived in the HTML file. Migrated into the DB once.
const seed = {
  profile: { name: "Shawn", sex: "male", age: 35, heightCm: 178, weightKg: 102 },
  settings: { weeklyLossKg: 1, stepsGoal: 10000, weightGoal: 95 },
  entries: {
    "2026-06-22": { intake: 1354, active: 805, steps: 11000, weight: 103.5 },
    "2026-06-23": { intake: 1292, active: 799, steps: 9000, weight: "" },
    "2026-06-24": { intake: 1653, active: 959, steps: 11000, weight: "" },
    "2026-06-25": { intake: 3494, active: 843, steps: 11600, weight: 101.7 },
    "2026-06-26": { intake: 133, active: 1375, steps: 18524, weight: "" }
  }
};

// Demo seeding disabled: the app now starts blank and stays blank on an empty DB.
// (Set SEED=1 to restore the old sample-data behavior.)
export function seedIfEmpty() {
  if (process.env.SEED !== '1') return;
  if (!db.prepare('SELECT 1 FROM profile WHERE id = 1').get()) saveProfile(seed.profile);
  if (!db.prepare('SELECT 1 FROM settings WHERE id = 1').get()) saveSettings(seed.settings);
  if (db.prepare('SELECT COUNT(*) AS n FROM entries').get().n === 0) {
    for (const [date, e] of Object.entries(seed.entries)) upsertEntry(date, e);
  }
}

// Run directly: `npm run migrate`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedIfEmpty();
  console.log('Seed complete:', db.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 'entries.');
}
