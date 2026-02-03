param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "flat-report.config.json")
)

if (-not (Test-Path $ConfigPath)) {
  Write-Error "Config not found: $ConfigPath"
  exit 2
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$schedule = $config.schedule
if (-not $schedule) {
  Write-Error "Missing schedule block in config."
  exit 2
}

if (-not $schedule.enabled) {
  Write-Host "Schedule disabled in config. Nothing to install."
  exit 0
}

if (-not $schedule.time) {
  Write-Error "schedule.time is required (HH:mm)."
  exit 2
}

if (-not $schedule.taskName) {
  Write-Error "schedule.taskName is required."
  exit 2
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "node.exe not found in PATH."
  exit 2
}

$nodePath = $nodeCmd.Source
$scriptPath = Join-Path $PSScriptRoot "run-flat-report.js"

if (-not (Test-Path $scriptPath)) {
  Write-Error "Script not found: $scriptPath"
  exit 2
}

try {
  $triggerTime = [DateTime]::ParseExact($schedule.time, "HH:mm", $null)
} catch {
  Write-Error "Invalid schedule.time '$($schedule.time)'. Expected HH:mm."
  exit 2
}

$arguments = "`"$scriptPath`" --config `"$ConfigPath`""
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $triggerTime
if ($schedule.intervalMinutes -and [int]$schedule.intervalMinutes -gt 0) {
  $interval = New-TimeSpan -Minutes $schedule.intervalMinutes
  $durationHours = if ($schedule.durationHours -and [int]$schedule.durationHours -gt 0) { [int]$schedule.durationHours } else { 24 }
  $duration = New-TimeSpan -Hours $durationHours
  $trigger.RepetitionInterval = $interval
  $trigger.RepetitionDuration = $duration
}

$startWhenAvailable = $true
if ($null -ne $schedule.runOnMissed) {
  $startWhenAvailable = [bool]$schedule.runOnMissed
}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable:$startWhenAvailable

if ($schedule.runIfLoggedOff) {
  $userHint = if ($schedule.runAsUser) { [string]$schedule.runAsUser } else { $null }
  $credMessage = "Enter the Windows account that should run this task when logged off."
  $cred = if ($userHint) { Get-Credential -UserName $userHint -Message $credMessage } else { Get-Credential -Message $credMessage }
  if (-not $cred) {
    Write-Error "Credentials are required when runIfLoggedOff is true."
    exit 2
  }

  $userId = $cred.UserName
  $password = $cred.GetNetworkCredential().Password
  if (-not $password) {
    Write-Error "Empty passwords are not supported for scheduled tasks."
    exit 2
  }

  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Password -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $schedule.taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -User $userId `
    -Password $password `
    -Description "DocGen flat report daily job" `
    -Force | Out-Null

  Write-Host "Scheduled task '$($schedule.taskName)' installed for $($schedule.time) (runs when logged off)."
  exit 0
}

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType InteractiveToken -RunLevel Limited

Register-ScheduledTask `
  -TaskName $schedule.taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "DocGen flat report daily job" `
  -Force | Out-Null

Write-Host "Scheduled task '$($schedule.taskName)' installed for $($schedule.time)."
