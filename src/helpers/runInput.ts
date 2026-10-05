// What the user asked for, as the Documents tab shows it: the frontend builds a one-line summary
// and a details object (doc type, context, template, each content control's data) and sends them
// in uploadProperties. They normally only outlive the run as an object next to a *generated*
// document, so a run that failed has nothing to look at. This keeps them on the run record, taken
// when the run starts, so Run detail can show the input of a failed run too.
//
// Both values come from the client and are for display only: the summary is clamped and the
// details are parsed defensively, redacted by key (like manifest.inputs) and size-bounded.
import { DocumentRequest } from '../models/DocumentRequest';
import { redactValue } from '../util/logger';
import { boundedData, MAX_CONTROL_DATA_BYTES } from './runManifest';

const MAX_SUMMARY_LEN = 1024;

export interface RunInput {
  summary?: string;
  details?: Record<string, unknown>;
}

export function buildRunInput(documentRequest: DocumentRequest): RunInput | undefined {
  const upload = documentRequest?.uploadProperties;
  const summary =
    typeof upload?.inputSummary === 'string' && upload.inputSummary.trim()
      ? upload.inputSummary.trim().slice(0, MAX_SUMMARY_LEN)
      : undefined;

  let details: Record<string, unknown> | undefined;
  const rawDetails = upload?.inputDetails;
  if (typeof rawDetails === 'string' && rawDetails.trim()) {
    try {
      const parsed = JSON.parse(rawDetails);
      // Only an object is a usable "details"; a bare string/number/array is not what the
      // frontend sends and would not render.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        details = boundedData(redactValue(parsed), MAX_CONTROL_DATA_BYTES) as Record<string, unknown>;
      }
    } catch {
      // not JSON: leave the details out rather than failing the run
    }
  }

  return summary || details ? { summary, details } : undefined;
}
