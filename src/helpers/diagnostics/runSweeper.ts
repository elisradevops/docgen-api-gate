// A run is created 'running' and only ever finalized by the request that created it. If that
// process dies mid-run (a crash, an OOM kill, a pod eviction) or the finalize write fails, nothing
// else would ever close it: it would count as running until the 90-day TTL. This marks runs that
// have been "running" for longer than any real generation as failed, with an explanatory entry.
import { DocumentRun } from '../../models/DocumentRun';
import { isMongoConnected } from '../../util/mongodb';
import { runContextStore } from '../../util/runContext';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const envStale = Number(process.env.RUN_STALE_MS);
const RUN_STALE_MS = Number.isFinite(envStale) && envStale > 0 ? envStale : 60 * 60 * 1000;

export async function sweepStaleRuns(now: number = Date.now(), staleMs: number = RUN_STALE_MS): Promise<number> {
  if (!isMongoConnected()) return 0;
  const result = await DocumentRun.updateMany(
    { status: 'running', startedAt: { $lt: new Date(now - staleMs) } },
    {
      $set: {
        status: 'failed',
        endedAt: new Date(now),
        errorChain: [{ service: 'dg-api-gate', message: 'Run abandoned: no completion was recorded' }],
      },
    }
  );
  return (result as { modifiedCount?: number }).modifiedCount ?? 0;
}

export function startRunSweeper(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    // Same reasoning as the sink timers: don't inherit an unrelated request's ALS context.
    runContextStore.exit(() => {
      sweepStaleRuns().catch((e) => {
        console.error('Run sweeper failed', e);
      });
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
