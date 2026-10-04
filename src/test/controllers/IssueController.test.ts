jest.mock('../../models/Issue', () => ({
  __esModule: true,
  Issue: { findByIdAndUpdate: jest.fn() },
}));

import { Issue } from '../../models/Issue';
import { IssueController } from '../../controllers/IssueController';
import { buildRes } from '../utils/testResponse';

const mockFindByIdAndUpdate = Issue.findByIdAndUpdate as jest.Mock;

describe('IssueController.resolve', () => {
  let controller: IssueController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new IssueController();
  });

  test('resolves the issue, attributing resolvedBy to the X-User-Id header', async () => {
    mockFindByIdAndUpdate.mockResolvedValue({ _id: 'issue-1', status: 'resolved', resolvedBy: 'home-account-1' });
    const req: any = { params: { issueId: 'issue-1' }, headers: { 'x-user-id': 'home-account-1' } };
    const res = buildRes();

    await controller.resolve(req, res);

    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      'issue-1',
      { $set: expect.objectContaining({ status: 'resolved', resolvedBy: 'home-account-1' }) },
      { new: true }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'resolved' });
  });

  test('sets resolvedAt to a real Date', async () => {
    mockFindByIdAndUpdate.mockResolvedValue({ _id: 'issue-1' });
    const req: any = { params: { issueId: 'issue-1' }, headers: { 'x-user-id': 'home-account-1' } };
    await controller.resolve(req, buildRes());

    const [, update] = mockFindByIdAndUpdate.mock.calls[0];
    expect(update.$set.resolvedAt).toBeInstanceOf(Date);
  });

  test('returns 404 when the issue does not exist', async () => {
    mockFindByIdAndUpdate.mockResolvedValue(null);
    const req: any = { params: { issueId: 'missing' }, headers: { 'x-user-id': 'home-account-1' } };
    const res = buildRes();

    await controller.resolve(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('issue_not_found');
  });

  test('leaves resolvedBy undefined without the header, and clamps an oversized one', async () => {
    mockFindByIdAndUpdate.mockResolvedValue({ _id: 'issue-1' });
    await controller.resolve({ params: { issueId: 'issue-1' }, headers: {} } as any, buildRes());
    expect(mockFindByIdAndUpdate.mock.calls[0][1].$set.resolvedBy).toBeUndefined();

    await controller.resolve({ params: { issueId: 'issue-1' }, headers: { 'x-user-id': 'u'.repeat(500) } } as any, buildRes());
    expect(mockFindByIdAndUpdate.mock.calls[1][1].$set.resolvedBy).toHaveLength(200);
  });
});
