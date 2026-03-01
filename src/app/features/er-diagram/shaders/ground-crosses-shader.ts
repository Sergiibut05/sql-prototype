import * as THREE from 'three';

export const GroundCrossesShader = {
  uniforms: {
    uTime: { value: 0 },
    uCrossSize: { value: 0.012 },
    uCrossDensity: { value: 0.06 },
    uCrossColor: { value: new THREE.Color(0xffffff) },
    uBaseColor: { value: new THREE.Color(0x0a0e1a) },
    uFadeDistance: { value: 1400.0 },
    uCrossOpacity: { value: 0.85 },
    uReflStrength: { value: 0.55 },  // fake ground reflection intensity
  },

  vertexShader: /* glsl */ `
    varying vec3 vWorldPosition;
    varying float vDistToCamera;

    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      vDistToCamera  = length(cameraPosition - worldPos.xyz);
      gl_Position    = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uCrossSize;
    uniform float uCrossDensity;
    uniform vec3  uCrossColor;
    uniform vec3  uBaseColor;
    uniform float uFadeDistance;
    uniform float uCrossOpacity;
    uniform float uReflStrength;

    varying vec3  vWorldPosition;
    varying float vDistToCamera;

    // ── Cross SDF ────────────────────────────────────────────────────────────
    float drawCross(vec2 pos, float size, float feather) {
      float arm       = size * 4.0;
      float thickness = size * 1.2;

      // Horizontal arm
      float h = smoothstep(thickness + feather, thickness - feather, abs(pos.y))
              * smoothstep(arm       + feather, arm       - feather, abs(pos.x));
      // Vertical arm
      float v = smoothstep(thickness + feather, thickness - feather, abs(pos.x))
              * smoothstep(arm       + feather, arm       - feather, abs(pos.y));
      return max(h, v);
    }

    // ── Cheap value noise (hash-based) ────────────────────────────────────────
    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    // Bilinear smooth noise, 0..1
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);   // smoothstep curve
      return mix(
        mix(hash21(i + vec2(0., 0.)), hash21(i + vec2(1., 0.)), f.x),
        mix(hash21(i + vec2(0., 1.)), hash21(i + vec2(1., 1.)), f.x),
        f.y
      );
    }

    // Two-octave FBM for a richer shimmery texture
    float fbm(vec2 p) {
      return valueNoise(p) * 0.65 + valueNoise(p * 2.3 + vec2(5.1, 1.7)) * 0.35;
    }

    // ── Main ─────────────────────────────────────────────────────────────────
    void main() {
      vec2  worldXZ = vWorldPosition.xz;
      float tileSize = 1.0 / uCrossDensity;

      // Anti-aliasing: compute feather from world-space derivatives BEFORE mod()
      float feather = length(vec2(dFdx(worldXZ.x), dFdy(worldXZ.x))) * 1.5;
      vec2  tilePos = mod(worldXZ + tileSize * 0.5, tileSize) - tileSize * 0.5;
      float cross_v = drawCross(tilePos, uCrossSize * tileSize, feather);

      // Distance fades
      float dist      = length(worldXZ);
      float fade      = 1.0 - smoothstep(uFadeDistance * 0.4,  uFadeDistance * 1.2, dist);
      float camFade   = 1.0 - smoothstep(uFadeDistance * 0.8,  uFadeDistance * 2.0, vDistToCamera);
      float combinedFade = fade * camFade;

      // Animated pulse on crosses
      float pulse = sin(uTime * 0.3 + dist * 0.005) * 0.08 + 0.92;

      vec3 crossContrib = uCrossColor * pulse * cross_v * combinedFade * uCrossOpacity;
      vec3 color        = uBaseColor + crossContrib;

      // ── Fake blurred ground reflection ─────────────────────────────────────
      //
      // Technique: cheap screen-space fake using two-octave FBM noise to morph
      // between two "reflected" palette colours (table header purple and cable
      // teal). A Fresnel-like factor makes the reflection stronger at grazing
      // angles (= fragments far from the camera nadir on the ground plane).
      //
      // Cost: ~10 extra ALU ops per fragment — no extra render passes.

      // Fresnel factor: 0 directly below camera, 1 at grazing distance
      float reflFresnel = smoothstep(
        uFadeDistance * 0.04,
        uFadeDistance * 0.65,
        vDistToCamera
      );

      // Slow-drifting ripple coordinates (two independent offsets for depth)
      float t  = uTime * 0.10;
      vec2  uv1 = worldXZ * 0.0025 + vec2( t * 0.35,  t * 0.28);
      vec2  uv2 = worldXZ * 0.006  + vec2(-t * 0.18,  t * 0.44);
      float n1  = fbm(uv1);
      float n2  = fbm(uv2);
      float shimmer = n1 * 0.55 + n2 * 0.45;   // 0..1

      // Palette: table header indigo-blue ↔ cable/edge azure-cyan
      vec3 reflTable = vec3(0.18, 0.20, 0.88);  // indigo-blue  — header glow
      vec3 reflCable = vec3(0.04, 0.50, 0.78);  // cyan-azure   — matches edge glow

      vec3 reflColor = mix(reflTable, reflCable, shimmer);

      // Sharp noise mask: create distinct "pool" highlights rather than uniform haze
      float reflMask = smoothstep(0.30, 0.72, shimmer);

      // Combine: Fresnel × distance fade × mask × user strength
      float reflStrength = reflFresnel * combinedFade * reflMask * uReflStrength;

      // Subtle second layer — softer, wider coverage, deep azure tint
      float softMask  = smoothstep(0.20, 0.55, n2);
      vec3  softRefl  = vec3(0.03, 0.12, 0.40) * softMask * reflFresnel * combinedFade
                      * uReflStrength * 0.4;

      color += reflColor * reflStrength + softRefl;
      color  = min(color, vec3(1.0));

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};
