import { tagName } from './tag-dictionary';

describe('tagName', () => {
  it('names a curated tag from any accepted spelling', () => {
    expect(tagName('x00100010')).toBe("Patient's Name");
    expect(tagName('00100010')).toBe("Patient's Name");
    expect(tagName('(0010,0010)')).toBe("Patient's Name");
  });

  it('is case-insensitive on the hex', () => {
    expect(tagName('x7FE00010')).toBe('Pixel Data');
  });

  it('labels any (gggg,0000) element as a group length', () => {
    expect(tagName('x00020000')).toBe('Group Length');
    expect(tagName('x00080000')).toBe('Group Length');
  });

  it('labels the private-creator block of an odd group', () => {
    expect(tagName('x00090010')).toBe('Private Creator');
  });

  it('returns null for an unknown tag', () => {
    expect(tagName('x00089999')).toBeNull();
  });

  it('returns null for a malformed tag', () => {
    expect(tagName('nope')).toBeNull();
    expect(tagName('x001000')).toBeNull();
  });
});
