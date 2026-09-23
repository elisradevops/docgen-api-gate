import { redact } from '../../util/logger';

const applyRedact = (info: Record<string, unknown>) => (redact() as any).transform({ ...info });

describe('logger redact format', () => {
  test('scrubs a top-level token/password/secret regardless of key casing', () => {
    const out = applyRedact({ level: 'info', message: 'x', token: 'abc', Password: 'p', SECRET: 's' });
    expect(out.token).toBe('[REDACTED]');
    expect(out.Password).toBe('[REDACTED]');
    expect(out.SECRET).toBe('[REDACTED]');
  });

  test('scrubs minioAccessKey/minioSecretKey', () => {
    const out = applyRedact({ level: 'info', message: 'x', minioAccessKey: 'AKIA', minioSecretKey: 'shh' });
    expect(out.minioAccessKey).toBe('[REDACTED]');
    expect(out.minioSecretKey).toBe('[REDACTED]');
  });

  test('scrubs nested config.auth.password and config.headers.Authorization — the AxiosError.toJSON() leak', () => {
    const axiosLikeError = {
      message: 'Request failed',
      config: {
        auth: { username: '', password: 'super-secret-pat' },
        headers: { Authorization: 'Bearer abc.def.ghi' },
      },
    };
    const out: any = applyRedact({ level: 'error', message: 'upstream failed', err: axiosLikeError });
    expect(out.err.config.auth.password).toBe('[REDACTED]');
    expect(out.err.config.headers.Authorization).toBe('[REDACTED]');
    // Non-sensitive sibling data survives.
    expect(out.err.message).toBe('Request failed');
  });

  test('leaves non-sensitive fields untouched', () => {
    const out = applyRedact({ level: 'info', message: 'ok', project: 'Cube-ADCS', docType: 'SVD' });
    expect(out.project).toBe('Cube-ADCS');
    expect(out.docType).toBe('SVD');
  });

  test('never throws on a circular object', () => {
    const circular: any = { name: 'x' };
    circular.self = circular;
    expect(() => applyRedact({ level: 'info', message: 'x', circular })).not.toThrow();
  });

  test('never throws and passes info through on null/undefined meta', () => {
    expect(() => applyRedact({ level: 'info', message: 'x', meta: null })).not.toThrow();
    expect(() => applyRedact({ level: 'info', message: 'x', meta: undefined })).not.toThrow();
  });
});
