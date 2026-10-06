jest.mock('../../util/mongodb', () => ({
  __esModule: true,
  isMongoConnected: jest.fn(),
}));
jest.mock('../../helpers/diagnostics/overviewQueries', () => ({
  __esModule: true,
  getRunCounts: jest.fn(),
  getIssueCounts: jest.fn(),
}));
jest.mock('../../helpers/diagnostics/issueQueries', () => ({
  __esModule: true,
  listIssues: jest.fn(),
  getIssueDetail: jest.fn(),
}));
jest.mock('../../helpers/diagnostics/eventQueries', () => ({
  __esModule: true,
  listEvents: jest.fn(),
  getEventFacets: jest.fn(),
  getEventHistogram: jest.fn(),
}));
jest.mock('../../helpers/diagnostics/runDetail', () => ({
  __esModule: true,
  getRunDetail: jest.fn(),
}));
jest.mock('../../helpers/diagnostics/manifestDiff', () => ({
  __esModule: true,
  diffManifests: jest.fn(),
  findBaselineRun: jest.fn(),
}));
jest.mock('../../helpers/diagnostics/reportContent', () => ({
  __esModule: true,
  buildRunReportContentControls: jest.fn(),
  buildCompareReportContentControls: jest.fn(),
}));
jest.mock('axios');
jest.mock('../../util/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import axios from 'axios';
import { isMongoConnected } from '../../util/mongodb';
import { getRunCounts, getIssueCounts } from '../../helpers/diagnostics/overviewQueries';
import { listIssues, getIssueDetail } from '../../helpers/diagnostics/issueQueries';
import { listEvents, getEventFacets, getEventHistogram } from '../../helpers/diagnostics/eventQueries';
import { getRunDetail } from '../../helpers/diagnostics/runDetail';
import { diffManifests, findBaselineRun } from '../../helpers/diagnostics/manifestDiff';
import { buildRunReportContentControls, buildCompareReportContentControls } from '../../helpers/diagnostics/reportContent';
import { DiagnosticsQueryController } from '../../controllers/DiagnosticsQueryController';
import { buildRes } from '../utils/testResponse';

const mockAxiosPost = axios.post as jest.Mock;
const mockIsMongoConnected = isMongoConnected as jest.Mock;
const mockGetRunCounts = getRunCounts as jest.Mock;
const mockGetIssueCounts = getIssueCounts as jest.Mock;
const mockGetRunDetail = getRunDetail as jest.Mock;
const mockDiffManifests = diffManifests as jest.Mock;
const mockFindBaselineRun = findBaselineRun as jest.Mock;
const mockBuildRunReportContentControls = buildRunReportContentControls as jest.Mock;
const mockBuildCompareReportContentControls = buildCompareReportContentControls as jest.Mock;
const mockListIssues = listIssues as jest.Mock;
const mockGetIssueDetail = getIssueDetail as jest.Mock;
const mockListEvents = listEvents as jest.Mock;
const mockGetEventFacets = getEventFacets as jest.Mock;
const mockGetEventHistogram = getEventHistogram as jest.Mock;

describe('DiagnosticsQueryController', () => {
  let controller: DiagnosticsQueryController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMongoConnected.mockReturnValue(true);
    controller = new DiagnosticsQueryController();
  });

  describe('getOverview', () => {
    test('returns 503 when Mongo is unavailable, without querying', async () => {
      mockIsMongoConnected.mockReturnValue(false);
      const res = buildRes();

      await controller.getOverview({ query: {} } as any, res);

      expect(res.statusCode).toBe(503);
      expect(res.body.error).toBe('db_unavailable');
      expect(mockGetRunCounts).not.toHaveBeenCalled();
    });

    test('returns run and issue counts', async () => {
      mockGetRunCounts.mockResolvedValue({ windowHours: 24, total: 3, succeeded: 2, failed: 1, running: 0 });
      mockGetIssueCounts.mockResolvedValue({ unresolved: 2, regressed: 1, resolvedRecently: 4 });
      const res = buildRes();

      await controller.getOverview({ query: {} } as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        runs: { windowHours: 24, total: 3, succeeded: 2, failed: 1, running: 0 },
        issues: { unresolved: 2, regressed: 1, resolvedRecently: 4 },
      });
    });

    test('passes a parsed windowHours query param through', async () => {
      mockGetRunCounts.mockResolvedValue({ windowHours: 48, total: 0, succeeded: 0, failed: 0, running: 0 });
      mockGetIssueCounts.mockResolvedValue({ unresolved: 0, regressed: 0, resolvedRecently: 0 });

      await controller.getOverview({ query: { windowHours: '48' } } as any, buildRes());

      expect(mockGetRunCounts).toHaveBeenCalledWith(48);
    });

    test('returns 500 on an unexpected failure', async () => {
      mockGetRunCounts.mockRejectedValue(new Error('boom'));
      const res = buildRes();

      await controller.getOverview({ query: {} } as any, res);

      expect(res.statusCode).toBe(500);
    });
  });

  describe('listIssues', () => {
    test('defaults to unresolved and forwards filters', async () => {
      mockListIssues.mockResolvedValue([]);

      await controller.listIssues(
        { query: { service: 'dg-content-control', project: 'Cube-ADCS', limit: '10' } } as any,
        buildRes()
      );

      expect(mockListIssues).toHaveBeenCalledWith({
        status: undefined,
        service: 'dg-content-control',
        project: 'Cube-ADCS',
        since: undefined,
        limit: 10,
      });
    });

    test('returns issues with their looked-up docType merged in', async () => {
      const issue = { toObject: () => ({ _id: 'i1', signature: 'sig' }) };
      mockListIssues.mockResolvedValue([{ issue, docType: 'SVD' }]);
      const res = buildRes();

      await controller.listIssues({ query: {} } as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.issues).toEqual([{ _id: 'i1', signature: 'sig', docType: 'SVD' }]);
    });

    test('returns 503 when Mongo is unavailable', async () => {
      mockIsMongoConnected.mockReturnValue(false);
      const res = buildRes();

      await controller.listIssues({ query: {} } as any, res);

      expect(res.statusCode).toBe(503);
    });
  });

  describe('getIssue', () => {
    test('returns 404 when the issue does not exist', async () => {
      mockGetIssueDetail.mockResolvedValue(undefined);
      const res = buildRes();

      await controller.getIssue({ params: { issueId: 'missing' } } as any, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('issue_not_found');
    });

    test('returns the issue, trend, and occurrences on success', async () => {
      const detail = { issue: { _id: 'i1' }, trend: [{ hoursAgo: 0, count: 2 }], occurrences: [{ runId: 'r1' }] };
      mockGetIssueDetail.mockResolvedValue(detail);
      const res = buildRes();

      await controller.getIssue({ params: { issueId: 'i1' } } as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(detail);
    });
  });

  describe('listEvents', () => {
    test('returns 503 when Mongo is unavailable', async () => {
      mockIsMongoConnected.mockReturnValue(false);
      const res = buildRes();

      await controller.listEvents({ query: {} } as any, res);

      expect(res.statusCode).toBe(503);
      expect(mockListEvents).not.toHaveBeenCalled();
    });

    test('parses repeated array params and forwards sort/cursor/limit', async () => {
      mockListEvents.mockResolvedValue({ events: [], nextCursor: undefined });

      await controller.listEvents(
        {
          query: {
            service: ['dg-api-gate', 'dg-content-control'],
            level: 'warn,error',
            sortBy: 'service',
            sortDir: 'asc',
            cursor: 'abc',
            limit: '25',
          },
        } as any,
        buildRes()
      );

      expect(mockListEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({ service: ['dg-api-gate', 'dg-content-control'], level: ['warn', 'error'] }),
          sortBy: 'service',
          sortDir: 'asc',
          cursor: 'abc',
          limit: 25,
        })
      );
    });

    test('ignores an unsupported sortBy value rather than passing it through', async () => {
      mockListEvents.mockResolvedValue({ events: [] });

      await controller.listEvents({ query: { sortBy: 'message' } } as any, buildRes());

      expect(mockListEvents).toHaveBeenCalledWith(expect.objectContaining({ sortBy: undefined }));
    });

    test('passes includeCount through only when the query param is the literal string "true"', async () => {
      mockListEvents.mockResolvedValue({ events: [] });

      await controller.listEvents({ query: { includeCount: 'true' } } as any, buildRes());
      expect(mockListEvents).toHaveBeenCalledWith(expect.objectContaining({ includeCount: true }));

      mockListEvents.mockClear();
      await controller.listEvents({ query: {} } as any, buildRes());
      expect(mockListEvents).toHaveBeenCalledWith(expect.objectContaining({ includeCount: false }));
    });

    test('passes insertedAfter through (valid ISO only) and always returns serverTime', async () => {
      mockListEvents.mockResolvedValue({ events: [] });
      const res: any = buildRes();
      await controller.listEvents({ query: { insertedAfter: '2026-10-05T10:00:10.000Z' } } as any, res);
      expect(mockListEvents.mock.calls[0][0].insertedAfter).toEqual(new Date('2026-10-05T10:00:10.000Z'));
      expect(Number.isNaN(Date.parse(res.body.serverTime))).toBe(false);

      mockListEvents.mockClear();
      await controller.listEvents({ query: { insertedAfter: 'garbage' } } as any, buildRes());
      expect(mockListEvents.mock.calls[0][0].insertedAfter).toBeUndefined();
      mockListEvents.mockClear();
      await controller.listEvents({ query: {} } as any, buildRes());
      expect(mockListEvents.mock.calls[0][0].insertedAfter).toBeUndefined();
    });

    test('narrows the window to 7 days for a service/level sort and says so in the response', async () => {
      mockListEvents.mockResolvedValue({ events: [] });
      const res: any = buildRes();
      await controller.listEvents({ query: { sortBy: 'service' } } as any, res);
      const filters = mockListEvents.mock.calls[0][0].filters;
      const days = (Date.now() - filters.since.getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThan(7.01);
      expect(res.body.windowCapped).toBe(true);
    });

    test('does not narrow the window for the default ts sort', async () => {
      mockListEvents.mockResolvedValue({ events: [] });
      const res: any = buildRes();
      await controller.listEvents({ query: {} } as any, res);
      expect(res.body.windowCapped).toBeUndefined();
    });

    test('clamps a since older than the retention window forward to the oldest retained instant', async () => {
      mockListEvents.mockResolvedValue({ events: [] });

      await controller.listEvents({ query: { since: '2000-01-01T00:00:00.000Z' } } as any, buildRes());

      const filters = mockListEvents.mock.calls[0][0].filters;
      expect(filters.since.getTime()).toBeGreaterThan(new Date('2000-01-01').getTime());
    });

    test('returns the {events, nextCursor} shape, plus the server clock', async () => {
      mockListEvents.mockResolvedValue({ events: [{ _id: '1' }], nextCursor: 'xyz' });
      const res = buildRes();

      await controller.listEvents({ query: {} } as any, res);

      expect(res.body).toEqual({ events: [{ _id: '1' }], nextCursor: 'xyz', serverTime: expect.any(String) });
    });

    test('returns 500 on an unexpected failure', async () => {
      mockListEvents.mockRejectedValue(new Error('boom'));
      const res = buildRes();

      await controller.listEvents({ query: {} } as any, res);

      expect(res.statusCode).toBe(500);
    });
  });

  describe('getEventFacets', () => {
    test('returns 503 when Mongo is unavailable', async () => {
      mockIsMongoConnected.mockReturnValue(false);
      const res = buildRes();

      await controller.getEventFacets({ query: {} } as any, res);

      expect(res.statusCode).toBe(503);
    });

    test('wraps the result under a facets key', async () => {
      mockGetEventFacets.mockResolvedValue({ level: [{ value: 'error', count: 3 }], service: [], project: [], docType: [] });
      const res = buildRes();

      await controller.getEventFacets({ query: {} } as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.facets.level).toEqual([{ value: 'error', count: 3 }]);
    });
  });

  describe('getEventHistogram', () => {
    test('returns 503 when Mongo is unavailable', async () => {
      mockIsMongoConnected.mockReturnValue(false);
      const res = buildRes();

      await controller.getEventHistogram({ query: {} } as any, res);

      expect(res.statusCode).toBe(503);
    });

    test('wraps the result under a buckets key', async () => {
      mockGetEventHistogram.mockResolvedValue([{ bucketStart: '2026-01-01T00:00:00.000Z', counts: { error: 1 } }]);
      const res = buildRes();

      await controller.getEventHistogram({ query: {} } as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.buckets).toHaveLength(1);
    });
  });

  describe('getRunDetail', () => {
    test('returns 503 when Mongo is unavailable', async () => {
      mockIsMongoConnected.mockReturnValue(false);
      const res = buildRes();

      await controller.getRunDetail({ params: { runId: 'r1' } } as any, res);

      expect(res.statusCode).toBe(503);
      expect(mockGetRunDetail).not.toHaveBeenCalled();
    });

    test('returns 404 for an unknown run', async () => {
      mockGetRunDetail.mockResolvedValue(undefined);
      const res = buildRes();

      await controller.getRunDetail({ params: { runId: 'missing' } } as any, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('run_not_found');
    });

    test('returns the run and timeline on success', async () => {
      mockGetRunDetail.mockResolvedValue({ run: { runId: 'r1' }, timeline: [{ name: 'a' }] });
      const res = buildRes();

      await controller.getRunDetail({ params: { runId: 'r1' } } as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ run: { runId: 'r1' }, timeline: [{ name: 'a' }] });
    });
  });

  describe('compareRuns', () => {
    test('returns 400 when a or b is missing', async () => {
      const res = buildRes();

      await controller.compareRuns({ query: { a: 'r1' } } as any, res);

      expect(res.statusCode).toBe(400);
      expect(mockGetRunDetail).not.toHaveBeenCalled();
    });

    test('returns 404 when either run is missing', async () => {
      mockGetRunDetail.mockResolvedValueOnce({ run: { runId: 'r1' } }).mockResolvedValueOnce(undefined);
      const res = buildRes();

      await controller.compareRuns({ query: { a: 'r1', b: 'r2' } } as any, res);

      expect(res.statusCode).toBe(404);
    });

    test('diffs both runs and returns the result verbatim', async () => {
      const runA = { runId: 'r1' };
      const runB = { runId: 'r2' };
      mockGetRunDetail.mockResolvedValueOnce({ run: runA }).mockResolvedValueOnce({ run: runB });
      const diffResult = { crossType: false, bands: { outcomes: [], volumes: [], environment: [], inputs: [], unchanged: [] } };
      mockDiffManifests.mockReturnValue(diffResult);
      const res = buildRes();

      await controller.compareRuns({ query: { a: 'r1', b: 'r2' } } as any, res);

      expect(mockDiffManifests).toHaveBeenCalledWith(runA, runB);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(diffResult);
    });
  });

  describe('getBaseline', () => {
    test('returns 404 when the run itself does not exist', async () => {
      mockGetRunDetail.mockResolvedValue(undefined);
      const res = buildRes();

      await controller.getBaseline({ params: { runId: 'missing' } } as any, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('run_not_found');
    });

    test('returns 404 with baseline_not_found when no baseline exists', async () => {
      mockGetRunDetail.mockResolvedValue({ run: { runId: 'r1' } });
      mockFindBaselineRun.mockResolvedValue(undefined);
      const res = buildRes();

      await controller.getBaseline({ params: { runId: 'r1' } } as any, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('baseline_not_found');
    });

    test('returns the baseline runId on success', async () => {
      mockGetRunDetail.mockResolvedValue({ run: { runId: 'r1' } });
      mockFindBaselineRun.mockResolvedValue({ runId: 'baseline-1' });
      const res = buildRes();

      await controller.getBaseline({ params: { runId: 'r1' } } as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ runId: 'baseline-1' });
    });
  });

  describe('getRunReport', () => {
    test('returns 404 when the run does not exist', async () => {
      mockGetRunDetail.mockResolvedValue(undefined);
      const res = buildRes();

      await controller.getRunReport({ params: { runId: 'missing' } } as any, res);

      expect(res.statusCode).toBe(404);
    });

    test('builds content controls, posts to json-to-word with enableDirectDownload, and streams the decoded DOCX', async () => {
      mockGetRunDetail.mockResolvedValue({ run: { runId: 'r1' }, timeline: [] });
      mockBuildRunReportContentControls.mockReturnValue([{ title: 'diagnostics-run-report', wordObjects: [] }]);
      mockAxiosPost.mockResolvedValue({ data: { Base64: Buffer.from('fake docx bytes').toString('base64') } });
      const res = buildRes();

      await controller.getRunReport({ params: { runId: 'r1' } } as any, res);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/api/word/create'),
        expect.objectContaining({
          ContentControls: [{ title: 'diagnostics-run-report', wordObjects: [] }],
          uploadProperties: expect.objectContaining({ enableDirectDownload: true }),
        })
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(res.headers['Content-Disposition']).toContain('attachment');
      expect(res.text.toString()).toBe('fake docx bytes');
    });

    test('returns 500 when json-to-word does not return a Base64 payload', async () => {
      mockGetRunDetail.mockResolvedValue({ run: { runId: 'r1' }, timeline: [] });
      mockBuildRunReportContentControls.mockReturnValue([{ title: 'x', wordObjects: [] }]);
      mockAxiosPost.mockResolvedValue({ data: {} });
      const res = buildRes();

      await controller.getRunReport({ params: { runId: 'r1' } } as any, res);

      expect(res.statusCode).toBe(500);
    });
  });

  describe('getCompareReport', () => {
    test('returns 400 when a or b is missing', async () => {
      const res = buildRes();

      await controller.getCompareReport({ query: { a: 'r1' } } as any, res);

      expect(res.statusCode).toBe(400);
    });

    test('diffs, builds compare content controls, and streams the decoded DOCX', async () => {
      const runA = { runId: 'r1' };
      const runB = { runId: 'r2' };
      mockGetRunDetail.mockResolvedValueOnce({ run: runA }).mockResolvedValueOnce({ run: runB });
      const diffResult = { crossType: false, bands: { outcomes: [], volumes: [], environment: [], inputs: [], unchanged: [] } };
      mockDiffManifests.mockReturnValue(diffResult);
      mockBuildCompareReportContentControls.mockReturnValue([{ title: 'diagnostics-compare-report', wordObjects: [] }]);
      mockAxiosPost.mockResolvedValue({ data: { Base64: Buffer.from('compare bytes').toString('base64') } });
      const res = buildRes();

      await controller.getCompareReport({ query: { a: 'r1', b: 'r2' } } as any, res);

      expect(mockBuildCompareReportContentControls).toHaveBeenCalledWith(runA, runB, diffResult);
      expect(res.statusCode).toBe(200);
      expect(res.text.toString()).toBe('compare bytes');
    });
  });
});
