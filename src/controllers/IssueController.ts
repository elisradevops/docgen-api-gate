import { Request, Response } from 'express';
import { Issue } from '../models/Issue';

export class IssueController {
  // POST /diagnostics/issues/:issueId/resolve — the only mutation this model has (no
  // ignore/mute/assign — see models/Issue.ts). Guarded by requireMongo only (the ADO-PAT login
  // path never establishes a session to require). The acting user is whatever the X-User-Id
  // header says — the same unauthenticated identity hint the SharePoint routes use — so
  // resolvedBy is attribution for the audit trail, not an authorization decision.
  public async resolve(req: Request, res: Response): Promise<void> {
    const { issueId } = req.params;
    const header = req.headers['x-user-id'];
    const resolvedBy = typeof header === 'string' && header.trim() ? header.trim().slice(0, 200) : undefined;
    const issue = await Issue.findByIdAndUpdate(
      issueId,
      { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy } },
      { new: true }
    );
    if (!issue) {
      res.status(404).json({ message: 'Issue not found', error: 'issue_not_found' });
      return;
    }
    res.status(200).json({ issue });
  }
}
