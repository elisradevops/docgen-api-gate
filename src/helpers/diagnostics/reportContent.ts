// Backs GET /diagnostics/runs/:runId/report and /diagnostics/compare/report (Phase 7c).
// Builds a plain ContentControl array using json-to-word's existing generic `table`/`paragraph`
// word-object primitives directly — no docgen-content-control round trip, no new skin type.
// EXPLICITLY A PLACEHOLDER for the report's content design (field selection, ordering): the
// org's downgrade/sanitization tool's exact required structure (headers, classification
// banners, metadata fields) is an external blocker named in the master plan, not discoverable
// from source. This proves the pipeline works; it is not the final template.
import { IDocumentRun } from '../../models/DocumentRun';
import { TimelineEntry } from './runDetail';
import { ManifestDiff, DiffRow } from './manifestDiff';
import { buildCompareFindings } from './compareFindings';

function paragraph(text: string, headingLevel = 0): Record<string, unknown> {
  return { type: 'paragraph', headingLevel, runs: [{ text }] };
}

function serializeCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { /* fall through */ }
  }
  return String(value);
}

function cell(text: unknown): Record<string, unknown> {
  return { Paragraphs: [{ Runs: [{ text: serializeCell(text) }] }] };
}

function row(cells: unknown[]): Record<string, unknown> {
  return { Cells: cells.map(cell) };
}

function table(headers: string[], rows: unknown[][], headingLevel = 0): Record<string, unknown> {
  return { type: 'table', headingLevel, Rows: [row(headers), ...rows.map(row)] };
}

function formatDuration(run: IDocumentRun): string {
  if (!run.endedAt) return 'in progress';
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

function runSummaryTable(run: IDocumentRun): Record<string, unknown> {
  return table(
    ['Field', 'Value'],
    [
      ['runId', run.runId],
      ['status', run.status],
      ['docType', run.docType || 'unknown'],
      ['project', run.project || 'unknown'],
      ['trigger', run.trigger],
      ['startedAt', new Date(run.startedAt).toISOString()],
      ['duration', formatDuration(run)],
    ],
    1
  );
}

function timelineTable(timeline: TimelineEntry[]): Record<string, unknown> {
  return table(
    ['Step', 'Service', 'Status', 'Offset (ms)', 'Duration (ms)', 'Errors', 'Warnings'],
    timeline.map((t) => [t.name, t.service, t.status, t.startOffsetMs, t.durationMs, t.errorCount, t.warnCount ?? 0]),
    1
  );
}

function errorChainSection(run: IDocumentRun): Record<string, unknown>[] {
  if (!run.errorChain?.length) return [paragraph('No error chain — this run had no recorded errors.', 1)];
  const nodes: Record<string, unknown>[] = [paragraph('Error chain', 1)];
  for (const entry of run.errorChain) {
    nodes.push(paragraph(`${entry.service}${entry.step ? ` — ${entry.step}` : ''}: ${entry.message}`));
  }
  return nodes;
}

// {title, wordObjects} is exactly the shape WordModel.ContentControls (WordContentControl.cs:
// Title/WordObjects) binds from — the same lowercase-key shape this codebase already uses
// everywhere it hand-builds a content control (e.g. addReleaseFileContentControl). No `type`/
// `skin`/`data` wrapper needed: those only matter for docgen-content-control's dispatch, which
// this path bypasses entirely.
export interface ReportContentControl {
  title: string;
  wordObjects: Record<string, unknown>[];
}

export function buildRunReportContentControls(run: IDocumentRun, timeline: TimelineEntry[]): ReportContentControl[] {
  const wordObjects = [
    paragraph(`Diagnostics report — run ${run.runId}`, 1),
    runSummaryTable(run),
    paragraph('Timeline', 1),
    timelineTable(timeline),
    ...errorChainSection(run),
  ];
  return [{ title: 'diagnostics-run-report', wordObjects }];
}

const BAND_TITLES: Record<keyof ManifestDiff['bands'], string> = {
  outcomes: 'Changed outcomes',
  volumes: 'Changed volumes',
  environment: 'Environment drift',
  inputs: 'Input differences',
  unchanged: 'Unchanged / low-signal fields',
};

// Only plain objects (not arrays) are "complex" for report rendering purposes.
// Primitive arrays arrived here because diffTree stores them atomically — they're short
// enough to read as a formatted cell value ("A: []  B: [15, 16, 30]") without a diff table.
function isComplexValue(v: unknown): v is Record<string, unknown> {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

// LCS-based line diff — mirrors the frontend's diffJsonLines so the report matches
// what the UI displays. Capped at 300 lines per side to avoid quadratic blowup on large
// objects (contentControls arrays can have many entries).
function diffJsonLines(
  a: unknown,
  b: unknown
): Array<{ type: 'same' | 'added' | 'removed'; line: string }> {
  const serialize = (v: unknown): string => {
    if (v === undefined) return '(not present)';
    try {
      const s = JSON.stringify(v, null, 2);
      // JSON.stringify returns undefined (not a string) for undefined input — guard it even
      // though the explicit check above should already handle that.
      return typeof s === 'string' ? s : String(v);
    } catch { return String(v); }
  };
  const MAX = 300;
  const linesA = serialize(a).split('\n').slice(0, MAX);
  const linesB = serialize(b).split('\n').slice(0, MAX);
  const m = linesA.length, n = linesB.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = linesA[i - 1] === linesB[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  const result: Array<{ type: 'same' | 'added' | 'removed'; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      result.unshift({ type: 'same', line: linesA[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', line: linesB[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'removed', line: linesA[i - 1] });
      i--;
    }
  }
  return result;
}

// Builds a Word table cell with optional background shading and run-level styling.
// Shading.Fill is the hex background color (no '#' prefix — Word's OOXML convention).
// Font "Courier New" gives monospace code-block appearance; size 9pt keeps lines compact.
function styledCell(text: string, fill?: string, fontColor?: string, width?: string): Record<string, unknown> {
  const run: Record<string, unknown> = { text, font: 'Courier New', size: 9 };
  if (fontColor) run.fontColor = fontColor;
  const c: Record<string, unknown> = {
    Paragraphs: [{ Runs: [run] }],
  };
  if (fill) c.Shading = { color: 'auto', fill };
  if (width) c.Width = width;
  return c;
}

// Produces a colored unified-diff table matching the UI's LCS diff view.
// Each diff line is one row:  narrow prefix column ("-"/"+"/" ") + wide content column.
// Row shading: removed → light red, added → light green, same → no fill.
// Side-by-side was evaluated but ruled out: JSON content lines are too long to split across
// two narrow columns without heavy wrapping that makes the diff unreadable.
function coloredDiffTable(
  diff: Array<{ type: 'same' | 'added' | 'removed'; line: string }>
): Record<string, unknown> {
  const STYLE: Record<string, { fill?: string; color: string; prefix: string }> = {
    removed: { fill: 'FFDCE0', color: '9B0000', prefix: '-' },
    added:   { fill: 'DCFFE4', color: '006620', prefix: '+' },
    same:    { fill: undefined, color:  '555555', prefix: ' ' },
  };
  const rows = diff.map((l) => {
    const s = STYLE[l.type];
    return {
      Cells: [
        styledCell(s.prefix, s.fill, s.color, '0.6cm'),
        styledCell(l.line,   s.fill, s.color),
      ],
    };
  });
  return { type: 'table', headingLevel: 2, Rows: rows };
}

// Mirrors the frontend's fieldSegments/FieldPath logic: show only the leaf segment of a
// dotted/bracketed path. The prefix is identical across sibling rows and adds no information.
function fieldLeaf(field: string): string {
  const re = /\[([^\]]+)\]|([^.\[]+)/g;
  let last = field;
  let m: RegExpExecArray | null;
  while ((m = re.exec(field)) !== null) {
    last = m[1] !== undefined ? `[${m[1]}]` : m[2];
  }
  return last;
}

// Mixed band renderer:
// • Primitive rows → compact 3-column table (Field | Run A | Run B).
// • Object/array rows → heading + LCS text-diff block (DOCX can't do coloured lines, so
//   we use the standard - / + prefix convention, same as a patch file).
function bandSection(rows: DiffRow[]): Record<string, unknown>[] {
  if (rows.length === 0) return [paragraph('Nothing to show.')];

  const primitiveRows = rows.filter((r) => !isComplexValue(r.a) && !isComplexValue(r.b));
  const complexRows   = rows.filter((r) => isComplexValue(r.a) || isComplexValue(r.b));

  const out: Record<string, unknown>[] = [];

  if (primitiveRows.length) {
    out.push(table(['Field', 'Run A', 'Run B'], primitiveRows.map((r) => [fieldLeaf(r.field), r.a, r.b]), 2));
  }

  for (const r of complexRows) {
    const diff = diffJsonLines(r.a, r.b);
    const removed = diff.filter((l) => l.type === 'removed').length;
    const added   = diff.filter((l) => l.type === 'added').length;
    // Cap at 120 lines so a large contentControls array doesn't produce a 10-page table.
    // The summary heading always shows the true counts even when lines are clipped.
    const DISPLAY_CAP = 120;
    const visibleLines = diff.slice(0, DISPLAY_CAP);
    if (diff.length > DISPLAY_CAP) {
      visibleLines.push({ type: 'same', line: `… (showing first ${DISPLAY_CAP} of ${diff.length} lines)` });
    }
    out.push(paragraph(`${fieldLeaf(r.field)}  (−${removed}  +${added})`, 2));
    out.push(coloredDiffTable(visibleLines));
  }

  return out;
}

export function buildCompareReportContentControls(runA: IDocumentRun, runB: IDocumentRun, diff: ManifestDiff): ReportContentControl[] {
  const wordObjects: Record<string, unknown>[] = [
    paragraph(`Diagnostics comparison — ${runA.runId} vs ${runB.runId}`, 1),
    ...(diff.crossType ? [paragraph('Comparing runs of different document types / projects — results may reflect expected differences, not a defect.')] : []),
    // The first thing a reader should see: where the runs diverge first, and what has been ruled out.
    paragraph('Findings', 1),
    ...buildCompareFindings(runA, runB, diff).map((f) =>
      paragraph(`${f.severity === 'severe' ? '[!] ' : '- '}${f.text}`)
    ),
  ];
  (Object.keys(BAND_TITLES) as Array<keyof ManifestDiff['bands']>).forEach((band) => {
    const rows = diff.bands[band];
    wordObjects.push(paragraph(BAND_TITLES[band], 1));
    wordObjects.push(...bandSection(rows));
  });
  return [{ title: 'diagnostics-compare-report', wordObjects }];
}
