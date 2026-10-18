// What a downstream DocGen service (content-control, json-to-word) said when it answered an error.
// An AxiosError's own message is only "Request failed with status code 500"; the reason is in the
// JSON body the service returned, which was previously dropped everywhere the error was recorded.
const MAX_DOWNSTREAM_MESSAGE_LEN = 500;
const MAX_BODY_EXCERPT_LEN = 200;
const MAX_DOWNSTREAM_STACK_LEN = 2000;

export interface DownstreamFailure {
  status?: number;
  code?: string;
  // The service's own explanation, when it sent one.
  downstreamMessage?: string;
  // The message to record: the transport message, followed by the service's explanation. When the
  // service answered an error but sent no explanation, it says so instead of staying silent.
  message: string;
  // The top frames of the service's own stack, when it sent them.
  downstreamStack?: string;
  // The stack to record. With the service's frames it leads with them (that is where the failure
  // happened) and keeps this process's own frames after a separator; otherwise it is the error's own.
  stack?: string;
}

export function describeDownstreamFailure(err: any): DownstreamFailure {
  const transportMessage = typeof err?.message === 'string' && err.message ? err.message : String(err);
  const data = err?.response?.data;
  // A body that is not an object (an HTML error page, a bare string) is not a structured reason.
  const rawMessage = data && typeof data === 'object' ? data.message : undefined;
  const downstreamMessage =
    typeof rawMessage === 'string' && rawMessage.trim()
      ? rawMessage.trim().slice(0, MAX_DOWNSTREAM_MESSAGE_LEN)
      : undefined;
  const rawStack = data && typeof data === 'object' ? data.stack : undefined;
  const downstreamStack =
    typeof rawStack === 'string' && rawStack.trim()
      ? rawStack.trimEnd().slice(0, MAX_DOWNSTREAM_STACK_LEN)
      : undefined;
  const status = Number(err?.response?.status);
  const code =
    typeof data?.code === 'string' ? data.code : typeof err?.code === 'string' ? err.code : undefined;
  return {
    status: Number.isFinite(status) && status > 0 ? status : undefined,
    code,
    downstreamMessage,
    downstreamStack,
    stack: downstreamStack
      ? `docgen-content-control (top frames):\n${downstreamStack}\n--- api-gate ---\n${err?.stack ?? ''}`.trimEnd()
      : err?.stack,
    message: downstreamMessage
      ? `${transportMessage}: ${downstreamMessage}`
      : err?.response
        ? `${transportMessage} (service sent no error message${describeBody(data)})`
        : transportMessage,
  };
}

// A body that is not a structured error (an HTML page from a framework's default handler, a bare
// string) still says something. Tags are stripped and the text is bounded, so a page cannot flood
// the run record; an empty or object body adds nothing.
function describeBody(data: unknown): string {
  if (typeof data !== 'string') return '';
  const text = data
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BODY_EXCERPT_LEN);
  return text ? `; body: ${text}` : '';
}
