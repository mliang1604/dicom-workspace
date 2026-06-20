/**
 * WGSL for the 3D pane. Each fragment builds an orthographic camera ray (from the
 * basis computed in `camera.ts`), converts it into the volume's texture space with
 * the `patientToTex` affine (built in `reslice.ts`), intersects the unit box,
 * clamps the marched segment to the thick-slab t-range and — when the MPR cut-away
 * is enabled — to the three slice-plane half-spaces, then renders the configured
 * 3D mode:
 *
 *   - a **projection** (MIP / MinIP / Average): march accumulating the maximum,
 *     the minimum, or the mean sample, then window it with the same DICOM linear
 *     transform (PS3.3 C.11.2.1.2) as the MPR slice shader; or
 *   - **direct volume rendering** (DVR): march front-to-back, map each sample
 *     through a transfer-function LUT (`transfer-function.ts`), shade it with a
 *     central-difference gradient + Lambert headlight (`dvr.ts`), and composite
 *     with early-ray termination.
 *
 * Kept as a string constant for the same reason as `slice-shader.ts`: Angular's
 * esbuild builder has no `?raw` text loader. The CPU-side ray/box intersection in
 * `camera.ts`, the slab/clip t-ranges in `reslice.ts`, and the DVR/TF maths in
 * `dvr.ts` / `transfer-function.ts` mirror this shader for unit testing.
 */
// language=wgsl
export const RAYCAST_SHADER = /* wgsl */ `
struct Params {
  patientToTex : mat4x4<f32>, // patient (LPS) point -> texture coord [0,1]^3
  eyeSteps : vec4<f32>,       // eye.xyz (patient mm), upper-bound step count in .w
  axisU : vec4<f32>,          // half-width image-plane axis in .xyz, windowCenter in .w
  axisV : vec4<f32>,          // half-height image-plane axis in .xyz, windowWidth in .w
  forward : vec4<f32>,        // unit ray direction (orthographic) in .xyz, voxels-per-t in .w
  modeSlab : vec4<f32>,       // mode (0 max,1 min,2 mean,3 DVR) .x, slab t-range [.y,.z], clip on .w
  tfDomain : vec4<f32>,       // DVR transfer-function domain [.x,.y] (HU), unused .z, gray invert .w
  clipA : vec4<f32>,          // axial cut-plane: texture-space normal .xyz, offset .w
  clipC : vec4<f32>,          // coronal cut-plane
  clipS : vec4<f32>,          // sagittal cut-plane
  light : vec4<f32>,          // DVR light direction (texture space) .xyz, shading enabled .w
  material : vec4<f32>,       // DVR Blinn-Phong: ambient .x, diffuse .y, specular .z, shininess .w
};

@group(0) @binding(0) var volTex : texture_3d<f32>;
@group(0) @binding(1) var volSamp : sampler;
@group(0) @binding(2) var<uniform> P : Params;
@group(0) @binding(3) var tfTex : texture_1d<f32>;

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

fn sampleVol(coord : vec3<f32>) -> f32 {
  return textureSampleLevel(volTex, volSamp, clamp(coord, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).r;
}

// Narrow [range.x, range.y] to the kept side of one cut-plane half-space; an
// empty result (x > y) signals a fully clipped ray. Mirrors clipTRange in reslice.ts.
fn clipPlane(planeN : vec3<f32>, planeOff : f32, ro : vec3<f32>, rd : vec3<f32>, range : vec2<f32>) -> vec2<f32> {
  let denom = dot(planeN, rd);
  let value0 = dot(planeN, ro) + planeOff;
  if (abs(denom) < 1e-12) {
    if (value0 < 0.0) { return vec2<f32>(1.0, -1.0); }
    return range;
  }
  let tCross = -value0 / denom;
  var lo = range.x;
  var hi = range.y;
  if (denom > 0.0) { lo = max(lo, tCross); } else { hi = min(hi, tCross); }
  return vec2<f32>(lo, hi);
}

// Direct volume rendering: front-to-back compositing through the transfer
// function with gradient-shaded samples. Mirrors dvr.ts / transfer-function.ts.
fn renderDvr(ro : vec3<f32>, rd : vec3<f32>, tEntry : f32, dt : f32, steps : u32) -> vec4<f32> {
  let tfLo = P.tfDomain.x;
  let tfHi = P.tfDomain.y;
  let texel = 1.0 / vec3<f32>(textureDimensions(volTex));
  let viewDir = -normalize(rd);   // toward the orthographic camera
  let shadeOn = P.light.w > 0.5;
  // Light direction (texture space) is the headlight by default, swung off it by
  // the lighting controls; fall back to the headlight if it was left unset.
  let lightDir = select(viewDir, normalize(P.light.xyz), shadeOn && length(P.light.xyz) > 1e-6);
  let ambient = P.material.x;
  let diffuse = P.material.y;
  let specular = P.material.z;
  let shininess = max(P.material.w, 1.0);
  let stepVoxels = dt * P.forward.w; // march length in voxels, for opacity correction

  var color = vec3<f32>(0.0);
  var alpha = 0.0;
  for (var i = 0u; i < steps; i = i + 1u) {
    let t = tEntry + (f32(i) + 0.5) * dt;
    let coord = clamp(ro + t * rd, vec3<f32>(0.0), vec3<f32>(1.0));
    let s = sampleVol(coord);
    let lutCoord = clamp((s - tfLo) / max(tfHi - tfLo, 1e-6), 0.0, 1.0);
    let tf = textureSampleLevel(tfTex, volSamp, lutCoord, 0.0);
    var a = clamp(tf.a, 0.0, 1.0);
    if (a > 0.0) {
      // Opacity correction so the image is invariant to the step length.
      a = 1.0 - pow(1.0 - a, max(stepVoxels, 0.0));
      // Central-difference gradient -> surface normal -> Lambert headlight.
      let grad = vec3<f32>(
        sampleVol(coord + vec3<f32>(texel.x, 0.0, 0.0)) - sampleVol(coord - vec3<f32>(texel.x, 0.0, 0.0)),
        sampleVol(coord + vec3<f32>(0.0, texel.y, 0.0)) - sampleVol(coord - vec3<f32>(0.0, texel.y, 0.0)),
        sampleVol(coord + vec3<f32>(0.0, 0.0, texel.z)) - sampleVol(coord - vec3<f32>(0.0, 0.0, texel.z)),
      );
      // Blinn-Phong: ambient + diffuse·(n·l) tints by the TF colour, with a white
      // specular highlight added on top. Shading off, or a flat (zero-gradient)
      // region, leaves the sample at its unshaded transfer-function colour.
      var lit = tf.rgb;
      if (shadeOn && length(grad) > 1e-6) {
        let n = normalize(-grad);
        let ndotl = max(dot(n, lightDir), 0.0);
        let half = normalize(lightDir + viewDir);
        let spec = specular * pow(max(dot(n, half), 0.0), shininess);
        lit = tf.rgb * (ambient + diffuse * ndotl) + vec3<f32>(spec);
      }
      let w = (1.0 - alpha) * a;
      color = color + lit * w;
      alpha = alpha + w;
      if (alpha >= 0.99) { break; }
    }
  }
  return vec4<f32>(color, 1.0);
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
  // min/max handle correctly (a ray parallel to and outside a slab misses). An
  // axis-aligned ray grazing a box face is the 0/0 -> NaN case, caught by the
  // NaN-safe miss test below so it can't poison the accumulators.
  let t0 = (vec3<f32>(0.0) - ro) / rd;
  let t1 = (vec3<f32>(1.0) - ro) / rd;
  let tlo = min(t0, t1);
  let thi = max(t0, t1);
  // Clamp the marched segment to the thick slab's t-range as well. The range is
  // [-inf, +inf] for a full-thickness slab, leaving the box traversal unchanged.
  let slabLo = P.modeSlab.y;
  let slabHi = P.modeSlab.z;
  var tEntry = max(max(tlo.x, max(tlo.y, tlo.z)), max(0.0, slabLo));
  var tExit = min(min(thi.x, min(thi.y, thi.z)), slabHi);

  // Clip to the three MPR cut-planes for the cut-away view, when enabled. Each
  // half-space narrows the t-range to its kept (far) side; the intersection is
  // the convex corner of the volume the projection / DVR then traverses.
  if (P.modeSlab.w > 0.5) {
    var range = vec2<f32>(tEntry, tExit);
    range = clipPlane(P.clipA.xyz, P.clipA.w, ro, rd, range);
    range = clipPlane(P.clipC.xyz, P.clipC.w, ro, rd, range);
    range = clipPlane(P.clipS.xyz, P.clipS.w, ro, rd, range);
    tEntry = range.x;
    tExit = range.y;
  }

  // NaN-safe miss test: a degenerate (0/0 -> NaN) or fully clipped range fails
  // this and returns black instead of feeding NaN into the accumulators.
  if (!(tExit >= tEntry)) {
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

  let mode = u32(P.modeSlab.x + 0.5);
  if (mode == 3u) {
    return renderDvr(ro, rd, tEntry, dt, steps);
  }

  // Projection: accumulate max / min / mean unconditionally, select at the end.
  var maxv = -3.0e38;
  var minv = 3.0e38;
  var sum = 0.0;
  for (var i = 0u; i < steps; i = i + 1u) {
    let t = tEntry + (f32(i) + 0.5) * dt;
    let s = sampleVol(ro + t * rd);
    maxv = max(maxv, s);
    minv = min(minv, s);
    sum = sum + s;
  }

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
  // Display inversion (shared with the MPR panes); DVR returns earlier, so only
  // the grayscale projections are flipped.
  let shade = select(g, 1.0 - g, P.tfDomain.w != 0.0);
  return vec4<f32>(shade, shade, shade, 1.0);
}
`;
