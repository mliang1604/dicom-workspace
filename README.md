# dicom-workspace

A WebGPU-based DICOM viewer and workspace, built with Angular 22.

Load a batch of DICOM images from disk and scroll through them in **Axial**,
**Coronal**, and **Sagittal** views. The slice stack is assembled into a 3D
volume texture and resliced on the GPU, so all three orientations come from a
single render path with live window/level.

## Requirements

- **Node.js** ≥ 24.15 (Angular 22 requirement)
- A **WebGPU-capable browser** — recent Chrome, Edge, or Safari.

## Getting started

```bash
npm install
npm start        # ng serve — open the printed http://localhost:4200
```

Then **Open folder…** (Chromium browsers) or **Open files…** and pick a series.
Use the View selector to switch orientation, the slider to scrub slices, and the
WL / WW fields to adjust the display window.

## Scripts

| Command         | Purpose                                  |
| --------------- | ---------------------------------------- |
| `npm start`     | Dev server with live reload.             |
| `npm run build` | Production build to `dist/`.             |
| `npm test`      | Unit tests (Vitest, via `@angular/build`). |

## Architecture

The framework-agnostic core is deliberately separate from the Angular layer:

| Path                  | Responsibility                                                    |
| --------------------- | ---------------------------------------------------------------- |
| `src/dicom/`          | DICOM parsing (`dicom-parser` wrapper), slice → `Volume` assembly, float16 packing. Pure, framework-free, unit-tested. |
| `src/render/`         | WebGPU device setup and the `SliceRenderer` (3D volume texture + WGSL reslice/windowing shader). |
| `src/app/`            | Angular shell, the `Viewer` component (signals + OnPush, zoneless), and the `VolumeLoader` service. |

### Rendering approach

Every slice in the series is uploaded once into a single `r16float` 3D texture.
Each view samples a plane out of that texture in the fragment shader, with the
slice axis chosen by orientation, physical aspect-ratio correction, and DICOM
linear windowing applied on the GPU.

## Current scope and limitations

This is the foundation. It currently handles the common case:

- **Supported:** uncompressed little-endian, single-frame, grayscale (CT/MR)
  series; spatial slice ordering via `ImagePositionPatient`; rescale
  slope/intercept; anisotropic voxel spacing.
- **Not yet:** compressed transfer syntaxes (JPEG/JPEG-LS/JPEG2000/RLE),
  multi-series folders, color images, oblique/3D volume rendering, and
  measurements. These are tracked as follow-up work.
