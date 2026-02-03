# Flat Test Reporter Job Guide (Windows – step by step)

If you follow this exactly, it should work without guesswork.

## What the job does

- Calls the `create-test-reporter-flat` API.
- Receives the XLSX as Base64 (direct download).
- Writes the file to the configured folder (overwrite `TestPlan.xlsx` by default).
- Logs every run to a daily log file.

## Prerequisites (do this once)

- Node.js **18+** installed.
  - Check: `node -v`
- These services are running and reachable:
  - `docgen-api-gate` (default: `http://localhost:30001`)
  - `docgen-content-control`
  - `docgen-json-to-word`
- Direct download enabled in `docgen-json-to-word` (already implemented in `ExcelController`).

## Configuration (do this once)

1) Copy the sample config:

```bash
cp scripts/flat-report/flat-report.config.sample.json scripts/flat-report/flat-report.config.json
```

2) Edit `scripts/flat-report/flat-report.config.json`:

Required fields (must be set or the job stops):
- `apiBaseUrl` (example: `http://localhost:30001`)
- `adoOrgUrl` (example: `https://dev.azure.com/your-org/`)
- `projectName` (ADO project name)
- `pat` (ADO Personal Access Token)
- `testPlanId` (number)
- `outputDir` (where the XLSX will be saved)
- `fileName` (example: `TestPlan.xlsx`)

Optional fields (safe to leave as-is):
- `subSystemField` (default `Custom.SubSystem`)
- `assignedToField` (default `System.AssignedTo`)
- `stateField` (default `System.State`)
- `logDir` (recommended inside your output folder, e.g. `\\\\stel01\\edenTest\\TestPlans\\logs\\flat-report`)
- `disableOnInvalid` (default `true`)
- `schedule` (for Windows Task Scheduler helper)

Example (macOS local testing):

```json
{
  "apiBaseUrl": "http://localhost:30001",
  "adoOrgUrl": "https://dev.azure.com/your-org/",
  "projectName": "YourProject",
  "pat": "YOUR_PAT_HERE",
  "testPlanId": 123,
  "outputDir": "/Users/your-user/Desktop/TestPlans",
  "fileName": "TestPlan.xlsx",
  "logDir": "./logs/flat-report",
  "disableOnInvalid": true
}
```

Example (Windows share):

```json
{
  "apiBaseUrl": "http://localhost:30001",
  "adoOrgUrl": "https://dev.azure.com/your-org/",
  "projectName": "YourProject",
  "pat": "YOUR_PAT_HERE",
  "testPlanId": 123,
  "outputDir": "\\\\stel01\\edenTest\\TestPlans",
  "fileName": "TestPlan.xlsx",
  "logDir": "\\\\stel01\\edenTest\\TestPlans\\logs\\flat-report",
  "disableOnInvalid": true,
  "schedule": {
    "enabled": true,
    "time": "06:00",
    "taskName": "DocGenFlatReport",
    "runIfLoggedOff": false,
    "intervalMinutes": 0,
    "durationHours": 24
  }
}
```

## Run once (Windows) – test it

From docgen-api-gate repo root:

```bash
node scripts/flat-report/run-flat-report.js --config scripts/flat-report/flat-report.config.json
```

Expected results:
- XLSX saved to `outputDir`
  - Example: `\\stel01\edenTest\TestPlans\TestPlan.xlsx`
- Logs saved to `logDir`:
  - Example: `\\stel01\edenTest\TestPlans\logs\flat-report\flat-report-YYYYMMDD.log`

If config is invalid and `disableOnInvalid=true`, the job creates a **disable flag**:

```
<logDir>/flat-report.disabled
```

The job will **skip future runs** until the config is fixed.

## Schedule on Windows (Task Scheduler) – daily or every X minutes

1) Install the task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\flat-report\install-flat-report-schedule.ps1 -ConfigPath scripts\flat-report\flat-report.config.json
```

2) Remove the task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\flat-report\remove-flat-report-schedule.ps1 -TaskName DocGenFlatReport
```

Notes:
- `runIfLoggedOff=false` means the task runs only while you are logged in.
- If you need “run when logged off”, set `runIfLoggedOff=true` and the installer will prompt for Windows credentials (optionally set `runAsUser` to prefill the username).
- `runOnMissed=true` means if the PC was off at 06:00, the task runs as soon as it becomes available.
- To run more frequently for debugging, set `schedule.intervalMinutes` to a value like `10`.
- `schedule.durationHours` controls how long the repetition runs after the first daily trigger.

## Common mistakes (and fixes)

- **API response missing base64 payload**
  - The `docgen-json-to-word` service is not updated or not restarted. Rebuild/restart it.

- **File not written to network share**
  - Confirm you can manually create a file in the share with your account.
  - Check `outputDir` is correct and uses double backslashes: `\\\\server\\share\\folder`.

- **Task runs but no file**
  - Open the log file in `logDir` and check the error message.

- **Job keeps skipping**
  - Delete `<logDir>\flat-report.disabled` after fixing config, or re-run once manually.

## Quick checklist

- [ ] Node 18+ installed (`node -v`)
- [ ] Services running
- [ ] `scripts/flat-report/flat-report.config.json` filled with real values
- [ ] Manual run works
- [ ] File appears in the share
- [ ] Scheduler installed (optional)

## Troubleshooting

- **API response missing base64 payload**  
  The `docgen-json-to-word` service is likely not updated or not restarted. Rebuild/restart it.

- **File not written to network share**  
  Check permissions and path. For Windows shares, ensure the script runs under an account with access.

- **Invalid config disables the job**  
  Fix the config and re-run once; the disable flag will be removed automatically.
