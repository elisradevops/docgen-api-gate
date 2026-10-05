import { buildRunInput } from '../../helpers/runInput';
import type { DocumentRequest } from '../../models/DocumentRequest';

const req = (upload: Record<string, unknown>): DocumentRequest => ({ uploadProperties: upload } as unknown as DocumentRequest);
const details = (obj: unknown) => JSON.stringify(obj);

describe('buildRunInput', () => {
  test('keeps the summary and the parsed details the Documents tab would show', () => {
    const out = buildRunInput(
      req({
        inputSummary: 'Doc Type: STD | Test Plan: 42',
        inputDetails: details({ version: 1, docType: 'STD', contentControls: [{ title: 'Plan', data: { testPlanId: 42 } }] }),
      })
    );
    expect(out?.summary).toBe('Doc Type: STD | Test Plan: 42');
    expect(out?.details).toMatchObject({ version: 1, docType: 'STD' });
    expect((out?.details as any).contentControls[0].data.testPlanId).toBe(42);
  });

  test('is undefined when the request carries neither (a pipeline-started run)', () => {
    expect(buildRunInput(req({}))).toBeUndefined();
    expect(buildRunInput(req({ inputSummary: '   ', inputDetails: '' }))).toBeUndefined();
    expect(buildRunInput({} as DocumentRequest)).toBeUndefined();
  });

  test('clamps an oversized summary to 1024 characters', () => {
    expect(buildRunInput(req({ inputSummary: 'x'.repeat(5000) }))?.summary).toHaveLength(1024);
  });

  test('redacts credential-looking keys at any depth, keeps ordinary ones', () => {
    const out = buildRunInput(
      req({ inputDetails: details({ contentControls: [{ data: { query: 'q', token: 'tok-1', nested: { password: 'pw' }, areaPath: 'A\\B' } }] }) })
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain('tok-1');
    expect(text).not.toContain('"pw"');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('areaPath');
  });

  test('drops details that are not JSON, not an object, or an array — and keeps the summary', () => {
    for (const bad of ['not json', '"a string"', '42', '[1,2]', 'null']) {
      const out = buildRunInput(req({ inputSummary: 'S', inputDetails: bad }));
      expect(out).toEqual({ summary: 'S', details: undefined });
    }
    expect(buildRunInput(req({ inputDetails: 'not json' }))).toBeUndefined();
  });

  test('replaces oversized details with a size marker instead of bloating the run', () => {
    const out = buildRunInput(req({ inputDetails: details({ blob: 'y'.repeat(70 * 1024) }) }));
    expect(out?.details).toMatchObject({ omitted: true });
    expect((out?.details as any).bytes).toBeGreaterThan(64 * 1024);
  });

  test('ignores non-string inputs', () => {
    expect(buildRunInput(req({ inputSummary: 5, inputDetails: { a: 1 } }))).toBeUndefined();
  });
});
