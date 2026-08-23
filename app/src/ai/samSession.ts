import { decodeMasks, pointsToImageSpace } from './maskDecode';
import type { MaskCandidates, PromptPoint } from './maskDecode';
import type { CapturedFrame } from '../viewer/Viewer';

/**
 * SAM (Segment Anything) running in the browser, via transformers.js on ONNX Runtime Web.
 *
 * This is a deliberately thin adapter. Everything that can be decided without the network
 * or a GPU lives in `maskDecode.ts`; what is left here is loading, device selection and two
 * inference calls, none of which can be unit-tested anyway.
 *
 * The two-stage split is the whole reason clicking feels immediate. The image encoder is
 * the expensive half and depends only on the picture, so it runs once per view and its
 * output is cached; every click after that runs only the mask decoder, which is
 * milliseconds. The camera is what invalidates that cache — hence `setImage` per view.
 */

export type SamState = 'idle' | 'loading' | 'encoding' | 'ready' | 'error';
export type SamBackend = 'webgpu' | 'wasm';

/** Distilled SAM: small enough to fetch on demand, good enough for object selection. */
const MODEL_ID = 'Xenova/slimsam-77-uniform';

type Transformers = typeof import('@huggingface/transformers');

let modulePromise: Promise<Transformers> | undefined;
/**
 * Imported lazily so the runtime and the ONNX wasm land in a chunk that is only fetched
 * when someone actually reaches for the tool. Must never move to module scope.
 */
const loadTransformers = (): Promise<Transformers> =>
  (modulePromise ??= import('@huggingface/transformers'));

async function pickBackend(): Promise<SamBackend> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The slice of the transformers.js surface this adapter actually uses.
 *
 * `from_pretrained` is typed as returning the base `PreTrainedModel` / `Processor`, which
 * do not declare SAM's two-stage methods. Naming the contract here — rather than casting
 * at each call — keeps one place to look when a library upgrade breaks something.
 */
interface SamTensor {
  data: Uint8Array;
  dims: number[];
}
interface SamModelHandle {
  (inputs: unknown): Promise<{ pred_masks: unknown; iou_scores: { data: Float32Array } }>;
  get_image_embeddings(inputs: unknown): Promise<Record<string, unknown>>;
  dispose?(): unknown;
}
interface SamProcessedImage {
  pixel_values: unknown;
  original_sizes: [number, number][];
  reshaped_input_sizes: [number, number][];
}
interface SamProcessorHandle {
  (image: unknown, options: Record<string, unknown>): Promise<SamProcessedImage>;
  post_process_masks(
    masks: unknown,
    originalSizes: [number, number][],
    reshapedSizes: [number, number][],
  ): Promise<SamTensor[]>;
}

export interface SamProgress {
  /** 0..1 while weights transfer; undefined once the work is compute rather than download. */
  fraction?: number;
  message: string;
}

/** Events: `state-changed`, `progress` (detail: `SamProgress`). */
export class SamSession extends EventTarget {
  private stateValue: SamState = 'idle';
  private backendValue?: SamBackend;
  private errorValue?: string;
  private model?: SamModelHandle;
  private processor?: SamProcessorHandle;
  private prepareInFlight?: Promise<void>;
  /** Encoder output for the current view, reused by every prompt against it. */
  private embeddings?: Record<string, unknown>;
  private imageSizes?: { original: [number, number][]; reshaped: [number, number][] };
  private frameScale = { x: 1, y: 1 };

  get state(): SamState {
    return this.stateValue;
  }
  get backend(): SamBackend | undefined {
    return this.backendValue;
  }
  get error(): string | undefined {
    return this.errorValue;
  }
  /** True once a view has been encoded, so prompts can be answered. */
  get hasImage(): boolean {
    return this.embeddings !== undefined;
  }

  /** Downloads and compiles the model. Idempotent; safe to call on every tool activation. */
  async prepare(): Promise<void> {
    if (this.model && this.processor) return;
    return (this.prepareInFlight ??= this.prepareOnce().finally(() => {
      this.prepareInFlight = undefined;
    }));
  }

  private async prepareOnce(): Promise<void> {
    this.setState('loading');
    try {
      const { SamModel, AutoProcessor, env } = await loadTransformers();
      // Weights come from the Hugging Face CDN and are cached by the browser; nothing is
      // served from our own origin, which matters because this deploys to a Pages subpath.
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      // GitHub Pages cannot set COOP/COEP, so there is no SharedArrayBuffer and ONNX
      // Runtime cannot start its worker threads. Asking for one up front avoids a failed
      // thread spawn followed by an opaque fallback.
      if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

      const backend = await pickBackend();
      try {
        await this.load(SamModel, AutoProcessor, backend);
      } catch (error) {
        if (backend === 'wasm') throw error;
        // A WebGPU adapter can exist and still fail to compile these graphs. CPU is slow,
        // but a slow tool beats a broken one.
        this.report(`WebGPU failed (${describe(error)}), retrying on CPU…`);
        await this.load(SamModel, AutoProcessor, 'wasm');
      }
      this.setState('ready');
    } catch (error) {
      this.errorValue = describe(error);
      this.setState('error');
      throw error;
    }
  }

  private async load(
    SamModel: Transformers['SamModel'],
    AutoProcessor: Transformers['AutoProcessor'],
    backend: SamBackend,
  ): Promise<void> {
    const progress_callback = (event: {
      status?: string;
      progress?: number;
      file?: string;
    }): void => {
      if (event.status === 'progress' && typeof event.progress === 'number')
        this.report(`Downloading ${event.file ?? 'model'}…`, event.progress / 100);
      else if (event.status === 'ready') this.report('Preparing model…');
    };
    this.model = (await SamModel.from_pretrained(MODEL_ID, {
      device: backend,
      dtype: backend === 'webgpu' ? 'fp16' : 'q8',
      progress_callback,
    })) as unknown as SamModelHandle;
    this.processor = (await AutoProcessor.from_pretrained(
      MODEL_ID,
      {},
    )) as unknown as SamProcessorHandle;
    this.backendValue = backend;
  }

  /**
   * Encodes one rendered view. This is the image encoder, so it is the slow call: run it
   * once per camera pose and let every prompt reuse the result.
   */
  async setImage(frame: CapturedFrame): Promise<void> {
    await this.prepare();
    const model = this.model!;
    const processor = this.processor!;
    const { RawImage } = await loadTransformers();
    this.setState('encoding');
    try {
      const image = new RawImage(new Uint8ClampedArray(frame.data), frame.width, frame.height, 4);
      const inputs = await processor(image, {});
      this.embeddings = await model.get_image_embeddings(inputs);
      this.imageSizes = { original: inputs.original_sizes, reshaped: inputs.reshaped_input_sizes };
      this.frameScale = { x: frame.scaleX, y: frame.scaleY };
      this.setState('ready');
    } catch (error) {
      this.errorValue = describe(error);
      this.setState('error');
      throw error;
    }
  }

  /** Forgets the encoded view — call when the camera moves. */
  clearImage(): void {
    this.embeddings = undefined;
    this.imageSizes = undefined;
  }

  /**
   * Runs the mask decoder for a set of clicks. Cheap, because it reuses the cached
   * embedding — which is what lets a negative click feel instant.
   *
   * @param points Clicks in canvas CSS pixels; `positive: false` means "not this".
   */
  async segment(points: readonly PromptPoint[]): Promise<MaskCandidates | undefined> {
    if (!this.embeddings || !this.imageSizes || points.length === 0) return undefined;
    const { Tensor } = await loadTransformers();
    const model = this.model!;
    const processor = this.processor!;
    const mapped = pointsToImageSpace(points, this.frameScale.x, this.frameScale.y);

    const input_points = new Tensor('float32', mapped.points.flat(), [
      1,
      1,
      mapped.points.length,
      2,
    ]);
    const input_labels = new Tensor('int64', mapped.labels.map(BigInt), [
      1,
      1,
      mapped.labels.length,
    ]);
    const outputs = await model({ ...this.embeddings, input_points, input_labels });
    const masks = await processor.post_process_masks(
      outputs.pred_masks,
      this.imageSizes.original,
      this.imageSizes.reshaped,
    );
    const first = masks[0];
    return first ? decodeMasks(first.data, first.dims, outputs.iou_scores.data) : undefined;
  }

  dispose(): void {
    void this.model?.dispose?.();
    this.model = undefined;
    this.processor = undefined;
    this.clearImage();
    this.setState('idle');
  }

  private setState(state: SamState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.dispatchEvent(new Event('state-changed'));
  }

  private report(message: string, fraction?: number): void {
    this.dispatchEvent(new CustomEvent<SamProgress>('progress', { detail: { message, fraction } }));
  }
}
