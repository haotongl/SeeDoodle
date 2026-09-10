// Both looks share one geometry pass. Classic keeps its original pen data; toon adds a surface
// class to the ink channel and packs full normals so world lighting stays stable while turning.
import * as THREE from 'three';

export const INK = { BLUE: 0, RED: 1, BLACK: 2, ORANGE: 3, GREEN: 4, PINK: 5, TEAL: 6, VIOLET: 7, BROWN: 8, OLIVE: 9 };
export const INK_COLORS = [
  new THREE.Vector3(0.10, 0.19, 0.76), // blue ballpoint
  new THREE.Vector3(0.86, 0.12, 0.20), // red pen
  new THREE.Vector3(0.18, 0.20, 0.26), // graphite
  new THREE.Vector3(0.92, 0.55, 0.08), // orange highlighter
  new THREE.Vector3(0.12, 0.60, 0.30), // green
  new THREE.Vector3(0.90, 0.40, 0.66), // pink eraser
  new THREE.Vector3(0.00, 0.46, 0.53), // teal pen
  new THREE.Vector3(0.46, 0.22, 0.67), // violet pen
  new THREE.Vector3(0.48, 0.28, 0.13), // brown pen
  new THREE.Vector3(0.44, 0.49, 0.06), // olive pen
];
export const LIGHT_WORLD = new THREE.Vector3(0.38, 0.82, 0.42).normalize();
export const SURFACE = { INK: 0, PLASTER: 1, GROUND: 2, STONE: 3, WOOD: 4, METAL: 5, GLASS: 6, FOLIAGE: 7, SKIN: 8, CLOTH: 9, WATER: 10, CERAMIC: 11 };
export const shared = { uLightDir: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 }, uToon: { value: 0 } };

const inkVert = /* glsl */`
varying vec3 vNormalV;
varying vec4 vColorData;
uniform float uTime;
void main() {
  vec3 transformed = position;
  vec3 objectNormal = normal;
  #ifdef USE_INSTANCING
    transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
    objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  #ifdef USE_INSTANCING_COLOR
    vColorData = vec4(instanceColor, 1.0);
  #else
    vColorData = vec4(0.0, 0.0, 0.0, -1.0);
  #endif
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vNormalV = normalize(normalMatrix * objectNormal);
  gl_Position = projectionMatrix * mvPosition;
}`;

const inkFrag = /* glsl */`
precision highp float;
uniform float uInk;
uniform float uFill;
uniform float uShadeScale;
uniform float uShadeBias;
uniform float uSurface;
uniform float uToon;
uniform vec3 uLightDir;
varying vec3 vNormalV;
varying vec4 vColorData;
void main() {
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, uLightDir) * 0.5 + 0.5;
  float ink = uInk; float fill = uFill;
  if (vColorData.a > 0.0) { ink = vColorData.r; fill = vColorData.g; }
  if (uToon > 0.5) {
    vec3 oct = n / (abs(n.x) + abs(n.y) + abs(n.z));
    vec2 enc = oct.xy;
    if (oct.z < 0.0) enc = (1.0 - abs(enc.yx)) * vec2(enc.x >= 0.0 ? 1.0 : -1.0, enc.y >= 0.0 ? 1.0 : -1.0);
    gl_FragColor = vec4(ndl, ink + 16.0 * uSurface, enc);
    return;
  }
  float shade = clamp(ndl * uShadeScale + uShadeBias, 0.0, 1.0);
  if (fill > 0.5) shade = -1.0;
  gl_FragColor = vec4(shade, ink, n.x, n.y);
}`;

export function makeInkMaterial(opts = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uInk: { value: opts.ink ?? INK.BLUE }, uFill: { value: opts.fill ? 1 : 0 },
      uShadeScale: { value: opts.shadeScale ?? 1.0 }, uShadeBias: { value: opts.shadeBias ?? 0.0 },
      uSurface: { value: typeof opts.surface === 'number' ? opts.surface : SURFACE[String(opts.surface || 'ink').toUpperCase()] ?? SURFACE.INK },
      uLightDir: shared.uLightDir, uTime: shared.uTime, uToon: shared.uToon,
    },
    vertexShader: inkVert, fragmentShader: inkFrag, side: opts.side ?? THREE.FrontSide,
  });
  m.inkId = opts.ink ?? INK.BLUE;
  return m;
}
export function setInk(mat, ink) { mat.uniforms.uInk.value = ink; mat.inkId = ink; }
export function setFill(mat, fill) { mat.uniforms.uFill.value = fill ? 1 : 0; }

const postVert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const postFrag = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uAspect;
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform float uHurt;
uniform float uFlash;
uniform float uSlow;
uniform float uLineSpacing;
uniform float uLowHp;
uniform float uViewOpacity;
uniform vec3 uPaper;
uniform vec3 uInks[${INK_COLORS.length}];
uniform mat4 uInvProj;
uniform mat4 uInvView;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float linDepth(float z) { float zn = z * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - zn * (uFar - uNear)); }
vec3 inkColor(float id) {
  int i = int(id + 0.5);
  if (i <= 0) return uInks[0]; if (i == 1) return uInks[1]; if (i == 2) return uInks[2];
  if (i == 3) return uInks[3]; if (i == 4) return uInks[4]; if (i == 5) return uInks[5];
  if (i == 6) return uInks[6]; if (i == 7) return uInks[7]; if (i == 8) return uInks[8]; return uInks[9];
}
float stripes(vec2 p, vec2 dir, float spacing, float width) {
  float t = dot(p, vec2(-dir.y, dir.x));
  float f = abs(fract(t / spacing) - 0.5) * spacing;
  float soft = width * 0.6;
  return 1.0 - smoothstep(width * 0.5 - soft, width * 0.5 + soft, f);
}
void main() {
  vec2 px = 1.0 / uRes;
  float sc = uRes.y / 900.0;
  vec2 nuv = vUv * vec2(uAspect, 1.0);
  vec2 wob = vec2(vnoise(nuv * 6.0 + 11.3), vnoise(nuv * 6.0 + 37.0)) - 0.5;
  vec2 suv = vUv + wob * 2.0 * sc * px;
  vec4 s = texture2D(tScene, suv);
  float z = texture2D(tDepth, suv).x;
  if (uViewOpacity >= 0.0 && z >= 0.999999) discard;
  float d = linDepth(z);
  float o = 1.15 * sc;
  vec2 ox = vec2(o, 0.0) * px, oy = vec2(0.0, o) * px;
  float zl = texture2D(tDepth, suv - ox).x, zr = texture2D(tDepth, suv + ox).x;
  float zu = texture2D(tDepth, suv + oy).x, zd = texture2D(tDepth, suv - oy).x;
  vec4 sl = texture2D(tScene, suv - ox), sr = texture2D(tScene, suv + ox);
  vec4 su = texture2D(tScene, suv + oy), sd = texture2D(tScene, suv - oy);
  // Edge test in inverse depth (1/d). For ANY plane - including ones seen at a
  // grazing angle, like the floor - 1/d is affine across the screen, so its second
  // difference is zero there and only real silhouettes register. Comparing it against
  // 1/d itself makes the test scale invariant, so distant outlines stay as crisp as near ones.
  float iw = 1.0 / d;
  float lap = abs(1.0 / linDepth(zl) + 1.0 / linDepth(zr) - 2.0 * iw)
            + abs(1.0 / linDepth(zu) + 1.0 / linDepth(zd) - 2.0 * iw);
  float edge = smoothstep(0.07, 0.30, lap / (iw + 1e-7));
  float nEdge = length(sl.ba - sr.ba) + length(su.ba - sd.ba);
  edge = max(edge, smoothstep(0.42, 0.85, nEdge));
  // ink colour of the front-most sample around the edge
  float zmin = z; float inkId = s.g;
  if (zl < zmin) { zmin = zl; inkId = sl.g; }
  if (zr < zmin) { zmin = zr; inkId = sr.g; }
  if (zu < zmin) { zmin = zu; inkId = su.g; }
  if (zd < zmin) { zmin = zd; inkId = sd.g; }
  float dFront = linDepth(zmin);
  bool sky = z >= 0.99999;

  // Hatching is anchored to the surface itself, not to the screen. The fragment's world position
  // is rebuilt from depth and the strokes are laid out in world units on whichever pair of axes
  // faces away from the surface normal, so the pattern stays put on a wall as you move past it.
  // Line spacing steps in powers of two with distance, which keeps the on-screen density roughly
  // constant instead of collapsing into moire on far geometry.
  float shade = s.r;
  float hatch = 0.0;
  if (!sky) {
    if (shade < 0.0) hatch = 1.0;
    else {
      vec2 hp; float sp, w;
      if (d < 2.0) {
        // the held weapon rides with the camera, so for it the screen is the stable frame
        hp = gl_FragCoord.xy + wob * 5.0 * sc;
        sp = 8.5 * sc; w = 1.5 * sc;
      } else {
        vec4 clip = vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
        vec4 vpos = uInvProj * clip; vpos /= vpos.w;
        vec3 wpos = (uInvView * vec4(vpos.xyz, 1.0)).xyz;
        vec2 nxy = s.ba;
        vec3 nView = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
        vec3 wn = normalize(mat3(uInvView) * nView);
        vec3 an = abs(wn);
        // project onto the plane the surface most faces, so strokes lie flat along it
        hp = an.y > max(an.x, an.z) ? wpos.xz : (an.x > an.z ? wpos.zy : wpos.xy);
        // pick the world spacing whose projected width is about nine pixels, quantised to powers
        // of two so the pattern only changes density in steps and never crawls as you walk
        float lod = exp2(floor(log2(max(1e-4, (0.0165 * d) / 0.16))));
        sp = 0.16 * lod; w = sp * 0.17;
        hp += (vnoise(hp * (2.5 / sp)) - 0.5) * sp * 0.4; // hand-drawn waver, fixed to the surface
      }
      const vec2 d1 = vec2(0.7071, 0.7071);
      const vec2 d2 = vec2(-0.7071, 0.7071);
      const vec2 d3 = vec2(0.2588, 0.9659);
      float h1 = stripes(hp, d1, sp, w);
      float h2 = stripes(hp, d2, sp * 1.15, w);
      float h3 = stripes(hp, d3, sp * 0.7, w);
      hatch = h1 * smoothstep(0.64, 0.5, shade);
      hatch = max(hatch, h2 * smoothstep(0.42, 0.32, shade));
      hatch = max(hatch, h3 * smoothstep(0.24, 0.14, shade));
      hatch = max(hatch, smoothstep(0.12, 0.0, shade) * 0.9);
    }
  }
  float fade = mix(1.0, 0.28, smoothstep(14.0, 110.0, d));
  float fadeE = mix(1.0, 0.45, smoothstep(30.0, 220.0, dFront));

  // paper with grain, ruled lines and a red margin
  vec2 pp = gl_FragCoord.xy;
  float grain = vnoise(pp * 0.8) * 0.6 + vnoise(pp * 0.17) * 0.4;
  vec3 paper = uPaper * (0.95 + 0.06 * grain);
  float ls = uLineSpacing;
  float ly = mod(pp.y + ls * 0.5, ls);
  float rule = 1.0 - smoothstep(0.5 * sc, 1.7 * sc, abs(ly - ls * 0.5));
  paper = mix(paper, vec3(0.58, 0.70, 0.92), rule * 0.5);
  float margin = 1.0 - smoothstep(0.9 * sc, 2.3 * sc, abs(pp.x - uRes.x * 0.07));
  paper = mix(paper, vec3(0.92, 0.48, 0.55), margin * 0.55);

  vec3 col = paper;
  col = mix(col, inkColor(s.g), hatch * 0.72 * fade);
  float ew = 0.75 + 0.35 * vnoise(pp * 0.35);
  col = mix(col, inkColor(inkId) * 0.92, clamp(edge * ew, 0.0, 1.0) * fadeE);

  // hurt: red scribble vignette; low hp: pulsing
  vec2 vc = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = smoothstep(0.32, 0.9, length(vc));
  float scr = 0.55 + 0.45 * stripes(pp + wob * 8.0, normalize(vec2(1.0, 0.8)), 7.0 * sc, 2.2 * sc);
  float hurt = clamp(uHurt + uLowHp * (0.35 + 0.25 * sin(uTime * 6.0)), 0.0, 1.0);
  col = mix(col, uInks[1] * 0.9, hurt * vig * scr);
  col = mix(col, uPaper, uFlash);
  float lum = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(lum) * vec3(0.8, 0.86, 1.0), uSlow * 0.55);
  gl_FragColor = vec4(col, uViewOpacity >= 0.0 ? uViewOpacity : 1.0);
}`;

const toonFrag = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tSurface;
uniform vec2 uRes;
uniform float uAspect;
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform float uHurt;
uniform float uFlash;
uniform float uSlow;
uniform float uLowHp;
uniform float uViewOpacity;
uniform float uMapMood;
uniform vec3 uHaze;
uniform vec3 uInks[${INK_COLORS.length}];
uniform mat4 uInvProj;
uniform mat4 uInvView;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), f.x), f.y);
}
float linDepth(float z) { float zn = z * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - zn * (uFar - uNear)); }
vec3 inkColor(float packed) {
  int i = int(mod(packed, 16.0) + 0.5);
  if (i <= 0) return uInks[0]; if (i == 1) return uInks[1]; if (i == 2) return uInks[2];
  if (i == 3) return uInks[3]; if (i == 4) return uInks[4]; if (i == 5) return uInks[5];
  if (i == 6) return uInks[6]; if (i == 7) return uInks[7]; if (i == 8) return uInks[8]; return uInks[9];
}
vec3 viewNormal(vec2 enc) {
  vec3 n = vec3(enc, 1.0 - abs(enc.x) - abs(enc.y));
  float t = max(-n.z, 0.0);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}
vec3 viewPosition(vec2 uv, float z) {
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
vec3 skyColor(vec3 ray) {
  float up = smoothstep(-0.10, 0.82, ray.y);
  vec3 sky = mix(vec3(0.88, 0.91, 0.86), vec3(0.32, 0.64, 0.84), up);
  vec2 cp = ray.xz / max(ray.y + 0.30, 0.08) * 1.6 + vec2(uTime * 0.0018, 0.0);
  float clouds = vnoise(cp) * 0.65 + vnoise(cp * 2.1 + 7.1) * 0.25 + vnoise(cp * 4.4) * 0.10;
  float cloud = smoothstep(0.51, 0.76, clouds) * smoothstep(0.0, 0.24, ray.y);
  sky = mix(sky, vec3(0.99, 0.97, 0.89), cloud * 0.87);
  float sun = pow(max(dot(ray, normalize(vec3(0.38, 0.82, 0.42))), 0.0), 28.0);
  sky += vec3(0.13, 0.095, 0.025) * sun;
  return mix(sky, sky * vec3(0.68, 0.80, 0.89), uMapMood * 0.5);
}
vec3 surfaceColor(float packed, vec3 p, vec2 uv, float brush) {
  float kind = floor(packed / 16.0 + 0.001);
  float ink = mod(packed, 16.0);
  vec3 tint = inkColor(packed);
  vec3 base = mix(tint, vec3(1.0), 0.15);
  float broad = vnoise(p.xz * 0.09 + p.y * 0.035);
  if (kind < 0.5) return base;
  if (kind < 1.5) {
    base = mix(vec3(0.91, 0.80, 0.64), vec3(0.95, 0.89, 0.77), broad);
    if (ink > 0.5 && ink < 1.5) base = vec3(0.80, 0.49, 0.36);
    else if (ink > 2.5 && ink < 3.5) base = vec3(0.93, 0.70, 0.39);
    else if (ink > 3.5 && ink < 4.5) base = vec3(0.57, 0.73, 0.61);
    else if (ink > 4.5 && ink < 5.5) base = vec3(0.87, 0.64, 0.61);
    base *= 0.98 + brush * 0.055;
  } else if (kind < 2.5) {
    base = mix(vec3(0.40, 0.44, 0.45), vec3(0.52, 0.55, 0.53), broad);
    base *= 0.96 + brush * 0.08;
  } else if (kind < 3.5) {
    base = mix(vec3(0.59, 0.64, 0.64), vec3(0.76, 0.77, 0.70), broad);
    base *= 0.96 + brush * 0.08;
  } else if (kind < 4.5) {
    float grain = vnoise(vec2(uv.x * 0.9, uv.y * 14.0));
    base = mix(vec3(0.39, 0.23, 0.12), vec3(0.65, 0.45, 0.24), grain * 0.7 + brush * 0.3);
  } else if (kind < 5.5) {
    base = mix(vec3(0.20, 0.29, 0.31), vec3(0.34, 0.42, 0.43), broad);
    if (ink < 1.5 || ink > 2.5) base = mix(base, tint, 0.12);
  } else if (kind < 6.5) {
    base = mix(vec3(0.25, 0.52, 0.62), vec3(0.53, 0.75, 0.77), broad);
  } else if (kind < 7.5) {
    base = mix(vec3(0.25, 0.46, 0.22), vec3(0.48, 0.64, 0.32), broad * 0.65 + brush * 0.35);
  } else if (kind < 8.5) {
    if (ink < 0.5) base = vec3(0.949, 0.788, 0.643);
    else if (ink < 1.5) base = vec3(0.863, 0.647, 0.467);
    else if (ink < 2.5) base = vec3(0.737, 0.510, 0.333);
    else if (ink < 3.5) base = vec3(0.600, 0.373, 0.231);
    else if (ink < 4.5) base = vec3(0.455, 0.271, 0.180);
    else base = vec3(0.298, 0.169, 0.125);
    base *= 0.99 + brush * 0.02;
  } else if (kind < 9.5) {
    base = mix(tint, vec3(0.95, 0.91, 0.83), 0.14) * (0.975 + brush * 0.05);
  } else if (kind < 10.5) {
    float ripple = sin(p.x * 1.15 + p.z * 0.45 + uTime * 0.65) * sin(p.z * 0.72 - uTime * 0.38);
    base = mix(vec3(0.16, 0.39, 0.36), vec3(0.35, 0.58, 0.52), broad);
    base += vec3(0.045, 0.055, 0.05) * smoothstep(0.68, 0.96, ripple);
  } else {
    base = mix(vec3(0.81, 0.83, 0.80), vec3(0.92, 0.92, 0.86), broad) * (0.99 + brush * 0.025);
  }
  return base;
}
float occlusion(vec2 uv, float depth, float radius) {
  float nearDepth = linDepth(texture2D(tDepth, uv).x);
  float delta = depth - nearDepth;
  return smoothstep(0.025, radius * 0.3, delta) * (1.0 - smoothstep(radius * 0.3, radius, delta));
}
void main() {
  vec2 px = 1.0 / uRes;
  vec4 s = texture2D(tScene, vUv);
  float z = texture2D(tDepth, vUv).x;
  if (uViewOpacity >= 0.0 && z >= 0.999999) discard;
  float d = linDepth(z);
  vec3 vp = viewPosition(vUv, z);
  vec3 ray = normalize(mat3(uInvView) * vp);
  vec3 sky = skyColor(ray);
  float sc = max(0.75, uRes.y / 900.0);
  vec2 ox = vec2(sc, 0.0) * px, oy = vec2(0.0, sc) * px;
  float zl = texture2D(tDepth, vUv - ox).x, zr = texture2D(tDepth, vUv + ox).x;
  float zu = texture2D(tDepth, vUv + oy).x, zd = texture2D(tDepth, vUv - oy).x;
  vec4 sl = texture2D(tScene, vUv - ox), sr = texture2D(tScene, vUv + ox);
  vec4 su = texture2D(tScene, vUv + oy), sd = texture2D(tScene, vUv - oy);
  float iw = 1.0 / d;
  float lap = abs(1.0 / linDepth(zl) + 1.0 / linDepth(zr) - 2.0 * iw)
            + abs(1.0 / linDepth(zu) + 1.0 / linDepth(zd) - 2.0 * iw);
  float edge = smoothstep(0.085, 0.35, lap / (iw + 1e-7));
  bool isSky = z >= 0.99999;
  vec3 col = sky;
  if (!isSky) {
    vec3 n = viewNormal(s.ba), wn = normalize(mat3(uInvView) * n);
    float normalEdge = length(viewNormal(sl.ba) - viewNormal(sr.ba)) + length(viewNormal(su.ba) - viewNormal(sd.ba));
    edge = max(edge, smoothstep(0.7, 1.5, normalEdge) * 0.52);
    vec3 wp = (uInvView * vec4(vp, 1.0)).xyz;
    vec3 an = abs(wn);
    vec2 surfUv = an.y > max(an.x, an.z) ? wp.xz : (an.x > an.z ? wp.zy : wp.xy);
    // The held model uses view coordinates, so cloth/metal grain does not slide as the player moves.
    if (d < 2.0) surfUv = vp.xy * 3.0;
    float brush = texture2D(tSurface, surfUv * 0.17).r * 0.6 + vnoise(surfUv * 1.3) * 0.4;
    vec3 base = surfaceColor(s.g, wp, surfUv, brush);
    float kind = floor(s.g / 16.0 + 0.001);
    float ndl = clamp(s.r * 2.0 - 1.0, -1.0, 1.0);
    float lit = smoothstep(-0.18, 0.85, ndl);
    float bounce = max(-wn.y, 0.0);
    vec3 ambient = mix(vec3(0.58, 0.68, 0.79), vec3(0.82, 0.76, 0.62), bounce * 0.45);
    vec3 light = ambient * 0.72 + vec3(0.53, 0.43, 0.29) * lit;
    col = base * light;
    vec3 sunDir = normalize(vec3(0.38, 0.82, 0.42));
    vec3 halfDir = normalize(sunDir - ray);
    float metal = step(4.5, kind) * (1.0 - step(6.5, kind));
    float gloss = pow(max(dot(wn, halfDir), 0.0), mix(24.0, 56.0, metal));
    float rim = pow(1.0 - max(dot(n, normalize(-vp)), 0.0), 3.0) * max(wn.y * 0.5 + 0.5, 0.0);
    col += vec3(1.0, 0.87, 0.63) * gloss * mix(0.035, 0.23, metal);
    col += vec3(0.66, 0.82, 0.89) * rim * mix(0.075, 0.16, metal);
    float reach = clamp(950.0 / max(d, 3.0), 2.0, 10.0) * sc;
    vec2 aoStep = px * reach;
    float radius = clamp(d * 0.035, 0.16, 1.8);
    float ao = occlusion(vUv + vec2(aoStep.x, 0.0), d, radius) + occlusion(vUv - vec2(aoStep.x, 0.0), d, radius)
             + occlusion(vUv + vec2(0.0, aoStep.y), d, radius) + occlusion(vUv - vec2(0.0, aoStep.y), d, radius);
    col *= 1.0 - ao * 0.065;
    col = mix(col, col * vec3(0.67, 0.79, 0.87), uMapMood * 0.3);
    float haze = smoothstep(uHaze.x, uHaze.y, d) * uHaze.z;
    col = mix(col, mix(vec3(0.83, 0.85, 0.80), sky, 0.35), haze);
  }
  // Keep contours delicate and neutral; the character's saturated uniform carries team identity.
  float edgeFade = mix(0.50, 0.17, smoothstep(24.0, 130.0, d));
  col = mix(col, col * vec3(0.38, 0.45, 0.48), edge * edgeFade);
  vec2 centered = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = smoothstep(0.30, 0.95, length(centered));
  col *= 1.0 - vig * 0.055;
  float hurt = clamp(uHurt + uLowHp * (0.35 + 0.25 * sin(uTime * 6.0)), 0.0, 1.0);
  col = mix(col, vec3(0.77, 0.12, 0.12), hurt * vig * 0.72);
  col = mix(col, vec3(1.0, 0.98, 0.87), uFlash);
  float lum = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(lum) * vec3(0.8, 0.90, 1.0), uSlow * 0.45);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), uViewOpacity >= 0.0 ? uViewOpacity : 1.0);
}`;

export class InkRenderer {
  constructor(canvas, options = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.pixelRatio = options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 1.5);
    this.fixedSize = options.width && options.height ? options : null;
    this.skin = 'classic'; this.map = 'district';
    const fallback = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    fallback.wrapS = fallback.wrapT = THREE.RepeatWrapping; fallback.needsUpdate = true;
    this._surface = fallback; this._surfaceRequested = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.08, 420);
    const depthTexture = new THREE.DepthTexture(2, 2); depthTexture.format = THREE.DepthFormat; depthTexture.type = THREE.FloatType;
    this.rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
    this.post = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.rt.texture }, tDepth: { value: depthTexture }, uRes: { value: new THREE.Vector2(2, 2) }, uAspect: { value: 1 },
        uTime: { value: 0 }, uNear: { value: this.camera.near }, uFar: { value: this.camera.far }, uHurt: { value: 0 }, uFlash: { value: 0 }, uSlow: { value: 0 },
        uLowHp: { value: 0 }, uViewOpacity: { value: -1 }, uLineSpacing: { value: 60 }, uPaper: { value: new THREE.Vector3(0.965, 0.955, 0.905) }, uInks: { value: INK_COLORS },
        uInvProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() },
        tSurface: { value: fallback }, uMapMood: { value: 0 }, uHaze: { value: new THREE.Vector3(38, 210, 0.72) },
      },
      vertexShader: postVert, fragmentShader: postFrag, depthTest: false, depthWrite: false,
    });
    this.toonPost = new THREE.ShaderMaterial({ uniforms: this.post.uniforms, vertexShader: postVert, fragmentShader: toonFrag, depthTest: false, depthWrite: false });
    this.postScene = new THREE.Scene(); this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post); this.postScene.add(this._postQuad);
    this._clear = new THREE.Color(1, 0, 0);
    this._ld = new THREE.Vector3();
    this.resize();
    if (!this.fixedSize) window.addEventListener('resize', () => this.resize());
  }
  setSkin(key) {
    this.skin = key === 'toon' ? 'toon' : 'classic';
    shared.uToon.value = this.skin === 'toon' ? 1 : 0;
    this._postQuad.material = this.skin === 'toon' ? this.toonPost : this.post;
    if (this.skin === 'toon' && !this._surfaceRequested) {
      this._surfaceRequested = true;
      // The generated tile is only a finish layer; offline/missing-asset clients keep the same look.
      new THREE.TextureLoader().load(new URL('../assets/toon-surface-v1.jpg', import.meta.url).href, texture => {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
        texture.needsUpdate = true;
        this._surface.dispose(); this._surface = texture;
        this.post.uniforms.tSurface.value = texture;
      }, undefined, () => { this._surfaceFailed = true; });
    }
    return this.skin;
  }
  setMap(key) {
    this.map = key || 'district';
    this.post.uniforms.uMapMood.value = this.map === 'undercity' ? 1 : 0;
    // The campus spans eight Depot arenas; keep its distant route landmarks legible.
    this.post.uniforms.uHaze.value.set(...(this.map === 'zijingang' ? [75, 360, 0.5] : [38, 210, 0.72]));
  }
  resize() {
    const w = Math.max(2, this.fixedSize?.width || window.innerWidth), h = Math.max(2, this.fixedSize?.height || window.innerHeight);
    this.renderer.setPixelRatio(this.pixelRatio); this.renderer.setSize(w, h, false);
    const rw = Math.floor(w * this.pixelRatio), rh = Math.floor(h * this.pixelRatio);
    this.rt.setSize(rw, rh);
    this._viewRt?.setSize(rw, rh);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const u = this.post.uniforms; u.uRes.value.set(rw, rh); u.uAspect.value = w / h; u.uLineSpacing.value = rh / 13.5;
  }
  render(time, fx = {}) {
    shared.uTime.value = time;
    this.camera.updateMatrixWorld(); this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    shared.uLightDir.value.copy(LIGHT_WORLD).transformDirection(this.camera.matrixWorldInverse);
    const r = this.renderer;
    r.setRenderTarget(this.rt); r.setClearColor(this._clear, 0); r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    const u = this.post.uniforms; u.uTime.value = time; u.uNear.value = this.camera.near; u.uFar.value = this.camera.far;
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse); u.uInvView.value.copy(this.camera.matrixWorld);
    u.uHurt.value = fx.hurt || 0; u.uFlash.value = fx.flash || 0; u.uSlow.value = fx.slow || 0; u.uLowHp.value = fx.lowHp || 0;
    r.render(this.postScene, this.postCam);
    this._renderViewModel();
  }
  _renderViewModel() {
    const view = this.camera.userData.translucentViewModel;
    if (!view) return;
    for (let o = view; o; o = o.parent) if (!o.visible) return;
    if (!this._viewRt) {
      const depthTexture = new THREE.DepthTexture(this.rt.width, this.rt.height); depthTexture.type = THREE.FloatType;
      this._viewRt = new THREE.WebGLRenderTarget(this.rt.width, this.rt.height, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
      const options = { uniforms: this.post.uniforms, vertexShader: postVert, depthTest: false, depthWrite: false, transparent: true };
      this._viewClassic = new THREE.ShaderMaterial({ ...options, fragmentShader: postFrag });
      this._viewToon = new THREE.ShaderMaterial({ ...options, fragmentShader: toonFrag });
    }
    // Finish the grenade's ink/toon shading before blending, preserving the world's material IDs,
    // normals, and depth. Only its first-person meshes use layer 1; shared materials stay opaque.
    const r = this.renderer, u = this.post.uniforms, layers = this.camera.layers.mask, material = this._postQuad.material;
    try {
      this.camera.layers.set(1); r.setRenderTarget(this._viewRt); r.setClearColor(this._clear, 0); r.clear(true, true, false);
      r.render(this.scene, this.camera); r.setRenderTarget(null);
      u.tScene.value = this._viewRt.texture; u.tDepth.value = this._viewRt.depthTexture; u.uViewOpacity.value = view.userData.viewOpacity ?? 0.5;
      this._postQuad.material = this.skin === 'toon' ? this._viewToon : this._viewClassic;
      r.render(this.postScene, this.postCam);
    } finally {
      this.camera.layers.mask = layers; r.setRenderTarget(null); this._postQuad.material = material;
      u.tScene.value = this.rt.texture; u.tDepth.value = this.rt.depthTexture; u.uViewOpacity.value = -1;
    }
  }
}
