// Builders for DocumentRun.manifest — the four uniform layers (environment/inputs/steps/
// artifacts) that make Phase 7's generic, doc-type-agnostic run comparison possible. Kept
// out of DocumentsGeneratorController (which stays thin per this repo's own CLAUDE.md) and
// out of JsonDocumentGenerator (whose job is the content-control fan-out itself).
import { DocumentRequest } from '../models/DocumentRequest';
import { IDocumentRunManifest, IDocumentRunManifestStep } from '../models/DocumentRun';
import { readOwnVersion, redactValue } from '../util/logger';

export interface ContentControlVersions {
  service?: string;
  dataProvider?: string;
  skins?: string;
}

// Config flags that can affect generated output, not every env var — this is diagnostic
// context for a run, not a full environment dump.
export function buildEnvironment(contentControlVersions?: ContentControlVersions) {
  return {
    services: {
      'dg-api-gate': readOwnVersion(),
      'dg-content-control': contentControlVersions?.service || 'unknown',
    },
    packages: {
      '@elisra-devops/docgen-data-provider': contentControlVersions?.dataProvider || 'unknown',
      '@elisra-devops/docgen-skins': contentControlVersions?.skins || 'unknown',
    },
    flags: {
      LOG_FORMAT: process.env.LOG_FORMAT || 'text',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    },
  };
}

// Explicit allowlist, not a redacted copy of the whole request — the manifest ends up in a
// downloadable report (Phase 7), so the safer default is naming what's kept rather than
// naming what's stripped. redactValue is applied only to each content control's free-form
// `data` blob as a backstop for whatever an individual content-control type happens to put
// there (per Phase 5's plan wording: "normalized, redacted request tree").
// A content control's `data` can embed whole tables or documents; the manifest lives in one Mongo
// document (16MB cap) that is written at run end, so an oversized blob would fail the finalize
// write and leave the run looking "running". Oversized parts are replaced by a size marker.
export const MAX_CONTROL_DATA_BYTES = 64 * 1024;
const MAX_INPUTS_BYTES = 256 * 1024;

function jsonBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

export function boundedData(data: unknown, maxBytes: number): unknown {
  const bytes = jsonBytes(data);
  return bytes > maxBytes ? { omitted: true, bytes: Number.isFinite(bytes) ? bytes : undefined } : data;
}

export function buildInputs(documentRequest: DocumentRequest, resolvedContextName?: string) {
  const inputs = {
    templateName: documentRequest.templateFile,
    project: documentRequest.teamProjectName,
    orgUrl: documentRequest.tfsCollectionUri,
    formattingSettings: documentRequest.formattingSettings,
    resolvedContextName: resolvedContextName || undefined,
    contentControls: (documentRequest.contentControls || []).map((cc: any) => ({
      title: cc?.title,
      type: cc?.type,
      skin: cc?.skin,
      headingLevel: cc?.headingLevel,
      data: boundedData(redactValue(cc?.data), MAX_CONTROL_DATA_BYTES),
    })),
  };
  // Many individually-small controls can still add up; drop their data entirely past the total.
  if (jsonBytes(inputs) > MAX_INPUTS_BYTES) {
    inputs.contentControls = inputs.contentControls.map((cc) => ({
      ...cc,
      data: { omitted: true, bytes: jsonBytes(cc.data) },
    }));
  }
  return inputs;
}

export function buildStep(params: {
  name: string;
  type: IDocumentRunManifestStep['type'];
  status: 'succeeded' | 'failed';
  startedAt: number;
  outputSummary?: Record<string, unknown>;
}): IDocumentRunManifestStep {
  return {
    name: params.name,
    type: params.type,
    status: params.status,
    durationMs: Date.now() - params.startedAt,
    errorCount: params.status === 'failed' ? 1 : 0,
    outputSummary: params.outputSummary,
  };
}

export function emptyManifest(): IDocumentRunManifest {
  return { steps: [], artifacts: [] };
}
