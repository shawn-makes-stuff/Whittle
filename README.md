# Whittle

**Whittle it down.** A local, private weekly calorie + macro tracker that runs as a small desktop app
(system-tray + browser/PWA window). Food is logged as meals (by you or an AI
assistant), and intake/macros are derived from them. The AI runs through a CLI you
already have installed (Claude, Codex, or Gemini) — **no API keys, no extra billing**.

- **Backend:** Node + Express + SQLite (`better-sqlite3`). All data lives in `tracker.db`.
- **Frontend:** a single static page (`public/index.html`) — installable as a PWA.
- **Desktop shell:** a system-tray launcher (`tray.js`) that runs the server and opens the app.
- **AI:** shells out to your local `claude` / `codex` / `gemini` CLI; auto-falls back if one fails.

Works on **Windows, Linux, and macOS** and in **any modern browser**.

<img width="877" height="1288" alt="image" src="https://github.com/user-attachments/assets/1c246774-ab7a-4423-b903-7db89b9833f4" />




## Requirements

- **Node.js 18+** (20/22 recommended).
- A build toolchain for `better-sqlite3` native module:
  - **Windows:** usually works out of the box (prebuilt binaries).
  - **Linux:** `sudo apt install build-essential python3` (or your distro's equivalent) if a prebuilt binary isn't available.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **At least one AI CLI** for the assistant (optional but recommended). Install whichever you use:
  - Claude: `npm install -g @anthropic-ai/claude-code`
  - Codex: `npm install -g @openai/codex`
  - Gemini: `npm install -g @google/gemini-cli`

  Sign in to that CLI once (per its own instructions). The tracker uses your existing plan.



## Setup

```bash
git clone <your-repo-url> whittle
cd whittle
npm install
npm start
```

`npm start` launches the tray app: it starts the server, shows a tray icon, and opens
the app. The first run seeds a little sample data and creates `tracker.db`.

Open it any time at **http://localhost:3000**.

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Tray icon + server, opens the app (the normal way to run it). |
| `npm run serve` | Server only (no tray) — handy for headless or debugging. |
| `npm run migrate` | Seed the database manually (also happens automatically on first start). |
| `npm run autostart:on` / `:off` | Launch on login (Windows Run key / Linux `~/.config/autostart`). |

Set a different port with `PORT=8080 npm start`.



## Install as a desktop app (any browser)

Open the app and use your browser's **Install** action:

- **Edge/Chrome/Brave:** an install icon in the address bar, or menu → *Apps → Install*, or the in-app **Settings → Desktop app → Install** button.
- After installing you get a real app window with its own icon and taskbar/dock entry; pin it if you like.

On **Windows**, once installed, the tray's **Open tracker** launches the installed app
directly (correct icon). If it isn't installed yet, the tray opens your default browser so
the install prompt is visible. On Linux/macOS the tray opens your default browser.

> The tray keeps the local server running, which is what the app/PWA loads — so keep it
> running (or enable **Start on login**).



## Using it

- **Timeframe:** one control drives the whole dashboard (table, stats, and chart).
  Pick a preset (today / this week / 4–12 weeks) or open the **calendar icon** to
  choose a single day or a custom start→end range.
- **Table:** each day's active calories, steps, and weight are editable. Calories and
  macros are **read-only** — they're the sum of that day's meals.
- **Meals:** click a day (or its 🍔 icon) to add/edit/delete meals. Typing a meal name
  suggests ones you've logged before and auto-fills its calories/macros.
- **Real burn (measured TDEE):** after ~2 weeks of logging (14 food days + a couple of
  weigh-ins), the stats headline shows your *measured* maintenance calories, derived from
  actual intake vs. your weight trend rather than a formula — plus a suggested daily intake
  for your goal. Days with no food logged show no deficit (an untracked gap, not a phantom win).
- **Reports:** the chart switches between Intake vs burn, Deficit, Weight, Steps,
  Macros, and **Goal rings** (deficit / steps / protein vs your goals). Macro targets
  are suggested from your goals and shown as faded bars.
- **Progress:** an **XP bar** and **achievements** (100 of them, including silly ones)
  reward consistency. **Streaks** in the top bar track logging, step-goal, deficit, and
  weekly-goal runs.
- **AI assistant** (chat panel): tell it what you ate or ask about your data, e.g.
  *"350g chicken and rice, walked 5km"* or *"what was my deficit yesterday?"*. Pick the
  engine / model / effort above the chat. Conversations are saved in a collapsible
  sidebar — start new ones, switch between them, or delete them.

### Goals & profile

Open **Settings** (the profile chip, top-right): set your profile (used for resting-burn
estimates), goals (weekly weight-loss, daily steps, target weight), theme, and install
the desktop app. Settings, achievements, and the date picker all share one popout modal.



## Data & privacy

Everything is local. Your log lives in `tracker.db` (SQLite) next to the app; AI prefs
are in `ai-config.json`. **Back up by copying `tracker.db`.** Nothing is sent anywhere
except the prompts your chosen CLI sends to its own provider.



## Troubleshooting

- **"No AI CLI found"** in chat → install one of the CLIs above and pick it in Settings.
  If your chosen engine fails, the app automatically tries the other installed ones.
- **Tray icon missing on Linux** → some desktops (e.g. GNOME) need a system-tray/AppIndicator
  extension. The server still runs; open http://localhost:3000 directly.
- **`better-sqlite3` build errors** → install the build tools listed under Requirements, then `npm install` again.
- **Port already in use** → run with a different `PORT`.



## Project layout

```
server.js     Express API + static hosting
db.js         SQLite schema + queries (profile, settings, entries, meals, chat)
ai.js         CLI bridge (Claude/Codex/Gemini), engine detection + fallback
migrate.js    one-time seed
tray.js       system-tray launcher + app window
autostart.js  enable/disable launch on login (Windows/Linux)
public/       index.html (UI), manifest, service worker, icons
```
