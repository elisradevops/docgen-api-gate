// The read side of Phase 7a's Monitoring tab — GET /diagnostics/overview, /issues,
// /issues/:issueId. Kept separate from DiagnosticsController (the ingest write path) so that
// controller stays focused on its one job. Response idiom copied from DiagnosticsController /
// IssueController: isMongoConnected() gate, {message, error:<snake_case>} pairs,
// res.status(...).json(...); return; (never return res.json), resource-named envelope keys.
import { Request, Response } from 'express';
import axios from 'axios';
import { isMongoConnected } from '../util/mongodb';
import { getRunCounts, getIssueCounts } from '../helpers/diagnostics/overviewQueries';
import { listIssues, getIssueDetail } from '../helpers/diagnostics/issueQueries';
import { listEvents, getEventFacets, getEventHistogram, EventFilters, SortField, SortDir } from '../helpers/diagnostics/eventQueries';
import { LOG_EVENT_RETENTION_MS } from '../models/LogEvent';
import { getRunDetail } from '../helpers/diagnostics/runDetail';
import { diffManifests, findBaselineRun } from '../helpers/diagnostics/manifestDiff';
import { buildRunReportContentControls, buildCompareReportContentControls } from '../helpers/diagnostics/reportContent';
import logger from '../util/logger';

function parsePositiveInt(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Accepts either a repeated query param (Express/qs parses ?level=warn&level=error as an
// array already) or one comma-separated value — the antd filter popover this feeds sends the
// former, a hand-typed curl/URL is more likely to send the latter.
function parseArrayParam(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string' && raw.length) return raw.split(',').map((v) => v.trim()).filter(Boolean);
  return undefined;
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const SORT_FIELDS = new Set<SortField>(['ts', 'service', 'level']);
function parseSortField(raw: unknown): SortField | undefined {
  return typeof raw === 'string' && SORT_FIELDS.has(raw as SortField) ? (raw as SortField) : undefined;
}
function parseSortDir(raw: unknown): SortDir | undefined {
  return raw === 'asc' || raw === 'desc' ? raw : undefined;
}

// Time range clamps at the 30-day TTL — nothing older is retained, so a wider request would
// just silently return nothing for the untruncated portion; clamping here makes that explicit
// rather than a confusing empty result.
function parseEventFilters(req: Request): EventFilters {
  const oldestRetained = new Date(Date.now() - LOG_EVENT_RETENTION_MS);
  const since = parseDate(req.query.since);
  const until = parseDate(req.query.until);
  return {
    level: parseArrayParam(req.query.level),
    service: parseArrayParam(req.query.service),
    project: parseArrayParam(req.query.project),
    docType: parseArrayParam(req.query.docType),
    runId: typeof req.query.runId === 'string' ? req.query.runId : undefined,
    since: since && since > oldestRetained ? since : oldestRetained,
    until,
    q: typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined,
  };
}

// A sort by service/level can't ride the {ts, _id} index, so its scan is bounded by narrowing
// the window instead; the response says so (windowCapped) rather than silently returning less.
const NON_TS_SORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class DiagnosticsQueryController {
  public async getOverview(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    try {
      const windowHours = parsePositiveInt(req.query.windowHours);
      const [runs, issues] = await Promise.all([getRunCounts(windowHours), getIssueCounts()]);
      res.status(200).json({ runs, issues });
    } catch (err) {
      res.status(500).json({ message: 'Failed to load diagnostics overview', error: String(err) });
    }
  }

  public async listIssues(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    try {
      const since = typeof req.query.since === 'string' ? new Date(req.query.since) : undefined;
      const items = await listIssues({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        service: typeof req.query.service === 'string' ? req.query.service : undefined,
        project: typeof req.query.project === 'string' ? req.query.project : undefined,
        since: since && !Number.isNaN(since.getTime()) ? since : undefined,
        limit: parsePositiveInt(req.query.limit),
      });
      res.status(200).json({
        issues: items.map(({ issue, docType }) => ({ ...issue.toObject(), docType })),
      });
    } catch (err) {
      res.status(500).json({ message: 'Failed to list issues', error: String(err) });
    }
  }

  public async getIssue(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    const { issueId } = req.params;
    try {
      const detail = await getIssueDetail(issueId);
      if (!detail) {
        res.status(404).json({ message: 'Issue not found', error: 'issue_not_found' });
        return;
      }
      res.status(200).json({ issue: detail.issue, trend: detail.trend, occurrences: detail.occurrences });
    } catch (err) {
      res.status(500).json({ message: 'Failed to load issue', error: String(err) });
    }
  }

  public async listEvents(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    try {
      const sortBy = parseSortField(req.query.sortBy);
      const filters = parseEventFilters(req);
      let windowCapped = false;
      if (sortBy && sortBy !== 'ts') {
        const cap = new Date(Date.now() - NON_TS_SORT_WINDOW_MS);
        if (filters.since && filters.since < cap) {
          filters.since = cap;
          windowCapped = true;
        }
      }
      const result = await listEvents({
        filters,
        sortBy,
        sortDir: parseSortDir(req.query.sortDir),
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        limit: parsePositiveInt(req.query.limit),
        includeCount: req.query.includeCount === 'true',
      });
      res.status(200).json(windowCapped ? { ...result, windowCapped: true } : result);
    } catch (err) {
      res.status(500).json({ message: 'Failed to list events', error: String(err) });
    }
  }

  public async getEventFacets(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    try {
      const facets = await getEventFacets(parseEventFilters(req));
      res.status(200).json({ facets });
    } catch (err) {
      res.status(500).json({ message: 'Failed to load event facets', error: String(err) });
    }
  }

  public async getEventHistogram(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    try {
      const buckets = await getEventHistogram(parseEventFilters(req));
      res.status(200).json({ buckets });
    } catch (err) {
      res.status(500).json({ message: 'Failed to load event histogram', error: String(err) });
    }
  }

  public async getRunDetail(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    try {
      const detail = await getRunDetail(req.params.runId);
      if (!detail) {
        res.status(404).json({ message: 'Run not found', error: 'run_not_found' });
        return;
      }
      res.status(200).json({ run: detail.run, timeline: detail.timeline });
    } catch (err) {
      res.status(500).json({ message: 'Failed to load run', error: String(err) });
    }
  }

  public async compareRuns(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    const a = typeof req.query.a === 'string' ? req.query.a : undefined;
    const b = typeof req.query.b === 'string' ? req.query.b : undefined;
    if (!a || !b) {
      res.status(400).json({ message: 'Expected ?a=<runId>&b=<runId>', error: 'invalid_query' });
      return;
    }
    try {
      const [detailA, detailB] = await Promise.all([getRunDetail(a), getRunDetail(b)]);
      if (!detailA || !detailB) {
        res.status(404).json({ message: 'One or both runs not found', error: 'run_not_found' });
        return;
      }
      res.status(200).json(diffManifests(detailA.run, detailB.run));
    } catch (err) {
      res.status(500).json({ message: 'Failed to compare runs', error: String(err) });
    }
  }

  // GET /diagnostics/runs — lists recent DocumentRuns for baseline selection in RunCompare.
  // Filters by project+docType (required for a meaningful baseline list) with an optional
  // status filter (defaults to 'succeeded') and a hard limit cap (max 50).
  public async listRuns(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    const { project, docType, status, runId: excludeRunId } = req.query;
    if (!project || !docType) {
      res.status(400).json({ message: 'Expected ?project=&docType=', error: 'invalid_query' });
      return;
    }
    try {
      const limitRaw = parsePositiveInt(req.query.limit);
      const limit = Math.min(limitRaw ?? 20, 50);
      const filter: Record<string, unknown> = {
        project: String(project),
        docType: String(docType),
        status: typeof status === 'string' ? status : 'succeeded',
      };
      if (typeof excludeRunId === 'string' && excludeRunId) {
        filter.runId = { $ne: excludeRunId };
      }
      const { DocumentRun } = await import('../models/DocumentRun');
      const runs = await DocumentRun.find(filter)
        .sort({ startedAt: -1 })
        .limit(limit)
        .select('runId status trigger startedAt endedAt userId project docType templateName documentUrl')
        .lean();
      res.status(200).json({ runs });
    } catch (err) {
      res.status(500).json({ message: 'Failed to list runs', error: String(err) });
    }
  }

  public async getBaseline(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    try {
      const detail = await getRunDetail(req.params.runId);
      if (!detail) {
        res.status(404).json({ message: 'Run not found', error: 'run_not_found' });
        return;
      }
      const baseline = await findBaselineRun(detail.run);
      if (!baseline) {
        res.status(404).json({ message: 'No baseline run found', error: 'baseline_not_found' });
        return;
      }
      res.status(200).json({ runId: baseline.runId });
    } catch (err) {
      res.status(500).json({ message: 'Failed to find baseline run', error: String(err) });
    }
  }

  public async getRunReport(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    try {
      const detail = await getRunDetail(req.params.runId);
      if (!detail) {
        res.status(404).json({ message: 'Run not found', error: 'run_not_found' });
        return;
      }
      const contentControls = buildRunReportContentControls(detail.run, detail.timeline);
      await sendDocxReport(res, contentControls, `diagnostics-run-${detail.run.runId}.docx`);
    } catch (err) {
      logger.error('Failed to build run report', err);
      res.status(500).json({ message: 'Failed to build run report', error: String(err) });
    }
  }

  public async getCompareReport(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    const a = typeof req.query.a === 'string' ? req.query.a : undefined;
    const b = typeof req.query.b === 'string' ? req.query.b : undefined;
    if (!a || !b) {
      res.status(400).json({ message: 'Expected ?a=<runId>&b=<runId>', error: 'invalid_query' });
      return;
    }
    try {
      const [detailA, detailB] = await Promise.all([getRunDetail(a), getRunDetail(b)]);
      if (!detailA || !detailB) {
        res.status(404).json({ message: 'One or both runs not found', error: 'run_not_found' });
        return;
      }
      const diff = diffManifests(detailA.run, detailB.run);
      const contentControls = buildCompareReportContentControls(detailA.run, detailB.run, diff);
      await sendDocxReport(res, contentControls, `diagnostics-compare-${a}-vs-${b}.docx`);
    } catch (err) {
      logger.error('Failed to build compare report', err);
      res.status(500).json({ message: 'Failed to build compare report', error: String(err) });
    }
  }
}

// Filenames here are always self-generated (diagnostics-run-<runId>.docx etc.), never derived
// from untrusted MinIO object names — unlike MinioController's own Content-Disposition builder,
// which has to defend against arbitrary/non-ASCII stored filenames, this one doesn't need that
// machinery.
function buildAsciiContentDisposition(fileName: string): string {
  const safe = fileName.replace(/[^\x20-\x7E]/g, '_');
  return `attachment; filename="${safe}"`;
}

// The direct-to-json-to-word path this phase uses: no docgen-content-control round trip, no
// MinIO upload. uploadProperties.enableDirectDownload:true makes WordController.cs return
// {FileName, Base64, ApplicationType} inline instead of uploading anywhere — decoded and
// streamed straight back here.
async function sendDocxReport(res: Response, contentControls: { title: string; wordObjects: Record<string, unknown>[] }[], fileName: string): Promise<void> {
  const response = await axios.post(`${process.env.jsonToWordPostUrl}/api/word/create`, {
    ContentControls: contentControls,
    uploadProperties: { enableDirectDownload: true, fileName },
  });
  const payload = response.data as { Base64?: string; base64?: string };
  const base64 = payload?.Base64 ?? payload?.base64;
  if (!base64) {
    throw new Error('json-to-word did not return a Base64 payload for enableDirectDownload');
  }
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': buildAsciiContentDisposition(fileName),
  });
  res.status(200).send(Buffer.from(base64, 'base64'));
}
