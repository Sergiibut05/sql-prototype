import * as THREE from 'three';
import { GroundCrossesShader } from '../shaders/ground-crosses-shader';
import { C } from './er-constants';
import { ErDebugParams } from './er-debug-params';

/**
 * Manages the core Three.js scene: scene, camera, renderer, lights and ground plane.
 */
export class ErSceneManager {
    readonly scene: THREE.Scene;
    readonly camera: THREE.PerspectiveCamera;
    readonly renderer: THREE.WebGLRenderer;
    readonly groundUniforms: Record<string, THREE.IUniform>;
    readonly groundClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.2);

    constructor(canvas: HTMLCanvasElement, p: ErDebugParams) {
        const w = canvas.clientWidth || window.innerWidth;
        const h = canvas.clientHeight || window.innerHeight;

        // ── Scene ─────────────────────────────────────────────────────
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(C.bg);
        this.scene.fog = new THREE.FogExp2(C.bg, 0.0018);

        // ── Camera ────────────────────────────────────────────────────
        this.camera = new THREE.PerspectiveCamera(p.fov, w / h, 0.1, 5000);
        this.camera.position.set(0, p.camY, p.camZ);
        this.camera.lookAt(0, 0, 0);

        // ── Renderer ──────────────────────────────────────────────────
        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
        });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.1;
        this.renderer.localClippingEnabled = true;

        // ── Lights ────────────────────────────────────────────────────
        const ambient = new THREE.AmbientLight(0x8090c0, 0.7);
        this.scene.add(ambient);

        const hemi = new THREE.HemisphereLight(0x6070a0, 0x101828, 0.55);
        this.scene.add(hemi);

        const key = new THREE.DirectionalLight(0xc0c8ff, 1.4);
        key.position.set(80, 200, 100);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.near = 0.5;
        key.shadow.camera.far = 600;
        key.shadow.camera.left = -200;
        key.shadow.camera.right = 200;
        key.shadow.camera.top = 200;
        key.shadow.camera.bottom = -200;
        key.shadow.bias = -0.0005;
        this.scene.add(key);

        const fill = new THREE.DirectionalLight(0x7080c0, 0.5);
        fill.position.set(-60, 100, -80);
        this.scene.add(fill);

        const rim = new THREE.PointLight(0x4f46e5, 0.6, 400);
        rim.position.set(0, 60, -120);
        this.scene.add(rim);

        // ── Ground plane with crosses shader ──────────────────────────
        this.groundUniforms = THREE.UniformsUtils.clone(GroundCrossesShader.uniforms);
        this.groundUniforms['uCrossColor'].value.set(p.crossColor);
        this.groundUniforms['uBaseColor'].value.set(p.groundBase);
        this.groundUniforms['uFadeDistance'].value = p.crossFade;
        this.groundUniforms['uCrossDensity'].value = p.crossDensity;
        this.groundUniforms['uCrossSize'].value = p.crossSize;
        this.groundUniforms['uCrossOpacity'].value = p.crossOpacity;
        this.groundUniforms['uReflStrength'].value = p.reflStrength;

        const groundMat = new THREE.ShaderMaterial({
            uniforms: this.groundUniforms,
            vertexShader: GroundCrossesShader.vertexShader,
            fragmentShader: GroundCrossesShader.fragmentShader,
            side: THREE.DoubleSide,
        });
        const groundGeo = new THREE.PlaneGeometry(3000, 3000);
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.15;
        ground.receiveShadow = true;
        this.scene.add(ground);
    }

    /** Advance the ground shader time each frame. */
    updateGroundTime(dt: number): void {
        if (this.groundUniforms['uTime']) {
            this.groundUniforms['uTime'].value += dt;
        }
    }

    /** Handle canvas resize. */
    resize(w: number, h: number): void {
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    dispose(): void {
        this.renderer.dispose();
    }
}
