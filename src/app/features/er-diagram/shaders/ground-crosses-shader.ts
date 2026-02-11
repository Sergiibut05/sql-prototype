import * as THREE from 'three';

export const GroundCrossesShader = {
  uniforms: {
    uTime: { value: 0 },
    uCrossSize: { value: 0.012 },
    uCrossDensity: { value: 0.06 },
    uCrossColor: { value: new THREE.Color(0x2a3f6a) },
    uBaseColor: { value: new THREE.Color(0x080c14) },
    uFadeDistance: { value: 500.0 },
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

    varying vec3 vWorldPosition;
    varying float vDistToCamera;

    float antialiasedStep(float edge, float x, float feather) {
      return smoothstep(edge - feather, edge + feather, x);
    }

    float drawCross(vec2 pos, float size, float feather) {
      float arm = size * 3.5;
      float thickness = size;
      float h = (1.0 - antialiasedStep(thickness, abs(pos.y), feather))
              * (1.0 - antialiasedStep(arm, abs(pos.x), feather));
      float v = (1.0 - antialiasedStep(thickness, abs(pos.x), feather))
              * (1.0 - antialiasedStep(arm, abs(pos.y), feather));
      return max(h, v);
    }

    void main() {
      vec2 worldXZ = vWorldPosition.xz;
      float tileSize = 1.0 / uCrossDensity;
      vec2 tilePos = mod(worldXZ + tileSize * 0.5, tileSize) - tileSize * 0.5;

      float feather = fwidth(tilePos.x) * 1.5;
      float cross = drawCross(tilePos, uCrossSize * tileSize, feather);

      // Distance-based fade
      float dist = length(worldXZ);
      float fade = 1.0 - smoothstep(uFadeDistance * 0.15, uFadeDistance, dist);

      // Camera distance fade
      float camFade = 1.0 - smoothstep(uFadeDistance * 0.5, uFadeDistance * 1.5, vDistToCamera);

      // Subtle animated pulse
      float pulse = sin(uTime * 0.3 + dist * 0.005) * 0.12 + 0.88;

      float combinedFade = fade * camFade;
      vec3 crossColor = uCrossColor * pulse;
      vec3 color = mix(uBaseColor, crossColor, cross * combinedFade);

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};
