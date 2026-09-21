@echo off
:: ============================================================
:: ZeusPack AE Bridge - Installer Launcher (Adobe After Effects)
:: ============================================================

:: Run PowerShell and wait for it to finish. No -NoExit and no pause: the window
:: closes on its own when the install succeeds. operator.ps1 pauses itself on
:: failure (so the error stays on screen) and closes on success — the catch here
:: is only a backstop for a parse error in the script.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { & '%~dp0operator.ps1' } catch { Write-Host $_.Exception.Message -ForegroundColor Red; Read-Host 'Press Enter to exit' }"
