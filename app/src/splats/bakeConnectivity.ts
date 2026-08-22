/**
 * Connected components over splat centres, constrained by colour similarity — tier 2 of
 * PLAN.md Phase 5. Pure geometry and appearance, no ML, seconds to run.
 *
 * This is the shared core behind both bake entry points: `tools/bake-connectivity.mjs`
 * (a CLI over a PLY) and the viewer's in-app bake (which works on anything Spark can
 * load, since it reads splats back out of a loaded mesh rather than parsing a file).
 *
 * Its limits are worth knowing, because they are the argument for the Gaga bake:
 * geometric connectivity alone collapses any single connected object into one group, and
 * the colour constraint that rescues it is a local heuristic that over-segments — it
 * splits a shadow from the surface it falls on. Gaga instead associates 2D masks from a
 * real segmenter across views, so its groups are objects rather than patches.
 */
// Explicit .ts extension: this module is also loaded directly by
// tools/bake-connectivity.mjs under Node, which does not do bundler-style resolution.
import type { GroupInfo, GroupsMeta } from './groupsFormat.ts';
import { UNASSIGNED } from './groupsFormat.ts';

export interface BakeInput {
  count: number;
  /** `[x0, y0, z0, x1, ...]` in splat-index order. */
  centres: Float32Array;
  /** Linear RGB in 0..1, `[r0, g0, b0, r1, ...]`, in splat-index order. */
  colours: Float32Array;
  /** Post-sigmoid opacity in 0..1, in splat-index order. */
  opacities: Float32Array;
}

export interface BakeOptions {
  /** Spatial cell size in scene units. */
  voxelSize: number;
  /** Colour cell size in 0..1. Zero disables the colour constraint entirely. */
  colourSize: number;
  /** How many colour cells apart two cells may be and still join. Above 0, a smooth
   *  gradient chains the whole scene into a single group. */
  colourSlack: number;
  /** Components smaller than this are left unassigned rather than kept as noise. */
  minSplats: number;
  /** Splats fainter than this are excluded, so haze cannot bridge two objects. */
  minOpacity: number;
}

export interface BakeResult {
  ids: Uint32Array;
  groups: GroupInfo[];
  stats: { cells: number; rawComponents: number; assigned: number; elapsedMs: number };
}

/** Robust extent per axis, via the 1st..99th percentile, so floaters do not set scale. */
export function robustExtent(centres: Float32Array, count: number): [number, number, number] {
  const extent: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const values = new Float32Array(count);
    for (let i = 0; i < count; i += 1) values[i] = centres[i * 3 + axis]!;
    values.sort();
    extent.push(values[Math.floor(count * 0.99)]! - values[Math.floor(count * 0.01)]!);
  }
  return [extent[0]!, extent[1]!, extent[2]!];
}

export function suggestOptions(centres: Float32Array, count: number): BakeOptions {
  const extent = robustExtent(centres, count);
  return {
    // Fine enough to separate touching objects, coarse enough that one surface stays
    // connected to itself.
    voxelSize: Math.max(...extent) / 300,
    colourSize: 0.12,
    colourSlack: 0,
    minSplats: Math.max(50, Math.round(count * 0.0005)),
    minOpacity: 0.1,
  };
}

export function bakeConnectivity(input: BakeInput, options: BakeOptions): BakeResult {
  const started = Date.now();
  const { count, centres, colours, opacities } = input;
  const { voxelSize, colourSize, colourSlack, minSplats, minOpacity } = options;

  const invVoxel = 1 / voxelSize;
  const invColour = colourSize > 0 ? 1 / colourSize : 0;

  // Cells are keyed by spatial voxel, then subdivided by colour cell, so two
  // differently-coloured surfaces meeting in space do not merge.
  const cells = new Map<string, Map<string, number[]>>();
  for (let i = 0; i < count; i += 1) {
    if (opacities[i]! < minOpacity) continue;
    const voxelKey =
      `${Math.floor(centres[i * 3]! * invVoxel)},` +
      `${Math.floor(centres[i * 3 + 1]! * invVoxel)},` +
      `${Math.floor(centres[i * 3 + 2]! * invVoxel)}`;
    let byColour = cells.get(voxelKey);
    if (!byColour) {
      byColour = new Map<string, number[]>();
      cells.set(voxelKey, byColour);
    }
    const colourKey =
      invColour === 0
        ? '0,0,0'
        : `${Math.floor(colours[i * 3]! * invColour)},` +
          `${Math.floor(colours[i * 3 + 1]! * invColour)},` +
          `${Math.floor(colours[i * 3 + 2]! * invColour)}`;
    const bucket = byColour.get(colourKey);
    if (bucket) bucket.push(i);
    else byColour.set(colourKey, [i]);
  }

  // Flood fill over cells: the 26 surrounding voxels plus the voxel itself, restricted
  // to colour cells within colourSlack steps on every channel.
  const componentOf = new Map<string, number>();
  const components: [string, string][][] = [];
  const stack: [string, string][] = [];

  for (const [startVoxel, byColour] of cells) {
    for (const startColour of byColour.keys()) {
      if (componentOf.has(`${startVoxel}|${startColour}`)) continue;
      const componentId = components.length;
      const members: [string, string][] = [];
      componentOf.set(`${startVoxel}|${startColour}`, componentId);
      stack.push([startVoxel, startColour]);
      while (stack.length > 0) {
        const [voxelKey, colourKey] = stack.pop()!;
        members.push([voxelKey, colourKey]);
        const [vx, vy, vz] = voxelKey.split(',').map(Number) as [number, number, number];
        const [cr, cg, cb] = colourKey.split(',').map(Number) as [number, number, number];
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
              const neighbourVoxel = `${vx + dx},${vy + dy},${vz + dz}`;
              const neighbourColours = cells.get(neighbourVoxel);
              if (!neighbourColours) continue;
              for (const neighbourColour of neighbourColours.keys()) {
                const key = `${neighbourVoxel}|${neighbourColour}`;
                if (componentOf.has(key)) continue;
                const [nr, ng, nb] = neighbourColour.split(',').map(Number) as [
                  number,
                  number,
                  number,
                ];
                if (
                  Math.abs(nr - cr) > colourSlack ||
                  Math.abs(ng - cg) > colourSlack ||
                  Math.abs(nb - cb) > colourSlack
                ) {
                  continue;
                }
                componentOf.set(key, componentId);
                stack.push([neighbourVoxel, neighbourColour]);
              }
            }
          }
        }
      }
      components.push(members);
    }
  }

  const membersOf = (member: [string, string]): number[] => cells.get(member[0])!.get(member[1])!;
  const sizes = components.map((members) =>
    members.reduce((total, member) => total + membersOf(member).length, 0),
  );
  const kept = components
    .map((_, id) => id)
    .filter((id) => sizes[id]! >= minSplats)
    .sort((a, b) => sizes[b]! - sizes[a]!);
  const denseId = new Map(kept.map((id, index) => [id, index]));

  const ids = new Uint32Array(count).fill(UNASSIGNED);
  let assigned = 0;
  for (const [key, componentId] of componentOf) {
    const dense = denseId.get(componentId);
    if (dense === undefined) continue;
    const split = key.lastIndexOf('|');
    for (const i of cells.get(key.slice(0, split))!.get(key.slice(split + 1))!) {
      ids[i] = dense;
      assigned += 1;
    }
  }

  // Without labels, a group's mean colour is the only handle a UI can show.
  const groups: GroupInfo[] = kept.map((id, index) => {
    const mean = [0, 0, 0];
    let total = 0;
    for (const member of components[id]!) {
      for (const i of membersOf(member)) {
        for (let c = 0; c < 3; c += 1) mean[c] = mean[c]! + colours[i * 3 + c]!;
        total += 1;
      }
    }
    const hex =
      '#' +
      mean
        .map((sum) =>
          Math.round(Math.min(1, Math.max(0, sum / total)) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    return { id: index, name: `Group ${index}`, count: sizes[id]!, colour: hex };
  });

  return {
    ids,
    groups,
    stats: {
      cells: cells.size,
      rawComponents: components.length,
      assigned,
      elapsedMs: Date.now() - started,
    },
  };
}

/** Serialises a bake into the `.groups` container described in docs/GROUPS_FORMAT.md. */
export function encodeGroups(ids: Uint32Array, meta: GroupsMeta): Uint8Array {
  const header = new TextEncoder().encode(`SPGRP1\n${JSON.stringify(meta)}\n`);
  const payload = new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength);
  const out = new Uint8Array(header.byteLength + payload.byteLength);
  out.set(header, 0);
  out.set(payload, header.byteLength);
  return out;
}
