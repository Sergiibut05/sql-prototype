import * as THREE from 'three';
import ThreeForceGraph from 'three-forcegraph';
import { forceCollide } from 'd3-force-3d';
import { ErDebugParams } from './er-debug-params';
import { ErTableRenderer } from './er-table-renderer';
import { ErLinkRenderer } from './er-link-renderer';

/**
 * Initialises the ThreeForceGraph instance and attaches it to the scene.
 * The collision, charge and link-distance forces are configured from `p`.
 *
 * Returns the configured graph so the component can hold the reference.
 */
export function setupGraph(
    scene: THREE.Scene,
    p: ErDebugParams,
    tableRenderer: ErTableRenderer,
    linkRenderer: ErLinkRenderer,
): ThreeForceGraph {
    const graph = new (ThreeForceGraph as any)()
        .numDimensions(2)
        .nodeId('id')
        .nodeVal((n: any) => Math.max(2, (n.columns?.length || 0) + 1))
        .nodeThreeObject((n: any) => tableRenderer.createTableNode(n))
        .nodeThreeObjectExtend(false)
        .linkThreeObject((l: any) => linkRenderer.createLinkLine(l))
        .linkPositionUpdate((obj: any, coords: any, link: any) =>
            linkRenderer.updateLinkLine(obj, coords, link),
        )
        .d3AlphaDecay(p.alphaDecay)
        .d3VelocityDecay(p.velDecay)
        .warmupTicks(80)
        .cooldownTime(8000);

    // Collision force — uses actual node dimensions once computed
    graph.d3Force(
        'collide',
        forceCollide()
            .radius((d: any) => {
                const dims = tableRenderer.nodeDimensions.get(d.id);
                if (dims) return Math.sqrt(dims.w ** 2 + dims.h ** 2) / 2 + 4;
                return p.collideRadius;
            })
            .strength(p.collideStrength)
            .iterations(p.collideIter),
    );

    // Charge force (repulsion)
    graph.d3Force('charge')?.strength(p.chargeStr);

    // Link distance
    const linkForce = graph.d3Force('link');
    if (linkForce) linkForce.distance(p.linkDist);

    // Rotate the graph group so the 2D layout (XY plane) lies on the ground (XZ plane)
    graph.rotation.x = -Math.PI / 2;

    scene.add(graph as any);
    return graph;
}
