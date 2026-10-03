const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const axios = require('axios');
const AdmZip = require('adm-zip');

// Where team copies pull updates from (public GitHub repo).
const REPO = process.env.MGLI_REPO || 'itsMannuYadav/mgli';
const BRANCH = process.env.MGLI_BRANCH || 'main';

const ROOT = __dirname;
const VERSION_FILE = path.join(ROOT, '.version');

// Never overwritten by an update: each person's own data and installs.
const PROTECTED = new Set(['.env', 'exports', 'last-user.json', 'stats.json', 'node_modules', '.git', '.version']);
// Repo files that are not needed on team machines.
const SKIP = new Set(['LoGo_Bot_Icon.png', '.gitignore']);

function readDeps() {
    try {
        const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        return JSON.stringify([p.dependencies || {}, p.bin || {}]);
    } catch (e) { return ''; }
}

function localVersion() {
    try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

async function remoteVersion(timeout = 8000) {
    const res = await axios.get(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
        timeout,
        headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'mgli-updater' },
        responseType: 'text',
        transformResponse: (d) => d,
    });
    return String(res.data).trim();
}

/** Quietly checks if a newer version exists. Resolves false on any problem (offline, rate limit...). */
async function updateAvailable(timeout = 2000) {
    try {
        const remote = await remoteVersion(timeout);
        const local = localVersion();
        return !!remote && remote !== local;
    } catch (e) {
        return false;
    }
}

function copyTree(srcDir, destDir, isTop) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (isTop && (PROTECTED.has(entry.name) || SKIP.has(entry.name))) continue;
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(dest, { recursive: true });
            copyTree(src, dest, false);
        } else {
            fs.copyFileSync(src, dest);
        }
    }
}

/** Downloads the latest version and installs it over this one. Returns a result object; throws on failure. */
async function runUpdate(log = console.log) {
    log('Checking for updates…');
    const remote = await remoteVersion();
    if (remote && remote === localVersion()) {
        return { updated: false, version: remote };
    }

    log('Downloading the latest version…');
    const res = await axios.get(`https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}`, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'mgli-updater' },
    });

    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mgli-update-'));
    try {
        new AdmZip(Buffer.from(res.data)).extractAllTo(tmp, true);
        const [top] = fs.readdirSync(tmp); // GitHub wraps everything in "<repo>-<branch>/"
        const depsBefore = readDeps();

        log('Installing files…');
        copyTree(path.join(tmp, top), ROOT, true);

        const depsAfter = readDeps();
        if (depsBefore !== depsAfter) {
            log('Dependencies changed — installing packages (this can take a minute)…');
            const opts = { cwd: ROOT, stdio: 'inherit', shell: true };
            if (spawnSync('npm', ['install'], opts).status !== 0) throw new Error('npm install failed');
            spawnSync('npx', ['playwright', 'install', 'chromium'], opts);
        }
        if (remote) fs.writeFileSync(VERSION_FILE, remote);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { updated: true, version: remote };
}

module.exports = { runUpdate, updateAvailable, REPO };
