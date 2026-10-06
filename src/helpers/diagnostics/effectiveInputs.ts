// The request as it effectively ran: the recorded inputs with the from/to that were auto-discovered filled in
// on the content control(s) they belong to. An Auto SVD request sends from/to empty, so two runs that used
// the same versions (one discovered them, one was given them) would otherwise compare as different inputs.
// Built only from the recorded request and the recorded resolvedRange. The frontend applies the same rule to
// the run page (runDetailState.buildEffectiveInput); keep the two in step.
type Json = Record<string, any>;

// An empty, zero or non-numeric from/to means "discover it" (what the Auto SVD script sends).
const isUnsetVersion = (value: unknown): boolean => {
  const n = Number(value);
  return !Number.isFinite(n) || n <= 0;
};

export interface EffectiveInputs {
  inputs: Json | undefined;
  changedPaths: string[];
}

export function buildEffectiveInputs(inputs: Json | undefined, range: Json | undefined): EffectiveInputs {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || !range || typeof range !== 'object') {
    return { inputs, changedPaths: [] };
  }
  const controls: any[] = Array.isArray(inputs.contentControls) ? inputs.contentControls : [];
  if (controls.length === 0) return { inputs, changedPaths: [] };
  const kind = range.rangeType === 'pipeline' ? 'pipeline' : 'release';
  const definitionId = range.definition?.id;
  const ofKind = controls.filter((c) => c?.data && typeof c.data === 'object' && c.data.rangeType === kind);
  // The recorded range belongs to one control. Match it by its definition id; when the control carries
  // none, only a single control of that type can be the one.
  const owners = ofKind.filter((c) =>
    c.data.repoId !== undefined && c.data.repoId !== null && definitionId !== undefined && definitionId !== null
      ? Number(c.data.repoId) === Number(definitionId)
      : ofKind.length === 1
  );
  if (owners.length === 0) return { inputs, changedPaths: [] };

  const copy: Json = JSON.parse(JSON.stringify(inputs));
  const changedPaths: string[] = [];
  copy.contentControls.forEach((control: any, index: number) => {
    const data = control?.data;
    if (!data || !owners.includes(controls[index])) return;
    for (const side of ['from', 'to'] as const) {
      const resolved = range[side];
      if (resolved?.source !== 'auto' || resolved.id === undefined || resolved.id === null) continue;
      if (!isUnsetVersion(data[side])) continue;
      data[side] = resolved.id;
      changedPaths.push(`contentControls[${index}].data.${side}`);
      const textKey = `${side}Text`;
      if (typeof data[textKey] === 'string') {
        data[textKey] = resolved.name || `#${resolved.id}`;
        changedPaths.push(`contentControls[${index}].data.${textKey}`);
      }
    }
  });
  return changedPaths.length > 0 ? { inputs: copy, changedPaths } : { inputs, changedPaths: [] };
}
