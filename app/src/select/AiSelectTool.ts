import { maskArea } from '../ai/maskDecode';
import type { MaskCandidates, PromptPoint } from '../ai/maskDecode';
import { LabelSession } from '../ai/labelSession';
import { SamSession } from '../ai/samSession';
import type { CapturedFrame } from '../viewer/Viewer';
import type { Layer } from '../model/Layer';
import { DepthGrid } from '../sketch/depthGrid';
import { ScreenIndex } from '../sketch/screenIndex';
import type { ToastLevel } from '../ui/hud';
import type { Viewer } from '../viewer/Viewer';
import { autoSegment, DEFAULT_AUTO_SETTINGS, groupBounds } from './autoSegment';
import { cropFrame } from '../ai/framePixels';
import { growSelection, liftMask } from './maskLift';
import { MaskOverlay } from './maskOverlay';
import type { Segmentation } from './Segmentation';

export interface AiSelectOptions {
  notify: (message: string, level?: ToastLevel) => void;
}

/** Tunables the SEGMENT panel drives. */
export interface AiSelectSettings {
  /**
   * How far behind the front surface a splat may sit and still be taken, as a fraction of
   * the layer's radius. At the maximum the depth test is off and this is plain frustum
   * projection — the whole column under the mask, wall included.
   */
  depthTolerance: number;
  /** Flood-fill hops used to repair the silhouette the mask cut through. */
  growSteps: number;
  /** Points per side of the "segment everything" sampling grid. */
  density: number;
}

export const DEFAULT_AI_SETTINGS: AiSelectSettings = {
  depthTolerance: 0.02,
  growSteps: 1,
  density: DEFAULT_AUTO_SETTINGS.density,
};
/** The tolerance slider's top stop means "no occlusion test at all". */
export const FRUSTUM_TOLERANCE = 1;

/**
 * Click-to-segment, after ArtisanGS (arXiv 2602.10173): SAM proposes a 2D mask from a few
 * clicks on the rendered view, and the mask is lifted to a 3D splat selection by depth
 * projection.
 *
 * The interaction is built around one performance fact — SAM's image encoder is slow and
 * its mask decoder is not. So the view is encoded once when the tool is entered (camera
 * locked, because moving it invalidates the embedding) and every subsequent click is a
 * decoder-only round trip. That is what makes a negative click feel like erasing rather
 * than like re-running a job.
 *
 * Unlike the paper this is single-view: the far side of an object is never selected,
 * because nothing here reasons about geometry the camera cannot see.
 *
 * Events: `changed` — any state the panel renders (points, candidates, busy).
 */
export class AiSelectTool extends EventTarget {
  readonly session = new SamSession();
  readonly labels = new LabelSession();
  /** Name objects with CLIP after segmenting. Off falls back to "Object n". */
  nameObjects = true;
  settings: AiSelectSettings = { ...DEFAULT_AI_SETTINGS };
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: MaskOverlay;
  private points: PromptPoint[] = [];
  private candidates?: MaskCandidates;
  private chosen = 0;
  private busyValue = false;
  private progressValue = '';
  private layer?: Layer;
  /** Bumped per prompt so a slow decode that lost the race cannot overwrite a newer one. */
  private sequence = 0;
  /** Shared so the toolbar button and the tool activation cannot both encode the view. */
  private beginInFlight?: Promise<void>;
  /** The frame the view was encoded from, kept so the namer can crop objects out of it. */
  private frame?: CapturedFrame;

  constructor(
    private readonly viewer: Viewer,
    private readonly segmentation: Segmentation,
    private readonly options: AiSelectOptions,
  ) {
    super();
    this.canvas = viewer.canvasElement;
    this.overlay = new MaskOverlay(this.canvas);
    this.overlay.setVisible(false);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.viewer.addEventListener('tool-changed', this.onToolChanged);
    this.viewer.addEventListener('document-changed', this.reset);
    this.session.addEventListener('state-changed', this.emitChange);
    this.labels.addEventListener('state-changed', this.emitChange);
    this.session.addEventListener('progress', this.onProgress);
    window.addEventListener('keydown', this.onKeyDown);
  }

  get active(): boolean {
    return this.viewer.tool === 'aiselect';
  }
  get busy(): boolean {
    return this.busyValue;
  }
  /** What the tool is doing right now, for the panel to show during a long run. */
  get progress(): string {
    return this.progressValue;
  }
  get promptPoints(): readonly PromptPoint[] {
    return this.points;
  }
  /** How many alternatives SAM offered for the current prompt, and which one is showing. */
  get candidateCount(): number {
    return this.candidates?.masks.length ?? 0;
  }
  get candidateIndex(): number {
    return this.chosen;
  }
  /** True when there is a mask on screen waiting to be committed. */
  get hasProposal(): boolean {
    return this.candidates !== undefined;
  }

  setSettings(settings: Partial<AiSelectSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.emitChange();
  }

  /** Cycles through SAM's alternative interpretations of the same clicks. */
  cycleCandidate(step: number): void {
    if (!this.candidates || this.candidates.masks.length === 0) return;
    const count = this.candidates.masks.length;
    this.chosen = (this.chosen + step + count) % count;
    this.overlay.setMask(this.candidates.masks[this.chosen]);
    this.emitChange();
  }

  /** Loads the model (if needed) and encodes the current view. */
  async begin(): Promise<void> {
    return (this.beginInFlight ??= this.beginOnce().finally(() => {
      this.beginInFlight = undefined;
    }));
  }

  private async beginOnce(): Promise<void> {
    const layer = this.segmentation.targetLayer();
    if (!layer) {
      this.options.notify('Select a layer to segment first.', 'warning');
      return;
    }
    if (layer.locked) {
      this.options.notify('That layer is locked.', 'warning');
      return;
    }
    this.layer = layer;
    this.busyValue = true;
    this.emitChange();
    try {
      this.viewer.lockCamera(true);
      await this.session.prepare();
      const frame = await this.viewer.captureFrame();
      this.frame = frame;
      await this.session.setImage(frame);
      this.options.notify('Click the object to select it. Alt-click removes a region.');
    } catch (error) {
      this.viewer.lockCamera(false);
      this.options.notify(
        `Could not start AI selection: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    } finally {
      this.busyValue = false;
      this.emitChange();
    }
  }

  /**
   * Lifts the shown mask to 3D and adopts it as a group on the layer.
   *
   * `liftMask` is where the paper's two operators live: a finite tolerance is depth
   * projection (this object), an infinite one is frustum projection (everything behind it
   * too). The grow afterwards repairs the silhouette, where a gaussian's centre falls just
   * outside a mask that its own footprint plainly covers.
   */
  commit(additive = false): void {
    const layer = this.layer;
    const mask = this.candidates?.masks[this.chosen];
    if (!layer || !mask) return;

    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const index = new ScreenIndex(layer, this.viewer, width, height);
    const document = this.viewer.document;
    const radius = Math.max(layer.localBounds().radius, 1e-4);
    const infinite = this.settings.depthTolerance >= FRUSTUM_TOLERANCE;
    const front =
      document && !infinite
        ? DepthGrid.build(document, this.viewer.camera, width, height)
        : undefined;

    let indices = liftMask(layer, index, front, mask, width, height, {
      depthTolerance: infinite ? Infinity : this.settings.depthTolerance * radius,
      minOpacity: 0.2,
    });
    if (indices.length === 0) {
      this.options.notify('That mask did not cover any splats of this layer.', 'warning');
      return;
    }
    if (this.settings.growSteps > 0)
      indices = growSelection(layer, indices, medianSpacing(layer) * 2, this.settings.growSteps);

    const fallback = `AI selection ${(layer.groups?.numGroups ?? 0) + 1}`;
    const groupId = this.segmentation.selectIndices(layer, indices, { name: fallback, additive });
    this.options.notify(`Selected ${indices.length.toLocaleString()} splats.`);
    this.clearPrompt();
    // Naming needs the network, so it lands after the selection rather than delaying it.
    if (this.nameObjects && groupId >= 0) void this.nameSelection(layer, indices, index, groupId);
  }

  /** Asks the namer what a single selection is and renames its group in place. */
  private async nameSelection(
    layer: Layer,
    indices: Uint32Array,
    index: ScreenIndex,
    groupId: number,
  ): Promise<void> {
    const frame = this.frame;
    if (!frame) return;
    try {
      await this.labels.prepare();
      const bounds = groupBounds(indices, index, frame);
      if (!bounds) return;
      const guess = await this.labels.classify(cropFrame(frame, bounds, 0.12));
      if (guess.name) this.segmentation.renameGroup(layer, groupId, guess.name);
    } catch {
      // The selection is already made and correct; only its name is missing.
    }
  }

  /**
   * Segments every object in the current view at once, replacing the layer's segmentation.
   *
   * Unlike `commit`, this does not select anything — it produces many groups and turns the
   * overlay on, so the scene arrives colour-coded and the user picks an object by clicking
   * it, the same as after a geometric bake.
   */
  async segmentAll(): Promise<void> {
    if (this.busyValue) return;
    // Start from cold if need be: picking the tool locks the camera and encodes the view,
    // and there is no reason to make the user do that as a separate step first.
    if (!this.active) this.viewer.setTool('aiselect');
    if (!this.session.hasImage) await this.begin();
    const layer = this.layer;
    if (!layer) return;
    if (!this.session.hasImage) {
      this.options.notify('Could not read the view — check the model loaded.', 'warning');
      return;
    }
    this.busyValue = true;
    this.clearPrompt();
    this.emitChange();
    const started = performance.now();
    try {
      const radius = Math.max(layer.localBounds().radius, 1e-4);
      const infinite = this.settings.depthTolerance >= FRUSTUM_TOLERANCE;
      if (this.nameObjects) {
        // A namer that will not load is a missing nicety, not a failed segmentation.
        try {
          this.progressValue = 'Loading object namer…';
          this.emitChange();
          await this.labels.prepare((message) => {
            this.progressValue = message;
            this.emitChange();
          });
        } catch {
          this.options.notify(
            'Could not load the object namer; groups will be numbered.',
            'warning',
          );
        }
      }
      const result = await autoSegment(
        layer,
        this.viewer,
        this.session,
        {
          ...DEFAULT_AUTO_SETTINGS,
          density: this.settings.density,
          depthTolerance: infinite ? Infinity : this.settings.depthTolerance * radius,
          minOpacity: 0.2,
        },
        (progress) => {
          this.progressValue = progress.message;
          this.emitChange();
        },
        this.nameObjects ? { labels: this.labels, frame: this.frame } : {},
      );
      if (!result || result.kept === 0) {
        this.options.notify('Nothing came back — try a closer view or a denser grid.', 'warning');
        return;
      }
      this.segmentation.applyGroupsUndoable(layer, result.groups, 'Segment everything');
      this.segmentation.setOverlay(true);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const namedPart = result.named > 0 ? `, ${result.named} named` : '';
      this.options.notify(
        `${result.kept} objects${namedPart} · ${Math.round(result.coverage * 100)}% of the layer · ${seconds}s. Click one to select it.`,
      );
    } catch (error) {
      this.options.notify(
        `Segment everything failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    } finally {
      this.busyValue = false;
      this.progressValue = '';
      this.emitChange();
    }
  }

  /** Drops the clicks and the proposed mask, keeping the encoded view. */
  clearPrompt(): void {
    this.points = [];
    this.candidates = undefined;
    this.chosen = 0;
    this.overlay.clear();
    this.emitChange();
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.viewer.removeEventListener('tool-changed', this.onToolChanged);
    this.viewer.removeEventListener('document-changed', this.reset);
    this.session.removeEventListener('state-changed', this.emitChange);
    this.labels.removeEventListener('state-changed', this.emitChange);
    this.session.removeEventListener('progress', this.onProgress);
    window.removeEventListener('keydown', this.onKeyDown);
    this.overlay.dispose();
    this.session.dispose();
    this.labels.dispose();
  }

  // ---- interaction --------------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.button !== 0 || this.busyValue || !this.session.hasImage) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = this.canvas.getBoundingClientRect();
    this.points.push({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      positive: !event.altKey,
    });
    this.overlay.setPoints(this.points);
    void this.runPrompt();
  };

  private async runPrompt(): Promise<void> {
    const ticket = ++this.sequence;
    this.busyValue = true;
    this.emitChange();
    try {
      const result = await this.session.segment(this.points);
      // A newer click landed while this decode was in flight: its answer is the real one.
      if (ticket !== this.sequence) return;
      if (!result || result.masks.length === 0) {
        this.options.notify('SAM returned no mask for those clicks.', 'warning');
        return;
      }
      this.candidates = result;
      this.chosen = result.best;
      const mask = result.masks[this.chosen];
      if (mask && maskArea(mask) === 0)
        this.options.notify('That mask came out empty — try another click.', 'warning');
      this.overlay.setMask(mask);
    } catch (error) {
      if (ticket === this.sequence)
        this.options.notify(
          `Segmentation failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
    } finally {
      if (ticket === this.sequence) {
        this.busyValue = false;
        this.emitChange();
      }
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.active || event.target !== document.body) return;
    if (event.key === 'Escape') {
      // One press clears the prompt, the next (nothing left to clear) leaves the tool —
      // the global Escape handler does that, so only swallow the key when it did work here.
      if (this.points.length === 0 && !this.hasProposal) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.clearPrompt();
    } else if (event.key === 'Enter' && this.hasProposal) {
      event.preventDefault();
      this.commit(event.shiftKey);
    } else if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      this.cycleCandidate(event.key === ']' ? 1 : -1);
    }
  };

  private readonly onToolChanged = (): void => {
    if (this.active) {
      this.overlay.setVisible(true);
      void this.begin();
    } else {
      this.overlay.setVisible(false);
      this.viewer.lockCamera(false);
      this.session.clearImage();
      this.clearPrompt();
    }
  };

  private readonly reset = (): void => {
    this.layer = undefined;
    this.session.clearImage();
    this.clearPrompt();
  };

  private readonly onProgress = (event: Event): void => {
    const detail = (event as CustomEvent<{ message: string; fraction?: number }>).detail;
    this.dispatchEvent(new CustomEvent('progress', { detail }));
  };

  private readonly emitChange = (): void => {
    this.dispatchEvent(new Event('changed'));
  };
}

/**
 * A rough nearest-neighbour spacing for the layer, used to size the flood-fill step.
 * Derived from the robust bounds and the splat count rather than measured, because an
 * actual kNN pass over millions of splats is not worth it for a slider default.
 */
function medianSpacing(layer: Layer): number {
  const bounds = layer.localBounds();
  const live = Math.max(layer.store.liveCount(), 1);
  return Math.max((bounds.radius * 2) / Math.cbrt(live), 1e-5);
}
