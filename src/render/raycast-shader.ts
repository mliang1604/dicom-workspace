/**
 * WGSL for the 3D projection pane. Each fragment builds an orthographic camera
 * ray (from the basis computed in `camera.ts`), converts it into the volume's
 * texture space with the `patientToTex` affine (built in `reslice.ts`),
 * intersects the unit box, clamps the marched segment to the thick-slab t-range,
 * then marches accumulating the configured projection: the maximum (MIP), the
 * minimum (MinIP), or the mean (Average) sample. The projected value is windowed
 * with the same DICOM linear transform (PS3.3 C.11.2.1.2) as the MPR slice
 * shader, so the two panes respond identically to the window/level controls.
 *
 * Kept as a string constant for the same reason as `slice-shader.ts`: Angular's
 * esbuild builder has no `?raw` text loader. The CPU-side ray/box intersection
 * in `camera.ts` mirrors the slab test here for unit testing, and the slab
 * t-range / projection-mode codes are computed in `reslice.ts` / `slice-renderer.ts`.
 */
// language=wgsl
export const RAYCAST_SHADER = /* wgsl */ `
struct Params {
  patientToTex : mat4x4<f32>, // patient (LPS) point -> texture coord [0,1]^3
  eyeSteps : vec4<f32>,       // eye.xyz (patient mm), upper-bound step count in .w
  axisU : vec4<f32>,          // half-width image-plane axis in .xyz, windowCenter in .w
  axisV : vec4<f32>,          // half-height image-plane axis in .xyz, windowWidth in .w
  forward : vec4<f32>,        // unit ray direction (orthographic) in .xyz, voxels-per-t in .w
  modeSlab : vec4<f32>,       // projection mode (0 max,1 min,2 mean) in .x, slab t-range [.y,.z]
};

@group(0) @binding(0) var volTex : texture_3d<f32>;
@group(0) @binding(1) var volSamp : sampler;
@group(0) @binding(2) var<uniform> P : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  // Oversized fullscreen triangle.
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let xy = corners[vi];
  var out : VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  // uv in [0,1], with v = 0 at the top of the canvas.
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Centred device coords with +y up; the image plane spans [-1,1] in each axis.
  let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let originWorld = P.eyeSteps.xyz + ndc.x * P.axisU.xyz + ndc.y * P.axisV.xyz;

  // World -> texture space: a point for the origin, a vector for the direction.
  let ro = (P.patientToTex * vec4<f32>(originWorld, 1.0)).xyz;
  let rd = (P.patientToTex * vec4<f32>(P.forward.xyz, 0.0)).xyz;

  // Slab intersection with the unit box; division by zero yields +/-inf, which
  // min/max handle correctly (a ray parallel to and outside a slab misses).
  let t0 = (vec3<f32>(0.0) - ro) / rd;
  let t1 = (vec3<f32>(1.0) - ro) / rd;
  let tlo = min(t0, t1);
  let thi = max(t0, t1);
  // Clamp the marched segment to the thick slab's t-range as well. The range is
  // [-inf, +inf] for a full-thickness slab, leaving the box traversal unchanged.
  let slabLo = P.modeSlab.y;
  let slabHi = P.modeSlab.z;
  let tEntry = max(max(tlo.x, max(tlo.y, tlo.z)), max(0.0, slabLo));
  let tExit = min(min(thi.x, min(thi.y, thi.z)), slabHi);
  if (tExit < tEntry) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Step roughly once per voxel along this ray's actual traversal: the span
  // (tExit - tEntry) times the voxels-crossed-per-unit-t for the shared
  // orthographic direction. Bounded above by the full-diagonal count so a
  // grazing ray is cheap while no ray ever undersamples. At full quality this
  // matches a one-sample-per-voxel march; the eyeSteps.w / forward.w pair is
  // scaled down together for cheaper interactive (LOD) frames.
  let maxSteps = max(u32(P.eyeSteps.w), 1u);
  let span = tExit - tEntry;
  let steps = clamp(u32(ceil(span * P.forward.w)), 1u, maxSteps);
  let dt = span / f32(steps);
  var maxv = -3.0e38;
  var minv = 3.0e38;
  var sum = 0.0;
  for (var i = 0u; i < steps; i = i + 1u) {
    let t = tEntry + (f32(i) + 0.5) * dt;
    let coord = ro + t * rd;
    let s = textureSampleLevel(volTex, volSamp, coord, 0.0).r;
    maxv = max(maxv, s);
    minv = min(minv, s);
    sum = sum + s;
  }

  // Reduce the marched samples to the configured projection: max (MIP, default),
  // min (MinIP), or mean (Average). The accumulators above run unconditionally so
  // the branch is a cheap final selection rather than per-sample divergence.
  let mode = u32(P.modeSlab.x + 0.5);
  var projected = maxv;
  if (mode == 1u) {
    projected = minv;
  } else if (mode == 2u) {
    projected = sum / f32(steps);
  }

  // DICOM windowing (PS3.3 C.11.2.1.2 linear form) on the projected value.
  let windowCenter = P.axisU.w;
  let windowWidth = P.axisV.w;
  let lo = windowCenter - 0.5 - (windowWidth - 1.0) * 0.5;
  let g = clamp((projected - lo) / max(windowWidth - 1.0, 1.0), 0.0, 1.0);
  return vec4<f32>(g, g, g, 1.0);
}
`;
