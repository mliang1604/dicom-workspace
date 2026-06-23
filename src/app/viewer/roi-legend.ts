import { rgbColor, roiKeyOf, setIsShown } from '../../render/roi-overlay';
import type { StructureSet } from '../../dicom/types';
import { roiColorHex } from './viewer-format';

/** One ROI listed in the structures panel, with its display controls. */
export interface RoiLegendEntry {
  /** Stable key, unique across structure sets (see {@link roiKeyOf}). */
  readonly key: string;
  /** Index of the structure set this ROI belongs to. */
  readonly setIndex: number;
  /** ROI Name, or a fallback when the RTSTRUCT left it blank. */
  readonly name: string;
  /** Interpreted type (ORGAN/PTV/GTV…) as a short upper-case badge, or '' when none. */
  readonly type: string;
  /** Effective display colour (ROI colour or the user's override) as a CSS colour. */
  readonly color: string;
  /** The effective colour as `#rrggbb`, for the colour `<input>`. */
  readonly colorHex: string;
  /** Effective draw opacity as a whole percent `[0, 100]`, for the opacity slider. */
  readonly opacityPercent: number;
  /** Whether the ROI's contours are currently drawn. */
  readonly visible: boolean;
}

/** The ROIs of one structure set, grouped under its label in the structures panel. */
export interface RoiLegendGroup {
  /** Index of the structure set this group lists. */
  readonly setIndex: number;
  /** The set's display label (Structure Set Label, else file name, else a fallback). */
  readonly label: string;
  /** The set's listed ROIs, in file order. */
  readonly entries: RoiLegendEntry[];
}

/**
 * Flatten the structure sets into {@link RoiLegendEntry} rows for the structures
 * panel. ROIs with no contours are skipped (nothing to draw or toggle), and the
 * rows are filtered to the selected structure set (or all of them when
 * `selectedSetIndex` is negative). Each row resolves the effective colour and
 * opacity from the override maps so the panel and the overlays stay in lockstep.
 * Pure, so it can be unit-tested without the component.
 */
export function buildRoiLegend(
  structureSets: readonly StructureSet[],
  hidden: ReadonlySet<string>,
  colorOverrides: ReadonlyMap<string, string>,
  opacities: ReadonlyMap<string, number>,
  selectedSetIndex: number,
): RoiLegendEntry[] {
  const entries: RoiLegendEntry[] = [];
  structureSets.forEach((ss, setIndex) => {
    if (!setIsShown(selectedSetIndex, setIndex)) return;
    for (const roi of ss.rois) {
      if (roi.contours.length === 0) continue; // nothing to draw or toggle
      const key = roiKeyOf(setIndex, roi.number);
      const override = colorOverrides.get(key);
      entries.push({
        key,
        setIndex,
        name: roi.name || `ROI ${roi.number}`,
        type: roi.interpretedType ? roi.interpretedType.toUpperCase() : '',
        color: override ?? rgbColor(roi.color),
        colorHex: roiColorHex(roi.color, override),
        opacityPercent: Math.round((opacities.get(key) ?? 1) * 100),
        visible: !hidden.has(key),
      });
    }
  });
  return entries;
}

/** A structure set's display label: its Structure Set Label, else its file name, else a fallback. */
export function structureSetLabel(ss: StructureSet | undefined, index: number): string {
  return ss?.label || ss?.name || `Structure set ${index + 1}`;
}

/**
 * Group {@link buildRoiLegend} rows by their structure set, preserving order, so
 * the panel can render each set's ROIs under its own label rather than as one
 * flat list (#259). The rows already arrive set-by-set, so one group is opened per
 * new {@link RoiLegendEntry.setIndex}. Pure, so it can be unit-tested.
 */
export function groupRoiLegend(
  entries: readonly RoiLegendEntry[],
  structureSets: readonly StructureSet[],
): RoiLegendGroup[] {
  const groups: RoiLegendGroup[] = [];
  const byIndex = new Map<number, RoiLegendGroup>();
  for (const entry of entries) {
    let group = byIndex.get(entry.setIndex);
    if (!group) {
      group = {
        setIndex: entry.setIndex,
        label: structureSetLabel(structureSets[entry.setIndex], entry.setIndex),
        entries: [],
      };
      byIndex.set(entry.setIndex, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/**
 * Every drawable ROI's key across the given structure sets (see {@link roiKeyOf}),
 * matching the keys {@link buildRoiLegend} emits. Used to seed {@link hiddenRois}
 * so a freshly loaded structure set starts with its contours hidden (#257).
 */
export function allRoiKeys(structureSets: readonly StructureSet[]): Set<string> {
  const keys = new Set<string>();
  structureSets.forEach((ss, setIndex) => {
    for (const roi of ss.rois) {
      if (roi.contours.length === 0) continue; // nothing to draw or toggle
      keys.add(roiKeyOf(setIndex, roi.number));
    }
  });
  return keys;
}
