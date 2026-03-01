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
 *
 * uPulse (0..1) drives an energy pulse wavefront along the cable
 * when it first appears during reveal — a bright flash that travels
 * from source to target.
 */
export const CableShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0x34d399) },       // base cable color
    uStripeCount: { value: 6.0 },                        // number of stripe cycles visible
    uStripeContrast: { value: 0.38 },                    // difference between light/dark bands
    uSpeed: { value: 1.2 },                               // scroll speed
    uOpacity: { value: 0.92 },
    uPulse: { value: -1.0 },                              // -1 = no pulse, 0..1 = pulse position
  },

  vertexShader: /* glsl */ `
    attribute float aProgress;
    varying vec2 vUv;
    varying float vProgress;

    void main() {
      vUv = uv;
      vProgress = aProgress;
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
    uniform float uPulse;

    varying vec2 vUv;
    varying float vProgress; // 0.0 at source, 1.0 at target

    void main() {
      // Normalised distance from center (0 = middle, 1 = edge)
      float dist = abs(vUv.y - 0.5) * 2.0;
      
      // 1. Core Line: Bright inner core
      float coreThickness = 0.25;
      float coreMask = smoothstep(coreThickness, 0.0, dist);
      
      // 2. Aura: Outer smooth glow (anti-aliased fade)
      float auraMask = smoothstep(1.0, 0.0, dist);
      
      // -- Coloring --
      vec3 coreColor = mix(uColor, vec3(1.0), 0.7); // Bright white-ish center
      vec3 glowColor = uColor * 0.8;                // Base cable color
      
      vec3 finalCol = glowColor * auraMask;
      finalCol += coreColor * coreMask;
      
      // 3. Subtle Flowing Energy
      // Uses sine wave instead of sharp fract so there are no cuts or sudden changes
      float phase = sin(vUv.x * uStripeCount * 0.5 - uTime * uSpeed) * 0.5 + 0.5;
      finalCol += mix(uColor, vec3(1.0), 0.5) * phase * auraMask * 0.8;

      // 4. Target Connection Glow
      // Exponential glow that gets extremely bright precisely at the endpoint (vProgress = 1.0)
      float targetGlow = smoothstep(0.9, 1.0, vProgress) * exp((vProgress - 1.0) * 15.0);
      finalCol += vec3(0.95, 0.98, 1.0) * targetGlow * 3.0 * auraMask;

      // 5. Connection Pulse (Static burst traveling the whole length during load)
      if (uPulse >= 0.0) {
        float pulseDist = abs(vUv.x - uPulse);
        float pulseGlow = exp(-pulseDist * 3.0);
        finalCol += vec3(1.0) * pulseGlow * auraMask * 1.5;
      }
      
      float finalAlpha = uOpacity * auraMask;

      gl_FragColor = vec4(finalCol, finalAlpha);
    }
  `,
};
