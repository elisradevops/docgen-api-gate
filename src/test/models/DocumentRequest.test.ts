import { RequirementsTraceabilityMode } from '../../models/DocumentRequest';

describe('DocumentRequest model', () => {
  test('RequirementsTraceabilityMode enum has expected numeric values', () => {
    expect(RequirementsTraceabilityMode.CustomerRequirementId).toBe(0);
    expect(RequirementsTraceabilityMode.RequirementId).toBe(1);
  });

  test('RequirementsTraceabilityMode reverse mapping returns names', () => {
    expect(RequirementsTraceabilityMode[0]).toBe('CustomerRequirementId');
    expect(RequirementsTraceabilityMode[1]).toBe('RequirementId');
  });
});
