# ============================================================
# ZeusPack AE Bridge - Installer Script (PowerShell)
# Installs the CEP panel that links Adobe After Effects to ZeusPack.
# Run via install.bat, do not run this file directly.
# ============================================================

param(
    [switch]$Elevated
)

# ---- Names / layout (single place to change) ----
$PluginName   = "ZeusPack AE Bridge"    # shown to the user
$SourceFolder = "ae_bridge"             # folder next to this script
$InstallName  = "zeuspack_ae_bridge"    # folder name under CEP\extensions

# ---- Color helpers ----
function Write-Ok   ($msg) { Write-Host "  [OK] $msg"  -ForegroundColor Green  }
function Write-Warn ($msg) { Write-Host "  [!]  $msg"  -ForegroundColor Yellow }
function Write-Err  ($msg) { Write-Host "  [X]  $msg"  -ForegroundColor Red    }
function Write-Step ($msg) { Write-Host "`n  >>  $msg" -ForegroundColor Cyan   }

# ============================================================
# SAFE EXIT -- pause ONLY on failure so an error stays readable;
# a successful (or cancelled) run closes on its own.
# ============================================================
function Safe-Exit ($code) {
    Write-Host ""
    if ($code -ne 0) { Read-Host "  Press Enter to exit" }
    exit $code
}

# ============================================================
# TOP-LEVEL ERROR TRAP
# ============================================================
trap {
    Write-Host ""
    Write-Err "Unexpected error: $_"
    Safe-Exit 1
}

# ============================================================
# 0. SELF-ELEVATE to Administrator if not already
# ============================================================
$isAdmin = ([Security.Principal.WindowsPrincipal]`
    [Security.Principal.WindowsIdentity]::GetCurrent()`
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "  Requesting administrator privileges..." -ForegroundColor Yellow

    # Resolve script path BEFORE elevation — $PSCommandPath can be empty
    # in child processes launched via -Command.
    $selfPath = $MyInvocation.MyCommand.Path
    if (-not $selfPath) {
        $selfPath = $PSCommandPath
    }
    if (-not $selfPath) {
        Write-Err "Cannot resolve script path. Please run via install.bat."
        Safe-Exit 1
    }

    $currentScriptDir = Split-Path -Parent $selfPath

    # ------------------------------------------------------------
    # CRITICAL: if this script is running from a mapped network
    # drive (e.g. W:\...), that drive letter is NOT visible inside
    # the elevated (UAC) session. Copy the ENTIRE project folder to
    # a local temp folder BEFORE elevating, then elevate and run from
    # there. The elevated session never touches the network drive.
    # ------------------------------------------------------------
    $localPreStage = "$env:TEMP\ZeusPackAeBridge_preelevate"

    try {
        if (Test-Path $localPreStage) {
            Remove-Item $localPreStage -Recurse -Force
        }
        New-Item -ItemType Directory -Path $localPreStage -Force | Out-Null
        Copy-Item -Path "$currentScriptDir\*" -Destination $localPreStage -Recurse -Force
    } catch {
        Write-Err "Failed to copy project to local folder before elevation: $_"
        Write-Err "Make sure the source drive is accessible."
        Safe-Exit 1
    }

    $localSelfPath = Join-Path $localPreStage "operator.ps1"

    if (-not (Test-Path $localSelfPath)) {
        Write-Err "operator.ps1 not found after local staging."
        Safe-Exit 1
    }

    # Write a tiny temp launcher so we never have to embed a spaced path
    # inside a -Command string (which breaks no matter how you quote it).
    $tempLauncher = "$env:TEMP\ZeusPackAeBridge_elevate_launcher.ps1"
    # No trailing Read-Host and no -NoExit below: the elevated operator.ps1
    # handles its own exit (auto-close on success, pause on failure via
    # Safe-Exit). The catch here only pauses if the script cannot start at all.
    Set-Content -Path $tempLauncher -Encoding UTF8 -Value @"
try {
    & '$($localSelfPath -replace "'", "''")' -Elevated
} catch {
    Write-Host `$_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to exit'
}
"@

    try {
        Start-Process -FilePath "powershell.exe" `
                      -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $tempLauncher `
                      -Verb RunAs `
                      -Wait
    } catch {
        Write-Err "Elevation cancelled or failed: $_"
        Safe-Exit 1
    }

    Remove-Item $tempLauncher -ErrorAction SilentlyContinue
    Remove-Item $localPreStage -Recurse -Force -ErrorAction SilentlyContinue

    exit 0
}

# ============================================================
# BANNER
# ============================================================
Clear-Host
Write-Host ""
Write-Host "  ======================================================" -ForegroundColor DarkCyan
Write-Host "   ZeusPack AE Bridge - Installer for After Effects    " -ForegroundColor Cyan
Write-Host "  ======================================================" -ForegroundColor DarkCyan
Write-Host ""

# ============================================================
# 1. RESOLVE PATHS
# ============================================================
Write-Step "Checking paths..."

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else {
    Split-Path -Parent $MyInvocation.MyCommand.Definition
}

if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$sourceDir = Join-Path $scriptDir $SourceFolder

$destSystem = "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\$InstallName"
$destUser   = "$env:APPDATA\Adobe\CEP\extensions\$InstallName"
$destDir    = if (Test-Path "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions") {
    $destSystem
} else {
    Write-Warn "System CEP path not found, using per-user path."
    $destUser
}

Write-Ok "Source      : $sourceDir"
Write-Ok "Destination : $destDir"

if (-not (Test-Path "$sourceDir\CSXS\manifest.xml")) {
    Write-Host ""
    Write-Err "Folder '$SourceFolder' or manifest.xml not found."
    Write-Err "Make sure the folder structure looks like this:"
    Write-Host ""
    Write-Host "    install.bat"              -ForegroundColor Gray
    Write-Host "    operator.ps1"             -ForegroundColor Gray
    Write-Host "    $SourceFolder\"           -ForegroundColor Gray
    Write-Host "      CSXS\manifest.xml"      -ForegroundColor Gray
    Write-Host "      index.html"             -ForegroundColor Gray
    Write-Host "      js\panel.js"            -ForegroundColor Gray
    Write-Host "      js\CSInterface.js"      -ForegroundColor Gray
    Write-Host "      jsx\host.jsx"           -ForegroundColor Gray
    Write-Host ""
    Safe-Exit 1
}

# ============================================================
# 3. CONFIRM SOURCE IS LOCAL (already staged before elevation)
# ============================================================
Write-Step "Confirming plugin source is local..."
Write-Ok "Running from local staged copy: $sourceDir"

# ============================================================
# 4. CHECK ADOBE AFTER EFFECTS PROCESS
# ============================================================
Write-Step "Checking for running Adobe After Effects process..."

$aeProcess = Get-Process -Name "AfterFX" -ErrorAction SilentlyContinue

if ($aeProcess) {
    Write-Warn "Adobe After Effects is currently running."
    Write-Host ""
    Write-Host "  Choose an action:" -ForegroundColor White
    Write-Host "  [1] Close After Effects automatically and continue" -ForegroundColor Gray
    Write-Host "  [2] Continue without closing (not recommended)" -ForegroundColor Gray
    Write-Host "  [3] Cancel" -ForegroundColor Gray
    Write-Host ""

    $choice = Read-Host "  Choice (1/2/3)"

    switch ($choice) {
        "1" {
            Stop-Process -Name "AfterFX" -Force
            Start-Sleep -Seconds 2
            Write-Ok "After Effects closed."
        }
        "2" {
            Write-Warn "Continuing without closing. Restart After Effects after installation is complete."
        }
        default {
            Write-Warn "Installation cancelled."
            Safe-Exit 0
        }
    }
} else {
    Write-Ok "Adobe After Effects is not currently running."
}

# ============================================================
# 5. COPY EXTENSION FILES (CEP Panel)
# ============================================================
Write-Step "Copying extension files to CEP extensions folder..."

try {
    if (Test-Path $destDir) {
        Remove-Item $destDir -Recurse -Force
        Write-Ok "Previous installation removed."
    }
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    Copy-Item -Path "$sourceDir\*" -Destination $destDir -Recurse -Force
    Write-Ok "Files copied to: $destDir"
} catch {
    Write-Err "Failed to copy files: $_"
    Safe-Exit 1
}

# ============================================================
# 6. REGISTRY -- PlayerDebugMode (required for unsigned CEP)
# ============================================================
Write-Step "Setting registry PlayerDebugMode..."

$csxsVersions = @(9, 10, 11, 12, 13)
$regErrors    = 0

foreach ($ver in $csxsVersions) {
    $regPath = "HKCU:\Software\Adobe\CSXS.$ver"
    try {
        if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
        Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value "1" -Type String -Force
        Write-Ok "CSXS.$ver - PlayerDebugMode=1"
    } catch {
        Write-Warn "CSXS.$ver - Failed: $_"
        $regErrors++
    }
}

if ($regErrors -gt 0) {
    Write-Warn "$regErrors key(s) could not be set (not critical)."
}

# ============================================================
# 7. VERIFICATION
# ============================================================
Write-Step "Verifying installation..."

$checks = @(
    @{ Path = "$destDir\CSXS\manifest.xml";  Label = "manifest.xml"  },
    @{ Path = "$destDir\index.html";         Label = "index.html"    },
    @{ Path = "$destDir\js\panel.js";        Label = "panel.js"      },
    @{ Path = "$destDir\js\CSInterface.js";  Label = "CSInterface.js"},
    @{ Path = "$destDir\jsx\host.jsx";       Label = "host.jsx"      }
)

$allOk = $true
foreach ($check in $checks) {
    if (Test-Path $check.Path) {
        Write-Ok $check.Label
    } else {
        Write-Err "$($check.Label) -- FILE NOT FOUND!"
        $allOk = $false
    }
}

# ============================================================
# DONE
# ============================================================
Write-Host ""
Write-Host "  ======================================================" -ForegroundColor DarkCyan

if ($allOk) {
    Write-Host "   INSTALLATION SUCCESSFUL!                          " -ForegroundColor Green
    Write-Host "  ======================================================" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor White
    Write-Host "  1. Start the ZeusPack app (the panel connects to it)"  -ForegroundColor Gray
    Write-Host "  2. Open Adobe After Effects"                           -ForegroundColor Gray
    Write-Host "  3. Panel : Window > Extensions > $PluginName"          -ForegroundColor Gray
    Write-Host "  4. The panel dot turns GREEN when connected"           -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Keep the panel open while working with ZeusPack." -ForegroundColor DarkGray
    Write-Host ""
    # Success: no key press needed. Show the result briefly, then close on its own.
    Write-Host "  This window closes automatically in 5 seconds..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
    exit 0
} else {
    Write-Host "   INSTALLATION COMPLETED WITH WARNINGS.            " -ForegroundColor Yellow
    Write-Host "  ======================================================" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "  Some files were not found at the destination." -ForegroundColor Yellow
    Write-Host "  Check the source folder and try again." -ForegroundColor Yellow
    Write-Host ""
    # Something is off — pause so the warnings can be read.
    Safe-Exit 1
}
