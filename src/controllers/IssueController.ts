import { Request, Response } from 'express';
import { Issue } from '../models/Issue';

export class IssueController {
  // POST /diagnostics/issues/:issueId/resolve — the only mutation this model has (no
  // ignore/mute/assign — see models/Issue.ts). Guarded requireSession+requireCsrf at the
  // route (the /auth/logout precedent, the only existing pair for "must always have an
  // acting user"), so req.spSession is always populated by the time this runs.
  public async resolve(req: Request, res: Response): Promise<void> {
    const { issueId } = req.params;
    const homeAccountId = (req as any).spSession?.homeAccountId;
    const issue = await Issue.findByIdAndUpdate(
      issueId,
      { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: homeAccountId } },
      { new: true }
    );
    if (!issue) {
      res.status(404).json({ message: 'Issue not found', error: 'issue_not_found' });
      return;
    }
    res.status(200).json({ issue });
  }
}
