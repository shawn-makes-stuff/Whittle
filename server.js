import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as store from './db.js';
import { seedIfEmpty } from './migrate.js';
import { parseEntry, warmUp, getConfig, setConfig, getEngines } from './ai.js';

seedIfEmpty();
store.migrateIntakeToMeals();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, 'public')));

app.get('/api/state', (req, res) => res.json(store.getState()));
app.put('/api/profile', (req, res) => { store.saveProfile(req.body); res.json({ ok: true }); });
app.put('/api/settings', (req, res) => { store.saveSettings(req.body); res.json({ ok: true }); });
app.put('/api/entries/:date', (req, res) => {
  const b = req.body || {};
  store.mergeEntry(req.params.date, { active: b.active, steps: b.steps, weight: b.weight });
  res.json({ ok: true });
});
app.get('/api/ai/config', (req, res) => res.json(getConfig()));
app.put('/api/ai/config', (req, res) => res.json(setConfig(req.body || {})));
app.get('/api/ai/engines', (req, res) => res.json(getEngines()));

app.post('/api/ai', async (req, res) => {
  try {
    const { message, today, sessionId } = req.body || {};
    const day = today || new Date().toISOString().slice(0, 10);
    const session = sessionId || store.createSession().id;
    const state = store.getState();
    const result = await parseEntry({ message, today: day, profile: state.profile, history: state.entries });
    for (const { date, ...fields } of result.changes) store.mergeEntry(date, fields);
    for (const meal of result.meals) store.addMeal(meal);
    store.titleSessionIfNew(session, message);
    store.addChat('user', message, day, session);
    store.addChat('ai', result.answer || '', day, session);
    res.json({ ...result, sessionId: session });
  } catch (err) {
    res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

app.get('/api/chat', (req, res) => res.json(store.listChat(Number(req.query.session) || null)));
app.get('/api/chat/sessions', (req, res) => res.json(store.listSessions()));
app.post('/api/chat/sessions', (req, res) => res.json(store.createSession()));
app.delete('/api/chat/sessions/:id', (req, res) => { store.deleteSession(Number(req.params.id)); res.json({ ok: true }); });

app.get('/api/meals/suggestions', (req, res) => res.json(store.mealSuggestions()));

app.get('/api/meals', (req, res) => res.json(store.listMeals(req.query.date)));

app.post('/api/meals', (req, res) => res.json({ ok: true, meal: store.addMeal(req.body || {}) }));

app.put('/api/meals/:id', (req, res) => { store.updateMeal(Number(req.params.id), req.body || {}); res.json({ ok: true }); });

app.delete('/api/meals/:id', (req, res) => { store.deleteMeal(Number(req.params.id)); res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Whittle: http://localhost:${PORT}`);
  warmUp(); // prime the AI so the first request is quick
});
