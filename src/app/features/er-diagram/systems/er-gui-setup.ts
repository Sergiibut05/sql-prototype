import * as THREE from 'three';
import ThreeForceGraph from 'three-forcegraph';
import GUI from 'lil-gui';
import { ErDebugParams } from './er-debug-params';
import { ErSceneManager } from './er-scene-manager';
import { ErPostProcessingManager } from './er-post-processing-manager';
import { ErTableRenderer } from './er-table-renderer';
import { ErLinkRenderer } from './er-link-renderer';
import { ErCameraManager } from './er-camera-manager';
import { ErParticleSystem } from './er-particle-system';

/**
 * Builds the lil-gui debug panel and wires all onChange callbacks.
 * The GUI is created hidden; the host component toggles its visibility.
 */
export function setupGUI(
    p: ErDebugParams,
    scene: ErSceneManager,
    postFx: ErPostProcessingManager,
    tableRenderer: ErTableRenderer,
    linkRenderer: ErLinkRenderer,
    cameraManager: ErCameraManager,
    particles: ErParticleSystem,
    graph: ThreeForceGraph,
): GUI {
    const gui = new GUI({ title: 'ER Diagram Debug', width: 300 });
    gui.domElement.style.zIndex = '100';

    // ── Camera ────────────────────────────────────────────────────────────────
    const cam = gui.addFolder('Camera');
    cam.add(p, 'camY', 50, 500, 1).onChange(() => cameraManager.setCameraTargetFromParams());
    cam.add(p, 'camZ', 0, 400, 1).onChange(() => cameraManager.setCameraTargetFromParams());
    cam.add(p, 'fov', 20, 90, 1).onChange(() => {
        (scene.camera as any).fov = p.fov;
        scene.camera.updateProjectionMatrix();
    });
    cam.add(p, 'cameraLerpSpeed', 0.3, 8, 0.1).name('Lerp Speed').onChange(() => {
        cameraManager.cameraLerpSpeed = p.cameraLerpSpeed;
    });

    // ── Layout ────────────────────────────────────────────────────────────────
    const layout = gui.addFolder('Layout');
    layout.add(p, 'collideRadius', 10, 80, 1);
    layout.add(p, 'chargeStr', -200, 0, 1).name('Repulsion').onChange(() => {
        (graph as any).d3Force('charge')?.strength(p.chargeStr);
        (graph as any).d3ReheatSimulation?.();
    });
    layout.add(p, 'linkDist', 10, 120, 1).name('Link Distance').onChange(() => {
        const lf = (graph as any).d3Force('link');
        if (lf) lf.distance(p.linkDist);
        (graph as any).d3ReheatSimulation?.();
    });
    layout.add(p, 'linkHeight', 0, 8, 0.1);

    // ── Cable ─────────────────────────────────────────────────────────────────
    const cable = gui.addFolder('Cable');
    cable.addColor(p, 'cableColor').name('Color').onChange(() => {
        // Each cable has its own uColor; update all
        (graph as THREE.Object3D).traverse((child: any) => {
            if (child.isMesh && child.material && (child.material as any).__isCable) {
                (child.material as THREE.ShaderMaterial).uniforms['uColor'].value.set(p.cableColor);
            }
        });
    });
    cable.add(p, 'cableSpeed', 0, 5, 0.1).name('Speed').onChange(() => {
        linkRenderer.cableUniforms['uSpeed'].value = p.cableSpeed;
    });
    cable.add(p, 'cableStripes', 2, 60, 1).name('Stripes').onChange(() => {
        linkRenderer.cableUniforms['uStripeCount'].value = p.cableStripes;
    });
    cable.add(p, 'cableContrast', 0, 1, 0.01).name('Contrast').onChange(() => {
        linkRenderer.cableUniforms['uStripeContrast'].value = p.cableContrast;
    });

    // ── Vignette ──────────────────────────────────────────────────────────────
    const vig = gui.addFolder('Vignette');
    vig.add(p, 'vigInt', 0, 1, 0.01).onChange(() => {
        postFx.vignettePass.uniforms['uIntensity'].value = p.vigInt;
    });
    vig.add(p, 'vigSoft', 0, 1, 0.01).onChange(() => {
        postFx.vignettePass.uniforms['uSoftness'].value = p.vigSoft;
    });

    // ── Ground ────────────────────────────────────────────────────────────────
    const gnd = gui.addFolder('Ground');
    gnd.add(p, 'crossDensity', 0.01, 0.2, 0.001).onChange(() => {
        scene.groundUniforms['uCrossDensity'].value = p.crossDensity;
    });
    gnd.add(p, 'crossSize', 0.001, 0.05, 0.001).onChange(() => {
        scene.groundUniforms['uCrossSize'].value = p.crossSize;
    });
    gnd.add(p, 'crossFade', 100, 2000, 10).onChange(() => {
        scene.groundUniforms['uFadeDistance'].value = p.crossFade;
    });
    gnd.add(p, 'crossOpacity', 0.1, 1.5, 0.01).name('Cross Opacity').onChange(() => {
        scene.groundUniforms['uCrossOpacity'].value = p.crossOpacity;
    });
    gnd.addColor(p, 'crossColor').name('Cross Color').onChange(() => {
        scene.groundUniforms['uCrossColor'].value.set(p.crossColor);
    });
    gnd.addColor(p, 'groundBase').name('Base Color').onChange(() => {
        scene.groundUniforms['uBaseColor'].value.set(p.groundBase);
    });
    gnd.add(p, 'reflStrength', 0, 1.5, 0.01).name('Reflection').onChange(() => {
        scene.groundUniforms['uReflStrength'].value = p.reflStrength;
    });

    // ── Table colors ──────────────────────────────────────────────────────────
    const tbl = gui.addFolder('Table Colors');
    tbl.addColor(p, 'tableEdge').name('Edge & Sides Glow').onChange(() => {
        for (const m of tableRenderer.tableMaterials.edges) {
            m.color.set(p.tableEdge);
            m.emissive.set(p.tableEdge);
        }
    });
    tbl.addColor(p, 'headerStart').name('Header Start').onChange(() => {
        tableRenderer.rebuildAllTableTextures(graph as any);
    });
    tbl.addColor(p, 'headerEnd').name('Header End').onChange(() => {
        tableRenderer.rebuildAllTableTextures(graph as any);
    });

    // ── Bloom ─────────────────────────────────────────────────────────────────
    const bloom = gui.addFolder('Bloom');
    bloom.add(p, 'bloomStrength', 0, 2, 0.01).name('Strength').onChange(() => {
        postFx.bloomPass.strength = p.bloomStrength;
    });
    bloom.add(p, 'bloomRadius', 0, 2, 0.01).name('Radius').onChange(() => {
        postFx.bloomPass.radius = p.bloomRadius;
    });
    bloom.add(p, 'bloomThreshold', 0, 2, 0.01).name('Threshold').onChange(() => {
        postFx.bloomPass.threshold = p.bloomThreshold;
    });

    // ── Particles ─────────────────────────────────────────────────────────────
    const part = gui.addFolder('Particles');
    part.add(p, 'particleSize', 0.1, 5, 0.1).name('Size').onChange(() => {
        (particles.points.material as THREE.PointsMaterial).size = p.particleSize;
    });
    part.add(p, 'particleOpacity', 0, 1, 0.01).name('Opacity').onChange(() => {
        (particles.points.material as THREE.PointsMaterial).opacity = p.particleOpacity;
    });

    // ── Hover ─────────────────────────────────────────────────────────────────
    const hover = gui.addFolder('Hover');
    hover.add(p, 'hoverElevation', 0, 10, 0.5).name('Elevation');

    // ── Parser ────────────────────────────────────────────────────────────────
    // (The actual re-parse callback is wired by the component after GUI creation)
    gui.addFolder('Parser'); // placeholder — component adds the control

    gui.hide();
    return gui;
}
