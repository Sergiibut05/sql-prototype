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
import GUI from 'lil-gui';
import { Subscription } from 'rxjs';

import { SqlParserService } from '../../core/services/sql-parser.service';
import { SqlglotParserService } from '../../core/services/sqlglot-parser.service';
import { QuerySimulatorService } from '../../core/services/query-simulator.service';
import { GraphData } from '../../shared/models/graph.model';

import { createDefaultParams, ErDebugParams } from './systems/er-debug-params';
import { ErSceneManager } from './systems/er-scene-manager';
import { ErPostProcessingManager } from './systems/er-post-processing-manager';
import { ErParticleSystem } from './systems/er-particle-system';
import { ErTableRenderer } from './systems/er-table-renderer';
import { ErLinkRenderer } from './systems/er-link-renderer';
import { ErTransitionManager } from './systems/er-transition-manager';
import { ErHoverManager } from './systems/er-hover-manager';
import { ErCameraManager } from './systems/er-camera-manager';
import { setupGraph } from './systems/er-graph-setup';
import { setupGUI } from './systems/er-gui-setup';

@Component({
  selector: 'app-er-diagram',
  standalone: true,
  templateUrl: './er-diagram.component.html',
  styleUrls: ['./er-diagram.component.scss'],
})
export class ErDiagramComponent implements AfterViewInit, OnDestroy {
  @ViewChild('rendererCanvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  // ── Template-bound state ──────────────────────────────────────────────────
  currentQuery = '';
  currentStep = 0;
  totalSteps = 0;
  isRunning = false;
  showQuery = false;

  // ── Debug params (single source of truth for all tunable values) ──────────
  private p: ErDebugParams = createDefaultParams();

  // ── Systems ───────────────────────────────────────────────────────────────
  private sceneManager!: ErSceneManager;
  private postFx!: ErPostProcessingManager;
  private particles!: ErParticleSystem;
  private tableRenderer!: ErTableRenderer;
  private linkRenderer!: ErLinkRenderer;
  private cameraManager!: ErCameraManager;
  private transitionMgr!: ErTransitionManager;
  private hoverManager!: ErHoverManager;
  private graph!: ThreeForceGraph;
  private gui!: GUI;
  private guiVisible = false;

  // ── Animation ─────────────────────────────────────────────────────────────
  private animFrameId = 0;
  private clock = new THREE.Clock();
  private subs = new Subscription();

  constructor(
    private sqlParser: SqlParserService,
    private sqlglotParser: SqlglotParserService,
    public simulator: QuerySimulatorService,
    private ngZone: NgZone,
  ) { }

  // ================================================================
  //  Lifecycle
  // ================================================================

  ngAfterViewInit(): void {
    this.totalSteps = this.simulator.totalSteps;
    const canvas = this.canvasRef.nativeElement;

    // 1. Core scene (renderer, camera, lights, ground)
    this.sceneManager = new ErSceneManager(canvas, this.p);

    // 2. Post-processing (bloom + vignette)
    this.postFx = new ErPostProcessingManager(
      this.sceneManager.renderer,
      this.sceneManager.scene,
      this.sceneManager.camera,
      this.p,
    );

    // 3. Particle system
    this.particles = new ErParticleSystem(this.sceneManager.scene, this.p);

    // 4. Table renderer (node 3D mesh + canvas texture)
    this.tableRenderer = new ErTableRenderer(this.sceneManager.groundClipPlane, this.p);

    // 5. Link renderer (cable ribbon + cable shader uniforms)
    this.linkRenderer = new ErLinkRenderer(
      this.sceneManager.groundClipPlane,
      this.tableRenderer.nodeColumnOffsets,
      this.tableRenderer.nodeDimensions,
      this.p,
    );

    // 6. Camera manager
    this.cameraManager = new ErCameraManager(this.sceneManager.camera, this.p);

    // 7. Force graph — wires nodes/links to the renderers
    this.graph = setupGraph(
      this.sceneManager.scene,
      this.p,
      this.tableRenderer,
      this.linkRenderer,
    );

    // 8. Transition state machine
    this.transitionMgr = new ErTransitionManager(
      this.graph,
      this.tableRenderer,
      this.linkRenderer,
      this.cameraManager,
      this.p,
    );

    // 9. Hover / raycast
    this.hoverManager = new ErHoverManager(
      this.graph,
      this.sceneManager.camera,
      this.tableRenderer.nodeThreeObjects,
      this.p,
      () => this.transitionMgr.phase,
    );

    // 10. Debug GUI
    this.gui = setupGUI(
      this.p,
      this.sceneManager,
      this.postFx,
      this.tableRenderer,
      this.linkRenderer,
      this.cameraManager,
      this.particles,
      this.graph,
    );
    // Add parser folder here so the component can supply the re-parse callback
    const parserFolder = this.gui.folders.find(f => f._title === 'Parser');
    if (parserFolder) {
      parserFolder.add(this.p, 'useParser', ['node-sql-parser', 'sqlglot'])
        .name('Engine')
        .onChange(() => {
          console.log(`Switched parser to: ${this.p.useParser}`);
          if (this.currentQuery) this.parseAndTransition(this.currentQuery);
        });
    }

    // 11. Mouse tracking for hover
    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      this.hoverManager.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.hoverManager.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverManager.mouse.set(-999, -999);
    });

    // 12. Start
    this.subscribeToSimulator();
    this.simulator.start();
    this.ngZone.runOutsideAngular(() => this.animate());
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animFrameId);
    this.subs.unsubscribe();
    this.gui?.destroy();
    this.tableRenderer?.dispose();
    this.postFx?.dispose();
    this.sceneManager?.dispose();
  }

  // ================================================================
  //  Simulator subscription
  // ================================================================

  private subscribeToSimulator(): void {
    this.subs.add(
      this.simulator.currentQuery$.subscribe(q => {
        if (!q) return;
        this.currentQuery = q;
        this.parseAndTransition(q);
      }),
    );
    this.subs.add(this.simulator.currentStep$.subscribe(s => (this.currentStep = s)));
    this.subs.add(this.simulator.running$.subscribe(r => (this.isRunning = r)));
  }

  /**
   * Parse SQL with the selected engine and hand the result to the
   * transition manager. sqlglot is async (HTTP); node-sql-parser is sync.
   */
  private parseAndTransition(sql: string): void {
    if (this.p.useParser === 'sqlglot') {
      this.sqlglotParser.parseQuery(sql, 'postgres').subscribe((data: GraphData) => {
        if (data.nodes.length === 0) {
          console.warn('sqlglot returned empty, falling back to node-sql-parser');
          const fallback = this.sqlParser.parseQueryToGraph(sql);
          this.transitionMgr.handleStepTransition(fallback);
        } else {
          this.transitionMgr.handleStepTransition(data);
        }
      });
    } else {
      const data = this.sqlParser.parseQueryToGraph(sql);
      this.transitionMgr.handleStepTransition(data);
    }
  }

  // ================================================================
  //  Animation loop
  // ================================================================

  private animate(): void {
    this.animFrameId = requestAnimationFrame(() => this.animate());
    const dt = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime;

    // Advance shader time uniforms
    this.sceneManager.updateGroundTime(dt);
    this.linkRenderer.updateTime(dt);

    // Tick the force-graph simulation (positions nodes / syncs THREE wrappers)
    // Frozen during 'sinking' and 'revealing' to prevent jitter
    const phase = this.transitionMgr.phase;
    if (phase === 'idle' || phase === 'settling') {
      (this.graph as any).tickFrame();
    }

    // State machine (sink → settle → reveal)
    this.transitionMgr.update(dt);

    // Smooth camera lerp
    this.cameraManager.update(dt, phase);

    // Particles
    this.particles.update(dt, elapsed);

    // Hover effects
    this.hoverManager.update(dt);

    // Render through the post-processing composer
    this.postFx.render();
  }

  // ================================================================
  //  Window events
  // ================================================================

  @HostListener('window:resize')
  onResize(): void {
    const el = this.canvasRef.nativeElement;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    this.sceneManager.resize(w, h);
    this.postFx.resize(w, h);
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'h' || e.key === 'H') {
      this.guiVisible = !this.guiVisible;
      this.guiVisible ? this.gui.show() : this.gui.hide();
    }
  }
}
