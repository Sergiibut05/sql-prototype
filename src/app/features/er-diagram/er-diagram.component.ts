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
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import GUI from 'lil-gui';
import { Subscription } from 'rxjs';

import { SqlParserService } from '../../core/services/sql-parser.service';
import { QuerySimulatorService } from '../../core/services/query-simulator.service';
import { GraphNode, GraphData } from '../../shared/models/graph.model';
import { GroundCrossesShader } from './shaders/ground-crosses-shader';
import { VignetteShader } from './shaders/vignette-shader';

// ── Layout constants ──────────────────────────────────────────────
const ROW_HEIGHT = 3.5;
const HEADER_HEIGHT = 5;
const NODE_WIDTH = 38;
const NODE_PADDING = 1.5;
const TABLE_DEPTH = 2.0;
const CANVAS_SCALE = 14; // px per graph unit for textures
const MAX_CURVE_PTS = 48;

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
  private bloomPass!: UnrealBloomPass;

  // ── Disposables ───────────────────────────────────────────────
  private subs = new Subscription();
  private textures: THREE.Texture[] = [];

  // ── Debug params ──────────────────────────────────────────────
  private p = {
    camY: 200,
    camZ: 160,
    fov: 50,
    collideRadius: 30,
    collideStrength: 1.0,
    collideIter: 5,
    bloomStr: 0.45,
    bloomRad: 0.35,
    bloomThr: 0.35,
    vigInt: 0.65,
    vigSoft: 0.42,
    crossDensity: 0.06,
    crossSize: 0.012,
    crossFade: 500,
    linkHeight: TABLE_DEPTH + 0.5,
    chargeStr: -80,
    alphaDecay: 0.02,
    velDecay: 0.3,
  };

  constructor(
    private sqlParser: SqlParserService,
    public simulator: QuerySimulatorService,
    private ngZone: NgZone,
  ) {}

  // ================================================================
  //  Lifecycle
  // ================================================================

  ngAfterViewInit(): void {
    this.totalSteps = this.simulator.totalSteps;
    this.initThreeJS();
    this.initPostProcessing();
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
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    // ── Lights ────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x8090c0, 0.5);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x6070a0, 0x101828, 0.4);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xc0c8ff, 1.2);
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

    const fill = new THREE.DirectionalLight(0x7080c0, 0.4);
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
  //  Post-processing
  // ================================================================

  private initPostProcessing(): void {
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Bloom
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      this.p.bloomStr,
      this.p.bloomRad,
      this.p.bloomThr,
    );
    this.composer.addPass(this.bloomPass);

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
      .warmupTicks(60)
      .cooldownTime(8000);

    // Collision force
    (this.graph as any).d3Force(
      'collide',
      forceCollide()
        .radius((d: any) => {
          const dims = this.nodeDimensions.get(d.id);
          if (dims) {
            return Math.sqrt(dims.w ** 2 + dims.h ** 2) / 2 + 6;
          }
          return this.p.collideRadius;
        })
        .strength(this.p.collideStrength)
        .iterations(this.p.collideIter),
    );

    // Adjust charge force
    (this.graph as any)
      .d3Force('charge')
      ?.strength(this.p.chargeStr);

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
    cam.add(this.p, 'camY', 50, 500, 1).onChange(() => this.applyCam());
    cam.add(this.p, 'camZ', 0, 400, 1).onChange(() => this.applyCam());
    cam.add(this.p, 'fov', 20, 90, 1).onChange(() => {
      this.camera.fov = this.p.fov;
      this.camera.updateProjectionMatrix();
    });

    // Layout
    const layout = this.gui.addFolder('Layout');
    layout.add(this.p, 'collideRadius', 10, 80, 1);
    layout.add(this.p, 'chargeStr', -200, 0, 1).onChange(() => {
      (this.graph as any).d3Force('charge')?.strength(this.p.chargeStr);
      (this.graph as any).d3ReheatSimulation?.();
    });
    layout.add(this.p, 'linkHeight', 0, 8, 0.1);

    // Bloom
    const bloom = this.gui.addFolder('Bloom');
    bloom.add(this.p, 'bloomStr', 0, 2, 0.01).onChange(() => {
      this.bloomPass.strength = this.p.bloomStr;
    });
    bloom.add(this.p, 'bloomRad', 0, 2, 0.01).onChange(() => {
      this.bloomPass.radius = this.p.bloomRad;
    });
    bloom.add(this.p, 'bloomThr', 0, 1, 0.01).onChange(() => {
      this.bloomPass.threshold = this.p.bloomThr;
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
    gnd.add(this.p, 'crossFade', 100, 1500, 10).onChange(() => {
      this.groundUniforms['uFadeDistance'].value = this.p.crossFade;
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
        this.applyGraphData(data);
      }),
    );
    this.subs.add(
      this.simulator.currentStep$.subscribe((s) => (this.currentStep = s)),
    );
    this.subs.add(
      this.simulator.running$.subscribe((r) => (this.isRunning = r)),
    );
  }

  private applyGraphData(data: GraphData): void {
    (this.graph as any).graphData({
      nodes: data.nodes,
      links: data.links,
    });
    // Fit camera after layout settles
    setTimeout(() => this.fitCamera(), 1500);
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
      // header at +Y end, columns descend
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

    // Material array: [+x, -x, +y, -y, +z (top), -z (bottom)]
    const sideMat = new THREE.MeshStandardMaterial({
      color: C.tableSide,
      roughness: 0.85,
      metalness: 0.05,
    });
    const bottomMat = new THREE.MeshStandardMaterial({
      color: 0x0a0e17,
      roughness: 1,
      metalness: 0,
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
    });

    // Edge highlight material (Y sides)
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0x2a2060,
      roughness: 0.6,
      metalness: 0.15,
      emissive: 0x1a1050,
      emissiveIntensity: 0.3,
    });

    const body = new THREE.Mesh(bodyGeo, [
      sideMat, // +X
      sideMat, // -X
      edgeMat, // +Y  (header edge after rotation → front/back edge)
      edgeMat, // -Y
      topMat, // +Z  (top face → faces UP after graph rotation)
      bottomMat, // -Z (bottom → faces down, on ground)
    ]);
    body.position.z = TABLE_DEPTH / 2; // lift so bottom sits at z=0
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

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
    grad.addColorStop(0, C.headerStart);
    grad.addColorStop(1, C.headerEnd);
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

      // Alternating row bg
      ctx.fillStyle = i % 2 === 0 ? C.rowEven : C.rowOdd;
      ctx.fillRect(0, y, cW, rowH);

      // FK icon
      ctx.fillStyle = '#fbbf24';
      ctx.font = `${Math.round(colFont * 0.85)}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u25C6', 10, y + rowH / 2); // diamond marker

      // Column name
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

  // ================================================================
  //  Link (connector) rendering
  // ================================================================

  private createLinkLine(link: any): THREE.Object3D {
    const group = new THREE.Group();
    const color = this.getLinkColor(link);

    // Outer glow
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(MAX_CURVE_PTS * 3), 3),
    );
    const glowMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    group.add(new THREE.Line(glowGeo, glowMat));

    // Core line
    const coreGeo = new THREE.BufferGeometry();
    coreGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(MAX_CURVE_PTS * 3), 3),
    );
    const coreMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
    });
    group.add(new THREE.Line(coreGeo, coreMat));

    // Arrow cone at target
    const coneGeo = new THREE.ConeGeometry(1.2, 3.5, 6);
    const coneMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.4,
      roughness: 0.5,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.visible = false;
    group.add(cone);

    return group;
  }

  private updateLinkLine(
    obj: THREE.Group,
    coords: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } },
    link: any,
  ): boolean {
    const { start, end } = coords;
    if (isNaN(start.x) || isNaN(end.x)) return true;

    // ── Source / target positions ────────────────────────────
    let sx = start.x,
      sy = start.y;
    let tx = end.x,
      ty = end.y;

    // Column Y-offsets
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

    const z = this.p.linkHeight; // above table top
    const halfW = NODE_WIDTH / 2 + 3;

    // ── Waypoints for orthogonal-ish routing ─────────────────
    let waypoints: THREE.Vector3[];
    const dx = tx - sx;

    if (Math.abs(dx) < NODE_WIDTH * 0.6) {
      // Nodes nearly aligned on X → route around to one side
      const routeX =
        Math.max(sx, tx) + halfW + 12;
      waypoints = [
        new THREE.Vector3(sx + halfW, sy, z),
        new THREE.Vector3(routeX, sy, z),
        new THREE.Vector3(routeX, ty, z),
        new THREE.Vector3(tx + halfW, ty, z),
      ];
    } else {
      const exitDir = dx > 0 ? 1 : -1;
      const exitX = sx + halfW * exitDir;
      const enterX = tx - halfW * exitDir;
      const midX = (exitX + enterX) / 2;
      waypoints = [
        new THREE.Vector3(exitX, sy, z),
        new THREE.Vector3(midX, sy, z),
        new THREE.Vector3(midX, ty, z),
        new THREE.Vector3(enterX, ty, z),
      ];
    }

    // Smooth curve
    const curve = new THREE.CatmullRomCurve3(
      waypoints,
      false,
      'catmullrom',
      0.3,
    );
    const pts = curve.getPoints(MAX_CURVE_PTS - 1);

    // Update glow + core geometries
    const flat = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      flat[i * 3] = pts[i].x;
      flat[i * 3 + 1] = pts[i].y;
      flat[i * 3 + 2] = pts[i].z;
    }

    const glowLine = obj.children[0] as THREE.Line;
    const coreLine = obj.children[1] as THREE.Line;
    const cone = obj.children[2] as THREE.Mesh;

    const updateGeo = (line: THREE.Line) => {
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      (attr.array as Float32Array).set(flat);
      attr.needsUpdate = true;
      line.geometry.setDrawRange(0, pts.length);
      line.geometry.computeBoundingSphere();
    };

    updateGeo(glowLine);
    updateGeo(coreLine);

    // Arrow cone at end
    if (pts.length >= 2) {
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      cone.position.copy(last);
      const dir = new THREE.Vector3()
        .subVectors(last, prev)
        .normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
      cone.setRotationFromQuaternion(quat);
      cone.visible = true;
    }

    return true; // skip default positioning
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

  private applyCam(): void {
    this.camera.position.set(0, this.p.camY, this.p.camZ);
    this.camera.lookAt(0, 0, 0);
  }

  private fitCamera(): void {
    const data = (this.graph as any).graphData();
    if (!data?.nodes?.length) return;

    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;

    for (const n of data.nodes) {
      if (n.x != null) {
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x);
      }
      if (n.y != null) {
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
      }
    }

    if (!isFinite(minX)) return;

    const spanX = maxX - minX + NODE_WIDTH * 2;
    const spanY = maxY - minY + 40;
    const span = Math.max(spanX, spanY, 80);

    const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = span / (2 * Math.tan(fovRad / 2));

    this.p.camY = dist * 0.85 + 40;
    this.p.camZ = dist * 0.5 + 30;
    this.applyCam();
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

    // Render via composer (RenderPass triggers graph's onBeforeRender)
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
    this.bloomPass.setSize(w, h);
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
