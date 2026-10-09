# Lead Generator — Terminal Edition

Scrapes **Libraries in India** from Google Maps (no paid API) and saves clean CSVs to `exports/`.
Everything is driven from the terminal — no Telegram, no bot token.

Built by **Mannu Yadav**.

## One-line install / update

Paste one line. It installs the extractor if you don't have it, and updates it if you do. It also installs Node.js (asking first) and the browser if they're missing.

**Windows** — open PowerShell (use this line on Windows; the `curl` line below is only for Mac/Linux and will not work in PowerShell):

```powershell
irm https://raw.githubusercontent.com/itsMannuYadav/mgli/main/install.ps1 | iex
```

**macOS / Linux** — open Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/itsMannuYadav/mgli/main/install.sh | bash
```

Both create the `mgli` command. An older copy from a previous zip is upgraded in place and your `.env` and `exports` folder are kept. Then open a **new** terminal and type `mgli`.

## Commands

| Command | What it does |
| --- | --- |
| `mgli` | Start an extraction |
| `mgli update` | Download and install the latest version |
| `mgli doctor` | Check this computer is ready (Node, browser, internet) and print the exact fix commands |
| `mgli version` | Show the installed version |
| `mgli help` | List all commands |

## Supported systems

- **Windows 10/11, macOS and Linux**, with **Node.js 18 or newer**. The installers set Node.js up for you if it's missing.
- On **Linux** the browser needs some system libraries. The installer offers to install them (needs `sudo`). If the browser fails to start, run: `sudo env "PATH=$PATH" npx playwright install-deps chromium`
- If the browser component is missing, `mgli` notices and offers to download it.
- Not sure what's wrong? Run `mgli doctor`.

## Quick start (Windows, with the zip)

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

Needs an internet connection. If the `mgli` command isn't found, run `setup.bat` once more, then open a **new** terminal. Or skip the command entirely: double-click **`update.bat`** in the install folder.

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
update.bat   ← double-click to update (works without the mgli command)
updater.js   ← powers `mgli update`
cli.js       ← terminal prompts + export
scraper.js   ← Google Maps engine (stealth, grid search, enrichment)
exports/     ← CSV output
```

Google Maps rate-limits; the scraper uses random delays. A full city grid search can take 15–45 minutes.
