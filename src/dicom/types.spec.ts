import { modalityUnit } from './types';

describe('modalityUnit', () => {
  it('labels CT values as Hounsfield Units', () => {
    expect(modalityUnit('CT')).toBe('HU');
  });

  it('returns null for modalities without a standard scalar unit', () => {
    expect(modalityUnit('MR')).toBeNull();
    expect(modalityUnit('US')).toBeNull();
  });

  it('returns null when the modality is unknown', () => {
    expect(modalityUnit(null)).toBeNull();
  });
});
