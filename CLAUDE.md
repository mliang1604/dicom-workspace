# CLAUDE.md

Guidance for agents and contributors working in this repo.

## Project

An Angular 22 (standalone, zoneless) WebGPU DICOM **MPR viewer**: it loads a
DICOM series into a single 3D volume and draws axial, coronal, and sagittal
slices into one `<canvas>`, with drag-to-pan, right-drag zoom (anchored on the
cursor), wheel-scroll through slices, Alt+right-drag window/level, and a live
voxel probe.

## Layout

- `src/dicom` — parsing and volume building: `dicom-parser.d.ts`, `loader.ts`
  (files → datasets), `volume.ts` (datasets → a `Volume`), `half.ts` (float →
  half for the GPU texture), `types.ts` (`Volume`, `Orientation`, modality
  helpers).
- `src/render` — GPU + geometry: `device.ts` (WebGPU init), `layout.ts` (pane
  rectangles), `slice-renderer.ts` (uploads the volume, draws the panes,
  exports pure helpers like `aspectScale` / `clampPan` / `rezoomPan`),
  `slice-shader.ts` (the WGSL reslice + windowing), `probe.ts` (CPU-side inverse
  of the reslice: cursor → voxel).
- `src/app` — UI: `viewer/` (the main component), routing (`app.routes.ts`),
  and the disclaimer flow (`disclaimer/`, `declined/`, `acknowledged-guard.ts`,
  `disclaimer-store.ts`).

## Patterns

- **Signals + `ChangeDetectionStrategy.OnPush`.** State is held in `signal()`,
  derived with `computed()`, and rendered effects run in `effect()`. Update
  signals immutably (`update`/`set`); don't mutate in place.
- **Per-orientation state is a `[axial, coronal, sagittal]` tuple**, indexed by
  the `Orientation` enum value (e.g. `zooms`, `pans`, `sliceIndices`). Update one
  entry with the local `withValue(tuple, orientation, value)` helper.
- **Exhaustive `switch` on enums** with a `const exhaustive: never = x` default,
  so adding an orientation/modality fails to compile until it's handled.
- **Keep the shader and the probe in sync.** The fragment shader in
  `slice-shader.ts` and the inverse mapping in `probe.ts` implement the same
  pan/letterbox/zoom geometry from opposite directions. Change one and you must
  change the other; pure geometry lives in shared helpers in `slice-renderer.ts`.

## Build / test

- Install: `npm ci` (never `npm install` — it rewrites the lockfile).
- Build: `ng build --configuration production`.
- Test: `ng test --watch=false` (vitest + jsdom). Specs are colocated as
  `*.spec.ts`; favor unit-testing the pure helpers in `src/render` and
  `src/dicom`.
- Format with Prettier before committing.

## Do not

- Modify or commit `package-lock.json`.
