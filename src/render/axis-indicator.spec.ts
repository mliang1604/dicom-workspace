import { axisMarkers, type AxisMarker } from './axis-indicator';

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
