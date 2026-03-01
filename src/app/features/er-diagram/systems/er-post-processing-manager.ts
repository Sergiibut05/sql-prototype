import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { VignetteShader } from '../shaders/vignette-shader';
import { ErDebugParams } from './er-debug-params';

/**
 * Manages the EffectComposer pipeline: Bloom + Vignette + OutputPass.
 */
export class ErPostProcessingManager {
    readonly composer: EffectComposer;
    readonly bloomPass: UnrealBloomPass;
    readonly vignettePass: ShaderPass;

    constructor(
        renderer: THREE.WebGLRenderer,
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        p: ErDebugParams,
    ) {
        const w = renderer.domElement.width;
        const h = renderer.domElement.height;

        // Create a multi-sampled render target to keep MSAA (Anti-Aliasing) 
        // when using the EffectComposer, preventing jagged diagonal cable lines.
        const renderTarget = new THREE.WebGLRenderTarget(w, h, {
            samples: Math.min(renderer.capabilities.maxSamples, 4), // 4x MSAA is perfect for most devices
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
        });

        this.composer = new EffectComposer(renderer, renderTarget);
        this.composer.addPass(new RenderPass(scene, camera));

        // Bloom — subtle glow on emissive surfaces (headers, cables, edges)
        this.bloomPass = new UnrealBloomPass(
            new THREE.Vector2(w, h),
            p.bloomStrength,
            p.bloomRadius,
            p.bloomThreshold,
        );
        this.composer.addPass(this.bloomPass);

        // Vignette
        this.vignettePass = new ShaderPass({
            uniforms: THREE.UniformsUtils.clone(VignetteShader.uniforms),
            vertexShader: VignetteShader.vertexShader,
            fragmentShader: VignetteShader.fragmentShader,
        });
        this.vignettePass.uniforms['uIntensity'].value = p.vigInt;
        this.vignettePass.uniforms['uSoftness'].value = p.vigSoft;
        this.composer.addPass(this.vignettePass);

        // Output pass (tone-mapping / color-space)
        this.composer.addPass(new OutputPass());
    }

    render(): void {
        this.composer.render();
    }

    resize(w: number, h: number): void {
        this.composer.setSize(w, h);
    }

    dispose(): void {
        this.composer.dispose();
    }
}
