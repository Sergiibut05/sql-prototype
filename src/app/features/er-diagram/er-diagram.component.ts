import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  NgZone,
  HostListener,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
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
  imports: [FormsModule],
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
  showQuery = true;

  /** 'demo' auto-plays the sample queries; 'custom' lets the visitor type their own SQL. */
  mode: 'demo' | 'custom' = 'demo';
  sqlInput = '';
  parseError: string | null = null;

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
  ) {
    this.totalSteps = this.simulator.totalSteps;
  }

  // ================================================================
  //  Lifecycle
  // ================================================================

  ngAfterViewInit(): void {
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

    // 12. Start (deferred a tick so the first simulator emission lands in its
    // own change-detection cycle instead of mutating state mid-render, which
    // Angular's dev mode flags as ExpressionChangedAfterItHasBeenChecked).
    setTimeout(() => {
      this.subscribeToSimulator();
      this.simulator.start();
    });
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
  private parseAndTransition(sql: string, onDone?: (data: GraphData) => void): void {
    if (this.p.useParser === 'sqlglot') {
      this.sqlglotParser.parseQuery(sql, 'postgres').subscribe((data: GraphData) => {
        if (data.nodes.length === 0) {
          console.warn('sqlglot returned empty, falling back to node-sql-parser');
          const fallback = this.sqlParser.parseQueryToGraph(sql);
          this.processKeys(fallback);
          this.transitionMgr.handleStepTransition(fallback);
          onDone?.(fallback);
        } else {
          this.processKeys(data);
          this.transitionMgr.handleStepTransition(data);
          onDone?.(data);
        }
      });
    } else {
      const data = this.sqlParser.parseQueryToGraph(sql);
      this.processKeys(data);
      this.transitionMgr.handleStepTransition(data);
      onDone?.(data);
    }
  }

  // ================================================================
  //  Custom SQL input (visitor-facing)
  // ================================================================

  /** Switch to the "write your own SQL" mode, pausing the auto-playing demo. */
  switchToCustom(): void {
    if (this.mode === 'custom') return;
    this.mode = 'custom';
    this.parseError = null;
    this.simulator.stop();
    if (!this.sqlInput.trim()) this.sqlInput = this.currentQuery;
    this.showQuery = true;
  }

  /** Switch back to the auto-playing demo. */
  switchToDemo(): void {
    if (this.mode === 'demo') return;
    this.mode = 'demo';
    this.parseError = null;
    this.simulator.start();
  }

  /** Parse and visualize whatever SQL the visitor typed into the editor. */
  runCustomQuery(): void {
    const sql = this.sqlInput.trim();
    if (!sql) return;

    this.parseError = null;
    this.currentQuery = sql;
    this.parseAndTransition(sql, (data) => {
      if (data.nodes.length === 0) {
        this.parseError = 'No se han detectado tablas: revisa la sintaxis SQL.';
      }
    });
  }

  /**
   * Annotate nodes with precisely which columns are used as keys (in links)
   * so the renderer doesn't have to guess based on column names like 'id' or 'fk'.
   */
  private processKeys(data: GraphData): void {
    const keyMap = new Map<string, Set<string>>();
    data.links.forEach(l => {
      const src = typeof l.source === 'string' ? l.source : l.source.id;
      const tgt = typeof l.target === 'string' ? l.target : l.target.id;

      // Only annotate the target (destination) side of the relationship as the foreign key
      if (tgt && l.targetColumn) {
        if (!keyMap.has(tgt)) keyMap.set(tgt, new Set());
        keyMap.get(tgt)!.add(l.targetColumn);
      }
    });

    data.nodes.forEach(n => {
      const keys = keyMap.get(n.id);
      (n as any).keyColumns = keys ? Array.from(keys) : [];
    });
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

    // Smooth camera lerp and cinematic drifting
    this.cameraManager.update(dt, elapsed, phase);

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
