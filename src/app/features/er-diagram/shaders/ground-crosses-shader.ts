import * as THREE from 'three';

export const GroundCrossesShader = {
  uniforms: {
    uTime: { value: 0 },
    uCrossSize: { value: 0.012 },
    uCrossDensity: { value: 0.06 },
    uCrossColor: { value: new THREE.Color(0x2a3f6a) },
    uBaseColor: { value: new THREE.Color(0x080c14) },
    uFadeDistance: { value: 500.0 },
    uCrossOpacity: { value: 0.85 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldPosition;
    varying float vDistToCamera;

    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      vDistToCamera = length(cameraPosition - worldPos.xyz);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uCrossSize;
    uniform float uCrossDensity;
    uniform vec3 uCrossColor;
    uniform vec3 uBaseColor;
    uniform float uFadeDistance;
    uniform float uCrossOpacity;

    varying vec3 vWorldPosition;
    varying float vDistToCamera;

    float drawCross(vec2 pos, float size, float feather) {
      float arm = size * 4.0;
      float thickness = size * 1.2;

      // Horizontal arm
      float h = smoothstep(thickness + feather, thickness - feather, abs(pos.y))
              * smoothstep(arm + feather, arm - feather, abs(pos.x));
      // Vertical arm
      float v = smoothstep(thickness + feather, thickness - feather, abs(pos.x))
              * smoothstep(arm + feather, arm - feather, abs(pos.y));

      return max(h, v);
    }

    void main() {
      vec2 worldXZ = vWorldPosition.xz;
      float tileSize = 1.0 / uCrossDensity;

      // Compute feather from world-space derivatives BEFORE mod()
      // This avoids discontinuities at tile boundaries that cause diagonal line artifacts
      float feather = length(vec2(dFdx(worldXZ.x), dFdy(worldXZ.x))) * 1.5;

      // Tile position — centered so cross is at tile center
      vec2 tilePos = mod(worldXZ + tileSize * 0.5, tileSize) - tileSize * 0.5;

      float cross = drawCross(tilePos, uCrossSize * tileSize, feather);

      // Distance-based fade
      float dist = length(worldXZ);
      float fade = 1.0 - smoothstep(uFadeDistance * 0.4, uFadeDistance * 1.2, dist);

      // Camera distance fade
      float camFade = 1.0 - smoothstep(uFadeDistance * 0.8, uFadeDistance * 2.0, vDistToCamera);

      // Subtle animated pulse
      float pulse = sin(uTime * 0.3 + dist * 0.005) * 0.08 + 0.92;

      float combinedFade = fade * camFade;

      // Cross is drawn additively on top of base color
      vec3 crossContrib = uCrossColor * pulse * cross * combinedFade * uCrossOpacity;
      vec3 color = uBaseColor + crossContrib;
      color = min(color, vec3(1.0));

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};
