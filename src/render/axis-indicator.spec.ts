import {
  axisIndicatorGeometry,
  axisMarkers,
  type AxisIndicatorMarker,
  type AxisMarker,
} from './axis-indicator';
import type { PaneRect } from './layout';

/** Look up a marker by its anatomical label. */
function marker(markers: readonly AxisMarker[], label: string): AxisMarker {
  const found = markers.find((m) => m.label === label);
  if (!found) throw new Error(`no marker labelled ${label}`);
  return found;
}

/** Assert a marker sits at the expected screen position and depth. */
function expectMarker(m: AxisMarker, x: number, y: number, depth: number): void {
  expect(m.x).toBeCloseTo(x, 6);
  expect(m.y).toBeCloseTo(y, 6);
  expect(m.depth).toBeCloseTo(depth, 6);
}

describe('axisMarkers', () => {
  it('labels all six patient axes once', () => {
    const labels = axisMarkers(0, 0)
      .map((m) => m.label)
      .sort();
    expect(labels).toEqual(['A', 'I', 'L', 'P', 'R', 'S']);
  });

  it('places left/right horizontally, superior/inferior vertically at the default view', () => {
    const markers = axisMarkers(0, 0);
    // Anterior view: patient-left to the right, superior up.
    expectMarker(marker(markers, 'L'), 1, 0, 0); // right edge, in the screen plane
    expectMarker(marker(markers, 'R'), -1, 0, 0); // left edge
    expectMarker(marker(markers, 'S'), 0, 1, 0); // top
    expectMarker(marker(markers, 'I'), 0, -1, 0); // bottom
  });

  it('points anterior toward the viewer and posterior away at the default view', () => {
    const markers = axisMarkers(0, 0);
    // A/P run along the view axis: anterior out of the screen, posterior into it.
    expectMarker(marker(markers, 'A'), 0, 0, 1);
    expectMarker(marker(markers, 'P'), 0, 0, -1);
  });

  it('swaps the left/right and anterior/posterior axes after a quarter orbit', () => {
    // Azimuth π/2 looks from the patient's left, so left now points at the viewer
    // and the front/back axis swings into the screen plane; superior stays up.
    const markers = axisMarkers(Math.PI / 2, 0);
    expectMarker(marker(markers, 'L'), 0, 0, 1); // toward the viewer
    expectMarker(marker(markers, 'R'), 0, 0, -1); // away
    expectMarker(marker(markers, 'P'), 1, 0, 0); // back of the head to the right
    expectMarker(marker(markers, 'A'), -1, 0, 0); // face to the left
    expectMarker(marker(markers, 'S'), 0, 1, 0); // still up
  });

  it('tilts superior toward the viewer as the camera elevates', () => {
    // Looking straight down from above (elevation π/2): superior points out of the
    // screen and the front/back axis runs vertically (posterior up at the pole).
    const markers = axisMarkers(0, Math.PI / 2);
    expectMarker(marker(markers, 'S'), 0, 0, 1);
    expectMarker(marker(markers, 'I'), 0, 0, -1);
    expectMarker(marker(markers, 'P'), 0, 1, 0); // back of the head up the screen
    expectMarker(marker(markers, 'A'), 0, -1, 0); // face down the screen
    // Left/right are unchanged by elevation alone.
    expectMarker(marker(markers, 'L'), 1, 0, 0);
  });

  it('keeps every marker on the unit screen disc (axes are unit vectors)', () => {
    for (const azimuth of [0, 0.7, 1.9, 3.5]) {
      for (const elevation of [-1.2, 0, 0.9]) {
        for (const m of axisMarkers(azimuth, elevation)) {
          expect(Math.hypot(m.x, m.y, m.depth)).toBeCloseTo(1, 6);
        }
      }
    }
  });

  it('keeps antipodal axes diametrically opposite', () => {
    const markers = axisMarkers(1.1, 0.4);
    for (const [a, b] of [
      ['L', 'R'],
      ['A', 'P'],
      ['S', 'I'],
    ]) {
      const m = marker(markers, a);
      const n = marker(markers, b);
      expect(m.x).toBeCloseTo(-n.x, 6);
      expect(m.y).toBeCloseTo(-n.y, 6);
      expect(m.depth).toBeCloseTo(-n.depth, 6);
    }
  });
});

/** Look up an overlay marker by its anatomical label. */
function widget(markers: readonly AxisIndicatorMarker[], label: string): AxisIndicatorMarker {
  const found = markers.find((m) => m.label === label);
  if (!found) throw new Error(`no marker labelled ${label}`);
  return found;
}

const RECT: PaneRect = { x: 200, y: 100, width: 300, height: 240 };

describe('axisIndicatorGeometry', () => {
  it('insets a fixed-size widget into the pane top-right corner', () => {
    const o = axisIndicatorGeometry(RECT, 0, 0);
    expect(o.size).toBe(72);
    expect(o.center).toBe(36);
    // Margin 12 from the pane's top-right corner.
    expect(o.left).toBe(RECT.x + RECT.width - 12 - 72);
    expect(o.top).toBe(RECT.y + 12);
  });

  it('places all six axes on spokes from the widget hub, +y flipped to CSS down', () => {
    const { markers, center } = axisIndicatorGeometry(RECT, 0, 0);
    expect(markers.map((m) => m.label).sort()).toEqual(['A', 'I', 'L', 'P', 'R', 'S']);
    const radius = 24;
    // Default view: patient-left to the screen right, superior up (smaller CSS y).
    expect(widget(markers, 'L').x).toBeCloseTo(center + radius, 6);
    expect(widget(markers, 'L').y).toBeCloseTo(center, 6);
    expect(widget(markers, 'R').x).toBeCloseTo(center - radius, 6);
    expect(widget(markers, 'S').y).toBeCloseTo(center - radius, 6); // up = toward the top
    expect(widget(markers, 'I').y).toBeCloseTo(center + radius, 6);
  });

  it('fades away-facing axes and keeps near ones bright', () => {
    const { markers } = axisIndicatorGeometry(RECT, 0, 0);
    // Anterior points out of the screen (depth +1) → full opacity; posterior away.
    expect(widget(markers, 'A').opacity).toBeCloseTo(1, 6);
    expect(widget(markers, 'P').opacity).toBeCloseTo(0.35, 6);
    // In-plane axes sit at the mid fade.
    expect(widget(markers, 'L').opacity).toBeCloseTo(0.675, 6);
    for (const m of markers) expect(m.opacity).toBeGreaterThanOrEqual(0.35);
  });

  it('sorts markers far-to-near so the nearest label renders last', () => {
    const { markers } = axisIndicatorGeometry(RECT, 0, 0);
    // Opacity rises monotonically with depth, so a far→near sort is non-decreasing.
    for (let i = 1; i < markers.length; i++) {
      expect(markers[i].opacity).toBeGreaterThanOrEqual(markers[i - 1].opacity);
    }
    expect(markers[0].label).toBe('P'); // farthest
    expect(markers[markers.length - 1].label).toBe('A'); // nearest
  });
});
