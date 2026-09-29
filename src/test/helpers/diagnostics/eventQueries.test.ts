const mockFind = jest.fn();
const mockAggregate = jest.fn();

jest.mock('../../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: { find: (...args: any[]) => mockFind(...args), aggregate: (...args: any[]) => mockAggregate(...args) },
}));

import {
  buildMatch,
  encodeCursor,
  decodeCursor,
  listEvents,
  getEventFacets,
  getEventHistogram,
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

describe('listEvents', () => {
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
    expect(pipeline[0].$match).toEqual({ ts: { $gte: since }, runId: 'run-1', $text: { $search: 'timeout' } });
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
