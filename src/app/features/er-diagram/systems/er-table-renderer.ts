import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GraphNode } from '../../../shared/models/graph.model';
import {
    ROW_HEIGHT, HEADER_HEIGHT, NODE_WIDTH,
    NODE_PADDING, TABLE_DEPTH, CANVAS_SCALE, C,
} from './er-constants';
import { ErDebugParams } from './er-debug-params';

/**
 * Responsible for creating and managing 3D table node meshes and their canvas textures.
 */
export class ErTableRenderer {
    readonly nodeDimensions = new Map<string, { w: number; h: number }>();
    readonly nodeColumnOffsets = new Map<string, Map<string, number>>();
    readonly nodeThreeObjects = new Map<string, THREE.Object3D>();
    readonly tableMaterials: {
        sides: THREE.MeshStandardMaterial[];
        edges: THREE.MeshStandardMaterial[];
        tops: THREE.MeshStandardMaterial[];
    } = { sides: [], edges: [], tops: [] };

    private readonly textures: THREE.Texture[] = [];

    constructor(
        private readonly groundClipPlane: THREE.Plane,
        private readonly p: ErDebugParams,
    ) { }

    reset(): void {
        this.tableMaterials.sides.length = 0;
        this.tableMaterials.edges.length = 0;
        this.tableMaterials.tops.length = 0;
        this.nodeColumnOffsets.clear();
        this.nodeDimensions.clear();
        this.nodeThreeObjects.clear();
    }

    createTableNode(node: GraphNode): THREE.Object3D {
        const group = new THREE.Group();
        const cols = node.columns || [];
        const totalH = HEADER_HEIGHT + cols.length * ROW_HEIGHT + NODE_PADDING * 2;
        const w = NODE_WIDTH;

        this.nodeDimensions.set(node.id, { w, h: totalH });

        const offsets = new Map<string, number>();
        cols.forEach((col, i) => {
            const y = totalH / 2 - HEADER_HEIGHT - NODE_PADDING - (i + 0.5) * ROW_HEIGHT;
            offsets.set(col, y);
        });
        this.nodeColumnOffsets.set(node.id, offsets);

        // ── Rounded box body (radius 0.4 — subtle, professional) ─────────────
        const bodyGeo = new RoundedBoxGeometry(w, totalH, TABLE_DEPTH, 3, 0.4);

        // Solid dark bottom face
        const bottomMat = new THREE.MeshStandardMaterial({
            color: 0x03080f,
            roughness: 0.9,
            metalness: 0.1,
            clippingPlanes: [this.groundClipPlane],
        });

        // Top face — canvas texture with subtle clearcoat (glass-screen look)
        const canvas = this.createTableCanvas(node, w, totalH);
        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        this.textures.push(tex);

        const topMat = new THREE.MeshPhysicalMaterial({
            map: tex,
            roughness: 0.35,          // Increased roughness so light spreads out
            metalness: 0.0,
            clearcoat: 0.10,          // Reduced so it doesn't wash out text
            clearcoatRoughness: 0.40, // Softer reflection
            clippingPlanes: [this.groundClipPlane],
        }) as unknown as THREE.MeshStandardMaterial;

        // Edge highlight — azure glow that echoes the ground reflection pools
        const edgeMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(this.p.tableEdge),
            roughness: 0.4,
            metalness: 0.3,
            emissive: new THREE.Color(this.p.tableEdge),
            emissiveIntensity: 0.9,
            clippingPlanes: [this.groundClipPlane],
        });

        // Push to materials array for live GUI updates
        this.tableMaterials.edges.push(edgeMat);
        this.tableMaterials.tops.push(topMat);

        const body = new THREE.Mesh(bodyGeo, [
            edgeMat,   // +X (Right side glow) 
            edgeMat,   // -X (Left side glow)  
            edgeMat,   // +Y (Top edge glow)
            edgeMat,   // -Y (Bottom edge glow)
            topMat,    // +Z (face visible from above)
            bottomMat, // -Z
        ]);
        body.position.z = TABLE_DEPTH / 2;
        body.castShadow = true;
        body.receiveShadow = true;
        body.renderOrder = 1;
        group.add(body);

        (group as any).__nodeRef = node;
        (group as any).__nodeId = node.id;
        this.nodeThreeObjects.set(node.id, group);
        return group;
    }

    createTableCanvas(
        node: GraphNode,
        nodeW: number,
        totalH: number,
    ): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        const cW = Math.round(nodeW * CANVAS_SCALE);
        const cH = Math.round(totalH * CANVAS_SCALE);
        canvas.width = cW;
        canvas.height = cH;
        const ctx = canvas.getContext('2d')!;
        const hH = Math.round(HEADER_HEIGHT * CANVAS_SCALE);

        // ── Full background — very dark blue-black ─────────────────────────
        ctx.fillStyle = '#040914';
        ctx.fillRect(0, 0, cW, cH);

        // ── Header: dark-navy → bright-royal-blue → dark-navy (centered highlight) ─
        const headerGrad = ctx.createLinearGradient(0, 0, cW, 0);
        headerGrad.addColorStop(0, this.p.headerStart); // dark edge
        headerGrad.addColorStop(0.50, this.p.headerEnd);   // bright center
        headerGrad.addColorStop(1, this.p.headerStart); // dark edge (symmetrical)
        ctx.fillStyle = headerGrad;
        ctx.fillRect(0, 0, cW, hH);

        // ── Glass gloss — subtle top reflection on header ──────────────────
        const gloss = ctx.createLinearGradient(0, 0, 0, hH * 0.55);
        gloss.addColorStop(0, 'rgba(180,210,255,0.06)'); // drastically reduced visual noise
        gloss.addColorStop(1, 'rgba(180,210,255,0)');
        ctx.fillStyle = gloss;
        ctx.fillRect(0, 0, cW, hH * 0.55);

        // ── Bottom separator — sky-blue accent line ─────────────────────────
        ctx.fillStyle = 'rgba(56,189,248,0.90)';
        ctx.fillRect(0, hH - 2, cW, 2);

        // ── Table name ─────────────────────────────────────────────────────
        const nameFontSize = Math.round(hH * 0.46);
        ctx.fillStyle = '#f0f6ff';
        ctx.font = `700 ${nameFontSize}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const displayName = node.name.length > 20 ? node.name.substring(0, 18) + '..' : node.name;
        ctx.fillText(displayName, cW / 2, hH * 0.4);

        // ── Schema / subquery label ─────────────────────────────────────────
        if (node.schema) {
            const schemaFont = Math.round(hH * 0.26);
            ctx.fillStyle = 'rgba(147,197,253,0.85)';
            ctx.font = `${schemaFont}px "Segoe UI", system-ui, sans-serif`;
            const schemaDisplay = node.schema.length > 24
                ? node.schema.substring(0, 22) + '..'
                : node.schema;
            ctx.fillText(schemaDisplay, cW / 2, hH * 0.78);
        }
        if (node.isSubquery) {
            const badge = Math.round(hH * 0.22);
            ctx.fillStyle = '#fbbf24';
            ctx.font = `italic ${badge}px "Segoe UI", system-ui, sans-serif`;
            ctx.fillText('(subquery)', cW / 2, hH * 0.78);
        }

        // ── Column rows ────────────────────────────────────────────────────
        const cols = node.columns || [];
        const rowH = Math.round(ROW_HEIGHT * CANVAS_SCALE);
        const padTop = Math.round(NODE_PADDING * CANVAS_SCALE);
        const colFont = Math.round(rowH * 0.52);

        cols.forEach((col, i) => {
            const y = hH + padTop + i * rowH;
            ctx.fillStyle = i % 2 === 0 ? C.rowEven : C.rowOdd;
            ctx.fillRect(0, y, cW, rowH);

            // Only treat as key if it actually participates in a graph link (Foreign Key / Primary Key acting as relationship)
            const isKey = node.keyColumns?.includes(col);

            if (isKey) {
                // Purple/Blue for actual rel keys exactly as requested
                ctx.fillStyle = '#a78bfa'; // violet-400
                const kx = 14;
                const ky = y + rowH / 2;
                ctx.save();
                ctx.translate(kx, ky);
                ctx.beginPath();
                ctx.arc(-4, 0, 3, 0, Math.PI * 2); // Head
                ctx.rect(-1, -1, 7, 2);            // Shaft
                ctx.rect(3, 1, 1.5, 2.5);          // Tooth 1
                ctx.rect(5.5, 1, 1.5, 2.5);        // Tooth 2
                ctx.fill();
                // Cutout hole
                ctx.fillStyle = i % 2 === 0 ? C.rowEven : C.rowOdd;
                ctx.beginPath();
                ctx.arc(-4, 0, 1.2, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } else {
                ctx.fillStyle = '#38bdf8';
                ctx.font = `${Math.round(colFont * 0.85)}px "Segoe UI", sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('\u25C6', 14, y + rowH / 2); // default diamond
            }

            ctx.fillStyle = C.textMuted;
            ctx.font = `${colFont}px "JetBrains Mono", Consolas, monospace`;
            ctx.textAlign = 'left';
            const colDisplay = col.length > 26 ? col.substring(0, 24) + '..' : col;
            ctx.fillText(colDisplay, 30, y + rowH / 2);
        });

        // ── Rounded border ─────────────────────────────────────────────────
        const r = Math.max(4, Math.round(Math.min(cW, cH) * 0.018));
        ctx.beginPath();
        if ((ctx as any).roundRect) {
            (ctx as any).roundRect(1.5, 1.5, cW - 3, cH - 3, r);
        } else {
            ctx.rect(1.5, 1.5, cW - 3, cH - 3);
        }
        ctx.strokeStyle = 'rgba(37,99,235,0.70)';
        ctx.lineWidth = 4;
        ctx.stroke();

        return canvas;
    }

    rebuildAllTableTextures(graph: THREE.Object3D): void {
        graph.children.forEach((child: any) => {
            child.traverse?.((obj: any) => {
                if (!obj.__nodeRef) return;
                const node = obj.__nodeRef as GraphNode;
                const dims = this.nodeDimensions.get(node.id);
                if (!dims) return;
                const canvas = this.createTableCanvas(node, dims.w, dims.h);
                const body = obj.children?.[0] as THREE.Mesh;
                if (body && Array.isArray(body.material)) {
                    const topMat = body.material[4] as THREE.MeshStandardMaterial;
                    if (topMat?.map) {
                        const tex = topMat.map as THREE.CanvasTexture;
                        (tex as any).image = canvas;
                        tex.needsUpdate = true;
                    }
                }
            });
        });
    }

    dispose(): void {
        this.textures.forEach(t => t.dispose());
        this.textures.length = 0;
    }
}
