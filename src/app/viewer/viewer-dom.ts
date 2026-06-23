import type { DropIntent } from './load-coordinator';
import { SERIES_DND_MIME } from './history-panel/series-chip';

/** Trigger a browser download of a blob under the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoke after the click has been dispatched so the download isn't cancelled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Ask whether to switch the catalog to the just-imported patient, discarding the
 * one currently loaded. The viewer holds one patient at a time, so a different-
 * patient import is a deliberate switch rather than a silent mix; `false` cancels
 * and leaves the current view untouched.
 */
export function confirmPatientSwitch(): boolean {
  return confirm(
    'These files belong to a different patient. Switch to them and clear the ' +
      'current patient from the viewer?',
  );
}

/** Whether a drag event carries files (vs. dragged text/elements within the page). */
export function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : false;
}

/** Whether a drag carries a history-panel series chip (its UID payload). */
export function hasSeriesDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes(SERIES_DND_MIME) : false;
}

/** Whether a drag is something the viewport can load: dropped files or a series chip. */
export function isLoadableDrag(event: DragEvent): boolean {
  return hasFiles(event) || hasSeriesDrag(event);
}

/**
 * The {@link DropIntent} a held modifier selects: ⌥/Alt forces a fusion overlay,
 * ⇧/Shift adds a side-by-side compare column, and a plain drop loads as the
 * primary series (smart-auto). Alt wins when both are held. Pure for unit testing.
 */
export function dropIntentOf(modifiers: { altKey: boolean; shiftKey: boolean }): DropIntent {
  if (modifiers.altKey) return 'overlay';
  if (modifiers.shiftKey) return 'compare';
  return 'primary';
}

/**
 * Drop-overlay headline reflecting what the held modifier will do on release.
 * `isSeriesDrag` distinguishes a dragged history chip (replaces the view) from a
 * plain file/folder drop, which now only catalogues into the history (#241).
 */
export function dropHeadlineText(intent: DropIntent, isSeriesDrag = true): string {
  switch (intent) {
    case 'overlay':
      return 'Drop to fuse as an overlay';
    case 'compare':
      return 'Drop to add a compare column';
    case 'primary':
      return isSeriesDrag ? 'Drop to load as primary' : 'Drop to add to the history';
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

/**
 * Whether a key event originates from a control where typing should win over the
 * viewer's shortcuts: text inputs, selects, textareas, and contenteditable hosts.
 * Used as the one focus guard shared by every keyboard handler.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable === true)
  );
}

/**
 * Blur a changed `<select>` so focus returns to the document. A picked dropdown
 * stays focused and {@link isEditableTarget} would then swallow every shortcut,
 * leaving hotkeys dead until the user clicks away (issue #175). Non-select targets
 * (checkboxes, etc.) are left untouched.
 */
export function releaseSelectFocus(target: EventTarget | null): void {
  if (target instanceof HTMLSelectElement) target.blur();
}
