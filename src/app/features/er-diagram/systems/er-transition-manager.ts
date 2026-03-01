import * as THREE from 'three';
import ThreeForceGraph from 'three-forcegraph';
import { GraphData } from '../../../shared/models/graph.model';
import {
    TRANSITION_SINK_DURATION, SETTLING_DURATION, SINK_DEPTH,
    REVEAL_DURATION, REVEAL_Z_AMPLITUDE, NODE_WIDTH,
} from './er-constants';
import { ErDebugParams } from './er-debug-params';
import { ErTableRenderer } from './er-table-renderer';
import { ErCameraManager } from './er-camera-manager';
import { ErLinkRenderer } from './er-link-renderer';

export type TransitionPhase = 'idle' | 'sinking' | 'settling' | 'revealing';

/**
 * Owns the full "sink → settle → reveal" state machine that fires every time
 * new SQL is parsed and a new graph layout needs to be displayed.
 *
 * Bruno Simon folio-2019 style reveal:
 *   nodes near the layout center appear first (lower distance → higher reveal
 *   progress at any given global time), creating a smooth wave effect.
 */
export class ErTransitionManager {
    phase: TransitionPhase = 'idle';
    timer = 0;
    pendingData: GraphData | null = null;
    revealProgress = 1;  // 0 = all hidden, 1 = fully revealed
    revealCenter = { x: 0, y: 0 };
    revealMaxDist = 1;

    private readonly nodeBasePositions = new Map<string, { x: number; y: number }>();

    constructor(
        private readonly graph: ThreeForceGraph,
        private readonly tableRenderer: ErTableRenderer,
        private readonly linkRenderer: ErLinkRenderer,
        private readonly cameraManager: ErCameraManager,
        private readonly p: ErDebugParams,
    ) { }

    // ──────────────────────────────────────────────────────────────────────────
    //  Public API called by the component
    // ──────────────────────────────────────────────────────────────────────────

    handleStepTransition(data: GraphData): void {
        const currentData = (this.graph as any).graphData();
        const hasExistingNodes = currentData?.nodes?.length > 0;

        if (!hasExistingNodes || this.phase !== 'idle') {
            this.pendingData = data;
            if (this.phase !== 'idle') return; // already transitioning — just update pending

            // First load — position graph below ground, apply data, wait to settle, then reveal
            this.graph.position.y = SINK_DEPTH;
            this.applyNewData(data);
            this.pendingData = null;
            this.phase = 'settling';
            this.timer = 0;
            return;
        }

        // Normal transition: sink current tables, then swap data and reveal
        this.pendingData = data;
        this.phase = 'sinking';
        this.timer = 0;
    }

    /** Called every frame from the animate loop — drives the state machine. */
    update(dt: number): void {
        if (this.phase === 'idle') return;
        this.timer += dt;

        switch (this.phase) {
            case 'sinking': this.updateSinking(); break;
            case 'settling': this.updateSettling(); break;
            case 'revealing': this.updateRevealing(dt); break;
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Phase handlers
    // ──────────────────────────────────────────────────────────────────────────

    private updateSinking(): void {
        const t = Math.min(this.timer / TRANSITION_SINK_DURATION, 1);
        const ease = this.easeInQuad(t);

        this.graph.position.y = SINK_DEPTH * ease;
        this.setAllLinksOpacity(1 - ease);
        // Turn off the connection-point pulse as cables sink — will be re-enabled on reveal
        this.setCablePulse(-1);

        if (t >= 1) {
            if (this.pendingData) {
                this.applyNewData(this.pendingData);
                this.pendingData = null;
            }
            this.phase = 'settling';
            this.timer = 0;
        }
    }

    private updateSettling(): void {
        // Graph stays at SINK_DEPTH — invisible. tickFrame() runs in animate() so
        // the d3 simulation positions nodes and THREE wrappers get synced.
        this.graph.position.y = SINK_DEPTH;

        if (this.timer >= SETTLING_DURATION) {
            this.prepareReveal();
        }
    }

    private updateRevealing(dt: number): void {
        this.revealProgress = Math.min(this.timer / REVEAL_DURATION, 1);
        this.updateRevealPerNode();

        // Cables fade in later — avoids cables appearing alone before nodes are visible
        const cableFadeT = Math.max(0, (this.revealProgress - 0.5) / 0.5);
        this.setAllLinksOpacity(this.easeOutCubic(cableFadeT));

        // Energy pulse: static bloom flash at the cable source end (UV = 0.0).
        // Stays permanently ON — the connection-point glow is part of the idle visual.
        // Only turned off when cables sink for the next transition (see updateSinking).
        if (cableFadeT > 0) {
            this.setCablePulse(0.0);   // glow at UV=0 (where cable meets source table)
        }

        if (this.revealProgress >= 1) {
            this.finalizeReveal();
            this.setAllLinksOpacity(1);
            this.setCablePulse(0.0);   // keep glow ON permanently in idle phase
            this.phase = 'idle';
            this.timer = 0;
            // NOTE: Do NOT clear routingCache here — stable routing must persist through idle.
            // It will be cleared by applyNewData() when the next step arrives.
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Helpers
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Apply new graph data. Graph must be at SINK_DEPTH (invisible) before calling.
     */
    private applyNewData(data: GraphData): void {
        this.tableRenderer.reset();
        this.linkRenderer.clearRoutingCache();
        this.nodeBasePositions.clear();

        // graphData() runs warmupTicks(80) synchronously → d3 gives nodes x,y.
        // createTableNode callback fills nodeThreeObjects.
        // The graph group is at SINK_DEPTH so everything is clipped by the ground
        // plane — completely invisible.
        (this.graph as any).graphData({ nodes: data.nodes, links: data.links });
    }

    /**
     * Called at the end of the settling phase.
     * Positions are now stable. Freeze d3, prepare nodes for the wave reveal and
     * bring the graph group back to y = 0.
     */
    private prepareReveal(): void {
        // Freeze d3 simulation — prevents jitter during and after reveal
        const gData = (this.graph as any).graphData();
        if (gData?.nodes) {
            for (const n of gData.nodes) {
                if (n.x != null && n.y != null) {
                    n.fx = n.x; n.fy = n.y;
                    n.vx = 0; n.vy = 0;
                    this.nodeBasePositions.set(n.id, { x: n.x, y: n.y });
                }
            }
        }

        this.cameraManager.computeCameraTarget(this.graph);
        this.recomputeRevealCenter();

        // Displace all nodes below ground so they can wave up during reveal
        for (const [, obj] of this.tableRenderer.nodeThreeObjects) {
            obj.position.z = -REVEAL_Z_AMPLITUDE;
        }
        this.setAllLinksOpacity(0);

        // Bring graph to ground level — nodes are hidden by z offset
        this.graph.position.y = 0;
        this.graph.scale.set(1, 1, 1);

        this.phase = 'revealing';
        this.timer = 0;
        this.revealProgress = 0;
    }

    private recomputeRevealCenter(): void {
        const gData = (this.graph as any).graphData();
        if (!gData?.nodes?.length) return;

        let sumX = 0, sumY = 0, count = 0;
        for (const n of gData.nodes) {
            if (n.x != null && n.y != null) { sumX += n.x; sumY += n.y; count++; }
        }
        if (count === 0) return;

        this.revealCenter = { x: sumX / count, y: sumY / count };

        let maxDist = 1;
        for (const n of gData.nodes) {
            if (n.x != null && n.y != null) {
                const dx = n.x - this.revealCenter.x;
                const dy = n.y - this.revealCenter.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d > maxDist) maxDist = d;
            }
        }
        this.revealMaxDist = maxDist;
    }

    /**
     * Bruno Simon folio-2019 per-node Z displacement.
     * Nodes closer to the layout center reveal before outer nodes,
     * creating a smooth radial wave.
     */
    private updateRevealPerNode(): void {
        const gData = (this.graph as any).graphData();
        if (!gData?.nodes) return;

        const adaptiveMultiplier = this.revealMaxDist > 1
            ? Math.max(3.0, Math.min(8.0, 80.0 / this.revealMaxDist))
            : 5.0;

        for (const n of gData.nodes) {
            if (n.x == null || n.y == null) continue;
            const nodeObj = this.tableRenderer.nodeThreeObjects.get(n.id);
            if (!nodeObj) continue;

            const dx = n.x - this.revealCenter.x;
            const dy = n.y - this.revealCenter.y;
            const distToCenter = Math.sqrt(dx * dx + dy * dy);
            const normalizedDist = this.revealMaxDist > 1 ? distToCenter / this.revealMaxDist : 0;

            let nodeReveal = (this.revealProgress - normalizedDist * 0.4) * adaptiveMultiplier;
            nodeReveal = Math.max(0, Math.min(1, nodeReveal));
            nodeReveal = 1.0 - Math.pow(1.0 - nodeReveal, 3); // easeOutCubic per node

            if (this.revealProgress > 0.95) nodeReveal = 1.0;

            nodeObj.position.z = -REVEAL_Z_AMPLITUDE * (1.0 - nodeReveal);
        }
    }

    private finalizeReveal(): void {
        for (const [, obj] of this.tableRenderer.nodeThreeObjects) {
            obj.position.z = 0;
        }
    }

    private setAllLinksOpacity(opacity: number): void {
        this.graph.traverse((child: any) => {
            if (child.isMesh && child.material && (child.material as any).__isCable) {
                (child.material as THREE.ShaderMaterial).uniforms['uOpacity'].value = opacity;
            }
        });
    }

    private setCablePulse(pulse: number): void {
        this.graph.traverse((child: any) => {
            if (child.isMesh && child.material && (child.material as any).__isCable) {
                const mat = child.material as THREE.ShaderMaterial;
                if (mat.uniforms['uPulse']) mat.uniforms['uPulse'].value = pulse;
            }
        });
    }

    // ── Easing functions ──────────────────────────────────────────────────────
    private easeInQuad(t: number): number { return t * t; }
    private easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }
}
