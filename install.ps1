# Lead Generator (mgli) - installer and updater.
# Safe to run any time:  no extractor yet = it installs one,  extractor already there = it updates it.
#
#   irm https://raw.githubusercontent.com/itsMannuYadav/mgli/main/install.ps1 | iex
#
# (ASCII only on purpose, so Windows PowerShell 5.1 reads it correctly.)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo   = 'itsMannuYadav/mgli'
$Branch = 'main'

function Say($msg, $color = 'Cyan') { Write-Host "  $msg" -ForegroundColor $color }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Has($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Host ''
Say 'Lead Generator (mgli) - install / update' 'White'
Write-Host ''

# 1. Node.js is required
if (-not (Has 'node')) {
    Say 'Node.js is not installed.' 'Yellow'
    if (Has 'winget') {
        $answer = Read-Host '  Install Node.js LTS now using winget? [Y/n]'
        if ($answer -eq '' -or $answer -match '^[Yy]') {
            winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
            Refresh-Path
        }
    }
    if (-not (Has 'node')) {
        Say 'Please install Node.js LTS from https://nodejs.org, then open a NEW terminal and run this command again.' 'Red'
        return
    }
}

# 2. Where is (or should be) the extractor?
$dir = $env:MGLI_DIR
if (-not $dir) {
    # An existing install is found through the global link that "npm link" (setup.bat) created.
    try {
        $root = (npm root -g).Trim()
        foreach ($item in (Get-ChildItem $root -Force -ErrorAction Stop | Where-Object { $_.LinkType })) {
            $target = $item.Target
            if ($target -is [array]) { $target = $target[0] }
            $pkgFile = Join-Path $target 'package.json'
            if ((Test-Path (Join-Path $target 'cli.js')) -and (Test-Path $pkgFile)) {
                $pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json
                if ($pkg.bin -and $pkg.bin.mgli) { $dir = $target; break }
            }
        }
    } catch { }
}
if (-not $dir) { $dir = Join-Path $env:USERPROFILE 'mgli' }

# Native commands are run through cmd so that harmless npm warnings (stderr) can't stop the script.
function Run($commandLine) {
    # Started as its own process on the same console: PowerShell does not re-decode its output (that garbled the
    # box characters), colors are kept, and npm warnings on stderr cannot stop this script.
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $commandLine -NoNewWindow -Wait -PassThru
    return $p.ExitCode
}

$hasApp     = Test-Path (Join-Path $dir 'cli.js')
$canUpdate  = $hasApp -and (Test-Path (Join-Path $dir 'updater.js'))

if ($canUpdate) {
    # 3a. Already installed, and new enough to update itself
    Say "Found an existing install: $dir"
    Push-Location $dir
    try { [void](Run 'node cli.js update') } finally { Pop-Location }
}
else {
    # 3b. Fresh install (or upgrading an older copy that has no updater yet; its own files are kept)
    if ($hasApp) { Say "Upgrading an older install: $dir" } else { Say "Installing to: $dir" }
    $tmp = Join-Path $env:TEMP ('mgli-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        Say 'Downloading...' 'Gray'
        $zip = Join-Path $tmp 'mgli.zip'
        Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -UseBasicParsing
        Expand-Archive $zip -DestinationPath $tmp -Force
        $src = Get-ChildItem $tmp -Directory | Select-Object -First 1

        New-Item -ItemType Directory -Force $dir | Out-Null
        Get-ChildItem $src.FullName -Force |
            Where-Object { $_.Name -notin @('LoGo_Bot_Icon.png', '.gitignore') } |
            Copy-Item -Destination $dir -Recurse -Force
        New-Item -ItemType Directory -Force (Join-Path $dir 'exports') | Out-Null

        # Remember which version this is, so "mgli update" knows when something newer exists
        try {
            $sha = Invoke-RestMethod "https://api.github.com/repos/$Repo/commits/$Branch" -Headers @{ Accept = 'application/vnd.github.sha'; 'User-Agent' = 'mgli-installer' }
            Set-Content -Path (Join-Path $dir '.version') -Value ([string]$sha).Trim() -NoNewline
        } catch { }
    }
    finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    Push-Location $dir
    try {
        Say 'Installing packages (a minute or two)...' 'Gray'
        if ((Run 'npm install --no-audit --no-fund --loglevel=error') -ne 0) { throw 'npm install failed' }

        Say 'Installing the browser (one time, about 150 MB)...' 'Gray'
        if ((Run 'npx playwright install chromium') -ne 0) { throw 'browser install failed' }
    }
    finally { Pop-Location }
}

# 4. Make sure the "mgli" command exists
if (-not $env:MGLI_NO_LINK) {
    if (-not (Has 'mgli')) {
        Push-Location $dir
        try { [void](Run 'npm link --no-audit --no-fund --loglevel=error') } finally { Pop-Location }
    }
}

Write-Host ''
Say 'All set!' 'Green'
Say 'Open a NEW terminal and type:' 'White'
Say '    mgli           to start' 'White'
Say '    mgli update    to update later' 'White'
Say '    mgli help      to see all commands' 'White'
Write-Host ''
