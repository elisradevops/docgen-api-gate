import { computeSignature } from '../../../helpers/diagnostics/signature';

describe('computeSignature', () => {
  test('two different work-item ids normalize to the same signature', () => {
    const a = computeSignature('Failed fetching work item 12345');
    const b = computeSignature('Failed fetching work item 67890');
    expect(a).toBe(b);
  });

  test('is case-insensitive and collapses whitespace', () => {
    const a = computeSignature('Could Not Fetch Query Results:  timeout');
    const b = computeSignature('could not fetch query results: timeout');
    expect(a).toBe(b);
  });

  test('replaces a GUID with a placeholder', () => {
    const out = computeSignature('Run 3fa85f64-5717-4562-b3fc-2c963f66afa6 failed');
    expect(out).toContain('<guid>');
    expect(out).not.toContain('3fa85f64');
  });

  test('replaces a URL with a placeholder', () => {
    const out = computeSignature('Request to https://dev.azure.com/org/project failed');
    expect(out).toContain('<url>');
    expect(out).not.toContain('dev.azure.com');
  });

  test('replaces a quoted literal with a placeholder', () => {
    const out = computeSignature('Field "System.Title" is required');
    expect(out).toContain('<str>');
    expect(out).not.toContain('System.Title');
  });

  test('truncates a very long message to a bounded length', () => {
    const out = computeSignature('x'.repeat(10000));
    expect(out.length).toBeLessThanOrEqual(300);
  });

  test('never throws on empty/undefined-ish input', () => {
    expect(() => computeSignature('')).not.toThrow();
    expect(() => computeSignature(undefined as unknown as string)).not.toThrow();
  });
});
