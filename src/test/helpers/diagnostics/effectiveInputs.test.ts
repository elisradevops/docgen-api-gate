import { buildEffectiveInputs } from '../../../helpers/diagnostics/effectiveInputs';

const control = (data: any) => ({ title: 'SVD', data });
const range = {
  rangeType: 'release',
  definition: { id: 7, name: 'Rel' },
  from: { id: 11, name: 'Release-11', source: 'auto' },
  to: { id: 12, source: 'auto' },
};

describe('buildEffectiveInputs', () => {
  test('fills auto-discovered from/to and their text on the control that owns the range', () => {
    const inputs = { contentControls: [control({ rangeType: 'release', repoId: 7, from: 0, to: '', fromText: '', toText: '' })] };
    const out = buildEffectiveInputs(inputs, range);
    expect(out.inputs!.contentControls[0].data).toMatchObject({ from: 11, to: 12, fromText: 'Release-11', toText: '#12' });
    expect(out.changedPaths).toHaveLength(4);
    expect(inputs.contentControls[0].data.from).toBe(0);
  });

  test('two controls of the same type: only the one whose repoId matches the definition', () => {
    const inputs = {
      contentControls: [
        control({ rangeType: 'release', repoId: 7, from: 0, to: 0 }),
        control({ rangeType: 'release', repoId: 8, from: 0, to: 0 }),
      ],
    };
    const out = buildEffectiveInputs(inputs, range);
    expect(out.inputs!.contentControls[0].data.from).toBe(11);
    expect(out.inputs!.contentControls[1].data.from).toBe(0);
  });

  test('no repoId: only when exactly one control has that range type', () => {
    const two = { contentControls: [control({ rangeType: 'release', from: 0 }), control({ rangeType: 'release', from: 0 })] };
    expect(buildEffectiveInputs(two, range).changedPaths).toEqual([]);
    const one = { contentControls: [control({ rangeType: 'release', from: 0 }), control({ rangeType: 'pipeline', from: 0 })] };
    expect(buildEffectiveInputs(one, range).inputs!.contentControls[0].data.from).toBe(11);
  });

  test('never overwrites a given version or fills an explicit/none side', () => {
    const inputs = { contentControls: [control({ rangeType: 'release', repoId: 7, from: 5, to: 0 })] };
    const out = buildEffectiveInputs(inputs, { ...range, from: { id: 11, source: 'explicit' }, to: { id: 12, source: 'none' } });
    expect(out.changedPaths).toEqual([]);
    expect(out.inputs).toBe(inputs);
  });

  test('tolerates a missing range, missing inputs and a non-array contentControls', () => {
    expect(buildEffectiveInputs(undefined, range).inputs).toBeUndefined();
    expect(buildEffectiveInputs({ a: 1 }, undefined).changedPaths).toEqual([]);
    expect(buildEffectiveInputs({ contentControls: 'x' }, range).changedPaths).toEqual([]);
  });
});
