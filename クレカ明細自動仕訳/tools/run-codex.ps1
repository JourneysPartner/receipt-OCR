# Run "codex exec" with a hang watchdog.
#
# Why: codex exec occasionally stalls completely right after emitting an
# assistant message - observed stalls of 4.7 h and 10.3 h with zero events
# logged. Median turn time is 8-22 s, so this is a hang, not slowness.
# This script watches the session rollout log; if it stops advancing for
# -IdleMinutes, it kills the process and continues with
# "codex exec resume --last". Session state lives in the rollout file, so
# no work is lost.
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI unless the
# file has a UTF-8 BOM, which mangles non-ASCII literals and breaks parsing.

param(
  [Parameter(Mandatory = $true)][string]$PromptFile,
  [string]$Project     = (Split-Path $PSScriptRoot -Parent),
  [int]   $IdleMinutes = 10,
  [int]   $MaxResumes  = 20,
  [string]$Codex       = ""
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $PromptFile)) { throw "prompt file not found: $PromptFile" }

if (-not $Codex) {
  # The install layout uses hash-named subfolders that change on self-update,
  # so never hardcode one. Pick the highest version present.
  $binRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
  $best = Get-ChildItem $binRoot -Recurse -Filter "codex.exe" -ErrorAction SilentlyContinue |
    ForEach-Object {
      $v = (& $_.FullName --version 2>&1) -replace '[^0-9.]', ''
      $parts = ($v -split '\.') | Where-Object { $_ -ne '' } | Select-Object -First 4
      while ($parts.Count -lt 4) { $parts += '0' }
      [PSCustomObject]@{
        Path = $_.FullName
        Sort = [int]$parts[0]*1000000 + [int]$parts[1]*10000 + [int]$parts[2]*100 + [int]$parts[3]
        Ver  = $v
      }
    } | Sort-Object Sort -Descending | Select-Object -First 1
  if (-not $best) { throw "codex.exe not found under $binRoot" }
  $Codex = $best.Path
  Write-Host ("codex  : {0} (v{1})" -f $Codex, $best.Ver)
}
if (-not (Test-Path $Codex)) { throw "codex.exe not found: $Codex" }

$sessionRoot = Join-Path $env:USERPROFILE ".codex\sessions"
$logDir      = Join-Path $Project "tools\codex-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp   = Get-Date -Format "yyyyMMdd-HHmmss"
# per-attempt logs live in $script:partFiles
$projectFull = (Resolve-Path $Project).Path

function Get-ActiveSessionTime {
  # Newest rollout whose cwd is this project. Returns LastWriteTime or $null.
  $cands = Get-ChildItem $sessionRoot -Recurse -File -Filter "*.jsonl" -ErrorAction SilentlyContinue |
           Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-24) } |
           Sort-Object LastWriteTime -Descending | Select-Object -First 12
  foreach ($c in $cands) {
    try {
      $m = (Get-Content $c.FullName -TotalCount 1 -Encoding UTF8) | ConvertFrom-Json
      if ($m.payload.cwd) {
        $cwd = (Resolve-Path $m.payload.cwd -ErrorAction SilentlyContinue).Path
        if ($cwd -eq $projectFull) { return $c.LastWriteTime }
      }
    } catch { }
  }
  return $null
}

$script:partFiles = @()
$script:attempt = 0
function Start-CodexRun([string[]]$CodexArgs, [string]$StdinFile) {
  # Start-Process handles Unicode paths natively. A .cmd wrapper does not:
  # cmd reads the script in the OEM codepage, so a Japanese path written as
  # ASCII becomes "?" and cmd reports an invalid filename.
  $script:attempt++
  $o = Join-Path $logDir ("out-{0}-{1:d2}.txt" -f $stamp, $script:attempt)
  $e = Join-Path $logDir ("err-{0}-{1:d2}.txt" -f $stamp, $script:attempt)
  $script:partFiles += @($o, $e)
  return Start-Process -FilePath $Codex -ArgumentList $CodexArgs `
    -RedirectStandardInput $StdinFile -RedirectStandardOutput $o -RedirectStandardError $e `
    -WorkingDirectory $Project -NoNewWindow -PassThru
}

# Start-Process -ArgumentList joins array elements with spaces and does NOT
# quote them. The project path contains spaces ("receipt OCR"), so it must be
# quoted here or the parser splits it and rejects the trailing "-".
$q = '"' + $projectFull + '"'
$argsFirst  = @('exec', '-C', $q, '-s', 'workspace-write', '--skip-git-repo-check', '-')
$argsResume = @('exec', 'resume', '--last', '-C', $q, '-s', 'workspace-write', '--skip-git-repo-check', '-')

Write-Host "prompt : $PromptFile"
Write-Host "idle   : $IdleMinutes min / max resumes: $MaxResumes"
Write-Host "logdir : $logDir"

$proc    = Start-CodexRun $argsFirst $PromptFile
$resumes = 0

while ($true) {
  Start-Sleep -Seconds 30
  if ($proc.HasExited) {
    Write-Host "finished (exit $($proc.ExitCode), resumes $resumes)"
    break
  }

  $times = @()
  $st = Get-ActiveSessionTime
  if ($st) { $times += $st }
  foreach ($pf in $script:partFiles) { if (Test-Path $pf) { $times += (Get-Item $pf).LastWriteTime } }
  if ($times.Count -eq 0) { continue }
  $newest = ($times | Sort-Object -Descending | Select-Object -First 1)
  $idle = ((Get-Date) - $newest).TotalMinutes

  if ($idle -ge $IdleMinutes) {
    if ($resumes -ge $MaxResumes) {
      Write-Warning "resume limit reached; stopping."
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
      break
    }
    $resumes++
    Write-Warning ("idle {0:N1} min - treating as hang, resuming (attempt {1})" -f $idle, $resumes)
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    Get-Process -Name "codex" -ErrorAction SilentlyContinue |
      Where-Object { $_.StartTime -gt (Get-Date).AddHours(-24) -and $_.Path -eq $Codex } |
      ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { } }
    Start-Sleep -Seconds 5

    $nudge = Join-Path $logDir "resume-$stamp-$resumes.txt"
    $text  = "The previous run stopped responding and the session was resumed. " +
             "Continue from where it was interrupted. Do not redo work that is already " +
             "complete. Check the current state first, then carry on."
    Set-Content -Path $nudge -Value $text -Encoding UTF8
    $proc = Start-CodexRun $argsResume $nudge
  }
}

Write-Host ""
Write-Host "=== tail of output ==="
$script:partFiles | Where-Object { (Test-Path $_) -and (Get-Item $_).Length -gt 0 } | ForEach-Object { Get-Content $_ -Tail 40 -Encoding UTF8 }
