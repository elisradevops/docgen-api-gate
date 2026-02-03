const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const args = process.argv.slice(2);
const configArgIndex = args.findIndex((arg) => arg === '--config');
const configPath =
  configArgIndex >= 0 && args[configArgIndex + 1]
    ? args[configArgIndex + 1]
    : path.join(__dirname, 'flat-report.config.json');

const now = new Date();
const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
  now.getDate()
).padStart(2, '0')}`;

const toWinPath = (dir, fileName) => {
  const base = dir || '';
  if (process.platform === 'win32' || base.startsWith('\\\\')) {
    return path.win32.join(base, fileName);
  }
  return path.join(base, fileName);
};

const normalizeProjectBucketName = (projectName) => {
  let name = String(projectName || '')
    .trim()
    .toLowerCase()
    .replace('_', '-')
    .replace(/[^a-z0-9-]/g, '');
  if (name.length < 3) {
    name = `${name}-bucket`;
  }
  return name;
};

const loadConfig = async () => {
  const raw = await fsp.readFile(configPath, 'utf8');
  return JSON.parse(raw);
};

const ensureDir = async (dir) => {
  if (!dir) return;
  await fsp.mkdir(dir, { recursive: true });
};

const resolveLogDir = (config) => {
  if (config.logDir) return config.logDir;
  if (config.outputDir) {
    return toWinPath(config.outputDir, path.win32.join('logs', 'flat-report'));
  }
  return path.join('logs', 'flat-report');
};

const createLogger = async (config) => {
  const resolvedLogDir = resolveLogDir(config);
  await ensureDir(resolvedLogDir);
  const logFile = path.join(resolvedLogDir, `flat-report-${dateStamp}.log`);

  const write = (level, message, meta) => {
    const ts = new Date().toISOString();
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${ts}] [${level}] ${message}${suffix}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
    console.log(line.trimEnd());
  };

  return { logDir: resolvedLogDir, logFile, write };
};

const validateConfig = (config) => {
  const missing = [];
  if (!config.apiBaseUrl) missing.push('apiBaseUrl');
  if (!config.adoOrgUrl) missing.push('adoOrgUrl');
  if (!config.projectName) missing.push('projectName');
  if (!config.pat) missing.push('pat');
  if (!config.testPlanId) missing.push('testPlanId');
  if (!config.outputDir) missing.push('outputDir');
  if (!config.fileName) missing.push('fileName');
  return missing;
};

const readResponseBody = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const buildPayload = (config) => {
  const bucketName = config.bucketName || normalizeProjectBucketName(config.projectName);
  const selectedFields = [];
  const flatFieldMap = {};

  const addField = (key, refName) => {
    if (!refName) return;
    flatFieldMap[key] = refName;
    selectedFields.push(`${refName}@testCaseWorkItemField`);
  };

  addField('SubSystem', config.subSystemField);
  addField('Assigned To Test', config.assignedToField || 'System.AssignedTo');
  addField('testCase.State', config.stateField || 'System.State');

  return {
    tfsCollectionUri: config.adoOrgUrl,
    PAT: config.pat,
    teamProjectName: config.projectName,
    templateFile: '',
    uploadProperties: {
      bucketName,
      fileName: config.fileName,
      enableDirectDownload: true,
    },
    contentControls: [
      {
        title: 'test-reporter-flat-content-control',
        type: 'testReporterFlat',
        skin: 'testReporterFlat',
        headingLevel: 1,
        data: {
          testPlanId: config.testPlanId,
          selectedFields,
          flatFieldMap,
        },
        isExcelSpreadsheet: true,
      },
    ],
    formattingSettings: {
      trimAdditionalSpacingInDescriptions: false,
      trimAdditionalSpacingInTables: false,
    },
  };
};

const main = async () => {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`Failed to read config at ${configPath}: ${err.message}`);
    process.exit(2);
  }

  const logger = await createLogger(config);
  const lockFile = path.join(logger.logDir, 'flat-report.disabled');
  const disableOnInvalid = config.disableOnInvalid !== false;

  const missing = validateConfig(config);
  if (missing.length > 0) {
    logger.write('error', 'Config validation failed', { missing });
    if (disableOnInvalid) {
      fs.writeFileSync(lockFile, `Invalid config: ${missing.join(', ')}`, 'utf8');
      logger.write('warn', 'Created disable flag; job will skip until config is fixed', {
        lockFile,
      });
    }
    process.exit(1);
  }

  if (disableOnInvalid && fs.existsSync(lockFile)) {
    logger.write('warn', 'Disable flag found. Validating config before proceeding.', { lockFile });
    const recheckMissing = validateConfig(config);
    if (recheckMissing.length > 0) {
      logger.write('error', 'Config still invalid; skipping run', { missing: recheckMissing });
      process.exit(1);
    }
    fs.unlinkSync(lockFile);
    logger.write('info', 'Config fixed; disable flag removed');
  }

  const payload = buildPayload(config);
  const url = `${config.apiBaseUrl.replace(/\/$/, '')}/jsonDocument/create-test-reporter-flat`;

  logger.write('info', 'Starting flat report job', { url });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await readResponseBody(response);
    logger.write('error', 'API request failed', { status: response.status, body });
    if (disableOnInvalid && response.status >= 400 && response.status < 500) {
      fs.writeFileSync(lockFile, `API validation error: ${response.status}`, 'utf8');
      logger.write('warn', 'Created disable flag due to API validation error', { lockFile });
    }
    process.exit(1);
  }

  const data = await response.json();
  const doc = data?.documentUrl ?? data;
  const base64 = doc?.Base64 || doc?.base64;
  if (!base64) {
    logger.write('error', 'API response missing base64 payload', { data });
    process.exit(1);
  }

  const fileName = config.fileName.endsWith('.xlsx') ? config.fileName : `${config.fileName}.xlsx`;
  const outputPath = toWinPath(config.outputDir, fileName);
  await ensureDir(config.outputDir);
  const buffer = Buffer.from(base64, 'base64');
  await fsp.writeFile(outputPath, buffer);

  logger.write('info', 'Report saved', { outputPath, bytes: buffer.length });
};

main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
