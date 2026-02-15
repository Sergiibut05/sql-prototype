import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  NgZone,
  HostListener,
} from '@angular/core';
import * as THREE from 'three';
import ThreeForceGraph from 'three-forcegraph';
import { forceCollide } from 'd3-force-3d';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import GUI from 'lil-gui';
import { Subscription } from 'rxjs';

import { SqlParserService } from '../../core/services/sql-parser.service';
import { QuerySimulatorService } from '../../core/services/query-simulator.service';
import { GraphNode, GraphData } from '../../shared/models/graph.model';
import { GroundCrossesShader } from './shaders/ground-crosses-shader';
import { VignetteShader } from './shaders/vignette-shader';
import { CableShader } from './shaders/cable-shader';

// ── Layout constants ──────────────────────────────────────────────
const ROW_HEIGHT = 3.5;
const HEADER_HEIGHT = 5;
const NODE_WIDTH = 38;
const NODE_PADDING = 1.5;
const TABLE_DEPTH = 2.0;
const CANVAS_SCALE = 14;
const MAX_LINE_PTS = 16;

// ── Edge routing ─────────────────────────────────────────────────
const EDGE_GAP = 0;           // no gap — cables connect flush to table edges
const EDGE_CLEARANCE = 5;

// ── Cable geometry ───────────────────────────────────────────────
const CABLE_WIDTH = 0.5;      // width of the flat ribbon cable
const CABLE_STRIPE_WORLD_SCALE = 0.08; // stripe period in world units (consistent across all cables)

// ── Colors ────────────────────────────────────────────────────────
const C = {
  bg: 0x080c14,
  tableBody: 0x141a2a,
  tableSide: 0x0f1322,
  headerStart: '#4f46e5',
  headerEnd: '#7c3aed',
  rowEven: '#1a2035',
  rowOdd: '#1e2640',
  textLight: '#e2e8f0',
  textMuted: '#94a3b8',
  textAccent: '#a5b4fc',
  border: '#4f46e5',
  linkInner: 0x34d399,
  linkLeft: 0xfbbf24,
  linkRight: 0xf87171,
  linkFull: 0xc084fc,
  linkDefault: 0x60a5fa,
};

// ── Transition ───────────────────────────────────────────────────
const TRANSITION_SINK_DURATION = 1.8;    // seconds — tables sink below ground (slow & deliberate)
const SETTLING_DURATION = 0.4;           // seconds to let d3 simulation settle while hidden below ground
const SINK_DEPTH = -80;                  // how far below ground tables sink

// ── Reveal (Bruno Simon folio-2019 style) ────────────────────────
const REVEAL_DURATION = 2.5;             // total reveal animation time (seconds)
const REVEAL_Z_AMPLITUDE = 18.0;         // how far nodes are displaced below ground at start
const REVEAL_WAVE_SCALE = 20.0;          // controls wave spread from center (higher = more staggered)

@Component({
  selector: 'app-er-diagram',
  standalone: true,
  templateUrl: './er-diagram.component.html',
  styleUrls: ['./er-diagram.component.scss'],
})
export class ErDiagramComponent implements AfterViewInit, OnDestroy {
  @ViewChild('rendererCanvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  // ── Template-bound state ──────────────────────────────────────
  currentQuery = '';
  currentStep = 0;
  totalSteps = 0;
  isRunning = false;
  showQuery = false;

  // ── Three.js core ─────────────────────────────────────────────
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private clock = new THREE.Clock();

  // ── Graph ─────────────────────────────────────────────────────
  private graph!: ThreeForceGraph;
  private animFrameId = 0;

  // ── Per-node meta ─────────────────────────────────────────────
  private nodeColumnOffsets = new Map<string, Map<string, number>>();
  private nodeDimensions = new Map<string, { w: number; h: number }>();

  // ── GUI ───────────────────────────────────────────────────────
  private gui!: GUI;
  private guiVisible = false;

  // ── Shader uniforms refs ──────────────────────────────────────
  private groundUniforms: Record<string, THREE.IUniform> = {};
  private vignettePass!: ShaderPass;

  // ── Cable shader uniforms (shared across all cables) ──────────
  private cableUniforms: Record<string, THREE.IUniform> = {};

  // ── Disposables ───────────────────────────────────────────────
  private subs = new Subscription();
  private textures: THREE.Texture[] = [];

  // ── Stored materials for live color updates ──────────────────
  private tableMaterials: {
    sides: THREE.MeshStandardMaterial[];
    edges: THREE.MeshStandardMaterial[];
    tops: THREE.MeshStandardMaterial[];
  } = { sides: [], edges: [], tops: [] };

  // ── Camera lerp ───────────────────────────────────────────────
  private cameraTarget = new THREE.Vector3(0, 200, 160);
  private cameraLookTarget = new THREE.Vector3(0, 0, 0);
  private cameraLerpSpeed = 1.8;
  private currentCameraSpeed = 1.8; // smoothed camera speed (avoids jerk on transition end)
  private cameraLookCurrent = new THREE.Vector3(0, 0, 0); // smoothed lookAt

  // ── Transition state ──────────────────────────────────────────
  private transitionPhase: 'idle' | 'sinking' | 'settling' | 'revealing' = 'idle';
  private transitionTimer = 0;
  private pendingGraphData: GraphData | null = null;
  private nodeBasePositions = new Map<string, { x: number; y: number }>();

  // ── Reveal state (Bruno Simon style) ──────────────────────────
  private revealProgress = 1;                // 0 = all hidden, 1 = all revealed
  private revealCenter = { x: 0, y: 0 };     // center of the node layout
  private revealMaxDist = 1;                  // max distance from center among nodes
  private nodeThreeObjects = new Map<string, THREE.Object3D>(); // ref to node 3D objects

  // ── Link routing cache (prevents flicker during reveal) ───────
  private linkRoutingCache = new Map<string, 'left' | 'right'>();

  // ── Ground clip plane for hiding sunken tables ────────────────
  private groundClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.2);

  // ── Debug params ──────────────────────────────────────────────
  private p = {
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
    linkHeight: TABLE_DEPTH * 0.6,  // below table top so tables occlude cables via depth test
    chargeStr: -40,
    alphaDecay: 0.02,
    velDecay: 0.3,
    cameraLerpSpeed: 1.8,
    // Colors
    tableBody: '#0f1322',
    tableEdge: '#2a2060',
    headerStart: '#4f46e5',
    headerEnd: '#7c3aed',
    crossColor: '#ffffff',
    groundBase: '#0a0e1a',
    cableColor: '#34d399',
    cableSpeed: 1.2,
    cableStripes: 6.0,
    cableContrast: 0.38,
  };

  constructor(
    private sqlParser: SqlParserService,
    public simulator: QuerySimulatorService,
    private ngZone: NgZone,
  ) { }

  // ================================================================
  //  Lifecycle
  // ================================================================

  ngAfterViewInit(): void {
    this.totalSteps = this.simulator.totalSteps;
    this.initThreeJS();
    this.initPostProcessing();
    this.initCableUniforms();
    this.initGraph();
    this.initGUI();
    this.subscribeToSimulator();
    this.simulator.start();
    this.ngZone.runOutsideAngular(() => this.animate());
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animFrameId);
    this.subs.unsubscribe();
    this.gui?.destroy();
    this.textures.forEach((t) => t.dispose());
    this.composer?.dispose();
    this.renderer?.dispose();
  }

  // ================================================================
  //  Three.js init
  // ================================================================

  private initThreeJS(): void {
    const el = this.canvasRef.nativeElement;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(C.bg);
    this.scene.fog = new THREE.FogExp2(C.bg, 0.0018);

    // Camera — top-down angle
    this.camera = new THREE.PerspectiveCamera(this.p.fov, w / h, 0.1, 5000);
    this.camera.position.set(0, this.p.camY, this.p.camZ);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: el,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    // Enable local clipping planes (for hiding sunken tables)
    this.renderer.localClippingEnabled = true;

    // ── Lights ────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x8090c0, 0.7);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x6070a0, 0x101828, 0.55);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xc0c8ff, 1.4);
    key.position.set(80, 200, 100);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 600;
    key.shadow.camera.left = -200;
    key.shadow.camera.right = 200;
    key.shadow.camera.top = 200;
    key.shadow.camera.bottom = -200;
    key.shadow.bias = -0.0005;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x7080c0, 0.5);
    fill.position.set(-60, 100, -80);
    this.scene.add(fill);

    const rim = new THREE.PointLight(0x4f46e5, 0.6, 400);
    rim.position.set(0, 60, -120);
    this.scene.add(rim);

    // ── Ground plane with crosses shader ──────────────────────
    this.groundUniforms = THREE.UniformsUtils.clone(
      GroundCrossesShader.uniforms,
    );
    const groundMat = new THREE.ShaderMaterial({
      uniforms: this.groundUniforms,
      vertexShader: GroundCrossesShader.vertexShader,
      fragmentShader: GroundCrossesShader.fragmentShader,
      side: THREE.DoubleSide,
    });
    const groundGeo = new THREE.PlaneGeometry(3000, 3000);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.15;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  // ================================================================
  //  Post-processing (NO BLOOM)
  // ================================================================

  private initPostProcessing(): void {
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Vignette
    this.vignettePass = new ShaderPass({
      uniforms: THREE.UniformsUtils.clone(VignetteShader.uniforms),
      vertexShader: VignetteShader.vertexShader,
      fragmentShader: VignetteShader.fragmentShader,
    });
    this.vignettePass.uniforms['uIntensity'].value = this.p.vigInt;
    this.vignettePass.uniforms['uSoftness'].value = this.p.vigSoft;
    this.composer.addPass(this.vignettePass);

    // Output pass (tone-mapping / color space)
    this.composer.addPass(new OutputPass());
  }

  // ================================================================
  //  Cable shader uniforms (shared)
  // ================================================================

  private initCableUniforms(): void {
    this.cableUniforms = THREE.UniformsUtils.clone(CableShader.uniforms);
    this.cableUniforms['uColor'].value.set(this.p.cableColor);
    this.cableUniforms['uSpeed'].value = this.p.cableSpeed;
    this.cableUniforms['uStripeCount'].value = this.p.cableStripes;
    this.cableUniforms['uStripeContrast'].value = this.p.cableContrast;
  }

  // ================================================================
  //  Force-graph init
  // ================================================================

  private initGraph(): void {
    this.graph = new (ThreeForceGraph as any)()
      .numDimensions(2)
      .nodeId('id')
      .nodeVal((n: any) => Math.max(2, (n.columns?.length || 0) + 1))
      .nodeThreeObject((n: any) => this.createTableNode(n as GraphNode))
      .nodeThreeObjectExtend(false)
      .linkThreeObject((l: any) => this.createLinkLine(l))
      .linkPositionUpdate((obj: any, coords: any, link: any) =>
        this.updateLinkLine(obj, coords, link),
      )
      .d3AlphaDecay(this.p.alphaDecay)
      .d3VelocityDecay(this.p.velDecay)
      .warmupTicks(80)
      .cooldownTime(8000);

    // Collision force
    (this.graph as any).d3Force(
      'collide',
      forceCollide()
        .radius((d: any) => {
          const dims = this.nodeDimensions.get(d.id);
          if (dims) {
            return Math.sqrt(dims.w ** 2 + dims.h ** 2) / 2 + 4;
          }
          return this.p.collideRadius;
        })
        .strength(this.p.collideStrength)
        .iterations(this.p.collideIter),
    );

    // Charge force
    (this.graph as any)
      .d3Force('charge')
      ?.strength(this.p.chargeStr);

    // Link distance
    const linkForce = (this.graph as any).d3Force('link');
    if (linkForce) {
      linkForce.distance(45);
    }

    // Rotate graph group so layout (XY) lies on ground (XZ)
    this.graph.rotation.x = -Math.PI / 2;

    this.scene.add(this.graph as any);
  }

  // ================================================================
  //  lil-gui
  // ================================================================

  private initGUI(): void {
    this.gui = new GUI({ title: 'ER Diagram Debug', width: 300 });
    this.gui.domElement.style.zIndex = '100';

    // Camera
    const cam = this.gui.addFolder('Camera');
    cam.add(this.p, 'camY', 50, 500, 1).onChange(() => this.setCameraTarget());
    cam.add(this.p, 'camZ', 0, 400, 1).onChange(() => this.setCameraTarget());
    cam.add(this.p, 'fov', 20, 90, 1).onChange(() => {
      this.camera.fov = this.p.fov;
      this.camera.updateProjectionMatrix();
    });
    cam.add(this.p, 'cameraLerpSpeed', 0.3, 8, 0.1).name('Lerp Speed').onChange(() => {
      this.cameraLerpSpeed = this.p.cameraLerpSpeed;
    });

    // Layout
    const layout = this.gui.addFolder('Layout');
    layout.add(this.p, 'collideRadius', 10, 80, 1);
    layout.add(this.p, 'chargeStr', -200, 0, 1).onChange(() => {
      (this.graph as any).d3Force('charge')?.strength(this.p.chargeStr);
      (this.graph as any).d3ReheatSimulation?.();
    });
    layout.add(this.p, 'linkHeight', 0, 8, 0.1);

    // Cable
    const cable = this.gui.addFolder('Cable');
    cable.addColor(this.p, 'cableColor').name('Color').onChange(() => {
      // Update ALL cable materials (each has its own uColor uniform)
      this.graph.traverse((child: any) => {
        if (child.isMesh && child.material && (child.material as any).__isCable) {
          (child.material as THREE.ShaderMaterial).uniforms['uColor'].value.set(this.p.cableColor);
        }
      });
    });
    cable.add(this.p, 'cableSpeed', 0, 5, 0.1).name('Speed').onChange(() => {
      this.cableUniforms['uSpeed'].value = this.p.cableSpeed;
    });
    cable.add(this.p, 'cableStripes', 2, 60, 1).name('Stripes').onChange(() => {
      this.cableUniforms['uStripeCount'].value = this.p.cableStripes;
    });
    cable.add(this.p, 'cableContrast', 0, 1, 0.01).name('Contrast').onChange(() => {
      this.cableUniforms['uStripeContrast'].value = this.p.cableContrast;
    });

    // Vignette
    const vig = this.gui.addFolder('Vignette');
    vig.add(this.p, 'vigInt', 0, 1, 0.01).onChange(() => {
      this.vignettePass.uniforms['uIntensity'].value = this.p.vigInt;
    });
    vig.add(this.p, 'vigSoft', 0, 1, 0.01).onChange(() => {
      this.vignettePass.uniforms['uSoftness'].value = this.p.vigSoft;
    });

    // Ground
    const gnd = this.gui.addFolder('Ground');
    gnd.add(this.p, 'crossDensity', 0.01, 0.2, 0.001).onChange(() => {
      this.groundUniforms['uCrossDensity'].value = this.p.crossDensity;
    });
    gnd.add(this.p, 'crossSize', 0.001, 0.05, 0.001).onChange(() => {
      this.groundUniforms['uCrossSize'].value = this.p.crossSize;
    });
    gnd.add(this.p, 'crossFade', 100, 2000, 10).onChange(() => {
      this.groundUniforms['uFadeDistance'].value = this.p.crossFade;
    });
    gnd.add(this.p, 'crossOpacity', 0.1, 1.5, 0.01).name('Cross Opacity').onChange(() => {
      this.groundUniforms['uCrossOpacity'].value = this.p.crossOpacity;
    });
    gnd.addColor(this.p, 'crossColor').name('Cross Color').onChange(() => {
      this.groundUniforms['uCrossColor'].value.set(this.p.crossColor);
    });
    gnd.addColor(this.p, 'groundBase').name('Base Color').onChange(() => {
      this.groundUniforms['uBaseColor'].value.set(this.p.groundBase);
    });

    // Table colors
    const tbl = this.gui.addFolder('Table Colors');
    tbl.addColor(this.p, 'tableBody').name('Body / Sides').onChange(() => {
      for (const m of this.tableMaterials.sides) m.color.set(this.p.tableBody);
    });
    tbl.addColor(this.p, 'tableEdge').name('Edge Glow').onChange(() => {
      for (const m of this.tableMaterials.edges) {
        m.color.set(this.p.tableEdge);
        m.emissive.set(this.p.tableEdge);
      }
    });
    tbl.addColor(this.p, 'headerStart').name('Header Start').onChange(() => {
      this.rebuildAllTableTextures();
    });
    tbl.addColor(this.p, 'headerEnd').name('Header End').onChange(() => {
      this.rebuildAllTableTextures();
    });

    // Start hidden
    this.gui.hide();
  }

  // ================================================================
  //  Simulator subscription
  // ================================================================

  private subscribeToSimulator(): void {
    this.subs.add(
      this.simulator.currentQuery$.subscribe((q) => {
        if (!q) return;
        this.currentQuery = q;
        const data = this.sqlParser.parseQueryToGraph(q);
        this.handleStepTransition(data);
      }),
    );
    this.subs.add(
      this.simulator.currentStep$.subscribe((s) => (this.currentStep = s)),
    );
    this.subs.add(
      this.simulator.running$.subscribe((r) => (this.isRunning = r)),
    );
  }

  // ================================================================
  //  Step transition — sink ↓ → new data → rise ↑
  // ================================================================

  private handleStepTransition(data: GraphData): void {
    const currentData = (this.graph as any).graphData();
    const hasExistingNodes = currentData?.nodes?.length > 0;

    if (!hasExistingNodes || this.transitionPhase !== 'idle') {
      this.pendingGraphData = data;
      if (this.transitionPhase !== 'idle') {
        return;  // already transitioning, just update pending
      }
      // First load — drop graph below ground, apply data, settle, then reveal
      this.graph.position.y = SINK_DEPTH;
      this.applyNewData(data);
      this.pendingGraphData = null;
      this.transitionPhase = 'settling';
      this.transitionTimer = 0;
      return;
    }

    // Normal transition: start sinking current tables
    this.pendingGraphData = data;
    this.transitionPhase = 'sinking';
    this.transitionTimer = 0;
  }

  /**
   * Apply new graph data. Does NOT change graph position or start reveal.
   * The graph should already be at SINK_DEPTH (invisible) when this is called.
   */
  private applyNewData(data: GraphData): void {
    this.tableMaterials = { sides: [], edges: [], tops: [] };
    this.nodeColumnOffsets.clear();
    this.nodeDimensions.clear();
    this.nodeBasePositions.clear();
    this.nodeThreeObjects.clear();
    this.linkRoutingCache.clear();

    // graphData() runs warmupTicks(80) synchronously → d3 nodes get x,y.
    // createTableNode callback stores refs in nodeThreeObjects.
    // The graph group is at SINK_DEPTH so everything is clipped by the
    // ground plane — completely invisible. tickFrame() in animate() will
    // sync THREE wrapper positions from d3 data during the settling phase.
    (this.graph as any).graphData({
      nodes: data.nodes,
      links: data.links,
    });
  }

  /**
   * Called at the end of the settling phase.
   * Positions are now synced. Prepare nodes for reveal and bring the graph up.
   */
  private prepareReveal(): void {
    // Freeze all node positions: set d3 fixed positions (fx/fy) and zero
    // velocities so the simulation can't move nodes anymore. This prevents
    // any jitter during the reveal and after it finishes (idle phase).
    // Positions are automatically unfixed when graphData() is called next
    // with fresh node objects.
    const gData = (this.graph as any).graphData();
    if (gData?.nodes) {
      for (const n of gData.nodes) {
        if (n.x != null && n.y != null) {
          // Fix position — d3 will not move this node
          n.fx = n.x;
          n.fy = n.y;
          // Zero velocity
          n.vx = 0;
          n.vy = 0;
          this.nodeBasePositions.set(n.id, { x: n.x, y: n.y });
        }
      }
    }
    this.computeCameraTarget();
    this.recomputeRevealCenter();

    // Hide all node groups below ground via local z offset.
    // When graph.position.y is reset to 0, nodes at z = -REVEAL_Z_AMPLITUDE
    // will be at world y ≈ -18 (below clip plane at y = -0.2).
    for (const [, obj] of this.nodeThreeObjects) {
      obj.position.z = -REVEAL_Z_AMPLITUDE;
    }
    this.setAllLinksOpacity(0);

    // NOW bring graph to ground level — nodes are hidden by z offset,
    // cables are hidden by opacity = 0
    this.graph.position.y = 0;
    this.graph.scale.set(1, 1, 1);

    // Start reveal
    this.transitionPhase = 'revealing';
    this.transitionTimer = 0;
    this.revealProgress = 0;
  }

  private recomputeRevealCenter(): void {
    const gData = (this.graph as any).graphData();
    if (!gData?.nodes?.length) return;

    let sumX = 0, sumY = 0, count = 0;
    for (const n of gData.nodes) {
      if (n.x != null && n.y != null) {
        sumX += n.x;
        sumY += n.y;
        count++;
      }
    }
    if (count === 0) return;

    this.revealCenter = { x: sumX / count, y: sumY / count };

    // Max distance from center
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

  private computeCameraTarget(): void {
    const data = (this.graph as any).graphData();
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

  /**
   * Update the transition each frame.  Called from animate().
   */
  private updateTransition(dt: number): void {
    if (this.transitionPhase === 'idle') return;

    this.transitionTimer += dt;

    if (this.transitionPhase === 'sinking') {
      const t = Math.min(this.transitionTimer / TRANSITION_SINK_DURATION, 1);
      const ease = this.easeInQuad(t);

      // Move the entire graph group downward
      this.graph.position.y = SINK_DEPTH * ease;

      // Fade cables out
      this.setAllLinksOpacity(1 - ease);

      if (t >= 1) {
        // Graph is now at SINK_DEPTH (invisible).
        // Apply new data and start settling.
        if (this.pendingGraphData) {
          this.applyNewData(this.pendingGraphData);
          this.pendingGraphData = null;
        }
        this.transitionPhase = 'settling';
        this.transitionTimer = 0;
      }
    } else if (this.transitionPhase === 'settling') {
      // Graph stays at SINK_DEPTH — everything is below the ground clip plane.
      // tickFrame() runs normally in animate() during this phase, so the
      // d3 simulation positions nodes and THREE wrappers get synced.
      this.graph.position.y = SINK_DEPTH;

      if (this.transitionTimer >= SETTLING_DURATION) {
        // Positions are settled — prepare for reveal
        this.prepareReveal();
      }
    } else if (this.transitionPhase === 'revealing') {
      // Bruno Simon folio-2019 reveal:
      // revealProgress goes 0 → 1 over REVEAL_DURATION.
      // Each node's Z displacement depends on its distance to center.
      // Nodes closer to center reveal first, distant ones later.
      this.revealProgress = Math.min(this.transitionTimer / REVEAL_DURATION, 1);

      this.updateRevealPerNode();

      // Cables fade in later, once most nodes are visible (avoids cables appearing alone)
      const cableFadeT = Math.max(0, (this.revealProgress - 0.5) / 0.5);
      this.setAllLinksOpacity(this.easeOutCubic(cableFadeT));

      if (this.revealProgress >= 1) {
        // Ensure all nodes at final position
        this.finalizeReveal();
        this.setAllLinksOpacity(1);
        this.transitionPhase = 'idle';
        this.transitionTimer = 0;
        // NOTE: Do NOT clear linkRoutingCache here — keep cached routing
        // decisions so cables never change exit side during idle phase.
        // Cache is cleared in applyNewData() when the next step arrives.
      }
    }
  }

  /**
   * Bruno Simon folio-2019 style: per-node Z displacement based on distance to center.
   * Nodes near the center appear first, distant ones later — creating a smooth wave.
   */
  private updateRevealPerNode(): void {
    const gData = (this.graph as any).graphData();
    if (!gData?.nodes) return;

    // Adaptive multiplier: for tighter layouts (small maxDist) we need a higher
    // multiplier so the wave effect is still visible. For spread out layouts, lower.
    const adaptiveMultiplier = this.revealMaxDist > 1
      ? Math.max(3.0, Math.min(8.0, 80.0 / this.revealMaxDist))
      : 5.0;

    for (const n of gData.nodes) {
      if (n.x == null || n.y == null) continue;

      const nodeObj = this.nodeThreeObjects.get(n.id);
      if (!nodeObj) continue;

      // Distance from this node to the layout center
      const dx = n.x - this.revealCenter.x;
      const dy = n.y - this.revealCenter.y;
      const distToCenter = Math.sqrt(dx * dx + dy * dy);

      // Normalize distance to 0..1 range using maxDist for consistent wave timing
      const normalizedDist = this.revealMaxDist > 1 ? distToCenter / this.revealMaxDist : 0;

      // Per-node reveal progress: closer nodes have higher progress at any given time
      // This is the key Bruno Simon formula:
      //   nodeReveal = (globalProgress - normalizedDist * waveFraction) * multiplier
      let nodeReveal = (this.revealProgress - normalizedDist * 0.4) * adaptiveMultiplier;
      nodeReveal = Math.max(0, Math.min(1, nodeReveal));

      // Ease the reveal for smoothness
      nodeReveal = 1.0 - Math.pow(1.0 - nodeReveal, 3); // easeOutCubic per node

      // At the very end, snap to final
      if (this.revealProgress > 0.95) {
        nodeReveal = 1.0;
      }

      // Displace in Z (graph space) = Y in world space (graph is rotated -PI/2 on X)
      // Nodes start displaced below by REVEAL_Z_AMPLITUDE and move to 0
      const zOffset = -REVEAL_Z_AMPLITUDE * (1.0 - nodeReveal);
      nodeObj.position.z = zOffset;
    }
  }

  /**
   * Ensure all nodes are at their final position after reveal completes.
   */
  private finalizeReveal(): void {
    for (const [, obj] of this.nodeThreeObjects) {
      obj.position.z = 0;
    }
  }

  private setAllLinksOpacity(opacity: number): void {
    // Traverse link objects and set opacity
    this.graph.traverse((child: any) => {
      if (child.isMesh && child.material && (child.material as any).__isCable) {
        (child.material as THREE.ShaderMaterial).uniforms['uOpacity'].value = opacity;
      }
    });
  }

  // ── Easing functions ──────────────────────────────────────────
  private easeInQuad(t: number): number {
    return t * t;
  }
  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }
  private easeOutQuart(t: number): number {
    return 1 - Math.pow(1 - t, 4);
  }

  // ================================================================
  //  Table node creation (3D box on ground)
  // ================================================================

  private createTableNode(node: GraphNode): THREE.Object3D {
    const group = new THREE.Group();
    const cols = node.columns || [];
    const totalH = HEADER_HEIGHT + cols.length * ROW_HEIGHT + NODE_PADDING * 2;
    const w = NODE_WIDTH;

    this.nodeDimensions.set(node.id, { w, h: totalH });

    // Column Y-offsets (in local graph space, along Y axis)
    const offsets = new Map<string, number>();
    cols.forEach((col, i) => {
      const y =
        totalH / 2 -
        HEADER_HEIGHT -
        NODE_PADDING -
        (i + 0.5) * ROW_HEIGHT;
      offsets.set(col, y);
    });
    this.nodeColumnOffsets.set(node.id, offsets);

    // ── Box body ──────────────────────────────────────────────
    const bodyGeo = new THREE.BoxGeometry(w, totalH, TABLE_DEPTH);

    const sideMat = new THREE.MeshStandardMaterial({
      color: C.tableSide,
      roughness: 0.85,
      metalness: 0.05,
      clippingPlanes: [this.groundClipPlane],
    });
    const bottomMat = new THREE.MeshStandardMaterial({
      color: 0x0a0e17,
      roughness: 1,
      metalness: 0,
      clippingPlanes: [this.groundClipPlane],
    });

    // Top face gets the canvas texture
    const canvas = this.createTableCanvas(node, w, totalH);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    this.textures.push(tex);

    const topMat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.7,
      metalness: 0.05,
      clippingPlanes: [this.groundClipPlane],
    });

    // Edge highlight material
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0x2a2060,
      roughness: 0.6,
      metalness: 0.15,
      emissive: 0x1a1050,
      emissiveIntensity: 0.3,
      clippingPlanes: [this.groundClipPlane],
    });

    // Store material refs for live GUI color updates
    this.tableMaterials.sides.push(sideMat);
    this.tableMaterials.edges.push(edgeMat);
    this.tableMaterials.tops.push(topMat);

    const body = new THREE.Mesh(bodyGeo, [
      sideMat,   // +X
      sideMat,   // -X
      edgeMat,   // +Y
      edgeMat,   // -Y
      topMat,    // +Z  (top face)
      bottomMat, // -Z  (bottom)
    ]);
    body.position.z = TABLE_DEPTH / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    // Tables render FIRST — they write to depth buffer so cables are occluded behind them
    body.renderOrder = 1;
    group.add(body);

    // Store node ref for texture rebuild
    (group as any).__nodeRef = node;
    (group as any).__nodeId = node.id;

    // Store ref for reveal animation (we modify THIS group's z, not the wrapper's)
    this.nodeThreeObjects.set(node.id, group);

    return group;
  }

  // ================================================================
  //  Canvas texture for table top face
  // ================================================================

  private createTableCanvas(
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

    // Background
    ctx.fillStyle = '#141a2a';
    ctx.fillRect(0, 0, cW, cH);

    // Header gradient
    const hH = Math.round(HEADER_HEIGHT * CANVAS_SCALE);
    const grad = ctx.createLinearGradient(0, 0, cW, 0);
    grad.addColorStop(0, this.p.headerStart);
    grad.addColorStop(1, this.p.headerEnd);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cW, hH);

    // Table name
    const nameFontSize = Math.round(hH * 0.48);
    ctx.fillStyle = C.textLight;
    ctx.font = `bold ${nameFontSize}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const displayName =
      node.name.length > 20
        ? node.name.substring(0, 18) + '..'
        : node.name;
    ctx.fillText(displayName, cW / 2, hH * 0.4);

    // Schema label
    if (node.schema) {
      const schemaFont = Math.round(hH * 0.26);
      ctx.fillStyle = C.textAccent;
      ctx.font = `${schemaFont}px "Segoe UI", system-ui, sans-serif`;
      const schemaDisplay =
        node.schema.length > 24
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

    // Columns
    const cols = node.columns || [];
    const rowH = Math.round(ROW_HEIGHT * CANVAS_SCALE);
    const padTop = Math.round(NODE_PADDING * CANVAS_SCALE);
    const colFont = Math.round(rowH * 0.52);

    cols.forEach((col, i) => {
      const y = hH + padTop + i * rowH;

      ctx.fillStyle = i % 2 === 0 ? C.rowEven : C.rowOdd;
      ctx.fillRect(0, y, cW, rowH);

      ctx.fillStyle = '#fbbf24';
      ctx.font = `${Math.round(colFont * 0.85)}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u25C6', 10, y + rowH / 2);

      ctx.fillStyle = C.textMuted;
      ctx.font = `${colFont}px "JetBrains Mono", Consolas, monospace`;
      ctx.textAlign = 'left';
      const colDisplay =
        col.length > 26 ? col.substring(0, 24) + '..' : col;
      ctx.fillText(colDisplay, 30, y + rowH / 2);
    });

    // Border
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(1, 1, cW - 2, cH - 2);

    return canvas;
  }

  private rebuildAllTableTextures(): void {
    const data = (this.graph as any).graphData();
    if (!data?.nodes?.length) return;

    this.graph.children.forEach((child: any) => {
      child.traverse?.((obj: any) => {
        if (obj.__nodeRef) {
          const node = obj.__nodeRef as GraphNode;
          const dims = this.nodeDimensions.get(node.id);
          if (dims) {
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
          }
        }
      });
    });
  }

  // ================================================================
  //  Link (connector) rendering — RIBBON MESH with CABLE SHADER
  // ================================================================

  /**
   * Creates a flat ribbon mesh for each link.
   * The ribbon has UVs where U runs along the length (0→1) and
   * V runs across the width (0→1). This drives the stripe shader.
   * No arrow cone — just the cable.
   */
  private createLinkLine(link: any): THREE.Object3D {
    const group = new THREE.Group();

    // Create a flat ribbon geometry with enough segments for orthogonal bends
    // We'll rebuild the positions each frame in updateLinkLine
    const segCount = MAX_LINE_PTS - 1;
    const geo = new THREE.PlaneGeometry(1, CABLE_WIDTH, segCount, 1);
    // Mark that we'll override positions
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      new Float32Array((segCount + 1) * 2 * 3), 3,
    ));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(
      new Float32Array((segCount + 1) * 2 * 2), 2,
    ));
    // We need an index for a proper strip
    const indices: number[] = [];
    for (let i = 0; i < segCount; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
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
      },
      vertexShader: CableShader.vertexShader,
      fragmentShader: CableShader.fragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,  // don't write depth — tables already wrote theirs
      depthTest: true,     // DO test depth — cables hide behind tables
      clippingPlanes: [this.groundClipPlane],
    });
    (mat as any).__isCable = true;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10; // render AFTER tables (which are at 1) so depth test works
    mesh.frustumCulled = false;
    group.add(mesh);

    (group as any).__cableMaterial = mat;

    return group;
  }

  /**
   * Build an orthogonal polyline and update the ribbon mesh.
   */
  private buildOrthogonalPath(
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

    const srcRight = sx + srcHW;
    const srcLeft = sx - srcHW;
    const tgtRight = tx + tgtHW;
    const tgtLeft = tx - tgtHW;

    let exitX: number;
    let entryX: number;
    let midX: number;

    // Use a small hysteresis margin to prevent routing flicker when nodes
    // are near the overlap boundary. Also cache the routing decision during
    // the reveal phase to avoid visible flickering.
    const OVERLAP_MARGIN = 3;
    const xOverlap = (srcRight - OVERLAP_MARGIN) > tgtLeft && (tgtRight - OVERLAP_MARGIN) > srcLeft;

    const linkKey = srcId < tgtId ? `${srcId}:${tgtId}` : `${tgtId}:${srcId}`;
    const cachedSide = this.linkRoutingCache.get(linkKey);

    if (!xOverlap && dx >= 0) {
      // Target is to the right — exit from source's right edge, enter target's left edge
      if (cachedSide === 'left') {
        // Reuse previous decision to avoid flicker
        exitX = srcLeft;
        entryX = tgtRight;
      } else {
        exitX = srcRight;
        entryX = tgtLeft;
        this.linkRoutingCache.set(linkKey, 'right');
      }
      midX = (exitX + entryX) / 2;
    } else if (!xOverlap && dx < 0) {
      // Target is to the left — exit from source's left edge, enter target's right edge
      if (cachedSide === 'right') {
        exitX = srcRight;
        entryX = tgtLeft;
      } else {
        exitX = srcLeft;
        entryX = tgtRight;
        this.linkRoutingCache.set(linkKey, 'left');
      }
      midX = (exitX + entryX) / 2;
    } else {
      // X overlap — route around the outside
      const rightEdge = Math.max(srcRight, tgtRight);
      const leftEdge = Math.min(srcLeft, tgtLeft);
      const routeRight = rightEdge + 15;
      const routeLeft = leftEdge - 15;

      // Pick the shorter route, or reuse cached side
      const distRight = Math.abs(sx - routeRight) + Math.abs(tx - routeRight);
      const distLeft = Math.abs(sx - routeLeft) + Math.abs(tx - routeLeft);

      let useRight: boolean;
      if (cachedSide === 'right') useRight = true;
      else if (cachedSide === 'left') useRight = false;
      else useRight = distRight <= distLeft;

      if (useRight) {
        exitX = srcRight;
        entryX = tgtRight;
        midX = routeRight;
        this.linkRoutingCache.set(linkKey, 'right');
      } else {
        exitX = srcLeft;
        entryX = tgtLeft;
        midX = routeLeft;
        this.linkRoutingCache.set(linkKey, 'left');
      }
    }

    const pts: THREE.Vector3[] = [];

    if (Math.abs(sy - ty) < 0.5 && !xOverlap) {
      pts.push(new THREE.Vector3(exitX, sy, z));
      pts.push(new THREE.Vector3(entryX, ty, z));
    } else if (xOverlap) {
      pts.push(new THREE.Vector3(exitX, sy, z));
      pts.push(new THREE.Vector3(midX, sy, z));
      pts.push(new THREE.Vector3(midX, ty, z));
      pts.push(new THREE.Vector3(entryX, ty, z));
    } else {
      pts.push(new THREE.Vector3(exitX, sy, z));
      pts.push(new THREE.Vector3(midX, sy, z));
      pts.push(new THREE.Vector3(midX, ty, z));
      pts.push(new THREE.Vector3(entryX, ty, z));
    }

    return pts;
  }

  private updateLinkLine(
    obj: THREE.Group,
    coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
    link: any,
  ): boolean {
    const { start, end } = coords;
    if (isNaN(start.x) || isNaN(end.x)) return true;

    let sy = start.y;
    let ty = end.y;
    const sx = start.x;
    const tx = end.x;

    const srcId =
      typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId =
      typeof link.target === 'object' ? link.target.id : link.target;

    if (link.sourceColumn) {
      const off = this.nodeColumnOffsets.get(srcId);
      if (off?.has(link.sourceColumn)) sy += off.get(link.sourceColumn)!;
    }
    if (link.targetColumn) {
      const off = this.nodeColumnOffsets.get(tgtId);
      if (off?.has(link.targetColumn)) ty += off.get(link.targetColumn)!;
    }

    const z = this.p.linkHeight;

    const waypoints = this.buildOrthogonalPath(sx, sy, tx, ty, srcId, tgtId, z);

    // ── Update ribbon mesh positions & UVs ────────────────────
    const mesh = obj.children[0] as THREE.Mesh;
    if (!mesh) return true;

    const totalPts = waypoints.length;
    if (totalPts < 2) return true;

    // Compute total path length for UV mapping
    let totalLength = 0;
    const segLengths: number[] = [0];
    for (let i = 1; i < totalPts; i++) {
      const d = waypoints[i].distanceTo(waypoints[i - 1]);
      totalLength += d;
      segLengths.push(totalLength);
    }
    if (totalLength < 0.01) totalLength = 1;

    // Build ribbon vertices with proper handling of 90° corners.
    // At each bend point we duplicate vertices: one pair using the incoming
    // segment's perpendicular and one pair using the outgoing segment's
    // perpendicular. This prevents twisting/folding at orthogonal bends.
    const halfW = CABLE_WIDTH / 2;

    // Pre-compute per-segment tangent and perpendicular
    const tangents: THREE.Vector3[] = [];
    const perps: THREE.Vector3[] = [];
    for (let i = 0; i < totalPts - 1; i++) {
      const t = new THREE.Vector3().subVectors(waypoints[i + 1], waypoints[i]).normalize();
      tangents.push(t);
      perps.push(new THREE.Vector3(-t.y, t.x, 0).multiplyScalar(halfW));
    }

    // Build vertex list: at each inner waypoint that has a direction change
    // we emit two vertex-pairs (one closing the old segment, one starting the new).
    const positions: number[] = [];
    const uvs: number[] = [];

    const pushPair = (px: number, py: number, pz: number, perp: THREE.Vector3, u: number) => {
      positions.push(px + perp.x, py + perp.y, pz);
      positions.push(px - perp.x, py - perp.y, pz);
      uvs.push(u, 0, u, 1);
    };

    // First point — use raw world-space distance so stripe width is consistent
    pushPair(waypoints[0].x, waypoints[0].y, waypoints[0].z, perps[0], segLengths[0] * CABLE_STRIPE_WORLD_SCALE);

    // Inner points
    for (let i = 1; i < totalPts - 1; i++) {
      const u = segLengths[i] * CABLE_STRIPE_WORLD_SCALE;
      const p = waypoints[i];
      const prevPerp = perps[i - 1];
      const nextPerp = perps[i];

      // Check if direction changed (corner)
      const dot = tangents[i - 1].dot(tangents[i]);
      if (dot < 0.999) {
        // Corner — emit closing pair with old perp, then opening pair with new perp
        pushPair(p.x, p.y, p.z, prevPerp, u);
        pushPair(p.x, p.y, p.z, nextPerp, u);
      } else {
        // Straight — single pair
        pushPair(p.x, p.y, p.z, nextPerp, u);
      }
    }

    // Last point
    pushPair(
      waypoints[totalPts - 1].x, waypoints[totalPts - 1].y, waypoints[totalPts - 1].z,
      perps[perps.length - 1], segLengths[totalPts - 1] * CABLE_STRIPE_WORLD_SCALE,
    );

    const posArr = new Float32Array(positions);
    const uvArr = new Float32Array(uvs);
    const pairCount = posArr.length / 6; // number of vertex-pairs

    // Build triangle-strip index
    const newIndices: number[] = [];
    for (let i = 0; i < pairCount - 1; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      newIndices.push(a, c, b);
      newIndices.push(b, c, d);
    }

    // Rebuild geometry fully (positions may change count at corners)
    mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    mesh.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
    mesh.geometry.setIndex(newIndices);
    mesh.geometry.computeBoundingSphere();

    return true;
  }

  // ================================================================
  //  Helpers
  // ================================================================

  private getLinkColor(link: any): number {
    switch (link.type) {
      case 'inner':
        return C.linkInner;
      case 'left':
        return C.linkLeft;
      case 'right':
        return C.linkRight;
      case 'full':
        return C.linkFull;
      default:
        return C.linkDefault;
    }
  }

  private setCameraTarget(): void {
    this.cameraTarget.set(0, this.p.camY, this.p.camZ);
  }

  private fitCamera(): void {
    this.computeCameraTarget();
  }

  // ================================================================
  //  Animation loop
  // ================================================================

  private animate(): void {
    this.animFrameId = requestAnimationFrame(() => this.animate());
    const dt = this.clock.getDelta();

    // Update ground shader time
    if (this.groundUniforms['uTime']) {
      this.groundUniforms['uTime'].value += dt;
    }

    // Update cable shader time
    if (this.cableUniforms['uTime']) {
      this.cableUniforms['uTime'].value += dt;
    }

    // Must tick the force graph (sets node positions / syncs THREE wrappers).
    // Run during 'idle' AND 'settling' phases. During settling, the graph
    // is at SINK_DEPTH (invisible below ground clip plane), so the user
    // sees nothing while the simulation positions nodes.
    // Freeze during 'sinking' (old nodes animating down) and
    // 'revealing' (prevent position jitter during reveal wave).
    if (this.transitionPhase === 'idle' || this.transitionPhase === 'settling') {
      (this.graph as any).tickFrame();
    }

    // ── Step transitions (runs AFTER tickFrame so it can override positions) ──
    this.updateTransition(dt);

    // ── Smooth camera lerp ──────────────────────────────────────
    // Use a smoothly decaying speed to avoid jerk when transition ends.
    // Slower ramp (dt * 0.8) prevents sudden acceleration/deceleration.
    const targetSpeed = this.transitionPhase !== 'idle' ? 0.5 : this.cameraLerpSpeed;
    this.currentCameraSpeed += (targetSpeed - this.currentCameraSpeed) * Math.min(dt * 0.8, 1.0);
    const lerpFactor = 1.0 - Math.exp(-this.currentCameraSpeed * dt);
    this.camera.position.lerp(this.cameraTarget, lerpFactor);

    // Smooth lookAt — use a separate, gentler lerp for look target to prevent shaking
    const lookLerpFactor = 1.0 - Math.exp(-Math.min(this.currentCameraSpeed, 1.0) * dt);
    this.cameraLookCurrent.lerp(this.cameraLookTarget, lookLerpFactor);
    this.camera.lookAt(this.cameraLookCurrent);

    // Render
    this.composer.render();
  }

  // ================================================================
  //  Events
  // ================================================================

  @HostListener('window:resize')
  onResize(): void {
    const el = this.canvasRef.nativeElement;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'h' || e.key === 'H') {
      this.guiVisible = !this.guiVisible;
      if (this.guiVisible) {
        this.gui.show();
      } else {
        this.gui.hide();
      }
    }
  }
}
