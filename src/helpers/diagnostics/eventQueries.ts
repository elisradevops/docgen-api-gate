// Backs GET /diagnostics/events, /events/facets, /events/histogram — the Logs explorer's
// three read endpoints (Phase 7b). Shares one filter-building vocabulary so all three agree on
// what "the current query" means.
import mongoose from 'mongoose';
import { LogEvent } from '../../models/LogEvent';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface EventFilters {
  level?: string[];
  service?: string[];
  project?: string[];
  docType?: string[];
  runId?: string;
  since?: Date;
  until?: Date;
  // Free-text search over `message`, via the { message: 'text' } index (models/LogEvent.ts).
  q?: string;
}

const FILTER_DIMENSIONS = ['level', 'service', 'project', 'docType'] as const;
type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

// The common part of the query — time range, runId, free-text — shared by every branch of the
// facets $facet stage and safe to run as a single leading $match (index-served: {ts:-1,_id:-1}
// and/or the text index) before the per-dimension work happens. `exclude` additionally omits
// one of the four field filters, for a facet branch computing that dimension's own sibling
// counts (a service filter shouldn't zero out the OTHER services' counts).
export function buildMatch(filters: EventFilters, exclude?: FilterDimension): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (filters.since || filters.until) {
    const range: Record<string, Date> = {};
    if (filters.since) range.$gte = filters.since;
    if (filters.until) range.$lte = filters.until;
    match.ts = range;
  }
  // Prefix match, not exact — the Logs table only ever displays a truncated runId (the first
  // 8 chars), so requiring the full UUID here would make that displayed value unusable as a
  // filter. Anchored (`^`) so it still uses the {runId:1, ts:1} index instead of a full scan.
  if (filters.runId) match.runId = { $regex: `^${escapeRegExp(filters.runId)}` };
  // $text is safe here (not nested inside an $or) — the cursor condition that IS an $or is
  // combined via a separate top-level $and in listEvents, never inside this object.
  if (filters.q) match.$text = { $search: filters.q };
  for (const dim of FILTER_DIMENSIONS) {
    if (dim === exclude) continue;
    const values = filters[dim];
    if (values && values.length) match[dim] = { $in: values };
  }
  return match;
}

export type SortField = 'ts' | 'service' | 'level';
export type SortDir = 'asc' | 'desc';

export interface EventCursor {
  v: string;
  id: string;
}

// Opaque to the client on purpose — a {sortValue, _id} tuple, base64-encoded. _id is required
// as a tiebreaker because `ts` is not unique across a batched flush (many events can share a
// timestamp); the same reasoning applies to service/level, which are far from unique.
export function encodeCursor(sortBy: SortField, doc: { ts: Date; service: string; level: string; _id: unknown }): string {
  const v = sortBy === 'ts' ? new Date(doc.ts).toISOString() : String(doc[sortBy]);
  return Buffer.from(JSON.stringify({ v, id: String(doc._id) })).toString('base64');
}

export function decodeCursor(raw?: string): EventCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (typeof parsed?.v === 'string' && typeof parsed?.id === 'string') return parsed;
  } catch {
    // malformed/tampered cursor — treated as "no cursor" (first page) rather than an error
  }
  return undefined;
}

function cursorValue(sortBy: SortField, raw: string): string | Date {
  return sortBy === 'ts' ? new Date(raw) : raw;
}

// Combined via a top-level $and with the base $match in listEvents — never nested inside an
// $or that also contains $text (the one arrangement Mongo actually forbids).
function buildCursorCondition(sortBy: SortField, dir: SortDir, cursor?: EventCursor): Record<string, unknown> {
  if (!cursor) return {};
  const cmp = dir === 'desc' ? '$lt' : '$gt';
  const v = cursorValue(sortBy, cursor.v);
  const id = new mongoose.Types.ObjectId(cursor.id);
  return {
    $or: [{ [sortBy]: { [cmp]: v } }, { [sortBy]: v, _id: { [cmp]: id } }],
  };
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function clampLimit(raw?: number): number {
  if (!raw || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIST_LIMIT);
}

export interface ListEventsParams {
  filters: EventFilters;
  sortBy?: SortField;
  sortDir?: SortDir;
  cursor?: string;
  limit?: number;
  // Opt-in only — the Logs explorer's live-tail poll needs to know how many events matched its
  // (narrow, incremental) window versus how many the page actually returned, to show a "+N more
  // events" burst signal. Initial load / "load older" never set this, so they pay no extra
  // countDocuments cost.
  includeCount?: boolean;
  // Live tail: only documents inserted at or after this instant (minus a small overlap), by their
  // `_id` creation time — i.e. by ARRIVAL, not by the event's own `ts`. Events reach Mongo late and
  // out of order (each service buffers and flushes on its own), so a poll that advanced a `ts`
  // boundary would skip a slow service's older events for good. `_id` is generated when api-gate
  // inserts the document, on one clock, and the default `_id` index serves the range, so this needs
  // no extra index.
  insertedAfter?: Date;
}

// Absorbs documents generated within the same second and a little clock difference between
// api-gate pods; the client drops the resulting duplicates by id.
export const INSERTED_AFTER_OVERLAP_SECONDS = 2;

export function insertedAfterCondition(insertedAfter?: Date): Record<string, unknown> {
  if (!insertedAfter || Number.isNaN(insertedAfter.getTime())) return {};
  const seconds = Math.max(0, Math.floor(insertedAfter.getTime() / 1000) - INSERTED_AFTER_OVERLAP_SECONDS);
  return { _id: { $gte: mongoose.Types.ObjectId.createFromTime(seconds) } };
}

export async function listEvents(params: ListEventsParams) {
  const sortBy = params.sortBy ?? 'ts';
  const sortDir = params.sortDir ?? 'desc';
  const limit = clampLimit(params.limit);
  const base = buildMatch(params.filters);
  const cursorCond = buildCursorCondition(sortBy, sortDir, decodeCursor(params.cursor));
  const insertedCond = insertedAfterCondition(params.insertedAfter);
  const conditions = [base, cursorCond, insertedCond].filter((c) => Object.keys(c).length > 0);
  const finalMatch = conditions.length > 1 ? { $and: conditions } : conditions[0] ?? base;

  const sortDirection = sortDir === 'asc' ? 1 : -1;
  // Fetch one extra to know whether a next page exists without a separate countDocuments.
  const [docs, matchedCount] = await Promise.all([
    LogEvent.find(finalMatch)
      .sort({ [sortBy]: sortDirection, _id: sortDirection } as Record<string, 1 | -1>)
      .limit(limit + 1)
      .lean(),
    // Counted over `base` (pre-cursor), not `finalMatch` — this is "how many match the filters
    // overall", not "how many remain after this page's cursor position".
    // Over the same window the live tail asks about (insertedAfter included), so "matched vs returned"
    // is the burst size of THIS poll, not of the whole time range.
    params.includeCount
      ? LogEvent.countDocuments(Object.keys(insertedCond).length ? { $and: [base, insertedCond] } : base)
      : Promise.resolve(undefined),
  ]);

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor = hasMore ? encodeCursor(sortBy, page[page.length - 1] as any) : undefined;
  return { events: page, nextCursor, matchedCount };
}

const FACET_LIMIT = 200; // Phase 7's own acceptance test requires staying usable past 100 values.

export async function getEventFacets(filters: EventFilters): Promise<Record<FilterDimension, Array<{ value: string; count: number }>>> {
  // Only the conditions common to every branch (time range, runId, free-text) are safe to
  // hoist into one leading $match before $facet — that's the part index-served ({ts:-1,_id:-1}
  // and/or the text index). The four field filters vary per branch (each excludes its own
  // dimension) and are applied inside each sub-pipeline instead, over the already-reduced set.
  const commonMatch = buildMatch({ since: filters.since, until: filters.until, runId: filters.runId, q: filters.q });
  const facetStage: Record<string, unknown[]> = {};
  for (const dim of FILTER_DIMENSIONS) {
    const dimOnlyFilters: EventFilters = { ...filters, since: undefined, until: undefined, runId: undefined, q: undefined };
    const branchMatch = buildMatch(dimOnlyFilters, dim);
    facetStage[dim] = [
      ...(Object.keys(branchMatch).length ? [{ $match: branchMatch }] : []),
      { $match: { [dim]: { $ne: null } } },
      { $group: { _id: `$${dim}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: FACET_LIMIT },
    ];
  }

  const pipeline: unknown[] = [];
  if (Object.keys(commonMatch).length) pipeline.push({ $match: commonMatch });
  pipeline.push({ $facet: facetStage });

  const [result] = await LogEvent.aggregate(pipeline as any[]);
  const out = {} as Record<FilterDimension, Array<{ value: string; count: number }>>;
  for (const dim of FILTER_DIMENSIONS) {
    out[dim] = ((result?.[dim] ?? []) as Array<{ _id: string; count: number }>).map((row) => ({
      value: row._id,
      count: row.count,
    }));
  }
  return out;
}

export interface HistogramBucket {
  bucketStart: string;
  counts: Record<string, number>;
}

const DEFAULT_HISTOGRAM_BUCKETS = 24;
const DEFAULT_HISTOGRAM_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getEventHistogram(filters: EventFilters, bucketCount = DEFAULT_HISTOGRAM_BUCKETS): Promise<HistogramBucket[]> {
  const until = filters.until ?? new Date();
  const since = filters.since ?? new Date(until.getTime() - DEFAULT_HISTOGRAM_WINDOW_MS);
  const totalMs = Math.max(1, until.getTime() - since.getTime());
  const bucketMs = Math.max(1, Math.floor(totalMs / bucketCount));

  const match = buildMatch({ ...filters, since, until });
  // Same bucketing math as issueQueries.ts's issue-detail trend ($floor/$divide/$subtract on
  // ts), parameterized by bucket width and with `level` added to the group key so the
  // histogram can render per-level segments.
  const rows = await LogEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          bucket: { $floor: { $divide: [{ $subtract: ['$ts', since] }, bucketMs] } },
          level: '$level',
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const buckets: HistogramBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    bucketStart: new Date(since.getTime() + i * bucketMs).toISOString(),
    counts: {},
  }));
  for (const row of rows as Array<{ _id: { bucket: number; level: string }; count: number }>) {
    const idx = row._id.bucket;
    if (idx < 0 || idx >= bucketCount) continue; // a boundary event landing exactly on `until`
    buckets[idx].counts[row._id.level] = row.count;
  }
  return buckets;
}
