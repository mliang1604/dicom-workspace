/**
 * WGSL for the 3D Maximum Intensity Projection (MIP) pane. Each fragment builds
 * an orthographic camera ray (from the basis computed in `camera.ts`), converts
 * it into the volume's texture space with the `patientToTex` affine (built in
 * `reslice.ts`), intersects the unit box, then marches a fixed number of steps
 * accumulating the maximum sample. The projected maximum is windowed with the
 * same DICOM linear transform (PS3.3 C.11.2.1.2) as the MPR slice shader, so the
 * two panes respond identically to the window/level controls.
 *
 * Kept as a string constant for the same reason as `slice-shader.ts`: Angular's
 * esbuild builder has no `?raw` text loader. The CPU-side ray/box intersection
 * in `camera.ts` mirrors the slab test here for unit testing.
 */
// language=wgsl
export const RAYCAST_SHADER = /* wgsl */ `
struct Params {
  patientToTex : mat4x4<f32>, // patient (LPS) point -> texture coord [0,1]^3
  eyeSteps : vec4<f32>,       // eye.xyz (patient mm), march step count in .w
  axisU : vec4<f32>,          // half-width image-plane axis in .xyz, windowCenter in .w
  axisV : vec4<f32>,          // half-height image-plane axis in .xyz, windowWidth in .w
  forward : vec4<f32>,        // unit ray direction (orthographic) in .xyz
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
  let tEntry = max(max(tlo.x, max(tlo.y, tlo.z)), 0.0);
  let tExit = min(thi.x, min(thi.y, thi.z));
  if (tExit < tEntry) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let steps = max(u32(P.eyeSteps.w), 1u);
  let dt = (tExit - tEntry) / f32(steps);
  var maxv = -3.0e38;
  for (var i = 0u; i < steps; i = i + 1u) {
    let t = tEntry + (f32(i) + 0.5) * dt;
    let coord = ro + t * rd;
    maxv = max(maxv, textureSampleLevel(volTex, volSamp, coord, 0.0).r);
  }

  // DICOM windowing (PS3.3 C.11.2.1.2 linear form) on the projected maximum.
  let windowCenter = P.axisU.w;
  let windowWidth = P.axisV.w;
  let lo = windowCenter - 0.5 - (windowWidth - 1.0) * 0.5;
  let g = clamp((maxv - lo) / max(windowWidth - 1.0, 1.0), 0.0, 1.0);
  return vec4<f32>(g, g, g, 1.0);
}
`;
