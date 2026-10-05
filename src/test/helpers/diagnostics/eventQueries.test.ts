const mockFind = jest.fn();
const mockAggregate = jest.fn();
const mockCountDocuments = jest.fn();

jest.mock('../../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: {
    find: (...args: any[]) => mockFind(...args),
    aggregate: (...args: any[]) => mockAggregate(...args),
    countDocuments: (...args: any[]) => mockCountDocuments(...args),
  },
}));

import {
  buildMatch,
  encodeCursor,
  decodeCursor,
  listEvents,
  getEventFacets,
  getEventHistogram,
  insertedAfterCondition,
  INSERTED_AFTER_OVERLAP_SECONDS,
} from '../../../helpers/diagnostics/eventQueries';

function chainable(result: any[]) {
  const chain: any = { sort: jest.fn(() => chain), limit: jest.fn(() => chain), lean: jest.fn(() => Promise.resolve(result)) };
  return chain;
}

describe('buildMatch', () => {
  test('builds an empty match with no filters', () => {
    expect(buildMatch({})).toEqual({});
  });

  test('includes a time range only when since/until are present', () => {
    const since = new Date('2026-01-01');
    const until = new Date('2026-01-02');
    expect(buildMatch({ since, until })).toEqual({ ts: { $gte: since, $lte: until } });
  });

  test('uses $in for multi-value field filters', () => {
    expect(buildMatch({ service: ['dg-api-gate', 'dg-content-control'] })).toEqual({
      service: { $in: ['dg-api-gate', 'dg-content-control'] },
    });
  });

  test('adds $text for free-text search', () => {
    expect(buildMatch({ q: 'timeout' })).toEqual({ $text: { $search: 'timeout' } });
  });

  test('excludes the named dimension even when a value is supplied for it', () => {
    const match = buildMatch({ service: ['dg-api-gate'], project: ['Cube-ADCS'] }, 'service');
    expect(match).toEqual({ project: { $in: ['Cube-ADCS'] } });
  });

  test('omits an empty array filter rather than matching nothing via $in: []', () => {
    expect(buildMatch({ service: [] })).toEqual({});
  });

  test('matches runId as an anchored prefix, not an exact value', () => {
    expect(buildMatch({ runId: 'abc123' })).toEqual({ runId: { $regex: '^abc123' } });
  });

  test('escapes regex metacharacters in runId so a literal value cannot be injected as a pattern', () => {
    expect(buildMatch({ runId: 'a.b*c' })).toEqual({ runId: { $regex: '^a\\.b\\*c' } });
  });
});

describe('cursor encode/decode', () => {
  test('round-trips a ts-sorted cursor', () => {
    const doc = { ts: new Date('2026-01-01T00:00:00.000Z'), service: 'svc', level: 'error', _id: '507f1f77bcf86cd799439011' };
    const encoded = encodeCursor('ts', doc as any);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ v: '2026-01-01T00:00:00.000Z', id: '507f1f77bcf86cd799439011' });
  });

  test('round-trips a service-sorted cursor', () => {
    const doc = { ts: new Date(), service: 'dg-content-control', level: 'warn', _id: '507f1f77bcf86cd799439011' };
    const decoded = decodeCursor(encodeCursor('service', doc as any));
    expect(decoded?.v).toBe('dg-content-control');
  });

  test('returns undefined for an absent cursor', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  test('returns undefined for a malformed/tampered cursor rather than throwing', () => {
    expect(decodeCursor('not-valid-base64-json')).toBeUndefined();
    expect(() => decodeCursor('not-valid-base64-json')).not.toThrow();
  });
});

describe('insertedAfterCondition (live tail by arrival)', () => {
  test('no condition without a usable instant', () => {
    expect(insertedAfterCondition(undefined)).toEqual({});
    expect(insertedAfterCondition(new Date('not a date'))).toEqual({});
  });

  test('an _id lower bound from the creation time, minus the overlap', () => {
    const at = new Date('2026-10-05T10:00:10.500Z');
    const cond = insertedAfterCondition(at) as any;
    const bound = cond._id.$gte as { getTimestamp: () => Date };
    expect(bound.getTimestamp().getTime()).toBe(Math.floor(at.getTime() / 1000) * 1000 - INSERTED_AFTER_OVERLAP_SECONDS * 1000);
  });

  test('never goes below the epoch', () => {
    const cond = insertedAfterCondition(new Date(500)) as any;
    expect(cond._id.$gte.getTimestamp().getTime()).toBe(0);
  });

  test('is by the _id, not by ts: an event with an old ts but a new id still matches', () => {
    // A late event (stamped 10:00:01, stored 10:00:12) has an _id created at 10:00:12, so it is
    // inside the bound for a boundary of 10:00:10 even though its ts is far older.
    const bound = (insertedAfterCondition(new Date('2026-10-05T10:00:10Z')) as any)._id.$gte;
    const lateStored = require('mongoose').Types.ObjectId.createFromTime(Date.parse('2026-10-05T10:00:12Z') / 1000);
    expect(lateStored.toHexString() >= bound.toHexString()).toBe(true);
    const storedLongAgo = require('mongoose').Types.ObjectId.createFromTime(Date.parse('2026-10-05T09:00:00Z') / 1000);
    expect(storedLongAgo.toHexString() >= bound.toHexString()).toBe(false);
  });
});

describe('listEvents', () => {
  test('insertedAfter is ANDed with the filters, and matchedCount stays over the same window', async () => {
    mockFind.mockReturnValue(chainable([]));
    mockCountDocuments.mockResolvedValue(0);
    await listEvents({ filters: { level: ['error'] }, insertedAfter: new Date('2026-10-05T10:00:10Z'), includeCount: true });
    const match = mockFind.mock.calls[mockFind.mock.calls.length - 1][0];
    expect(match.$and).toHaveLength(2);
    expect(match.$and[0]).toEqual({ level: { $in: ['error'] } });
    expect(match.$and[1]._id.$gte).toBeDefined();
  });

  test('matchedCount is counted over the same insertedAfter window, not the whole time range', async () => {
    mockFind.mockReturnValue(chainable([]));
    mockCountDocuments.mockClear();
    mockCountDocuments.mockResolvedValue(3);
    const r = await listEvents({ filters: { since: new Date('2026-10-01') }, insertedAfter: new Date('2026-10-05T10:00:10Z'), includeCount: true });
    expect(r.matchedCount).toBe(3);
    const counted = mockCountDocuments.mock.calls[0][0];
    expect(counted.$and).toHaveLength(2);
    expect(counted.$and[1]._id.$gte).toBeDefined();
  });

  test('without insertedAfter the match is unchanged', async () => {
    mockFind.mockReturnValue(chainable([]));
    await listEvents({ filters: { level: ['error'] } });
    expect(mockFind.mock.calls[mockFind.mock.calls.length - 1][0]).toEqual({ level: { $in: ['error'] } });
  });

  test('insertedAfter alone (no other filter, no cursor) is the whole match', async () => {
    mockFind.mockReturnValue(chainable([]));
    await listEvents({ filters: {}, insertedAfter: new Date('2026-10-05T10:00:10Z') });
    const match = mockFind.mock.calls[mockFind.mock.calls.length - 1][0];
    expect(Object.keys(match)).toEqual(['_id']);
  });

  beforeEach(() => jest.clearAllMocks());

  test('defaults to newest-first (ts desc) with no cursor', async () => {
    const findChain = chainable([]);
    mockFind.mockReturnValue(findChain);

    await listEvents({ filters: {} });

    expect(findChain.sort).toHaveBeenCalledWith({ ts: -1, _id: -1 });
  });

  test('supports ascending sort on an alternate indexed field', async () => {
    const findChain = chainable([]);
    mockFind.mockReturnValue(findChain);

    await listEvents({ filters: {}, sortBy: 'service', sortDir: 'asc' });

    expect(findChain.sort).toHaveBeenCalledWith({ service: 1, _id: 1 });
  });

  test('returns nextCursor only when more results exist than the page limit', async () => {
    const docs = Array.from({ length: 3 }, (_, i) => ({
      _id: `id-${i}`,
      ts: new Date(2026, 0, i + 1),
      service: 'svc',
      level: 'error',
    }));
    mockFind.mockReturnValue(chainable(docs));

    const result = await listEvents({ filters: {}, limit: 2 });

    expect(result.events).toHaveLength(2);
    expect(result.nextCursor).toBeDefined();
  });

  test('omits nextCursor on the last page', async () => {
    mockFind.mockReturnValue(chainable([{ _id: 'id-0', ts: new Date(), service: 'svc', level: 'error' }]));

    const result = await listEvents({ filters: {}, limit: 50 });

    expect(result.nextCursor).toBeUndefined();
  });

  test('combines the base match and cursor condition via a top-level $and, never nesting $text in an $or', async () => {
    const findChain = chainable([]);
    mockFind.mockReturnValue(findChain);
    const cursor = encodeCursor('ts', { ts: new Date('2026-01-01'), service: 's', level: 'error', _id: '507f1f77bcf86cd799439011' } as any);

    await listEvents({ filters: { q: 'timeout' }, cursor });

    const matchArg = mockFind.mock.calls[0][0];
    expect(matchArg.$and).toBeDefined();
    expect(matchArg.$and[0]).toEqual({ $text: { $search: 'timeout' } });
    expect(matchArg.$and[1].$or).toBeDefined();
  });

  test('clamps an oversized limit to the max', async () => {
    const findChain = chainable([]);
    mockFind.mockReturnValue(findChain);

    await listEvents({ filters: {}, limit: 10_000 });

    expect(findChain.limit).toHaveBeenCalledWith(201); // MAX_LIST_LIMIT (200) + 1 lookahead
  });

  test('omits matchedCount and never calls countDocuments when includeCount is not set', async () => {
    mockFind.mockReturnValue(chainable([]));

    const result = await listEvents({ filters: {} });

    expect(result.matchedCount).toBeUndefined();
    expect(mockCountDocuments).not.toHaveBeenCalled();
  });

  test('includes matchedCount, counted over the pre-cursor match, when includeCount is set', async () => {
    mockFind.mockReturnValue(chainable([]));
    mockCountDocuments.mockResolvedValue(342);
    const cursor = encodeCursor('ts', { ts: new Date('2026-01-01'), service: 's', level: 'error', _id: '507f1f77bcf86cd799439011' } as any);

    const result = await listEvents({ filters: { service: ['json-to-word'] }, cursor, includeCount: true });

    expect(result.matchedCount).toBe(342);
    // Counted over the base filters only — not the $and-wrapped cursor condition passed to find().
    expect(mockCountDocuments).toHaveBeenCalledWith({ service: { $in: ['json-to-word'] } });
  });
});

describe('getEventFacets', () => {
  beforeEach(() => jest.clearAllMocks());

  test('excludes each dimension from its own branch (the sibling-counts fix)', async () => {
    mockAggregate.mockResolvedValue([{ level: [], service: [{ _id: 'dg-content-control', count: 5 }], project: [], docType: [] }]);

    await getEventFacets({ service: ['dg-api-gate'] });

    const pipeline = mockAggregate.mock.calls[0][0];
    const facetStage = pipeline.find((stage: any) => stage.$facet)?.$facet;
    expect(facetStage).toBeDefined();
    const serviceBranchOwnFilter = facetStage.service.find((stage: any) => stage.$match?.service?.$in);
    expect(serviceBranchOwnFilter).toBeUndefined(); // service's own filter must not appear in its own branch

    const projectBranch = facetStage.project;
    const projectFilterMatch = projectBranch.find((stage: any) => stage.$match?.service?.$in);
    expect(projectFilterMatch).toBeDefined(); // but DOES appear in a sibling dimension's branch
  });

  test('shapes the response as {value, count} per dimension', async () => {
    mockAggregate.mockResolvedValue([
      {
        level: [{ _id: 'error', count: 3 }],
        service: [],
        project: [],
        docType: [],
      },
    ]);

    const facets = await getEventFacets({});

    expect(facets.level).toEqual([{ value: 'error', count: 3 }]);
    expect(facets.service).toEqual([]);
  });

  test('hoists common filters (time range, runId, q) into one leading $match before $facet', async () => {
    mockAggregate.mockResolvedValue([{ level: [], service: [], project: [], docType: [] }]);
    const since = new Date('2026-01-01');

    await getEventFacets({ since, runId: 'run-1', q: 'timeout' });

    const pipeline = mockAggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toEqual({ ts: { $gte: since }, runId: { $regex: '^run-1' }, $text: { $search: 'timeout' } });
    expect(pipeline[1].$facet).toBeDefined();
  });
});

describe('getEventHistogram', () => {
  beforeEach(() => jest.clearAllMocks());

  test('produces the requested number of buckets, zero-filled where empty', async () => {
    mockAggregate.mockResolvedValue([]);

    const buckets = await getEventHistogram({}, 24);

    expect(buckets).toHaveLength(24);
    expect(buckets[0].counts).toEqual({});
  });

  test('places counts into the matching bucket index, per level', async () => {
    mockAggregate.mockResolvedValue([
      { _id: { bucket: 0, level: 'error' }, count: 4 },
      { _id: { bucket: 0, level: 'warn' }, count: 1 },
      { _id: { bucket: 5, level: 'error' }, count: 2 },
    ]);

    const buckets = await getEventHistogram({ since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-02T00:00:00Z') }, 24);

    expect(buckets[0].counts).toEqual({ error: 4, warn: 1 });
    expect(buckets[5].counts).toEqual({ error: 2 });
  });

  test('discards an out-of-range bucket index rather than throwing (a boundary event landing on `until`)', async () => {
    mockAggregate.mockResolvedValue([{ _id: { bucket: 24, level: 'error' }, count: 1 }]);

    const buckets = await getEventHistogram({}, 24);

    expect(buckets.every((b) => Object.keys(b.counts).length === 0)).toBe(true);
  });
});
