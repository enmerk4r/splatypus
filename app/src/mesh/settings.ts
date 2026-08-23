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

/** Modelling settings: outline shape, polygon sides, ortho drawing, last extrusion height. */
export class ModelSettingsStore extends EventTarget {
  shape: ShapeMode = 'polyline';
  sides = 6;
  /** Only axis-aligned segments while drawing (Shift toggles temporarily). */
  ortho = false;
  height = 0.3;

  constructor() {
    super();
    const shape = read('shape') as ShapeMode | null;
    if (shape && SHAPES.includes(shape)) this.shape = shape;
    const sides = Number(read('sides'));
    if (Number.isInteger(sides) && sides >= 3 && sides <= 64) this.sides = sides;
    this.ortho = read('ortho') === '1';
    const height = Number(read('height'));
    if (Number.isFinite(height) && height !== 0 && read('height') !== null) this.height = height;
  }

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
