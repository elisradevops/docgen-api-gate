jest.mock('../../../models/Issue', () => ({
  __esModule: true,
  Issue: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn().mockResolvedValue(undefined),
  },
  ISSUE_OCCURRENCE_RUN_IDS_CAP: 50,
}));

import { Issue } from '../../../models/Issue';
import { upsertIssueForEvent } from '../../../helpers/diagnostics/issueUpsert';

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
    expect(update.$addToSet).toEqual({ projects: 'elisradevops-project' });
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
    expect(update.$addToSet).toEqual({ projects: 'Cube-ADCS', docTypes: 'SVD' });
  });

  test('adds only docType to $addToSet when project is absent', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    await upsertIssueForEvent({ signature: 's', message: 'm', service: 'svc', level: 'error', version: '1.0.0', docType: 'SVD' });
    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(update.$addToSet).toEqual({ docTypes: 'SVD' });
  });
});
