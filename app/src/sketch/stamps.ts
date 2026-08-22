import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Preset } from './presets';
import type { StrokeSettings } from './stroke';

export interface Stamp {
  center: Vector3;
  scales: [number, number, number];
  quat: [number, number, number, number];
  rgb: [number, number, number];
  opacity: number;
}

export type RandomSource = () => number;

export function hashStrokeId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): RandomSource {
  return (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function stablePerpendicular(tangent: Vector3): Vector3 {
  const up = Math.abs(tangent.y) < 0.95 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  return new Vector3().crossVectors(tangent, up).normalize();
}

function orientedQuaternion(
  tangentValue: Vector3,
  viewDir: Vector3,
  billboard: boolean,
): Quaternion {
  const x = tangentValue.clone().normalize();
  if (x.lengthSq() < 1e-12) x.set(1, 0, 0);
  let z: Vector3;
  let y: Vector3;
  if (billboard) {
    z = viewDir.clone().addScaledVector(x, -viewDir.dot(x)).normalize();
    if (z.lengthSq() < 1e-12) z = stablePerpendicular(x);
    y = new Vector3().crossVectors(z, x).normalize();
    z = new Vector3().crossVectors(x, y).normalize();
  } else {
    y = stablePerpendicular(x);
    z = new Vector3().crossVectors(x, y).normalize();
  }
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
}

function randomQuaternion(rng: RandomSource): Quaternion {
  const u1 = rng(),
    u2 = rng(),
    u3 = rng();
  const a = Math.sqrt(1 - u1),
    b = Math.sqrt(u1);
  return new Quaternion(
    a * Math.sin(2 * Math.PI * u2),
    a * Math.cos(2 * Math.PI * u2),
    b * Math.sin(2 * Math.PI * u3),
    b * Math.cos(2 * Math.PI * u3),
  );
}

function tuple(quaternion: Quaternion): [number, number, number, number] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

export function stampsFor(
  sample: { p: Vector3; t: Vector3; pressure: number },
  view: { dir: Vector3 },
  settings: StrokeSettings,
  preset: Preset,
  rng: RandomSource,
): Stamp[] {
  const pressure = Math.min(1, Math.max(0, sample.pressure));
  const radius = settings.radius * (settings.pressure ? 0.4 + 0.6 * pressure : 1);
  const opacity =
    preset.opacity * settings.opacity * (settings.pressure ? 0.6 + 0.4 * pressure : 1);
  const scatter = preset.scatter;
  if (scatter) {
    const stamps: Stamp[] = [];
    for (let index = 0; index < scatter.count; index += 1) {
      const z = rng() * 2 - 1;
      const angle = rng() * Math.PI * 2;
      const radial = Math.sqrt(Math.max(0, 1 - z * z));
      const distance = Math.cbrt(rng()) * radius * scatter.radius;
      const center = sample.p
        .clone()
        .add(
          new Vector3(radial * Math.cos(angle), z, radial * Math.sin(angle)).multiplyScalar(
            distance,
          ),
        );
      const size = radius * scatter.size;
      stamps.push({
        center,
        scales: [size, size, size],
        quat: tuple(randomQuaternion(rng)),
        rgb: [...settings.colour],
        opacity,
      });
    }
    return stamps;
  }
  return [
    {
      center: sample.p.clone(),
      scales: [radius * preset.stretch, radius * preset.side, radius * preset.flat],
      quat: tuple(orientedQuaternion(sample.t, view.dir, preset.billboard)),
      rgb: [...settings.colour],
      opacity,
    },
  ];
}
