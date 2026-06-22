import { tagLabel } from './tag-dictionary';

describe('tagLabel', () => {
  it('names a known tag from either key form', () => {
    expect(tagLabel('x00100010')).toBe('Patient Name');
    expect(tagLabel('00100010')).toBe('Patient Name');
  });

  it('is case-insensitive about the hex digits', () => {
    expect(tagLabel('X0008103E')).toBe('Series Description');
  });

  it('labels the example group-length element from the issue', () => {
    expect(tagLabel('x00020000')).toBe('Group Length');
  });

  it('labels any (gggg,0000) length element generically', () => {
    expect(tagLabel('x00280000')).toBe('Group Length');
  });

  it('labels odd (private) groups as private tags', () => {
    expect(tagLabel('x00090010')).toBe('Private Tag');
    expect(tagLabel('x00111001')).toBe('Private Tag');
  });

  it('returns null for an unknown even-group tag', () => {
    expect(tagLabel('x00081234')).toBeNull();
  });

  it('returns null for a malformed key', () => {
    expect(tagLabel('x123')).toBeNull();
    expect(tagLabel('')).toBeNull();
  });
});
