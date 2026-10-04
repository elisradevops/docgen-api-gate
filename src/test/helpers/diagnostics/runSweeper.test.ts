jest.mock('../../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: { updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }) },
}));
jest.mock('../../../util/mongodb', () => ({
  __esModule: true,
  isMongoConnected: jest.fn().mockReturnValue(true),
}));

import { DocumentRun } from '../../../models/DocumentRun';
import { isMongoConnected } from '../../../util/mongodb';
import { sweepStaleRuns } from '../../../helpers/diagnostics/runSweeper';

const mockUpdateMany = DocumentRun.updateMany as jest.Mock;

describe('sweepStaleRuns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isMongoConnected as jest.Mock).mockReturnValue(true);
  });

  test('marks runs still "running" past the stale threshold as failed, with an explanatory entry', async () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const count = await sweepStaleRuns(now, 60 * 60 * 1000);
    expect(count).toBe(2);
    const [filter, update] = mockUpdateMany.mock.calls[0];
    expect(filter.status).toBe('running');
    expect(filter.startedAt.$lt).toEqual(new Date('2026-10-04T11:00:00Z'));
    expect(update.$set.status).toBe('failed');
    expect(update.$set.endedAt).toEqual(new Date(now));
    expect(update.$set.errorChain[0]).toMatchObject({ service: 'dg-api-gate' });
  });

  test('does nothing while Mongo is disconnected', async () => {
    (isMongoConnected as jest.Mock).mockReturnValue(false);
    expect(await sweepStaleRuns()).toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
