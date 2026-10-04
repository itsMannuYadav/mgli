#!/usr/bin/env node
// Needs Node 18+. Checked first, before loading anything that could fail on an old Node.
if (Number(process.versions.node.split('.')[0]) < 18) {
    const fix = { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node   (or download from https://nodejs.org)' }[process.platform]
        || 'install Node.js LTS from https://nodejs.org (or use nvm)';
    console.error(`\n  Node.js 18 or newer is required (you have ${process.versions.node}).\n  Fix:  ${fix}\n  Then open a NEW terminal and run mgli again.\n`);
    process.exit(1);
}
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const readline = require('readline');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createObjectCsvWriter } = require('csv-writer');
const GoogleMapsScraper = require('./scraper');
const { runUpdate, updateAvailable } = require('./updater');

// ─────────────────────────────────────────────────────────────────────────────
// FIXED SEARCH SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS = 'Library';
const COUNTRY = 'India';

const EXPORTS_DIR = path.join(__dirname, 'exports');
const STATS_FILE = path.join(__dirname, 'stats.json');
const USER_FILE = path.join(__dirname, 'last-user.json');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
const DISCARDED_FILE = path.join(__dirname, 'progress.discarded.json');

// Progress of the current run, saved as it goes so a crash or accidental stop doesn't lose the work.
function saveProgress(state) {
    try {
        const tmp = PROGRESS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ ...state, savedAt: Date.now() }));
        fs.renameSync(tmp, PROGRESS_FILE);
    } catch (e) {}
}
function loadProgress() {
    try {
        const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        return p && p.city && Array.isArray(p.leads) ? p : null;
    } catch (e) { return null; }
}
function clearProgress() { try { fs.unlinkSync(PROGRESS_FILE); } catch (e) {} }
function discardProgress() {
    try { fs.renameSync(PROGRESS_FILE, DISCARDED_FILE); } catch (e) {}
}

const CSV_HEADER = [
    { id: 'name',         title: 'Business Name' },
    { id: 'verification', title: 'Verification Status' },
    { id: 'category',     title: 'Category' },
    { id: 'rating',       title: 'Rating' },
    { id: 'reviews',      title: 'Reviews' },
    { id: 'phone',        title: 'Phone' },
    { id: 'email',        title: 'Email (Primary)' },
    { id: 'allEmails',    title: 'All Emails Found' },
    { id: 'website',      title: 'Website' },
    { id: 'socials',      title: 'Social Media Links' },
    { id: 'hours',        title: 'Opening Hours' },
    { id: 'tags',         title: 'Amenities / Tags' },
    { id: 'address',      title: 'Address' },
    { id: 'state',        title: 'State' },
    { id: 'zip',          title: 'Zip Code' },
    { id: 'lat',          title: 'Latitude' },
    { id: 'lng',          title: 'Longitude' },
    { id: 'mapsUrl',      title: 'Google Maps Link' },
    { id: 'extractedBy',  title: 'Extracted By' },
    { id: 'extractedOn',  title: 'Extracted On' },
];

// ─────────────────────────────────────────────────────────────────────────────
// UI KIT (dependency-free ANSI; falls back to plain text when not a TTY)
// ─────────────────────────────────────────────────────────────────────────────
const TTY = (!!process.stdout.isTTY || !!process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (TTY ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const c = {
    bold: wrap(1, 22), dim: wrap(2, 22),
    red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39),
    blue: wrap(34, 39), magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const visLen = (s) => stripAnsi(s).length;
const WIDTH = Math.min(Math.max((process.stdout.columns || 80) - 2, 50), 68);

function box(lines, color = c.cyan) {
    const inner = WIDTH - 2;
    const out = [color('╭' + '─'.repeat(inner) + '╮')];
    for (const l of lines) {
        const pad = Math.max(0, inner - 2 - visLen(l));
        out.push(color('│') + ' ' + l + ' '.repeat(pad) + ' ' + color('│'));
    }
    out.push(color('╰' + '─'.repeat(inner) + '╯'));
    return out.join('\n');
}

function center(s) {
    const pad = Math.max(0, Math.floor((WIDTH - 4 - visLen(s)) / 2));
    return ' '.repeat(pad) + s;
}

function bar(done, total, width = 24) {
    const ratio = total > 0 ? Math.min(1, done / total) : 0;
    const filled = Math.round(ratio * width);
    return c.cyan('█'.repeat(filled)) + c.gray('░'.repeat(width - filled)) + ' ' + c.bold(`${Math.round(ratio * 100)}%`);
}

function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE STATUS LINE (one in-place line + a spinner; log lines print above it)
// ─────────────────────────────────────────────────────────────────────────────
const live = {
    text: '', timer: null, frame: 0, startedAt: 0,
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    clear() { if (TTY) process.stdout.write('\r\x1b[2K'); },
    draw() {
        if (!TTY || !this.text) return;
        const spin = c.cyan(this.frames[this.frame % this.frames.length]);
        const elapsed = c.gray(formatDuration(Date.now() - this.startedAt));
        const line = `${spin} ${this.text}  ${elapsed}`;
        const max = (process.stdout.columns || 80) - 1;
        process.stdout.write('\r\x1b[2K' + (visLen(line) > max ? stripAnsi(line).slice(0, max - 1) + '…' : line));
    },
    set(text) { this.text = text; if (!TTY) return; this.draw(); },
    start() {
        this.startedAt = Date.now();
        if (!TTY) return;
        process.stdout.write('\x1b[?25l'); // hide cursor
        this.timer = setInterval(() => { this.frame++; this.draw(); }, 100);
    },
    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.text = '';
        this.clear();
        if (TTY) process.stdout.write('\x1b[?25h');
    },
};

// Print a permanent line above the live status line.
function say(line = '') {
    live.clear();
    process.stdout.write(line + '\n');
    live.draw();
}

// Route scraper chatter ([Scraper] ...) through the UI, dimmed, so it never garbles the status line.
function quietConsole() {
    const tidy = (args) => args.map((a) => (typeof a === 'string' ? a : String(a?.message || a))).join(' ');
    console.log = (...a) => {
        const t = tidy(a);
        if (/^\[Scraper\] (Searching|Initializing)/.test(t)) return; // we show our own progress
        say(c.gray('  ' + t));
    };
    console.warn = (...a) => say(c.yellow('  ⚠ ' + tidy(a).replace(/^\[Scraper\]\s*(⚠️\s*)?/, '')));
    console.error = (...a) => say(c.red('  ✖ ' + tidy(a).replace(/^\[Scraper\]\s*/, '')));
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPTS
// ─────────────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', () => {
    console.log('\n\n' + c.gray('  Cancelled. Goodbye!'));
    process.exit(0);
});

const TOTAL_STEPS = 6;
let who = ''; // the person running the extraction; used to address them by name

const titleCase = (n) => n.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
const firstName = () => who.split(' ')[0];
const personalize = (title) => (who ? `${firstName()}, ${title[0].toLowerCase()}${title.slice(1)}` : title);

function loadLastUser() {
    try { return JSON.parse(fs.readFileSync(USER_FILE, 'utf8')).name || ''; } catch (e) { return ''; }
}
function saveLastUser(name) {
    try { fs.writeFileSync(USER_FILE, JSON.stringify({ name })); } catch (e) {}
}

function ask(step, title, hint, defaultText) {
    const head = `\n${c.cyan(c.bold(`  ${step ? `[${step}/${TOTAL_STEPS}] ` : ''}${personalize(title)}`))}`;
    const tail = hint ? `\n  ${c.gray(hint)}` : '';
    const def = defaultText ? c.gray(` (${defaultText})`) : '';
    return new Promise((resolve) => {
        console.log(head + tail);
        rl.question(`  ${c.magenta('❯')}${def} `, (a) => resolve(a.trim()));
    });
}

async function askRequired(step, title, hint) {
    while (true) {
        const answer = await ask(step, title, hint);
        if (answer) return answer;
        console.log('  ' + c.red('✖ This one is required.'));
    }
}

async function askYesNo(step, title, hint, defaultYes) {
    while (true) {
        const answer = (await ask(step, title, hint, defaultYes ? 'Y/n' : 'y/N')).toLowerCase();
        if (!answer) return defaultYes;
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
        console.log('  ' + c.red('✖ Please answer y or n.'));
    }
}

async function askLimit(step) {
    while (true) {
        const answer = (await ask(step, 'How many leads?', 'A number like 20, or "all" to run the full grid search.', 'all')).toLowerCase();
        if (!answer || answer === 'all') return Infinity;
        const n = parseInt(answer, 10);
        if (Number.isInteger(n) && n > 0) return n;
        console.log('  ' + c.red('✖ Enter a positive number or "all".'));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function updateStats(leadsCount) {
    let stats = { totalLeads: 0, totalSearches: 0 };
    try {
        if (fs.existsSync(STATS_FILE)) stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_FILE)) };
    } catch (e) {}
    stats.totalLeads += leadsCount;
    stats.totalSearches += 1;
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

async function fetchFreeProxies() {
    if (process.env.USE_FREE_PROXIES !== 'true') return [];
    try {
        live.set('Fetching free proxies…');
        const res = await axios.get(
            'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
            { timeout: 10000 }
        );
        const pool = String(res.data || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.includes(':'))
            .map((l) => ({ server: `http://${l}` }));
        say(c.gray(`  Proxy pool ready: ${pool.length} proxies`));
        return pool;
    } catch (e) {
        say(c.yellow(`  ⚠ Could not fetch free proxies, using your own IP (${e.message})`));
        return [];
    }
}

const kv = (k, v) => `${c.gray(k.padEnd(14))} ${v}`;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n' + box([
        '',
        center(c.bold(c.cyan('📚  LEAD GENERATOR'))),
        center(c.gray('Google Maps  →  clean CSV')),
        '',
        center(`${c.gray('Searching')} ${c.bold(BUSINESS)} ${c.gray('in')} ${c.bold(COUNTRY)}`),
        center(c.dim('by Mannu Yadav')),
        '',
    ]));

    if (!(await ensureBrowser())) {
        rl.close();
        return;
    }

    if (await updateAvailable()) {
        console.log('\n' + box([
            c.yellow(c.bold('🔔 A new version is available')),
            `Close this and run  ${c.bold(c.cyan('mgli update'))}  to get it.`,
        ], c.yellow));
    }

    const lastUser = loadLastUser();
    while (!who) {
        const typed = await ask(null, "What's your name?", 'Your name is stamped on every file you export.', lastUser ? `Enter = ${lastUser}` : '');
        const name = titleCase((typed || lastUser).replace(/[^\p{L}\p{N} .'-]/gu, '').trim());
        if (name) who = name;
        else console.log('  ' + c.red('✖ Please tell us your name.'));
    }
    saveLastUser(who);
    console.log(`\n  ${c.green('👋')} Welcome, ${c.bold(firstName())}! Let's find some leads.`);

    // ── Unfinished run from last time? Offer to continue it ──
    let saved = loadProgress();
    let resumeRun = false;
    if (saved) {
        const ago = formatDuration(Date.now() - (saved.savedAt || Date.now()));
        console.log('\n' + box([
            c.yellow(c.bold('⏯  Unfinished search found')),
            '',
            kv('Search', `${c.bold(BUSINESS)} in ${c.bold(saved.city)}, ${COUNTRY}`),
            kv('Saved so far', `${c.bold(String((saved.leads || []).length))} leads`),
            kv('Saved', `${ago} ago`),
        ], c.yellow));
        resumeRun = await askYesNo(null, 'Resume it?', 'Yes = carry on where it stopped. No = start a new search (the old progress is kept in progress.discarded.json).', true);
        if (!resumeRun) { discardProgress(); saved = null; }
    }

    let city, areas, limit, huntEmails, phoneRequired, emailRequired;
    if (resumeRun) {
        ({ city, areas, huntEmails, phoneRequired, emailRequired } = saved);
        limit = saved.limit === 'all' ? Infinity : saved.limit;
    } else {
        city = titleCase(await askRequired(1, 'Which city?', 'e.g. Lucknow, Gorakhpur, New Delhi'));
        const areasRaw = await ask(2, 'Specific areas?  (optional)', 'Comma-separated for deeper coverage, or press Enter to skip.\n  e.g. Hazratganj, Gomti Nagar, Aliganj');
        areas = areasRaw.split(',').map((a) => a.trim()).filter(Boolean);
        limit = await askLimit(3);
        huntEmails = await askYesNo(4, 'Hunt emails & social links?', 'Visits each business website. Slower, but finds more contacts.', true);
        phoneRequired = await askYesNo(5, 'Phone number required?', 'Drops leads that have no phone number.', false);
        emailRequired = huntEmails
            ? await askYesNo(6, 'Email required?', 'Drops leads where no email was found.', false)
            : false;
    }

    const on = (b) => (b ? c.green('✔ yes') : c.gray('✘ no'));
    console.log('\n' + box([
        c.bold(`${firstName()}, please review your search`),
        '',
        kv('Extracted by', c.bold(who)),
        kv('Search', `${c.bold(BUSINESS)} in ${c.bold(city)}, ${COUNTRY}`),
        kv('Areas', areas.length ? areas.join(', ') : c.gray('none')),
        kv('Limit', limit === Infinity ? 'All (full grid search)' : String(limit)),
        kv('Hunt emails', on(huntEmails)),
        kv('Phone only', on(phoneRequired)),
        kv('Email only', on(emailRequired)),
    ], c.blue));

    if (!resumeRun && !(await askYesNo(null, 'Start extraction?', 'Tip: press Ctrl+C twice while running to stop early and still save results.', true))) {
        console.log('\n  ' + c.gray('Cancelled. Nothing was run.\n'));
        rl.close();
        return;
    }
    rl.close();
    console.log();

    // ── Run ──────────────────────────────────────────────────────────────────
    let stopRequested = false;
    let stopArmedAt = 0;
    process.on('SIGINT', () => {
        if (stopRequested) {
            live.stop();
            console.log('\n  ' + c.red('Force quitting.'));
            process.exit(1);
        }
        // First press only asks for confirmation, so copying text with Ctrl+C can't stop a long run by accident.
        if (Date.now() - stopArmedAt > 5000) {
            stopArmedAt = Date.now();
            say(c.yellow('  ⚠ Ctrl+C pressed. Press it again within 5 seconds to stop. Otherwise nothing changes.'));
            return;
        }
        stopRequested = true;
        say(c.yellow('  ⏹ Stopping after the current step — results so far will be saved. (Ctrl+C again to force quit)'));
    });

    quietConsole();
    live.start();
    const scraper = new GoogleMapsScraper({ proxies: await fetchFreeProxies() });
    const startedAt = Date.now();
    let currentPhase = '';
    let unique = 0;

    const progress = (data) => {
        if (!data || typeof data === 'string') return;
        const { phase, query, status, count, current, total, totalUnique } = data;
        if (typeof totalUnique === 'number') unique = totalUnique;

        if (phase && phase !== currentPhase && status !== 'complete') {
            currentPhase = phase;
            say(`${c.cyan('▶')} ${c.bold(phase)}`);
            if (query) say(c.gray(`    ${query}`));
        }
        const found = unique > 0 ? c.gray(`· ${unique} unique so far`) : '';
        if (status === 'scrolling') live.set(`Loading results  ${c.bold(count || 0)} found ${found}`);
        else if (status === 'extracting') live.set(`${bar(current, total)}  ${c.bold(`${current}/${total}`)} ${found}`);
        else if (status === 'complete') say(`${c.green('✔')} ${c.bold('Search finished')} ${c.gray(`— ${totalUnique || 0} unique leads`)}`);
        else live.set(`Searching  ${found}`);
    };

    try {
        live.set('Launching browser…');
        await scraper.init();

        const settings = { city, areas, limit: limit === Infinity ? 'all' : limit, huntEmails, phoneRequired, emailRequired };
        if (resumeRun) say(`${c.green('⏯')} ${c.bold('Resuming')} ${c.gray(`— ${saved.leads.length} leads already saved`)}`);

        let leads = await scraper.gridSearch(
            BUSINESS, city, COUNTRY, progress, areas, limit, () => stopRequested,
            {
                leads: resumeRun ? saved.leads : [],
                doneQueries: resumeRun ? saved.doneQueries : [],
                onCheckpoint: (state) => saveProgress({ ...settings, ...state }),
            }
        );

        if (huntEmails && leads.length && !stopRequested) {
            say(`${c.cyan('▶')} ${c.bold('Enriching leads')} ${c.gray('— emails & social links')}`);
            for (let i = 0; i < leads.length; i++) {
                if (stopRequested) break;
                live.set(`${bar(i + 1, leads.length)}  ${c.bold(`${i + 1}/${leads.length}`)}`);
                leads[i] = await scraper.enrich(leads[i]);
            }
            say(`${c.green('✔')} ${c.bold('Enrichment done')}`);
        }

        const allLeads = [...leads];
        if (phoneRequired) leads = leads.filter((l) => l.phone && l.phone.trim());
        if (emailRequired) leads = leads.filter((l) => l.email && l.email.trim());
        const filteredOut = allLeads.length - leads.length;

        live.stop();

        if (allLeads.length === 0) {
            clearProgress();
            console.log('\n' + box([
                c.yellow(c.bold('No leads found')),
                '',
                'Try a different city, or add specific areas.',
            ], c.yellow) + '\n');
            return;
        }

        fs.mkdirSync(EXPORTS_DIR, { recursive: true });
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
        const fileSafe = (t) => t.replace(/[^\w\-]+/g, '_').slice(0, 80);
        const safeTag = `${fileSafe(`${BUSINESS}_${city}`)}_by_${fileSafe(who)}`;
        const extractedOn = new Date().toISOString().slice(0, 10);
        for (const l of allLeads) { l.extractedBy = who; l.extractedOn = extractedOn; }
        const filteredPath = path.join(EXPORTS_DIR, `Targeted_Leads_${safeTag}_${ts}.csv`);
        const rawPath = path.join(EXPORTS_DIR, `Full_Master_Dataset_${safeTag}_${ts}.csv`);

        await createObjectCsvWriter({ path: filteredPath, header: CSV_HEADER })
            .writeRecords(leads.length ? leads : allLeads);
        if (filteredOut > 0) {
            await createObjectCsvWriter({ path: rawPath, header: CSV_HEADER }).writeRecords(allLeads);
        }

        updateStats(allLeads.length);
        // A finished run needs no resuming. If it was stopped early, keep the progress so it can be continued.
        if (!stopRequested) clearProgress();

        const shown = leads.length ? leads : allLeads;
        const hot = shown.filter((l) => l.verification === 'Unclaimed').length;
        const lines = [
            c.green(c.bold(stopRequested ? `✔ Stopped early, ${firstName()} — results saved` : `✔ Great work, ${firstName()}! Extraction complete`)),
            '',
            kv('Leads', c.bold(String(shown.length))),
        ];
        if (filteredOut > 0) lines.push(kv('Filtered out', `${filteredOut}  ${c.gray(`(${allLeads.length} found in total)`)}`));
        lines.push(
            kv('Hot leads', `${c.bold(String(hot))} ${c.gray('unclaimed businesses')}`),
            kv('Time taken', formatDuration(Date.now() - startedAt)),
        );
        console.log('\n' + box(lines, c.green));
        console.log('\n  ' + c.gray('Saved in the exports folder:'));
        console.log('  ' + c.cyan(path.basename(filteredPath)));
        if (filteredOut > 0) console.log('  ' + c.cyan(path.basename(rawPath)));
        console.log();
    } catch (err) {
        live.stop();
        const advice = explainError(err);
        const first = String(err.message || err).split('\n')[0]; // skip Playwright's long call logs
        console.log('\n' + box([c.red(c.bold('✖ Something went wrong')), '', ...(advice || [first])], c.red) + '\n');
        process.exitCode = 1;
    } finally {
        live.stop();
        await scraper.close();
    }
}

process.on('exit', () => { if (TTY) process.stdout.write('\x1b[?25h'); });

async function updateCommand() {
    console.log('\n' + c.cyan(c.bold('  Updating Lead Generator')) + '\n');
    try {
        const r = await runUpdate((m) => console.log('  ' + c.gray(m)));
        console.log('\n' + (r.updated
            ? box([c.green(c.bold('✔ Updated to the latest version')), '', 'Type  mgli  to start.'], c.green)
            : box([c.green(c.bold('✔ You already have the latest version'))], c.green)) + '\n');
    } catch (err) {
        console.log('\n' + box([c.red(c.bold('✖ Update failed')), '', (err.response && err.response.status === 404 ? 'The update source was not found. Please tell Mannu.' : err.message), '', 'Check your internet connection and try again.'], c.red) + '\n');
        process.exitCode = 1;
    }
    process.exit();
}

// ─────────────────────────────────────────────────────────────────────────────
// HELP / VERSION / DOCTOR / BROWSER CHECK
// ─────────────────────────────────────────────────────────────────────────────
const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform;

function versionInfo() {
    let v = '1.0.0';
    try { v = require('./package.json').version; } catch (e) {}
    let build = '';
    try { build = fs.readFileSync(path.join(__dirname, '.version'), 'utf8').trim().slice(0, 7); } catch (e) {}
    return build ? `${v} (${build})` : v;
}

function helpCommand(exitCode = 0) {
    const row = (cmd, text) => `  ${c.cyan(cmd.padEnd(16))}${text}`;
    console.log([
        '',
        `  ${c.bold(c.cyan('📚 Lead Generator (mgli)'))} ${c.gray(versionInfo())}`,
        c.gray(`  Collects ${BUSINESS.toLowerCase()} leads in ${COUNTRY} from Google Maps into CSV files.`),
        '',
        c.bold('  Commands'),
        row('mgli', 'Start an extraction (asks a few quick questions)'),
        row('mgli update', 'Download and install the latest version'),
        row('mgli doctor', 'Check this computer is ready (Node, browser, internet)'),
        row('mgli version', 'Show the installed version'),
        row('mgli help', 'Show this help'),
        '',
        c.bold('  While it runs'),
        row('Ctrl+C twice', 'Stop early and still save what was found'),
        row('Next start', 'Offers to resume an unfinished search'),
        '',
        c.bold('  Where things are'),
        row('Your CSV files', path.join(__dirname, 'exports')),
        row('Install folder', __dirname),
        '',
        c.gray('  Install or update on any computer: see the one-line commands in the README'),
        c.gray('  https://github.com/itsMannuYadav/mgli'),
        '',
    ].join('\n'));
    process.exit(exitCode);
}

function versionCommand() {
    console.log(`mgli ${versionInfo()}  (Node ${process.versions.node}, ${OS_NAME} ${process.arch})`);
    process.exit(0);
}

function chromiumPath() {
    try { return require('playwright').chromium.executablePath(); } catch (e) { return ''; }
}
function browserInstalled() {
    const p = chromiumPath();
    return !!p && fs.existsSync(p);
}

// Exact commands to fix a missing browser, per operating system.
function browserFixLines() {
    const lines = ['npx playwright install chromium'];
    if (process.platform === 'linux') {
        lines.push('sudo env "PATH=$PATH" npx playwright install-deps chromium   # Linux system libraries');
    }
    return lines;
}

/** Makes sure the browser is there; offers to download it. Returns false if the run can't continue. */
async function ensureBrowser() {
    if (browserInstalled()) return true;
    console.log('\n' + box([
        c.yellow(c.bold('The browser component is not installed yet')),
        '',
        'One-time download of about 150 MB.',
    ], c.yellow));
    const yes = await askYesNo(null, 'Install it now?', 'Runs:  npx playwright install chromium', true);
    if (yes) {
        const r = spawnSync('npx playwright install chromium', { cwd: __dirname, stdio: 'inherit', shell: true });
        if (r.status === 0 && browserInstalled()) return true;
    }
    console.log('\n  ' + c.red('✖ The browser is not installed.') + ' Run this, then start mgli again:');
    for (const l of browserFixLines()) console.log('    ' + c.cyan(l));
    console.log();
    return false;
}

/** Turns a raw failure into plain advice when we recognise the cause. */
function explainError(err) {
    const m = String((err && err.message) || err || '');
    if (/Executable doesn't exist|playwright install/i.test(m)) {
        return ['The browser component is missing.', ...browserFixLines().map((l) => '  ' + l)];
    }
    if (/missing dependencies|shared librar|libnss|libatk|libgbm/i.test(m)) {
        return ['Your system is missing libraries that the browser needs.', '  sudo env "PATH=$PATH" npx playwright install-deps chromium'];
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_(INTERNET|NAME|CONNECTION)/i.test(m)) {
        return ['Could not reach the internet. Check your connection and try again.'];
    }
    return null;
}

async function doctorCommand() {
    const ok = (t) => `  ${c.green('✔')} ${t}`;
    const bad = (t) => `  ${c.red('✖')} ${t}`;
    const warn = (t) => `  ${c.yellow('!')} ${t}`;
    const fixes = [];
    console.log(`\n  ${c.bold(c.cyan('mgli doctor'))} ${c.gray(`— checking this computer`)}\n`);

    console.log(ok(`System: ${OS_NAME} ${process.arch}`));
    console.log(ok(`Version: ${versionInfo()}`));
    console.log(ok(`Node.js ${process.versions.node}`));

    if (browserInstalled()) console.log(ok('Browser component installed'));
    else { console.log(bad('Browser component NOT installed')); fixes.push(...browserFixLines()); }

    try {
        fs.mkdirSync(path.join(__dirname, 'exports'), { recursive: true });
        fs.accessSync(path.join(__dirname, 'exports'), fs.constants.W_OK);
        console.log(ok('Exports folder is writable'));
    } catch (e) { console.log(bad(`Cannot write to ${path.join(__dirname, 'exports')}`)); }

    try {
        await axios.get('https://www.google.com/maps', { timeout: 8000, validateStatus: () => true });
        console.log(ok('Can reach Google Maps'));
    } catch (e) { console.log(bad(`Cannot reach Google Maps (${e.code || e.message})`)); }

    if (await updateAvailable(5000)) { console.log(warn('A newer version is available')); fixes.push('mgli update'); }
    else console.log(ok('Up to date (or offline)'));

    if (fixes.length) {
        console.log('\n  ' + c.bold('To fix, run:'));
        for (const f of fixes) console.log('    ' + c.cyan(f));
    } else {
        console.log('\n  ' + c.green(c.bold('All good. Type mgli to start.')));
    }
    console.log();
    process.exit(fixes.some((f) => f !== 'mgli update') ? 1 : 0);
}

const sub = (process.argv[2] || '').toLowerCase();
if (['update', '--update', '-u'].includes(sub)) {
    updateCommand();
} else if (['help', '--help', '-h', '/?', '?'].includes(sub)) {
    helpCommand();
} else if (['version', '--version', '-v'].includes(sub)) {
    versionCommand();
} else if (sub === 'doctor') {
    doctorCommand();
} else if (sub) {
    console.log(`\n  ${c.red(`Unknown command "${process.argv[2]}".`)}`);
    helpCommand(1);
} else {
    main().catch((err) => {
        live.stop();
        if (err && err.code === 'ERR_USE_AFTER_CLOSE') { // input closed (Ctrl+D, or no terminal attached)
            console.log('\n  ' + c.gray('Input closed. Goodbye!'));
            process.exit(0);
        }
        console.error(err);
        process.exit(1);
    });
}
