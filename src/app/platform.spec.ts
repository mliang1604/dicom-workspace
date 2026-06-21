import { describe, expect, it } from 'vitest';

import { isMac, modifierLabel } from './platform';

describe('isMac', () => {
  it('detects macOS platform strings (case-insensitive)', () => {
    expect(isMac('MacIntel')).toBe(true);
    expect(isMac('macOS')).toBe(true);
    expect(isMac('Macintosh')).toBe(true);
  });

  it('is false for non-mac and empty platform strings', () => {
    expect(isMac('Win32')).toBe(false);
    expect(isMac('Windows')).toBe(false);
    expect(isMac('Linux x86_64')).toBe(false);
    expect(isMac('')).toBe(false);
  });
});

describe('modifierLabel', () => {
  it('uses macOS glyphs on a Mac', () => {
    expect(modifierLabel('alt', true)).toBe('⌥');
    expect(modifierLabel('shift', true)).toBe('⇧');
    expect(modifierLabel('ctrl', true)).toBe('⌃');
    expect(modifierLabel('meta', true)).toBe('⌘');
  });

  it('uses word labels off a Mac', () => {
    expect(modifierLabel('alt', false)).toBe('Alt');
    expect(modifierLabel('shift', false)).toBe('Shift');
    expect(modifierLabel('ctrl', false)).toBe('Ctrl');
    expect(modifierLabel('meta', false)).toBe('Win');
  });
});
