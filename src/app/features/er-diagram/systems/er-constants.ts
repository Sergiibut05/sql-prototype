// ── Layout constants ──────────────────────────────────────────────
export const ROW_HEIGHT = 3.5;
export const HEADER_HEIGHT = 5;
export const NODE_WIDTH = 38;
export const NODE_PADDING = 1.5;
export const TABLE_DEPTH = 2.0;
export const CANVAS_SCALE = 14;
export const MAX_LINE_PTS = 64;  // increased from 16 to fit smoothed curve corners

// ── Edge routing ─────────────────────────────────────────────────
export const EDGE_GAP = 0;   // no gap — cables connect flush to table edges
export const EDGE_CLEARANCE = 5;

// ── Cable geometry ───────────────────────────────────────────────
export const CABLE_WIDTH = 1.1; // Increased width for a wider glow halo
export const CABLE_STRIPE_WORLD_SCALE = 0.08; // stripe period in world units (consistent across cables)

// ── Colors ────────────────────────────────────────────────────────
export const C = {
    bg: 0x080c14,
    tableBody: 0x101c2e,
    tableSide: 0x0c1624,
    headerStart: '#071040',  // deep dark navy — header edge
    headerEnd: '#1a58f5',  // bright royal blue — header center highlight
    rowEven: '#060e1e',  // very dark blue — high contrast
    rowOdd: '#08111f',  // slightly lighter dark blue
    textLight: '#e2e8f0',
    textMuted: '#94a3b8',
    textAccent: '#93c5fd',
    border: '#2563eb',
    linkInner: 0x38bdf8,  // sky blue  (inner join — most common)
    linkLeft: 0x60a5fa,  // blue-400  (left join)
    linkRight: 0x818cf8,  // indigo-400 (right join)
    linkFull: 0xa78bfa,  // violet-400 (full join — stays distinct)
    linkDefault: 0x7dd3fc,  // lighter sky (default)
} as const;

// ── Transition ───────────────────────────────────────────────────
export const TRANSITION_SINK_DURATION = 1.8;   // seconds — tables sink (slow & deliberate)
export const SETTLING_DURATION = 0.4;   // seconds to let d3 settle while hidden
export const SINK_DEPTH = -80;   // how far below ground tables sink

// ── Reveal (Bruno Simon folio-2019 style) ────────────────────────
export const REVEAL_DURATION = 2.5;   // total reveal animation time (seconds)
export const REVEAL_Z_AMPLITUDE = 18.0;  // how far nodes are displaced below ground at start
export const REVEAL_WAVE_SCALE = 20.0;  // controls wave spread from center
