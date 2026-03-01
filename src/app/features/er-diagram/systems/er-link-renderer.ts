import * as THREE from 'three';
import { CableShader } from '../shaders/cable-shader';
import {
    NODE_WIDTH, MAX_LINE_PTS, CABLE_WIDTH, CABLE_STRIPE_WORLD_SCALE, C,
} from './er-constants';
import { ErDebugParams } from './er-debug-params';

/**
 * Responsible for creating and updating the flat ribbon cable meshes that
 * represent FK/JOIN relationships between table nodes.
 *
 * Cable geometry uses orthogonal routing (Manhattan-style) and the animated
 * CableShader for the scrolling-stripe effect.
 */
export class ErLinkRenderer {
    /** Stable routing cache — prevents cables from flipping sides during reveal. */
    readonly routingCache = new Map<string, 'left' | 'right'>();

    /** Shared `uTime` uniform — must be advanced each frame by the owner. */
    readonly cableUniforms: Record<string, THREE.IUniform>;

    constructor(
        private readonly groundClipPlane: THREE.Plane,
        private readonly nodeColumnOffsets: Map<string, Map<string, number>>,
        private readonly nodeDimensions: Map<string, { w: number; h: number }>,
        private readonly p: ErDebugParams,
    ) {
        this.cableUniforms = THREE.UniformsUtils.clone(CableShader.uniforms);
        this.cableUniforms['uColor'].value.set(p.cableColor);
        this.cableUniforms['uSpeed'].value = p.cableSpeed;
        this.cableUniforms['uStripeCount'].value = p.cableStripes;
        this.cableUniforms['uStripeContrast'].value = p.cableContrast;
    }

    /** Advance the shared cable time uniform each frame. */
    updateTime(dt: number): void {
        if (this.cableUniforms['uTime']) {
            this.cableUniforms['uTime'].value += dt;
        }
    }

    clearRoutingCache(): void {
        this.routingCache.clear();
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  ThreeForceGraph callbacks
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Creates a flat ribbon mesh for each link.
     * UVs: U runs along the length (0→1), V across the width (0→1).
     */
    createLinkLine(link: any): THREE.Object3D {
        const group = new THREE.Group();
        const segCount = MAX_LINE_PTS - 1;

        // PlaneGeometry is just a placeholder — positions are overridden each frame
        const geo = new THREE.PlaneGeometry(1, CABLE_WIDTH, segCount, 1);
        geo.setAttribute('position', new THREE.Float32BufferAttribute(
            new Float32Array((segCount + 1) * 2 * 3), 3,
        ));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(
            new Float32Array((segCount + 1) * 2 * 2), 2,
        ));

        const indices: number[] = [];
        for (let i = 0; i < segCount; i++) {
            const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
            indices.push(a, c, b, b, c, d);
        }
        geo.setIndex(indices);

        const color = this.getLinkColor(link);
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uTime: this.cableUniforms['uTime'],
                uColor: { value: new THREE.Color(color) },
                uStripeCount: this.cableUniforms['uStripeCount'],
                uStripeContrast: this.cableUniforms['uStripeContrast'],
                uSpeed: this.cableUniforms['uSpeed'],
                uOpacity: { value: 0.92 },
                uPulse: { value: -1.0 },
            },
            vertexShader: CableShader.vertexShader,
            fragmentShader: CableShader.fragmentShader,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false, // don't write depth — tables already wrote theirs
            depthTest: true,   // DO test depth — cables hide behind tables
            clippingPlanes: [this.groundClipPlane],
        });
        (mat as any).__isCable = true;

        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 10; // render AFTER tables (at renderOrder 1)
        mesh.frustumCulled = false;
        group.add(mesh);

        (group as any).__cableMaterial = mat;
        return group;
    }

    /**
     * Called every frame by ThreeForceGraph to reposition the cable ribbon.
     * Returns true to indicate we handle the update ourselves.
     */
    updateLinkLine(
        obj: THREE.Group,
        coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
        link: any,
    ): boolean {
        const { start, end } = coords;
        if (isNaN(start.x) || isNaN(end.x)) return true;

        let sy = start.y, ty = end.y;
        const sx = start.x, tx = end.x;

        const srcId = typeof link.source === 'object' ? link.source.id : link.source;
        const tgtId = typeof link.target === 'object' ? link.target.id : link.target;

        if (link.sourceColumn) {
            const off = this.nodeColumnOffsets.get(srcId);
            if (off?.has(link.sourceColumn)) sy += off.get(link.sourceColumn)!;
        }
        if (link.targetColumn) {
            const off = this.nodeColumnOffsets.get(tgtId);
            if (off?.has(link.targetColumn)) ty += off.get(link.targetColumn)!;
        }

        const z = this.p.linkHeight;
        const orthoWaypoints = this.buildOrthogonalPath(sx, sy, tx, ty, srcId, tgtId, z);
        const waypoints = this.smoothWaypoints(orthoWaypoints, 5); // smoothly round the corners

        // ── Update ribbon mesh ─────────────────────────────────────────────────
        const mesh = obj.children[0] as THREE.Mesh;
        if (!mesh) return true;

        const totalPts = waypoints.length;
        if (totalPts < 2) return true;

        // Total path length for UV mapping
        let totalLength = 0;
        const segLengths: number[] = [0];
        for (let i = 1; i < totalPts; i++) {
            const d = waypoints[i].distanceTo(waypoints[i - 1]);
            totalLength += d;
            segLengths.push(totalLength);
        }
        if (totalLength < 0.01) totalLength = 1;

        // Pre-compute continuous perpendiculars for smooth ribbon joints
        const halfW = CABLE_WIDTH / 2;
        const perps: THREE.Vector3[] = [];

        for (let i = 0; i < totalPts; i++) {
            let dir: THREE.Vector3;
            if (i === 0) {
                dir = new THREE.Vector3().subVectors(waypoints[1], waypoints[0]).normalize();
            } else if (i === totalPts - 1) {
                dir = new THREE.Vector3().subVectors(waypoints[totalPts - 1], waypoints[totalPts - 2]).normalize();
            } else {
                // Average of incoming and outgoing tangents for a perfect miter joint
                const t1 = new THREE.Vector3().subVectors(waypoints[i], waypoints[i - 1]).normalize();
                const t2 = new THREE.Vector3().subVectors(waypoints[i + 1], waypoints[i]).normalize();
                dir = new THREE.Vector3().addVectors(t1, t2).normalize();
                if (dir.lengthSq() < 0.001) dir = t1; // fallback
            }

            // To maintain constant width through a miter joint, we divide by the dot product
            // but for gentle bezier curves, a standard normalised perpendicular is perfect.
            perps.push(new THREE.Vector3(-dir.y, dir.x, 0).normalize().multiplyScalar(halfW));
        }

        // Build ribbon vertices — single unified strip
        const positions: number[] = [];
        const uvs: number[] = [];
        const progresses: number[] = []; // Distance 0..1 along the cable

        const pushPair = (px: number, py: number, pz: number, perp: THREE.Vector3, u: number, progress: number) => {
            positions.push(px + perp.x, py + perp.y, pz);
            positions.push(px - perp.x, py - perp.y, pz);
            uvs.push(u, 0, u, 1);
            progresses.push(progress, progress);
        };

        for (let i = 0; i < totalPts; i++) {
            const u = segLengths[i] * CABLE_STRIPE_WORLD_SCALE;
            const progress = totalLength > 0 ? (segLengths[i] / totalLength) : 0;
            const p = waypoints[i];
            pushPair(p.x, p.y, p.z, perps[i], u, progress);
        }

        const posArr = new Float32Array(positions);
        const uvArr = new Float32Array(uvs);
        const pairCount = posArr.length / 6;

        // Triangle-strip index
        const newIndices: number[] = [];
        for (let i = 0; i < pairCount - 1; i++) {
            const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
            newIndices.push(a, c, b, b, c, d);
        }

        mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
        mesh.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
        mesh.geometry.setAttribute('aProgress', new THREE.Float32BufferAttribute(new Float32Array(progresses), 1));
        mesh.geometry.setIndex(newIndices);
        mesh.geometry.computeBoundingSphere();
        return true;
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Orthogonal routing
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Builds a Manhattan (right-angle) polyline between two table nodes.
     * Uses a hysteresis margin and a routing cache to prevent flickering when
     * nodes are near the X-overlap boundary.
     */
    buildOrthogonalPath(
        sx: number, sy: number,
        tx: number, ty: number,
        srcId: string, tgtId: string,
        z: number,
    ): THREE.Vector3[] {
        const srcDims = this.nodeDimensions.get(srcId) || { w: NODE_WIDTH, h: 15 };
        const tgtDims = this.nodeDimensions.get(tgtId) || { w: NODE_WIDTH, h: 15 };

        const srcHW = srcDims.w / 2;
        const tgtHW = tgtDims.w / 2;
        const dx = tx - sx;

        const srcRight = sx + srcHW, srcLeft = sx - srcHW;
        const tgtRight = tx + tgtHW, tgtLeft = tx - tgtHW;

        const OVERLAP_MARGIN = 3;
        const xOverlap = (srcRight - OVERLAP_MARGIN) > tgtLeft && (tgtRight - OVERLAP_MARGIN) > srcLeft;
        const linkKey = srcId < tgtId ? `${srcId}:${tgtId}` : `${tgtId}:${srcId}`;
        const cachedSide = this.routingCache.get(linkKey);

        let exitX: number, entryX: number, midX: number;

        if (!xOverlap && dx >= 0) {
            // Target is to the right
            if (cachedSide === 'left') {
                exitX = srcLeft; entryX = tgtRight;
            } else {
                exitX = srcRight; entryX = tgtLeft;
                this.routingCache.set(linkKey, 'right');
            }
            midX = (exitX + entryX) / 2;
        } else if (!xOverlap && dx < 0) {
            // Target is to the left
            if (cachedSide === 'right') {
                exitX = srcRight; entryX = tgtLeft;
            } else {
                exitX = srcLeft; entryX = tgtRight;
                this.routingCache.set(linkKey, 'left');
            }
            midX = (exitX + entryX) / 2;
        } else {
            // X-overlap — route around the outside
            const rightEdge = Math.max(srcRight, tgtRight);
            const leftEdge = Math.min(srcLeft, tgtLeft);
            const routeRight = rightEdge + 15;
            const routeLeft = leftEdge - 15;

            const distRight = Math.abs(sx - routeRight) + Math.abs(tx - routeRight);
            const distLeft = Math.abs(sx - routeLeft) + Math.abs(tx - routeLeft);

            let useRight: boolean;
            if (cachedSide === 'right') useRight = true;
            else if (cachedSide === 'left') useRight = false;
            else useRight = distRight <= distLeft;

            if (useRight) {
                exitX = srcRight; entryX = tgtRight; midX = routeRight;
                this.routingCache.set(linkKey, 'right');
            } else {
                exitX = srcLeft; entryX = tgtLeft; midX = routeLeft;
                this.routingCache.set(linkKey, 'left');
            }
        }

        // ... existing OrthogonalPath ...
        const pts: THREE.Vector3[] = [];
        if (Math.abs(sy - ty) < 0.5 && !xOverlap) {
            pts.push(new THREE.Vector3(exitX, sy, z));
            pts.push(new THREE.Vector3(entryX, ty, z));
        } else {
            pts.push(new THREE.Vector3(exitX, sy, z));
            pts.push(new THREE.Vector3(midX, sy, z));
            pts.push(new THREE.Vector3(midX, ty, z));
            pts.push(new THREE.Vector3(entryX, ty, z));
        }
        return pts;
    }

    /** Rounds the sharp corners of the orthogonal path for a premium, curved look. */
    private smoothWaypoints(pts: THREE.Vector3[], radius: number): THREE.Vector3[] {
        if (pts.length <= 2) return pts;
        const smoothed: THREE.Vector3[] = [];
        smoothed.push(pts[0]);
        for (let i = 1; i < pts.length - 1; i++) {
            const pPrev = pts[i - 1];
            const p = pts[i];
            const pNext = pts[i + 1];

            const dPrev = pPrev.distanceTo(p);
            const dNext = pNext.distanceTo(p);
            const r = Math.min(radius, dPrev * 0.48, dNext * 0.48);

            if (r < 0.5) {
                smoothed.push(p);
                continue;
            }

            const dirPrev = new THREE.Vector3().subVectors(pPrev, p).normalize();
            const dirNext = new THREE.Vector3().subVectors(pNext, p).normalize();

            const p0 = new THREE.Vector3().addVectors(p, dirPrev.multiplyScalar(r));
            const p2 = new THREE.Vector3().addVectors(p, dirNext.multiplyScalar(r));

            const curve = new THREE.QuadraticBezierCurve3(p0, p, p2);
            const curvePts = curve.getPoints(6); // 6 segments for the corner
            for (let j = 0; j < curvePts.length; j++) {
                smoothed.push(curvePts[j]);
            }
        }
        smoothed.push(pts[pts.length - 1]);
        return smoothed;
    }

    getLinkColor(link: any): number {
        switch (link.type) {
            case 'inner': return C.linkInner;
            case 'left': return C.linkLeft;
            case 'right': return C.linkRight;
            case 'full': return C.linkFull;
            default: return C.linkDefault;
        }
    }
}
