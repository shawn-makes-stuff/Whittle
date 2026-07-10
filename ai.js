import { execFile, spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// Uses your local Claude / Codex / Gemini CLI (existing plan) — no API key, no extra billing.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'ai-config.json');
const DEFAULTS = { engine: 'claude', model: 'haiku', effort: 'low', memory: 10 };
const isWin = process.platform === 'win32';

const ENGINES = {
  claude: { label: 'Claude', cmd: 'claude', install: 'npm install -g @anthropic-ai/claude-code', run: runClaude },
  codex: { label: 'Codex', cmd: 'codex', install: 'npm install -g @openai/codex', run: runCodex },
  gemini: { label: 'Gemini', cmd: 'gemini', install: 'npm install -g @google/gemini-cli', run: runGemini }
};

export function getConfig() {
  try { if (existsSync(CONFIG_PATH)) return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { /* fall through to defaults */ }
  return { ...DEFAULTS };
}

export function setConfig(patch = {}) {
  const next = { ...getConfig(), ...patch };
  next.engine = ENGINES[next.engine] ? next.engine : 'claude';
  next.model = typeof next.model === 'string' ? next.model.trim() : '';
  next.effort = ['low', 'medium', 'high'].includes(next.effort) ? next.effort : 'low';
  next.memory = Number.isFinite(+next.memory) ? Math.min(100, Math.max(0, Math.round(+next.memory))) : 10;
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

function cliExists(cmd) {
  try { execFileSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// Which engines are installed (for the settings UI).
export function getEngines() {
  const out = {};
  for (const [k, e] of Object.entries(ENGINES)) out[k] = { label: e.label, installed: cliExists(e.cmd), install: e.install };
  return out;
}

export function parseEntry({ message, today, profile = {}, history = {}, notes = [], convo = [] }) {
  if (!message || !String(message).trim()) return Promise.reject(new Error('Empty message'));
  const cfg = getConfig();
  const prompt = buildPrompt({ message, today, profile, history, notes, convo, memory: cfg.memory });
  // Try the chosen engine first, then any other installed engine as a fallback.
  const order = [cfg.engine, ...Object.keys(ENGINES).filter(e => e !== cfg.engine)];
  const available = order.filter(e => cliExists(ENGINES[e].cmd));
  if (!available.length) {
    return Promise.reject(new Error('No AI CLI found. Install one and pick it in settings:\n' +
      Object.values(ENGINES).map(e => `• ${e.label}: ${e.install}`).join('\n')));
  }
  return (async () => {
    let lastErr;
    for (const eng of available) {
      // On a fallback engine, drop the configured model (it belongs to the chosen engine).
      const useCfg = eng === cfg.engine ? cfg : { ...cfg, model: '' };
      try { return await ENGINES[eng].run(prompt, useCfg); }
      catch (e) { lastErr = e; }
    }
    throw new Error('AI request failed on all available engines. ' + (lastErr?.message || ''));
  })();
}

// Prime Claude so the first real request is quick (caches the big prompt prefix).
export function warmUp() {
  const cfg = getConfig();
  if (cfg.engine !== 'claude' || !cliExists('claude')) return;
  const args = ['-p', 'reply OK', '--output-format', 'json'];
  if (cfg.model) args.push('--model', cfg.model);
  execFile('claude', args, { timeout: 60000, windowsHide: true }, () => {});
}

function runClaude(prompt, cfg) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json',
      '--append-system-prompt', 'Respond with raw JSON only — no markdown, no code fences, no commentary.'];
    if (cfg.model) args.push('--model', cfg.model);
    if (cfg.effort) args.push('--effort', cfg.effort);
    execFile('claude', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error('Claude CLI failed: ' + (err.message || err)));
      try {
        const env = JSON.parse(stdout);
        if (env.is_error) return reject(new Error(env.result || 'AI error'));
        resolve(normalize(extractJson(String(env.result || ''))));
      } catch (e) { reject(new Error('Could not read Claude response: ' + e.message)); }
    });
  });
}

function runCodex(prompt, cfg) {
  return new Promise((resolve, reject) => {
    const out = join(os.tmpdir(), `cal-codex-${Date.now()}.txt`);
    const parts = ['codex', 'exec', '-', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '-o', `"${out}"`];
    if (cfg.model) parts.push('-m', cfg.model);
    if (cfg.effort) parts.push('-c', `model_reasoning_effort="${cfg.effort}"`);
    const child = spawn(parts.join(' '), { shell: true, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => reject(new Error('Codex spawn failed: ' + e.message)));
    child.on('close', code => {
      try {
        const text = readFileSync(out, 'utf8');
        try { unlinkSync(out); } catch { /* ignore */ }
        resolve(normalize(extractJson(text)));
      } catch (e) {
        reject(new Error('Codex CLI failed' + (code ? ` (exit ${code})` : '') + (stderr ? ': ' + stderr.slice(0, 300) : '')));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function runGemini(prompt, cfg) {
  return new Promise((resolve, reject) => {
    const parts = ['gemini'];
    if (cfg.model) parts.push('-m', cfg.model);
    const child = spawn(parts.join(' '), { shell: true, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => reject(new Error('Gemini spawn failed: ' + e.message)));
    child.on('close', code => {
      try { resolve(normalize(extractJson(out))); }
      catch (e) { reject(new Error('Gemini CLI failed' + (code ? ` (exit ${code})` : '') + (err ? ': ' + err.slice(0, 300) : ''))); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildPrompt({ message, today, profile, history, notes = [], convo = [], memory = 10 }) {
  const n = Math.max(0, Math.round(memory)); // 0 = no conversational memory
  const recent = n ? convo.slice(-n) : []; // last few turns for follow-up context
  const transcript = recent.length
    ? recent.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')
    : 'none';
  const h = numOr(profile.heightCm, 175);
  const w = profile.weightKg ?? 'unknown';
  const sex = profile.sex || 'male';
  const age = profile.age ?? 'unknown';
  return [
    `You manage a personal calorie tracker. Today is ${today}. Interpret the user's message: it may LOG or MODIFY entries on any date(s), and/or ASK a question about their records.`,
    `Profile: sex ${sex}, age ${age}, height ${h} cm, weight ${w} kg.`,
    `Existing records (date -> {intake kcal, active kcal, steps, weight kg, protein g, carbs g, fat g}; null = empty):`,
    JSON.stringify(history),
    ``,
    `User's daily notes (date -> note text) — context the user wrote; use them when answering, but never log them as meals or changes:`,
    notes.length ? JSON.stringify(notes) : 'none',
    ``,
    `Formulas (use for answers and estimates):`,
    `- resting burn = Mifflin-St Jeor: (10*kg)+(6.25*cm)-(5*age)+(5 if male, -161 if female). kg = that day's weight, else most recent known weight, else profile weight.`,
    `- if active calories are empty, estimate from steps: round(steps * (0.414*${h}/100/1000) * kg * 0.5).`,
    `- total burn = resting + active(or estimate); deficit = total burn - intake.`,
    ``,
    `Earlier messages in this chat (oldest to newest) — use them to resolve follow-ups and references like "that", "instead", "the lunch I mentioned":`,
    transcript,
    ``,
    `User message: """${message}"""`,
    ``,
    `Resolve relative dates (yesterday, last Tuesday, a week ago) against today (${today}).`,
    `Log each food the user mentions as a MEAL with its own estimate: {date, name, kcal, protein, carbs, fat}. One object per distinct food/dish. Do the calorie math (e.g. 350 g at 300 cal/100g = 1050); estimate macros best-effort.`,
    `Use CHANGES only for non-food: steps (convert any distance with stride = 0.414*height_cm; ADD unless a total is stated), active calories (only if explicitly given as a burn), and weight (REPLACES). Never put food calories or macros in changes.`,
    `If the user says they blew it / went way over / lost count for a day, don't mark anything special — log a single best-effort high MEAL estimate (e.g. name "Blowout — estimate", kcal ~3000-4000) so the day counts honestly.`,
    `Return ONLY this JSON:`,
    `{"answer":"<concise reply: answer the question or confirm what you logged>","meals":[{"date":"YYYY-MM-DD","name":"<food>","kcal":<int>,"protein":<int>,"carbs":<int>,"fat":<int>}],"changes":[{"date":"YYYY-MM-DD","steps":<int>,"active":<int>,"weight":<num>}]}`,
    `Integers except weight (one decimal). Include only the fields that apply. Use "meals":[] and "changes":[] when the user only asked a question.`
  ].join('\n');
}

function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (t[0] !== '{') { const i = t.indexOf('{'), j = t.lastIndexOf('}'); if (i >= 0 && j > i) t = t.slice(i, j + 1); }
  return JSON.parse(t);
}

function normalize(obj) {
  const answer = typeof obj.answer === 'string' ? obj.answer : '';
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const changes = [];
  for (const c of Array.isArray(obj.changes) ? obj.changes : []) {
    if (!c || !valid(c.date)) continue;
    const out = { date: c.date };
    for (const k of ['steps', 'active', 'weight']) { const n = num(c[k]); if (n !== null) out[k] = n; }
    if (Object.keys(out).length > 1) changes.push(out);
  }
  const meals = [];
  for (const m of Array.isArray(obj.meals) ? obj.meals : []) {
    if (!m || !valid(m.date)) continue;
    const kcal = num(m.kcal);
    if (kcal === null) continue;
    meals.push({ date: m.date, name: (typeof m.name === 'string' && m.name.trim()) ? m.name.trim() : 'Meal', kcal, protein: num(m.protein), carbs: num(m.carbs), fat: num(m.fat) });
  }
  return { answer, changes, meals };
}

const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
