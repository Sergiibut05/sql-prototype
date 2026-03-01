import { TABLE_DEPTH } from './er-constants';

export interface ErDebugParams {
    camY: number;
    camZ: number;
    fov: number;
    collideRadius: number;
    collideStrength: number;
    collideIter: number;
    vigInt: number;
    vigSoft: number;
    crossDensity: number;
    crossSize: number;
    crossFade: number;
    crossOpacity: number;
    linkHeight: number;
    chargeStr: number;
    linkDist: number;
    alphaDecay: number;
    velDecay: number;
    cameraLerpSpeed: number;
    // Colors
    tableBody: string;
    tableEdge: string;
    headerStart: string;
    headerEnd: string;
    crossColor: string;
    groundBase: string;
    cableColor: string;
    cableSpeed: number;
    cableStripes: number;
    cableContrast: number;
    // Bloom
    bloomStrength: number;
    bloomRadius: number;
    bloomThreshold: number;
    // Particles
    particleSize: number;
    particleOpacity: number;
    // Hover
    hoverElevation: number;
    // Ground reflection
    reflStrength: number;
    // Parser
    useParser: 'node-sql-parser' | 'sqlglot';
}

export function createDefaultParams(): ErDebugParams {
    return {
        camY: 200,
        camZ: 160,
        fov: 50,
        collideRadius: 30,
        collideStrength: 1.0,
        collideIter: 5,
        vigInt: 0.65,
        vigSoft: 0.42,
        crossDensity: 0.06,
        crossSize: 0.012,
        crossFade: 1400,
        crossOpacity: 0.85,
        linkHeight: TABLE_DEPTH * 0.6,
        chargeStr: -15,
        linkDist: 45,
        alphaDecay: 0.02,
        velDecay: 0.3,
        cameraLerpSpeed: 1.8,
        tableBody: '#0c1624',   // cooler blue-navy
        tableEdge: '#163669',   // deep azure (was indigo)
        headerStart: '#071040',   // deep dark navy edge
        headerEnd: '#1a58f5',   // bright royal blue centre
        crossColor: '#ffffff',
        groundBase: '#0a0e1a',
        cableColor: '#38bdf8',   // sky blue (matches new cable/link palette)
        cableSpeed: 1.2,
        cableStripes: 6.0,
        cableContrast: 0.38,
        bloomStrength: 0.35,
        bloomRadius: 0.6,
        bloomThreshold: 0.75,
        particleSize: 1.2,
        particleOpacity: 0.6,
        hoverElevation: 3.0,
        reflStrength: 0.30,  // reduced so tables dominate visually
        useParser: 'node-sql-parser',
    };
}
