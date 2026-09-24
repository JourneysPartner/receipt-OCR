# Run "codex exec" with a hang watchdog.
#
# Why: codex exec occasionally stalls completely right after emitting an
# assistant message - observed stalls of 4.7 h and 10.3 h with zero events
# logged. Median turn time is 8-22 s, so this is a hang, not slowness.
# This script watches the session rollout log; if it stops advancing for
# -IdleMinutes, it stops the run and continues it with
# "codex exec resume <session id>". Session state lives in the rollout file,
# so no work is lost.
#
# The watchdog touches only what this script started (fixed 2026-09-24):
# - It stops the process tree it launched (taskkill /T on that PID). It used
#   to stop every codex.exe from the same binary started within 24 hours -
#   and that binary is also the Codex desktop app's app-server, so a stall
#   here would have killed the user's other Codex conversations.
# - It resumes by the session id printed in this run's own log. "--last"
#   means "newest session for this directory", which need not be this one.
# - "exec resume" rejects -C and -s (CLI 0.155: unexpected argument '-C').
#   The working directory comes from Start-Process, and the sandbox is
#   passed as a config override instead.
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
$started = Get-Date
# per-attempt logs live in $script:partFiles
$projectFull = (Resolve-Path $Project).Path

$script:sessionId = $null
function Get-SessionId {
  # "codex exec" prints "session id: <uuid>" in the header of its stderr
  # log. Read the head of the first attempt's log without locking the
  # writer out (the run is still writing to it).
  if ($script:sessionId) { return $script:sessionId }
  $errLog = $script:partFiles | Where-Object { $_ -like '*\err-*' } | Select-Object -First 1
  if (-not $errLog -or -not (Test-Path $errLog)) { return $null }
  try {
    $fs = [System.IO.File]::Open($errLog, 'Open', 'Read', 'ReadWrite')
    try {
      $buffer = New-Object byte[] 16384
      $read = $fs.Read($buffer, 0, $buffer.Length)
      $head = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    } finally { $fs.Dispose() }
    $m = [regex]::Match($head, '(?:session|thread) id:\s*([0-9a-fA-F-]{36})')
    if ($m.Success) { $script:sessionId = $m.Groups[1].Value }
  } catch { }
  return $script:sessionId
}

function Get-ActiveSessionTime {
  # LastWriteTime of this run's own rollout file, or $null. Rollouts are
  # named rollout-<time>-<session id>.jsonl under sessions\yyyy\MM\dd; look
  # only in the date folders this run can have written to.
  $id = Get-SessionId
  if (-not $id) { return $null }
  $newest = $null
  for ($day = $started.Date.AddDays(-1); $day -le (Get-Date).Date; $day = $day.AddDays(1)) {
    $dir = Join-Path $sessionRoot $day.ToString('yyyy\\MM\\dd')
    if (-not (Test-Path $dir)) { continue }
    Get-ChildItem $dir -File -Filter "*$id.jsonl" -ErrorAction SilentlyContinue | ForEach-Object {
      if (-not $newest -or $_.LastWriteTime -gt $newest) { $newest = $_.LastWriteTime }
    }
  }
  return $newest
}

function Stop-OwnRun($p) {
  # Stop the process this script started and its children - nothing else.
  if (-not $p -or $p.HasExited) { return }
  # Local to this function: under 'Stop', PowerShell 5.1 turns a native
  # command's stderr line into a terminating error.
  $ErrorActionPreference = 'Continue'
  & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
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
  $p = Start-Process -FilePath $Codex -ArgumentList $CodexArgs `
    -RedirectStandardInput $StdinFile -RedirectStandardOutput $o -RedirectStandardError $e `
    -WorkingDirectory $Project -NoNewWindow -PassThru
  # Windows PowerShell fills ExitCode only if the handle was opened while the
  # process was alive; without this the summary line says "exit ".
  $null = $p.Handle
  return $p
}

# Start-Process -ArgumentList joins array elements with spaces and does NOT
# quote them. The project path contains spaces ("receipt OCR"), so it must be
# quoted here or the parser splits it and rejects the trailing "-".
$q = '"' + $projectFull + '"'
$argsFirst = @('exec', '-C', $q, '-s', 'workspace-write', '--skip-git-repo-check', '-')

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
      Stop-OwnRun $proc
      break
    }
    $id = Get-SessionId
    if (-not $id) {
      # Without this run's own id, a resume could continue somebody else's
      # conversation. Stop instead of guessing.
      Write-Warning "idle, but no session id was found in this run's log; stopping without resuming."
      Stop-OwnRun $proc
      break
    }
    $resumes++
    Write-Warning ("idle {0:N1} min - treating as hang, resuming session {1} (attempt {2})" -f $idle, $id, $resumes)
    Stop-OwnRun $proc
    Start-Sleep -Seconds 5

    $nudge = Join-Path $logDir "resume-$stamp-$resumes.txt"
    $text  = "The previous run stopped responding and the session was resumed. " +
             "Continue from where it was interrupted. Do not redo work that is already " +
             "complete. Check the current state first, then carry on."
    Set-Content -Path $nudge -Value $text -Encoding UTF8
    $argsResume = @('exec', 'resume', $id, '-c', "sandbox_mode='workspace-write'",
                    '--skip-git-repo-check', '-')
    $proc = Start-CodexRun $argsResume $nudge
  }
}

Write-Host ""
Write-Host "=== tail of output ==="
$script:partFiles | Where-Object { (Test-Path $_) -and (Get-Item $_).Length -gt 0 } | ForEach-Object { Get-Content $_ -Tail 40 -Encoding UTF8 }
