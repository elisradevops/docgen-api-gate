jest.mock('../../../models/Issue', () => ({
  __esModule: true,
  Issue: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn().mockResolvedValue(undefined),
  },
  ISSUE_OCCURRENCE_RUN_IDS_CAP: 50,
}));

import { Issue } from '../../../models/Issue';
import { upsertIssueForEvent, upsertIssuesForEvents } from '../../../helpers/diagnostics/issueUpsert';

const mockFindOneAndUpdate = Issue.findOneAndUpdate as jest.Mock;
const mockUpdateOne = Issue.updateOne as jest.Mock;

describe('upsertIssueForEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips debug/info events entirely', async () => {
    await upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'debug', version: '1.0.0' });
    await upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'info', version: '1.0.0' });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('skips warn events — only error level creates/updates issues', async () => {
    await upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'warn', version: '1.0.0' });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('upserts on an error event, with $setOnInsert/$inc/$set and environmentAtFirstSeen', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null); // genuine insert
    await upsertIssueForEvent({
      signature: 'failed to build compare report cannot read properties of undefined (reading <str>)',
      message: "Failed to build compare report Cannot read properties of undefined (reading 'split')",
      service: 'dg-api-gate',
      level: 'error',
      version: '1.0.0',
      project: 'elisradevops-project',
      runId: 'run-1',
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      signature: 'failed to build compare report cannot read properties of undefined (reading <str>)',
      service: 'dg-api-gate',
    });
    expect(update.$setOnInsert).toMatchObject({
      status: 'unresolved',
      message: "Failed to build compare report Cannot read properties of undefined (reading 'split')",
      environmentAtFirstSeen: { service: 'dg-api-gate', version: '1.0.0' },
    });
    expect(update.$inc).toEqual({ count: 1 });
    expect(update.$addToSet).toEqual({ projects: { $each: ['elisradevops-project'] } });
    expect(update.$push.occurrenceRunIds.$each).toEqual(['run-1']);
    expect(opts).toMatchObject({ upsert: true, new: false });
    // A genuine insert (before === null) never needs the regression flip.
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('a recurring but still-unresolved issue does not trigger the regression flip', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'issue-1', status: 'unresolved' });
    await upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'error', version: '1.0.0' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('a resolved issue whose signature reappears flips back to unresolved with regressedAt — the regression case', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'issue-1', status: 'resolved' });
    await upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'error', version: '1.0.0' });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'issue-1' });
    expect(update.$set.status).toBe('unresolved');
    expect(update.$set.regressedAt).toBeInstanceOf(Date);
  });

  test('never throws when Mongo fails', async () => {
    mockFindOneAndUpdate.mockRejectedValue(new Error('mongo is down'));
    await expect(
      upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'error', version: '1.0.0' })
    ).resolves.toBeUndefined();
  });

  test('omits $addToSet/$push when project/runId are absent', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    await upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'error', version: '1.0.0' });
    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$addToSet).toBeUndefined();
    expect(update.$push).toBeUndefined();
  });

  test('adds both project and docType to $addToSet in the same update', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    await upsertIssueForEvent({
      signature: 's',
      message: 'm',
      service: 'svc',
      level: 'error',
      version: '1.0.0',
      project: 'Cube-ADCS',
      docType: 'SVD',
    });
    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$addToSet).toEqual({ projects: { $each: ['Cube-ADCS'] }, docTypes: { $each: ['SVD'] } });
  });

  test('adds only docType to $addToSet when project is absent', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    await upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'error', version: '1.0.0', docType: 'SVD' });
    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$addToSet).toEqual({ docTypes: { $each: ['SVD'] } });
  });
});

describe('upsertIssuesForEvents (grouped)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue(null);
  });
  const ev = (over: Record<string, unknown> = {}) => ({
    signature: 'sig-a',
    message: 'm',
    service: 'svc',
    level: 'error',
    version: '1.0.0',
    ...over,
  });

  test('a burst of identical errors is one update with $inc of the group size', async () => {
    await upsertIssuesForEvents(Array.from({ length: 500 }, () => ev({ runId: 'run-1', project: 'P' })));
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$inc).toEqual({ count: 500 });
    expect(update.$push.occurrenceRunIds.$each).toEqual(['run-1']); // deduplicated
    expect(update.$addToSet.projects.$each).toEqual(['P']);
  });

  test('distinct signatures and distinct services each get their own update', async () => {
    await upsertIssuesForEvents([ev(), ev({ signature: 'sig-b' }), ev({ service: 'other' }), ev()]);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(3);
    const counts = mockFindOneAndUpdate.mock.calls.map(([f, u]) => [f.signature, f.service, u.$inc.count]);
    expect(counts).toEqual(expect.arrayContaining([['sig-a', 'svc', 2], ['sig-b', 'svc', 1], ['sig-a', 'other', 1]]));
  });

  test('ignores non-error events and merges runIds/projects across a group', async () => {
    await upsertIssuesForEvents([
      ev({ runId: 'r1', project: 'P1' }),
      ev({ runId: 'r2', project: 'P2', docType: 'SVD' }),
      ev({ level: 'warn', runId: 'r3' }),
    ]);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$inc.count).toBe(2);
    expect(update.$push.occurrenceRunIds.$each).toEqual(['r1', 'r2']);
    expect(update.$addToSet).toEqual({ projects: { $each: ['P1', 'P2'] }, docTypes: { $each: ['SVD'] } });
  });

  test('bounds concurrency: never more than 10 upserts in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    mockFindOneAndUpdate.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return null;
    });
    await upsertIssuesForEvents(Array.from({ length: 35 }, (_, i) => ev({ signature: `sig-${i}` })));
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(35);
    expect(peak).toBeLessThanOrEqual(10);
  });
});
