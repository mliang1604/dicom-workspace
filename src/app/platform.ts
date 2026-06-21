/**
 * Host-OS detection for user-facing key labels. The drop-hint glyphs and any
 * future keyboard-shortcut help should read as the user's own keyboard does:
 * macOS glyphs on a Mac, neutral words (Alt/Shift/…) on Windows and Linux.
 */

/** A modifier key we render a host-adapted label for. */
export type ModifierKey = 'alt' | 'shift' | 'ctrl' | 'meta';

/**
 * The host platform string, preferring the structured
 * `navigator.userAgentData.platform` and falling back to the legacy
 * `navigator.platform`. Returns `''` outside a browser (test/SSR) so callers
 * never throw on a missing global.
 */
function hostPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return uaData?.platform ?? navigator.platform ?? '';
}

/**
 * Whether the host is macOS. Pass `platform` explicitly to unit-test the
 * mapping without touching the global `navigator`.
 */
export function isMac(platform: string = hostPlatform()): boolean {
  return /mac/i.test(platform);
}

/**
 * A host-adapted label for a modifier key: macOS glyphs (`⌥`, `⇧`, `⌃`, `⌘`) on
 * a Mac, word labels (`Alt`, `Shift`, `Ctrl`, `Win`) elsewhere. Pass `mac`
 * explicitly to unit-test both branches.
 */
export function modifierLabel(key: ModifierKey, mac: boolean = isMac()): string {
  switch (key) {
    case 'alt':
      return mac ? '⌥' : 'Alt';
    case 'shift':
      return mac ? '⇧' : 'Shift';
    case 'ctrl':
      return mac ? '⌃' : 'Ctrl';
    case 'meta':
      return mac ? '⌘' : 'Win';
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}
