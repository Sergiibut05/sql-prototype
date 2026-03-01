import * as THREE from 'three';
import ThreeForceGraph from 'three-forcegraph';
import { NODE_WIDTH } from './er-constants';
import { ErDebugParams } from './er-debug-params';

/**
 * Manages smooth camera movement — interpolating position and look-at target
 * each frame, and computing an auto-fit camera position from graph bounds.
 */
export class ErCameraManager {
    readonly baseCameraTarget = new THREE.Vector3(0, 200, 160);
    readonly cameraTarget = new THREE.Vector3(0, 200, 160);
    readonly cameraLookTarget = new THREE.Vector3(0, 0, 0);
    readonly cameraLookCurrent = new THREE.Vector3(0, 0, 0);

    cameraLerpSpeed = 1.8;
    currentCameraSpeed = 1.8; // smoothed — avoids jerk when transition ends

    constructor(
        private readonly camera: THREE.PerspectiveCamera,
        private readonly p: ErDebugParams,
    ) { }

    /**
     * Advance camera lerp each frame.
     * @param phase Current transition phase — camera moves slower during transitions.
     */
    update(dt: number, elapsed: number, phase: string): void {
        const targetSpeed = phase !== 'idle' ? 0.5 : this.cameraLerpSpeed;
        this.currentCameraSpeed += (targetSpeed - this.currentCameraSpeed) * Math.min(dt * 0.8, 1.0);

        // ── Cinematic slow orbit ─────────────────────────────────────────────
        // Adds continuous, smooth floating movement around the diagram.
        const rX = 35;  // Horizontal drift amplitude
        const rZ = 15;  // Depth drift amplitude
        const rY = 5;   // Vertical bobbing amplitude
        const s = 0.12; // Orbit speed

        this.cameraTarget.x = this.baseCameraTarget.x + Math.sin(elapsed * s) * rX;
        this.cameraTarget.z = this.baseCameraTarget.z + Math.cos(elapsed * s * 0.8) * rZ;
        this.cameraTarget.y = this.baseCameraTarget.y + Math.sin(elapsed * s * 0.5) * rY;

        const lerpFactor = 1.0 - Math.exp(-this.currentCameraSpeed * dt);
        this.camera.position.lerp(this.cameraTarget, lerpFactor);

        const lookLerpFactor = 1.0 - Math.exp(-Math.min(this.currentCameraSpeed, 1.0) * dt);
        this.cameraLookCurrent.lerp(this.cameraLookTarget, lookLerpFactor);
        this.camera.lookAt(this.cameraLookCurrent);
    }

    /** Set camera target from manual GUI sliders. */
    setCameraTargetFromParams(): void {
        this.baseCameraTarget.set(0, this.p.camY, this.p.camZ);
    }

    /**
     * Auto-fit the camera to frame all nodes in the graph.
     * Called at the end of the settling phase so positions are stable.
     */
    computeCameraTarget(graph: ThreeForceGraph): void {
        const data = (graph as any).graphData();
        if (!data?.nodes?.length) return;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const n of data.nodes) {
            if (n.x != null) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); }
            if (n.y != null) { minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
        }
        if (!isFinite(minX)) return;

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const spanX = maxX - minX + NODE_WIDTH * 2;
        const spanY = maxY - minY + 40;
        // Boost minimum span slightly to prevent extreme wide-angle distortion, but keep it close
        const span = Math.max(spanX, spanY, 100);
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const dist = span / (2 * Math.tan(fovRad / 2));

        // Flatter camera angle emphasizes 3D thickness, but pulled in closer
        this.p.camY = dist * 0.70 + 15;
        this.p.camZ = dist * 0.45 + 15;
        this.baseCameraTarget.set(centerX, this.p.camY, this.p.camZ + centerY);
        this.cameraLookTarget.set(centerX, 0, centerY);
    }
}
