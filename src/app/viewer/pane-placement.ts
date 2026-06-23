import { Orientation } from '../../dicom/types';
import {
  compareLayout,
  LayoutMode,
  mprLayout,
  singleLayout,
  triLayout,
  type PaneRect,
} from '../../render/layout';
import { COMPARE_GROUPS } from './compare-store';

/** A pane's placement on screen, in CSS pixels, plus what it shows. */
export type PanePlacement =
  | {
      readonly kind: 'mpr';
      readonly orientation: Orientation;
      readonly rect: PaneRect;
      /** Compare-group index (0 unless the Compare layout splits into columns). */
      readonly group: number;
    }
  | { readonly kind: 'mip'; readonly rect: PaneRect };

/** Order the main (top-left) pane cycles through when swapping. */
const ORIENTATION_ORDER = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal] as const;

/** Lay out the panes for a layout mode and canvas size, with `main` in the lead pane. */
export function placePanes(
  mode: LayoutMode,
  width: number,
  height: number,
  main: Orientation,
): PanePlacement[] {
  const sides = ORIENTATION_ORDER.filter((orientation) => orientation !== main);
  switch (mode) {
    case LayoutMode.TriMpr: {
      const layout = triLayout(width, height);
      return [
        { kind: 'mpr', orientation: main, rect: layout.main, group: 0 },
        { kind: 'mpr', orientation: sides[0], rect: layout.topRight, group: 0 },
        { kind: 'mpr', orientation: sides[1], rect: layout.bottomRight, group: 0 },
      ];
    }
    case LayoutMode.Quad: {
      const layout = mprLayout(width, height);
      return [
        { kind: 'mpr', orientation: main, rect: layout.topLeft, group: 0 },
        { kind: 'mpr', orientation: sides[0], rect: layout.topRight, group: 0 },
        { kind: 'mpr', orientation: sides[1], rect: layout.bottomLeft, group: 0 },
        { kind: 'mip', rect: layout.bottomRight },
      ];
    }
    case LayoutMode.Compare: {
      // Two side-by-side columns, each a full axial/coronal/sagittal stack; the
      // left column shows the base layer, the right the second (overlay) layer.
      const cols = compareLayout(width, height, COMPARE_GROUPS);
      return cols.flatMap((rows, group) =>
        ORIENTATION_ORDER.map((orientation, row) => ({
          kind: 'mpr' as const,
          orientation,
          rect: rows[row],
          group,
        })),
      );
    }
    case LayoutMode.Volume3d:
      return [{ kind: 'mip', rect: singleLayout(width, height) }];
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/** Stable identity for a placement, used for `@for` tracking and hover state. */
export function paneKeyOf(pane: PanePlacement): string {
  return pane.kind === 'mip' ? 'mip' : `mpr-${pane.group}-${pane.orientation}`;
}

/** The pane containing CSS-pixel point (x, y), or null. */
export function placementAt(
  panes: readonly PanePlacement[],
  x: number,
  y: number,
): PanePlacement | null {
  for (const pane of panes) {
    if (withinRect(pane.rect, x, y)) return pane;
  }
  return null;
}

/** Whether CSS-pixel point (x, y) lies within a rectangle. */
export function withinRect(rect: PaneRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
