const mockDocumentRunAggregate = jest.fn();
const mockIssueCountDocuments = jest.fn();

jest.mock('../../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: { aggregate: (...args: any[]) => mockDocumentRunAggregate(...args) },
}));
jest.mock('../../../models/Issue', () => ({
  __esModule: true,
  Issue: { countDocuments: (...args: any[]) => mockIssueCountDocuments(...args) },
}));

import { getRunCounts, getIssueCounts } from '../../../helpers/diagnostics/overviewQueries';

describe('getRunCounts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('defaults to a 24-hour window and totals across statuses', async () => {
    mockDocumentRunAggregate.mockResolvedValue([
      { _id: 'succeeded', count: 5 },
      { _id: 'failed', count: 2 },
      { _id: 'running', count: 1 },
    ]);

    const counts = await getRunCounts();

    expect(counts).toEqual({ windowHours: 24, total: 8, succeeded: 5, failed: 2, running: 1 });
  });

  test('defaults missing statuses to zero rather than omitting the field', async () => {
    mockDocumentRunAggregate.mockResolvedValue([{ _id: 'succeeded', count: 3 }]);

    const counts = await getRunCounts(48);

    expect(counts).toEqual({ windowHours: 48, total: 3, succeeded: 3, failed: 0, running: 0 });
  });
});

describe('getIssueCounts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('queries unresolved, regressed-and-unresolved, and recently-resolved counts', async () => {
    mockIssueCountDocuments.mockResolvedValueOnce(4).mockResolvedValueOnce(1).mockResolvedValueOnce(9);

    const counts = await getIssueCounts();

    expect(counts).toEqual({ unresolved: 4, regressed: 1, resolvedRecently: 9 });
    expect(mockIssueCountDocuments).toHaveBeenNthCalledWith(1, { status: 'unresolved' });
    expect(mockIssueCountDocuments).toHaveBeenNthCalledWith(2, {
      status: 'unresolved',
      regressedAt: { $exists: true },
    });
    expect(mockIssueCountDocuments.mock.calls[2][0]).toMatchObject({ status: 'resolved' });
    expect(mockIssueCountDocuments.mock.calls[2][0].resolvedAt.$gte).toBeInstanceOf(Date);
  });
});
