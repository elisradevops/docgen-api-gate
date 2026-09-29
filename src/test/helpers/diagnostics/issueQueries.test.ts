const mockIssueFind = jest.fn();
const mockIssueFindById = jest.fn();
const mockDocumentRunFind = jest.fn();
const mockLogEventAggregate = jest.fn();

jest.mock('../../../models/Issue', () => ({
  __esModule: true,
  Issue: { find: (...args: any[]) => mockIssueFind(...args), findById: (...args: any[]) => mockIssueFindById(...args) },
}));
jest.mock('../../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: { find: (...args: any[]) => mockDocumentRunFind(...args) },
}));
jest.mock('../../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: { aggregate: (...args: any[]) => mockLogEventAggregate(...args) },
}));

import { listIssues, getIssueDetail } from '../../../helpers/diagnostics/issueQueries';

function chainable(result: any) {
  const chain: any = { sort: jest.fn(() => chain), limit: jest.fn(() => chain), lean: jest.fn(() => Promise.resolve(result)) };
  // Awaiting the chain itself (no .lean()) also resolves to result — Issue.find(...).sort().limit() is awaited directly.
  chain.then = (resolve: any) => Promise.resolve(result).then(resolve);
  return chain;
}

describe('listIssues', () => {
  beforeEach(() => jest.clearAllMocks());

  test('defaults to unresolved status', async () => {
    mockIssueFind.mockReturnValue(chainable([]));

    await listIssues({});

    expect(mockIssueFind).toHaveBeenCalledWith(expect.objectContaining({ status: 'unresolved' }));
  });

  test('clamps an oversized limit to the max', async () => {
    const findChain = chainable([]);
    mockIssueFind.mockReturnValue(findChain);

    await listIssues({ limit: 10_000 });

    expect(findChain.limit).toHaveBeenCalledWith(200);
  });

  test('falls back to the default limit for an invalid value', async () => {
    const findChain = chainable([]);
    mockIssueFind.mockReturnValue(findChain);

    await listIssues({ limit: -5 });

    expect(findChain.limit).toHaveBeenCalledWith(50);
  });

  test('attaches the docType of each issue\'s newest occurrence run', async () => {
    const issues = [
      { _id: 'i1', occurrenceRunIds: ['old-run', 'new-run'] },
      { _id: 'i2', occurrenceRunIds: [] },
    ];
    mockIssueFind.mockReturnValue(chainable(issues));
    mockDocumentRunFind.mockReturnValue({ lean: () => Promise.resolve([{ runId: 'new-run', docType: 'SVD' }]) });

    const result = await listIssues({});

    expect(mockDocumentRunFind).toHaveBeenCalledWith(
      { runId: { $in: ['new-run'] }, docType: { $ne: null } },
      { runId: 1, docType: 1 }
    );
    expect(result).toEqual([
      { issue: issues[0], docType: 'SVD' },
      { issue: issues[1], docType: undefined },
    ]);
  });

  test('does not query DocumentRun when no issue has occurrence runs', async () => {
    mockIssueFind.mockReturnValue(chainable([{ _id: 'i1', occurrenceRunIds: [] }]));

    await listIssues({});

    expect(mockDocumentRunFind).not.toHaveBeenCalled();
  });
});

describe('getIssueDetail', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns undefined when the issue does not exist', async () => {
    mockIssueFindById.mockResolvedValue(null);

    expect(await getIssueDetail('missing')).toBeUndefined();
    expect(mockLogEventAggregate).not.toHaveBeenCalled();
  });

  test('returns occurrences newest-first with their run metadata', async () => {
    mockIssueFindById.mockResolvedValue({
      signature: 'sig',
      service: 'dg-content-control',
      occurrenceRunIds: ['run-a', 'run-b'],
    });
    mockLogEventAggregate.mockResolvedValue([]);
    mockDocumentRunFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          { runId: 'run-a', startedAt: new Date('2026-01-01'), status: 'failed', project: 'P', docType: 'SVD' },
          { runId: 'run-b', startedAt: new Date('2026-01-02'), status: 'succeeded', project: 'P', docType: 'SVD' },
        ]),
    });

    const detail = await getIssueDetail('issue-1');

    expect(detail!.occurrences.map((o) => o.runId)).toEqual(['run-b', 'run-a']);
    expect(detail!.occurrences[0].status).toBe('succeeded');
  });

  test('fills a 24-hour trend with zero counts for empty buckets', async () => {
    mockIssueFindById.mockResolvedValue({ signature: 'sig', service: 'svc', occurrenceRunIds: [] });
    mockLogEventAggregate.mockResolvedValue([{ _id: 0, count: 5 }]);

    const detail = await getIssueDetail('issue-1');

    expect(detail!.trend).toHaveLength(24);
    expect(detail!.trend[23]).toEqual({ hoursAgo: 0, count: 5 });
    expect(detail!.trend[0]).toEqual({ hoursAgo: 23, count: 0 });
  });
});
