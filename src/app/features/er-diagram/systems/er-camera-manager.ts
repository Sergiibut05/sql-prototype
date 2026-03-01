import * as THREE from 'three';
import ThreeForceGraph from 'three-forcegraph';
import { NODE_WIDTH } from './er-constants';
import { ErDebugParams } from './er-debug-params';

/**
 * Manages smooth camera movement — interpolating position and look-at target
 * each frame, and computing an auto-fit camera position from graph bounds.
 */
export class ErCameraManager {
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
    update(dt: number, phase: string): void {
        const targetSpeed = phase !== 'idle' ? 0.5 : this.cameraLerpSpeed;
        this.currentCameraSpeed += (targetSpeed - this.currentCameraSpeed) * Math.min(dt * 0.8, 1.0);

        const lerpFactor = 1.0 - Math.exp(-this.currentCameraSpeed * dt);
        this.camera.position.lerp(this.cameraTarget, lerpFactor);

        const lookLerpFactor = 1.0 - Math.exp(-Math.min(this.currentCameraSpeed, 1.0) * dt);
        this.cameraLookCurrent.lerp(this.cameraLookTarget, lookLerpFactor);
        this.camera.lookAt(this.cameraLookCurrent);
    }

    /** Set camera target from manual GUI sliders. */
    setCameraTargetFromParams(): void {
        this.cameraTarget.set(0, this.p.camY, this.p.camZ);
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
        const span = Math.max(spanX, spanY, 80);
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const dist = span / (2 * Math.tan(fovRad / 2));

        this.p.camY = dist * 0.8 + 30;
        this.p.camZ = dist * 0.45 + 25;
        this.cameraTarget.set(centerX, this.p.camY, this.p.camZ + centerY);
        this.cameraLookTarget.set(centerX, 0, centerY);
    }
}
