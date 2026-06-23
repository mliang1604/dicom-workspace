import { type MeasureTool } from './measurement-store';

/** The shortcuts listed in the help overlay, in display order. */
export const SHORTCUTS = [
  { keys: 'X', label: 'Swap the main view to the next orientation' },
  { keys: 'F', label: 'Flip the sagittal view left/right' },
  { keys: 'L', label: 'Cycle the viewport layout' },
  { keys: 'C', label: 'Toggle linked crosshairs & 3D cut-planes' },
  { keys: 'P', label: 'Play / pause cine through the hovered pane' },
  { keys: 'I', label: 'Toggle the metadata / tag inspector' },
  { keys: '0', label: 'Zoom every pane to fit' },
  { keys: '1', label: 'Native voxel scale (1:1)' },
  { keys: 'R', label: 'Reset zoom, pan & window/level' },
  { keys: 'V', label: 'Invert the grayscale' },
  { keys: 'H', label: 'Collapse / expand the study history panel' },
  { keys: '?', label: 'Toggle this shortcuts help' },
  { keys: 'Esc', label: 'Cancel a measurement / close overlays' },
  { keys: 'Drag', label: 'Pan an MPR pane · orbit the 3D pane' },
  { keys: 'Middle-drag / Alt+drag', label: 'Pan the 3D pane (and MPR panes)' },
  { keys: 'Scroll', label: 'Change slice (MPR) · zoom (3D)' },
  { keys: 'Ctrl+Scroll', label: 'Zoom an MPR pane about the cursor' },
  { keys: 'Shift+Click', label: 'Link every pane to the clicked point' },
  { keys: 'Knob drag', label: 'Tilt an MPR pane to an oblique plane (double-click resets)' },
  { keys: 'Right-drag', label: 'Adjust window / level' },
] as const;

/** The measurement tools offered in the palette, in display order. */
export const MEASURE_TOOLS: readonly { value: MeasureTool; label: string; glyph: string }[] = [
  { value: 'distance', label: 'Distance', glyph: '╱' },
  { value: 'angle', label: 'Angle', glyph: '∠' },
  { value: 'ellipse', label: 'Ellipse', glyph: '◯' },
  { value: 'rectangle', label: 'Rectangle', glyph: '▭' },
];

/** Frames-per-second options offered in the cine speed selector, in display order. */
export const CINE_FPS_OPTIONS = [5, 10, 15, 20, 30] as const;
