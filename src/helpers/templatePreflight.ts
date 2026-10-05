// A generation needs its template (.dotx) in storage, but nothing touches it until json-to-word
// downloads it as the very last step — after every content control has been fetched. A missing
// template therefore surfaced only at the end, as json-to-word's bare "404 (Not Found)" that
// never says which file. This checks for the template up front and, if storage says it is gone,
// fails the run in seconds with a message that names it.
//
// It can only ever fail a run for one reason — storage answered 404. Anything else (a 403 on a
// presigned URL, a timeout, MinIO unreachable from this pod) means "could not verify", is
// warned about, and generation continues: a preflight must never block a run that would work.
import axios from 'axios';
import logger from '../util/logger';

const TIMEOUT_MS = 5000;

// bucket/key of the template, without host or query string: the query of a presigned URL carries
// its signature, which must not reach an error message or a log.
export function describeTemplateLocation(templateFile: string): string {
  try {
    return decodeURIComponent(new URL(templateFile).pathname.replace(/^\/+/, ''));
  } catch {
    return '(unparseable template url)';
  }
}

export async function assertTemplateExists(templateFile: string | undefined): Promise<void> {
  if (!templateFile || !/^https?:\/\//i.test(templateFile)) return;
  const location = describeTemplateLocation(templateFile);
  let status: number | undefined;
  try {
    // A ranged GET rather than HEAD: a presigned URL is only valid for the method it was signed
    // for. Streamed and destroyed straight away, so a server that ignores Range doesn't send the
    // whole template.
    const response = await axios.get(templateFile, {
      headers: { Range: 'bytes=0-0' },
      timeout: TIMEOUT_MS,
      responseType: 'stream',
      validateStatus: () => true,
    });
    status = response?.status;
    (response?.data as { destroy?: () => void } | undefined)?.destroy?.();
  } catch (err: any) {
    logger.warn(`Could not verify the template before generating (${location}): ${err?.message ?? err}`);
    return;
  }

  if (status === 404) {
    logger.error(`Template not found in storage: ${location}`, { code: 'TEMPLATE_NOT_FOUND' });
    const error: any = new Error(`Template not found in storage: ${location}`);
    error.statusCode = 404;
    error.code = 'TEMPLATE_NOT_FOUND';
    error.step = 'validate-template';
    error.dependency = 'minio';
    error.url = (() => {
      try {
        const u = new URL(templateFile);
        return `${u.origin}${u.pathname}`;
      } catch {
        return undefined;
      }
    })();
    throw error;
  }
  if (status === undefined || status < 200 || status >= 300) {
    logger.warn(`Could not verify the template before generating (${location}): storage answered ${status ?? 'nothing'}`);
  }
}
