import * as THREE from 'three';
import { ErDebugParams } from './er-debug-params';

/**
 * Manages the floating luminous-dust particle system.
 */
export class ErParticleSystem {
    readonly points: THREE.Points;
    readonly positions: Float32Array;
    readonly velocities: Float32Array;

    private static readonly COUNT = 800;
    private static readonly SPREAD = 600;
    private static readonly HEIGHT = 100;

    constructor(scene: THREE.Scene, p: ErDebugParams) {
        const { COUNT, SPREAD, HEIGHT } = ErParticleSystem;

        this.positions = new Float32Array(COUNT * 3);
        this.velocities = new Float32Array(COUNT * 3);

        for (let i = 0; i < COUNT; i++) {
            this.positions[i * 3] = (Math.random() - 0.5) * SPREAD;
            this.positions[i * 3 + 1] = Math.random() * HEIGHT;
            this.positions[i * 3 + 2] = (Math.random() - 0.5) * SPREAD;
            // Gentle upward drift + slight horizontal drift
            this.velocities[i * 3] = (Math.random() - 0.5) * 0.3;
            this.velocities[i * 3 + 1] = 0.2 + Math.random() * 0.4;
            this.velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

        // Small glowing circle texture
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d')!;
        const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
        grad.addColorStop(0, 'rgba(180,200,255,1)');
        grad.addColorStop(0.4, 'rgba(120,140,255,0.4)');
        grad.addColorStop(1, 'rgba(60,80,200,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 32, 32);

        const mat = new THREE.PointsMaterial({
            size: p.particleSize,
            map: new THREE.CanvasTexture(canvas),
            transparent: true,
            opacity: p.particleOpacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            sizeAttenuation: true,
        });

        this.points = new THREE.Points(geo, mat);
        scene.add(this.points);
    }

    /** Advance particle positions each frame. */
    update(dt: number, time: number): void {
        const count = this.positions.length / 3;
        for (let i = 0; i < count; i++) {
            const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
            this.positions[ix] += this.velocities[ix] * dt + Math.sin(time * 0.3 + i) * 0.02;
            this.positions[iy] += this.velocities[iy] * dt;
            this.positions[iz] += this.velocities[iz] * dt + Math.cos(time * 0.2 + i * 0.7) * 0.02;

            // Recycle particles that float too high
            if (this.positions[iy] > 100) {
                this.positions[iy] = -5;
                this.positions[ix] = (Math.random() - 0.5) * 600;
                this.positions[iz] = (Math.random() - 0.5) * 600;
            }
        }
        (this.points.geometry.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
    }
}
