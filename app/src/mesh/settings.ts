export type ShapeMode = 'polyline' | 'rectangle' | 'polygon' | 'circle';

const PREFIX = 'splatypus.model.';
const SHAPES: ShapeMode[] = ['polyline', 'rectangle', 'polygon', 'circle'];

function read(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // private mode
  }
}

/** Rotation snap used by ortho mode (radians). */
export const ORTHO_ROTATION_STEP = Math.PI / 12; // 15°

/**
 * Modelling settings: outline shape, polygon sides, ortho mode, last extrusion height.
 * Ortho constrains polyline segments to the axes and snaps gizmo rotations to 15° steps;
 * holding Shift inverts it while held (`orthoActive`).
 */
export class ModelSettingsStore extends EventTarget {
  shape: ShapeMode = 'polyline';
  sides = 6;
  /** Ortho mode as set in the panel (Shift inverts it temporarily). */
  ortho = false;
  height = 0.3;
  private shiftHeld = false;

  constructor() {
    super();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
    const shape = read('shape') as ShapeMode | null;
    if (shape && SHAPES.includes(shape)) this.shape = shape;
    const sides = Number(read('sides'));
    if (Number.isInteger(sides) && sides >= 3 && sides <= 64) this.sides = sides;
    this.ortho = read('ortho') === '1';
    const height = Number(read('height'));
    if (Number.isFinite(height) && height !== 0 && read('height') !== null) this.height = height;
  }

  /** Ortho as it applies right now: the setting, inverted while Shift is held. */
  get orthoActive(): boolean {
    return this.ortho !== this.shiftHeld;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    const held =
      event.type === 'keydown' ? event.shiftKey || event.key === 'Shift' : event.shiftKey;
    if (held === this.shiftHeld) return;
    this.shiftHeld = held;
    this.dispatchEvent(new Event('settings-changed'));
  };

  private readonly onBlur = (): void => {
    if (!this.shiftHeld) return;
    this.shiftHeld = false;
    this.dispatchEvent(new Event('settings-changed'));
  };

  setShape(value: ShapeMode): void {
    this.shape = value;
    this.changed('shape', value);
  }
  setSides(value: number): void {
    this.sides = Math.min(64, Math.max(3, Math.round(value)));
    this.changed('sides', String(this.sides));
  }
  setOrtho(value: boolean): void {
    this.ortho = value;
    this.changed('ortho', value ? '1' : '0');
  }
  setHeight(value: number): void {
    if (!Number.isFinite(value)) return;
    this.height = value;
    this.changed('height', String(value));
  }

  private changed(key: string, value: string): void {
    write(key, value);
    this.dispatchEvent(new Event('settings-changed'));
  }
}
