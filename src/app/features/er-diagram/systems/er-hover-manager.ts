import * as THREE from 'three';
import ThreeForceGraph from 'three-forcegraph';
import { ErDebugParams } from './er-debug-params';
import { TransitionPhase } from './er-transition-manager';

/**
 * Handles interactive hover over table nodes:
 * – raycasting to find the hovered node
 * – smooth Z-elevation animation for the hovered node
 * – dimming non-connected cables and highlighting connected ones
 */
export class ErHoverManager {
    readonly mouse = new THREE.Vector2(-999, -999);
    hoveredNodeId: string | null = null;

    private readonly raycaster = new THREE.Raycaster();
    private readonly hoverElevation = new Map<string, number>();

    constructor(
        private readonly graph: ThreeForceGraph,
        private readonly camera: THREE.PerspectiveCamera,
        private readonly nodeThreeObjects: Map<string, THREE.Object3D>,
        private readonly p: ErDebugParams,
        private readonly getPhase: () => TransitionPhase,
    ) { }

    /** Called every frame from the animate loop. */
    update(dt: number): void {
        this.raycaster.setFromCamera(this.mouse, this.camera);

        // ── Raycast to find hovered node ────────────────────────────────────────
        let newHoveredId: string | null = null;
        const gData = (this.graph as any).graphData?.();
        if (gData?.nodes?.length && this.getPhase() === 'idle') {
            const intersects = this.raycaster.intersectObjects(
                (this.graph as THREE.Object3D).children, true,
            );
            for (const hit of intersects) {
                let obj: THREE.Object3D | null = hit.object;
                while (obj) {
                    if ((obj as any).__nodeId) { newHoveredId = (obj as any).__nodeId; break; }
                    obj = obj.parent;
                }
                if (newHoveredId) break;
            }
        }

        this.hoveredNodeId = newHoveredId;

        // ── Smooth elevation animation ───────────────────────────────────────────
        for (const [nodeId, nodeObj] of this.nodeThreeObjects) {
            const targetElev = nodeId === this.hoveredNodeId ? this.p.hoverElevation : 0;
            const currentElev = this.hoverElevation.get(nodeId) || 0;
            const newElev = currentElev + (targetElev - currentElev) * Math.min(dt * 8, 1);
            this.hoverElevation.set(nodeId, newElev);

            if (this.getPhase() === 'idle') {
                nodeObj.position.z = newElev;
            }
        }

        // ── Cable highlight ──────────────────────────────────────────────────────
        if (this.getPhase() !== 'idle') return;

        if (this.hoveredNodeId) {
            this.graph.traverse((child: any) => {
                if (!child.isMesh || !child.material || !(child.material as any).__isCable) return;
                const mat = child.material as THREE.ShaderMaterial;
                const linkData = (child.parent as any)?.__data;
                const isConnected = linkData && (
                    (linkData.source?.id || linkData.source) === this.hoveredNodeId ||
                    (linkData.target?.id || linkData.target) === this.hoveredNodeId
                );

                const targetOpacity = isConnected ? 1.0 : 0.15; // slightly dimmer for non-connected
                mat.uniforms['uOpacity'].value += (targetOpacity - mat.uniforms['uOpacity'].value) * Math.min(dt * 12, 1);
            });
        } else {
            // Smoothly reset all cables to full opacity when nothing is hovered
            this.graph.traverse((child: any) => {
                if (child.isMesh && child.material && (child.material as any).__isCable) {
                    const mat = child.material as THREE.ShaderMaterial;
                    const targetOpacity = 0.92;
                    mat.uniforms['uOpacity'].value += (targetOpacity - mat.uniforms['uOpacity'].value) * Math.min(dt * 12, 1);
                }
            });
        }
    }
}
