import { Quaternion, Vector3 } from 'three';
import { utils } from '@sparkjsdev/spark';
import { EditSplats } from '../model/brushCommands';
import type { SplatEdit } from '../model/brushCommands';
import type { Document } from '../model/Document';
import type { Layer } from '../model/Layer';
import type { ToastLevel } from '../ui/hud';
import type { Viewer } from '../viewer/Viewer';
import { worldPerPixel } from './placement';
import { ScreenIndex } from './screenIndex';

export type BrushKind = 'recolor' | 'fade' | 'grab' | 'inflate';

export interface BrushSettings {
  kind: BrushKind;
  radiusPx: number;
  /** 0..1 — how much one pass changes a splat at the brush centre. */
  strength: number;
  /** Falloff towards the ring edge (true) or a hard-edged disc (false). */
  softEdge: boolean;
  /** Linear RGB 0..1 for the recolor brush. */
  colour: [number, number, number];
  /** Shift held at pointer-down: inverse operation where it makes sense (inflate → shrink, fade → restore). */
  inverse: boolean;
}

const BRUSH_LABELS: Record<BrushKind, string> = {
  recolor: 'Recolor',
  fade: 'Fade',
  grab: 'Grab',
  inflate: 'Inflate',
};

/** Resolves the layer a brush acts on: the active layer, else the only one; toasts why not otherwise. */
export function brushTarget(
  document: Document,
  notify: (message: string, level?: ToastLevel) => void,
): Layer | undefined {
  const layer =
    document.active() ?? (document.layers.length === 1 ? document.layers[0] : undefined);
  if (!layer) {
    notify('Select the layer to edit (brushes only affect the active layer).', 'warning');
    return undefined;
  }
  if (layer.locked) {
    notify(`“${layer.name}” is locked.`, 'warning');
    return undefined;
  }
  if (!layer.visible) {
    notify(`“${layer.name}” is hidden.`, 'warning');
    return undefined;
  }
  return layer;
}

/** Brush weight from the normalised distance to the brush centre. */
export function falloff(normalisedDistance: number, softEdge: boolean): number {
  if (!softEdge) return 1;
  const d = Math.min(1, Math.max(0, normalisedDistance));
  return 1 - d * d;
}

/**
 * Photoshop-style attribute brushes over the **active layer** (screen-space ring, one pass
 * per gesture per splat): Recolor (tint towards the brush colour), Fade (opacity; Shift
 * restores), Grab (drag splats along the screen plane), Inflate (scale; Shift shrinks).
 * Edits preview live in the packed GPU cache and commit as one `EditSplats` on release.
 */
export class SplatBrush {
  private readonly index: ScreenIndex;
  /** Store index → weight of the strongest pass so far. */
  private readonly weights = new Map<number, number>();
  /** Grab only: captured splats with per-splat world-per-pixel factors (depth-dependent). */
  private grabbed?: { indices: Uint32Array; weights: Float32Array; perPixel: Float32Array };
  private last?: { x: number; y: number };
  private start?: { x: number; y: number };
  private readonly toLocalRotation = new Quaternion();
  private readonly layerScale: number;

  static begin(
    viewer: Viewer,
    document: Document,
    settings: BrushSettings,
    notify: (message: string, level?: ToastLevel) => void,
  ): SplatBrush | undefined {
    const layer = brushTarget(document, notify);
    return layer ? new SplatBrush(viewer, document, layer, settings) : undefined;
  }

  private constructor(
    private readonly viewer: Viewer,
    private readonly document: Document,
    private readonly layer: Layer,
    private readonly settings: BrushSettings,
  ) {
    const rect = viewer.canvasElement.getBoundingClientRect();
    const started = performance.now();
    this.index = new ScreenIndex(layer, viewer, rect.width, rect.height);
    console.info(
      `${BRUSH_LABELS[settings.kind]} brush index for “${layer.name}” built in ${(performance.now() - started).toFixed(0)} ms`,
    );
    layer.object.updateMatrixWorld(true);
    const worldRotation = new Quaternion();
    const worldScale = new Vector3();
    layer.object.matrixWorld.decompose(new Vector3(), worldRotation, worldScale);
    this.toLocalRotation.copy(worldRotation).invert();
    this.layerScale = Math.max((worldScale.x + worldScale.y + worldScale.z) / 3, 1e-9);
  }

  get count(): number {
    return this.weights.size;
  }

  /** Canvas-relative pixel position (+ pressure) of a pointer sample. */
  moveTo(x: number, y: number, pressure = 1): void {
    const from = this.last ?? { x, y };
    this.last = { x, y };
    this.start ??= { x, y };
    const radius = this.settings.radiusPx;
    if (this.settings.kind === 'grab') {
      // Capture under the ring at pointer-down; afterwards everything captured follows the pointer.
      if (!this.grabbed) {
        const captured: number[] = [];
        const weights: number[] = [];
        this.index.within(x, y, radius, (index, d) => {
          captured.push(index);
          weights.push(falloff(d, this.settings.softEdge) * pressure);
        });
        const perPixel = new Float32Array(captured.length);
        captured.forEach((index, at) => {
          const depth = this.index.depth[index];
          perPixel[at] = worldPerPixel(this.viewer, Number.isFinite(depth) ? depth! : 1);
          this.weights.set(index, weights[at] ?? 0);
        });
        this.grabbed = {
          indices: Uint32Array.from(captured),
          weights: Float32Array.from(weights),
          perPixel,
        };
      }
      this.previewGrab(x - this.start.x, y - this.start.y);
      return;
    }
    const touched: number[] = [];
    this.index.sweep(from.x, from.y, x, y, radius, (index, d) => {
      const weight = falloff(d, this.settings.softEdge) * pressure;
      const previous = this.weights.get(index) ?? 0;
      if (weight > previous) {
        this.weights.set(index, weight);
        touched.push(index);
      }
    });
    if (touched.length) this.preview(touched);
  }

  /** Commits the gesture as one undo step. Returns the number of edited splats. */
  finish(): number {
    if (this.weights.size === 0) return 0;
    const edit = this.buildEdit();
    this.document.history.push(
      new EditSplats(this.document, this.layer.id, edit, BRUSH_LABELS[this.settings.kind]),
    );
    return edit.indices.length;
  }

  /** Drops the live preview without committing. */
  cancel(): void {
    if (this.weights.size === 0) return;
    this.layer.dirty = true;
    void this.layer.sync();
  }

  // ---- value functions (from the store's current values) ---------------------------------

  private editedColour(index: number, weight: number, out: Float32Array, at: number): void {
    const { colors } = this.layer.store;
    const [br, bg, bb] = this.settings.colour;
    const s = Math.min(1, this.settings.strength * weight);
    out[at] = (colors[index * 3] ?? 0.5) + (br - (colors[index * 3] ?? 0.5)) * s;
    out[at + 1] = (colors[index * 3 + 1] ?? 0.5) + (bg - (colors[index * 3 + 1] ?? 0.5)) * s;
    out[at + 2] = (colors[index * 3 + 2] ?? 0.5) + (bb - (colors[index * 3 + 2] ?? 0.5)) * s;
  }

  private editedOpacity(index: number, weight: number): number {
    const opacity = this.layer.store.opacities[index] ?? 1;
    const s = Math.min(1, this.settings.strength * weight);
    // Fade multiplies towards 0; Shift (inverse) restores towards 1.
    return this.settings.inverse ? opacity + (1 - opacity) * s : opacity * (1 - s);
  }

  private editedScales(index: number, weight: number, out: Float32Array, at: number): void {
    const { scales } = this.layer.store;
    const s = this.settings.strength * weight;
    const factor = this.settings.inverse ? 1 / (1 + s) : 1 + s;
    out[at] = (scales[index * 3] ?? 0) * factor;
    out[at + 1] = (scales[index * 3 + 1] ?? 0) * factor;
    out[at + 2] = (scales[index * 3 + 2] ?? 0) * factor;
  }

  /**
   * Layer-local screen axes for a pointer delta: camera right/up in layer space, per world
   * unit, scaled by strength. Per splat the displacement is these × perPixel(depth) × weight.
   */
  private grabAxes(): { right: Vector3; up: Vector3 } {
    const camera = this.viewer.camera;
    const right = new Vector3()
      .setFromMatrixColumn(camera.matrixWorld, 0)
      .normalize()
      .applyQuaternion(this.toLocalRotation)
      .divideScalar(this.layerScale)
      .multiplyScalar(this.settings.strength);
    const up = new Vector3()
      .setFromMatrixColumn(camera.matrixWorld, 1)
      .normalize()
      .applyQuaternion(this.toLocalRotation)
      .divideScalar(this.layerScale)
      .multiplyScalar(this.settings.strength);
    return { right, up };
  }

  /** Writes the grabbed centres for a pointer delta into `out` (3 per captured splat). */
  private grabbedCenters(dxPx: number, dyPx: number, out: Float32Array): void {
    const grabbed = this.grabbed;
    if (!grabbed) return;
    const { centers } = this.layer.store;
    const { right, up } = this.grabAxes();
    for (let at = 0; at < grabbed.indices.length; at += 1) {
      const index = grabbed.indices[at]!;
      const k = grabbed.perPixel[at]! * grabbed.weights[at]!;
      const mx = (right.x * dxPx - up.x * dyPx) * k;
      const my = (right.y * dxPx - up.y * dyPx) * k;
      const mz = (right.z * dxPx - up.z * dyPx) * k;
      out[at * 3] = (centers[index * 3] ?? 0) + mx;
      out[at * 3 + 1] = (centers[index * 3 + 1] ?? 0) + my;
      out[at * 3 + 2] = (centers[index * 3 + 2] ?? 0) + mz;
    }
  }

  // ---- preview / commit -----------------------------------------------------------------

  private preview(indices: number[]): void {
    const packed = this.layer.mesh.packedSplats;
    const array = packed?.packedArray;
    if (!packed || !array) return;
    const map = this.layer.storeToPacked();
    const encoding = packed.splatEncoding;
    const tmp = new Float32Array(3);
    for (const index of indices) {
      const packedIndex = map[index] ?? -1;
      if (packedIndex < 0) continue;
      const weight = this.weights.get(index) ?? 0;
      if (this.settings.kind === 'recolor') {
        this.editedColour(index, weight, tmp, 0);
        utils.setPackedSplatRgb(array, packedIndex, tmp[0]!, tmp[1]!, tmp[2]!, encoding);
      } else if (this.settings.kind === 'fade') {
        utils.setPackedSplatOpacity(array, packedIndex, this.editedOpacity(index, weight));
      } else {
        this.editedScales(index, weight, tmp, 0);
        utils.setPackedSplatScales(array, packedIndex, tmp[0]!, tmp[1]!, tmp[2]!, encoding);
      }
    }
    packed.needsUpdate = true;
    this.layer.mesh.updateVersion();
  }

  private previewGrab(dxPx: number, dyPx: number): void {
    const packed = this.layer.mesh.packedSplats;
    const array = packed?.packedArray;
    const grabbed = this.grabbed;
    if (!packed || !array || !grabbed) return;
    const map = this.layer.storeToPacked();
    const centers = new Float32Array(grabbed.indices.length * 3);
    this.grabbedCenters(dxPx, dyPx, centers);
    for (let at = 0; at < grabbed.indices.length; at += 1) {
      const packedIndex = map[grabbed.indices[at]!] ?? -1;
      if (packedIndex < 0) continue;
      utils.setPackedSplatCenter(
        array,
        packedIndex,
        centers[at * 3]!,
        centers[at * 3 + 1]!,
        centers[at * 3 + 2]!,
      );
    }
    packed.needsUpdate = true;
    this.layer.mesh.updateVersion();
  }

  private buildEdit(): SplatEdit {
    const indices = Uint32Array.from(this.weights.keys());
    const n = indices.length;
    switch (this.settings.kind) {
      case 'recolor': {
        const colors = new Float32Array(n * 3);
        indices.forEach((index, at) =>
          this.editedColour(index, this.weights.get(index) ?? 0, colors, at * 3),
        );
        return { indices, colors };
      }
      case 'fade': {
        const opacities = new Float32Array(n);
        indices.forEach((index, at) => {
          opacities[at] = this.editedOpacity(index, this.weights.get(index) ?? 0);
        });
        return { indices, opacities };
      }
      case 'inflate': {
        const scales = new Float32Array(n * 3);
        indices.forEach((index, at) =>
          this.editedScales(index, this.weights.get(index) ?? 0, scales, at * 3),
        );
        return { indices, scales };
      }
      case 'grab': {
        const grabbed = this.grabbed ?? {
          indices,
          weights: new Float32Array(n),
          perPixel: new Float32Array(n),
        };
        const centers = new Float32Array(grabbed.indices.length * 3);
        const dx = (this.last?.x ?? 0) - (this.start?.x ?? 0);
        const dy = (this.last?.y ?? 0) - (this.start?.y ?? 0);
        this.grabbedCenters(dx, dy, centers);
        return { indices: grabbed.indices, centers };
      }
    }
  }
}
