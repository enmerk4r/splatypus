import { softmax } from './framePixels';
import type { FrameImage } from './framePixels';
import { allPhrases, nameOf } from './vocabulary';

/**
 * Naming segmented objects with CLIP.
 *
 * SAM finds *where* things are and has no notion of *what* they are — every group it
 * returns is "Object 37". CLIP closes that gap: it embeds images and text into one space,
 * so scoring a cropped object against a list of phrases and taking the nearest is a
 * classifier you can define by writing a list, with no training and no fixed label set.
 *
 * The cost is arranged so it lands once: text embeddings for the whole vocabulary are
 * computed on load and reused for every crop thereafter, leaving one small image encode
 * per object.
 *
 * Kept a thin adapter for the same reason as `samSession`: it needs the network and a GPU,
 * so it cannot be unit-tested. The arithmetic lives in `framePixels.ts` and the label set
 * in `vocabulary.ts`, both of which can.
 */

export type LabelState = 'idle' | 'loading' | 'ready' | 'error';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
/** Below this probability the winner is not convincing enough to put on a group. */
const MIN_CONFIDENCE = 0.18;

type Transformers = typeof import('@huggingface/transformers');

let modulePromise: Promise<Transformers> | undefined;
const loadTransformers = (): Promise<Transformers> =>
  (modulePromise ??= import('@huggingface/transformers'));

interface Embedded {
  data: Float32Array;
  dims: number[];
}
interface TextModelHandle {
  (inputs: unknown): Promise<{ text_embeds: Embedded }>;
  dispose?(): unknown;
}
interface VisionModelHandle {
  (inputs: unknown): Promise<{ image_embeds: Embedded }>;
  dispose?(): unknown;
}
type TokenizerHandle = (texts: string[], options: Record<string, unknown>) => unknown;
type ImageProcessorHandle = (image: unknown) => Promise<unknown>;

function unitVector(source: Float32Array, offset: number, length: number): Float32Array {
  const out = source.slice(offset, offset + length);
  let sum = 0;
  for (const value of out) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i += 1) out[i] = out[i]! / norm;
  return out;
}

export interface LabelGuess {
  name?: string;
  confidence: number;
}

/** Events: `state-changed`. */
export class LabelSession extends EventTarget {
  private stateValue: LabelState = 'idle';
  private textModel?: TextModelHandle;
  private visionModel?: VisionModelHandle;
  private tokenizer?: TokenizerHandle;
  private processor?: ImageProcessorHandle;
  /** One unit vector per vocabulary phrase, computed once. */
  private phraseVectors: Float32Array[] = [];
  private dimension = 0;
  private prepareInFlight?: Promise<void>;

  get state(): LabelState {
    return this.stateValue;
  }
  get ready(): boolean {
    return this.stateValue === 'ready';
  }

  async prepare(onProgress?: (message: string) => void): Promise<void> {
    if (this.ready) return;
    return (this.prepareInFlight ??= this.prepareOnce(onProgress).finally(() => {
      this.prepareInFlight = undefined;
    }));
  }

  private async prepareOnce(onProgress?: (message: string) => void): Promise<void> {
    this.setState('loading');
    try {
      const {
        AutoTokenizer,
        AutoProcessor,
        CLIPTextModelWithProjection,
        CLIPVisionModelWithProjection,
        env,
      } = await loadTransformers();
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

      const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
      const device = gpu ? 'webgpu' : 'wasm';
      const options = { device, dtype: device === 'webgpu' ? 'fp16' : 'q8' } as const;
      onProgress?.('Downloading object namer…');

      this.tokenizer = (await AutoTokenizer.from_pretrained(
        MODEL_ID,
      )) as unknown as TokenizerHandle;
      this.processor = (await AutoProcessor.from_pretrained(
        MODEL_ID,
        {},
      )) as unknown as ImageProcessorHandle;
      try {
        this.textModel = (await CLIPTextModelWithProjection.from_pretrained(
          MODEL_ID,
          options,
        )) as unknown as TextModelHandle;
        this.visionModel = (await CLIPVisionModelWithProjection.from_pretrained(
          MODEL_ID,
          options,
        )) as unknown as VisionModelHandle;
      } catch (error) {
        if (device === 'wasm') throw error;
        const cpu = { device: 'wasm', dtype: 'q8' } as const;
        this.textModel = (await CLIPTextModelWithProjection.from_pretrained(
          MODEL_ID,
          cpu,
        )) as unknown as TextModelHandle;
        this.visionModel = (await CLIPVisionModelWithProjection.from_pretrained(
          MODEL_ID,
          cpu,
        )) as unknown as VisionModelHandle;
      }

      onProgress?.('Reading the object list…');
      await this.embedPhrases();
      this.setState('ready');
    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  /** Embeds the whole vocabulary once; every later guess is a dot product against these. */
  private async embedPhrases(): Promise<void> {
    const phrases = allPhrases();
    const inputs = this.tokenizer!(phrases, { padding: true, truncation: true });
    const { text_embeds } = await this.textModel!(inputs);
    this.dimension = text_embeds.dims[1] ?? 0;
    this.phraseVectors = phrases.map((_, index) =>
      unitVector(text_embeds.data, index * this.dimension, this.dimension),
    );
  }

  /**
   * Names one cropped object, or returns no name when nothing in the vocabulary fits well
   * enough — a wrong label is worse than none, because it reads as certainty.
   */
  async classify(crop: FrameImage): Promise<LabelGuess> {
    if (!this.ready) return { confidence: 0 };
    const { RawImage } = await loadTransformers();
    const image = new RawImage(new Uint8ClampedArray(crop.data), crop.width, crop.height, 4);
    const inputs = await this.processor!(image);
    const { image_embeds } = await this.visionModel!(inputs);
    const vector = unitVector(image_embeds.data, 0, this.dimension);

    const similarities = this.phraseVectors.map((phrase) => {
      let total = 0;
      for (let i = 0; i < this.dimension; i += 1) total += phrase[i]! * vector[i]!;
      return total;
    });
    const probabilities = softmax(similarities);
    let best = 0;
    for (let i = 1; i < probabilities.length; i += 1)
      if (probabilities[i]! > probabilities[best]!) best = i;

    const confidence = probabilities[best] ?? 0;
    if (confidence < MIN_CONFIDENCE) return { confidence };
    // An index past the vocabulary is one of the reject phrases: recognised as nothing.
    return { name: nameOf(best), confidence };
  }

  dispose(): void {
    void this.textModel?.dispose?.();
    void this.visionModel?.dispose?.();
    this.textModel = undefined;
    this.visionModel = undefined;
    this.phraseVectors = [];
    this.setState('idle');
  }

  private setState(state: LabelState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.dispatchEvent(new Event('state-changed'));
  }
}
