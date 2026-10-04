# Lead Generator — Terminal Edition

Scrapes **Libraries in India** from Google Maps (no paid API) and saves clean CSVs to `exports/`.
Everything is driven from the terminal — no Telegram, no bot token.

Built by **Mannu Yadav**.

## Quick start (Windows)

1. Install [Node.js LTS](https://nodejs.org) (one time).
2. Unzip this folder anywhere.
3. Double-click **`setup.bat`** (one time).
4. Double-click **`run.bat`** whenever you want to extract.

After setup you can open any terminal and type **`mgli`** to start, and **`mgli update`** to get the latest version.

CSV files appear in the `exports` folder. Read `PRO_SAFETY_GUIDE.md` before running big searches.

## Updating

New versions are released often. To get the latest one, open any terminal and run:

```bash
mgli update
```

That's it — no need to download a new zip. It downloads the newest code and installs it, and your own files are never touched (`exports/`, your saved name, `.env`). If you're already up to date it says so. You'll also see a yellow "new version available" box when you start `mgli`.

Needs an internet connection. If the `mgli` command isn't found, run `setup.bat` once more, then open a **new** terminal.

## Setup (manual)

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm start
```

You'll be asked:

0. **Your name** — stamped on your CSV files (remembered for next time)
1. **City** — e.g. `Lucknow`
2. **Specific areas** — optional, comma-separated
3. **How many leads** — a number or `all`
4. **Hunt emails & socials** — visits each business website
5. **Phone / email filters** — keep only leads that have them
6. Review summary → confirm

Business type (**Library**) and country (**India**) are fixed — edit `BUSINESS` / `COUNTRY` at the top of `cli.js` to change them.

## Stopping and resuming

- Progress is saved to disk as the search runs, so a crash, a closed window or a power cut doesn't lose your leads.
- Next time you start `mgli`, it offers **"Resume it?"**: press Enter to carry on where it stopped.
- To stop on purpose, press **Ctrl+C twice** (the first press only asks you to confirm, so copying text can't stop a long run by accident). Your results so far are saved to a CSV.
- Tip: in Windows Terminal, copy selected text with **Ctrl+Shift+C**.


## Output

- `exports/Targeted_Leads_<...>.csv` — leads matching your filters
- `exports/Full_Master_Dataset_<...>.csv` — everything found (only written when filters removed some leads)

## Optional

Set `USE_FREE_PROXIES=true` in `.env` to rotate free public proxies (see `.env.example`).

## Files

```
setup.bat    ← one-time install
run.bat      ← double-click to start
updater.js   ← powers `mgli update`
cli.js       ← terminal prompts + export
scraper.js   ← Google Maps engine (stealth, grid search, enrichment)
exports/     ← CSV output
```

Google Maps rate-limits; the scraper uses random delays. A full city grid search can take 15–45 minutes.
