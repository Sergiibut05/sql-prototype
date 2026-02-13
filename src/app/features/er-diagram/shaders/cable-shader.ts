import * as THREE from 'three';

/**
 * Animated striped cable shader — inspired by Supabase schema visualizer.
 *
 * Creates alternating lighter / darker bands that scroll along the cable,
 * producing a "flowing energy" effect. Uses smooth sinusoidal transitions
 * between light and dark bands for a polished, professional look.
 *
 * The base color and speed are configurable via uniforms so the GUI
 * can drive them at runtime.
 */
export const CableShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0x34d399) },       // base cable color
    uStripeCount: { value: 6.0 },                        // number of stripe cycles visible
    uStripeContrast: { value: 0.38 },                    // difference between light/dark bands
    uSpeed: { value: 1.2 },                               // scroll speed
    uOpacity: { value: 0.92 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform vec3 uColor;
    uniform float uStripeCount;
    uniform float uStripeContrast;
    uniform float uSpeed;
    uniform float uOpacity;

    varying vec2 vUv;

    void main() {
      // Stripe wave — smooth sinusoidal bands scrolling along the cable length
      float phase = (vUv.x * uStripeCount - uTime * uSpeed) * 6.28318;
      float wave = sin(phase);

      // Smooth brightness modulation between 1-contrast and 1+contrast
      float brightness = 1.0 + wave * uStripeContrast;

      // Edge softness — slightly brighter centre, softer edges
      float edgeDist = abs(vUv.y - 0.5) * 2.0;  // 0 at center, 1 at edges
      float edgeSoft = smoothstep(1.0, 0.3, edgeDist);

      // Core glow — subtle bright line at the very center
      float coreGlow = smoothstep(0.35, 0.0, edgeDist) * 0.2;

      vec3 col = uColor * brightness * (0.7 + 0.3 * edgeSoft);
      col += uColor * coreGlow;

      // Alpha: solid center, fading edges for a cleaner look
      float alpha = uOpacity * smoothstep(1.0, 0.5, edgeDist);

      gl_FragColor = vec4(col, alpha);
    }
  `,
};
