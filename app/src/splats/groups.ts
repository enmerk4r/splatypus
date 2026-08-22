/**
 * Reads the `.groups` segmentation sidecar described in docs/GROUPS_FORMAT.md.
 *
 * Segmentation is baked offline; the viewer only looks it up. Group ids are addressed
 * by splat index, which is sound because Spark's loaders preserve file order — but a
 * sidecar whose splat count disagrees with the mesh is rejected rather than applied,
 * since a misaligned map would silently mislabel the entire scene.
 */

import { MAGIC, UNASSIGNED } from './groupsFormat';
import type { GroupInfo, GroupsMeta } from './groupsFormat';

export { UNASSIGNED };
export type { GroupInfo, GroupsMeta };

export class GroupMapError extends Error {}

export class GroupMap {
  readonly meta: GroupsMeta;
  /** Group id per splat index; `UNASSIGNED` where no group claimed the splat. */
  readonly ids: Uint32Array;

  private groupStarts?: Int32Array;
  private groupItems?: Int32Array;

  private constructor(meta: GroupsMeta, ids: Uint32Array) {
    this.meta = meta;
    this.ids = ids;
  }

  /** Wraps a freshly baked result, for a bake run inside the viewer. */
  static fromIds(ids: Uint32Array, meta: GroupsMeta): GroupMap {
    return new GroupMap(meta, ids);
  }

  static parse(bytes: ArrayBuffer, expectedSplats?: number): GroupMap {
    const probe = new TextDecoder().decode(
      new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 65536)),
    );
    const firstBreak = probe.indexOf('\n');
    const secondBreak = probe.indexOf('\n', firstBreak + 1);
    if (firstBreak < 0 || secondBreak < 0) {
      throw new GroupMapError('Not a .groups file — no header found.');
    }
    if (probe.slice(0, firstBreak) !== MAGIC) {
      throw new GroupMapError(
        `Unsupported .groups version “${probe.slice(0, firstBreak)}” — expected ${MAGIC}.`,
      );
    }

    let meta: GroupsMeta;
    try {
      meta = JSON.parse(probe.slice(firstBreak + 1, secondBreak)) as GroupsMeta;
    } catch (error) {
      throw new GroupMapError('The .groups header is not valid JSON.', { cause: error });
    }

    // The header is ASCII in practice, but measure it in bytes so a non-ASCII group
    // name cannot shift the payload offset.
    const headerBytes = new TextEncoder().encode(probe.slice(0, secondBreak + 1)).byteLength;
    const payload = bytes.byteLength - headerBytes;
    if (payload !== meta.numSplats * 4) {
      throw new GroupMapError(
        `The .groups payload holds ${payload / 4} ids but its header claims ${meta.numSplats}.`,
      );
    }
    if (expectedSplats !== undefined && meta.numSplats !== expectedSplats) {
      throw new GroupMapError(
        `The .groups file covers ${meta.numSplats} splats but the scene has ${expectedSplats}.`,
      );
    }

    return new GroupMap(meta, new Uint32Array(bytes.slice(headerBytes)));
  }

  get numGroups(): number {
    return this.meta.numGroups;
  }

  groupOf(splatIndex: number): number {
    return this.ids[splatIndex] ?? UNASSIGNED;
  }

  info(groupId: number): GroupInfo {
    return (
      this.meta.groups?.find((group) => group.id === groupId) ?? {
        id: groupId,
        name: `Group ${groupId}`,
        count: this.indicesOf(groupId).length,
      }
    );
  }

  /** Group ids ordered largest first, for a UI list that leads with the real objects. */
  listGroups(): GroupInfo[] {
    if (this.meta.groups && this.meta.groups.length > 0) {
      return [...this.meta.groups].sort((a, b) => b.count - a.count);
    }
    return Array.from({ length: this.numGroups }, (_, id) => this.info(id)).sort(
      (a, b) => b.count - a.count,
    );
  }

  /** Splat indices belonging to a group. The inverted index is built once, on demand. */
  indicesOf(groupId: number): Uint32Array {
    if (!this.groupStarts || !this.groupItems) this.buildInverted();
    const starts = this.groupStarts!;
    const items = this.groupItems!;
    if (groupId < 0 || groupId >= this.numGroups) return new Uint32Array(0);
    const from = starts[groupId]!;
    const to = starts[groupId + 1]!;
    return new Uint32Array(items.buffer, items.byteOffset + from * 4, to - from);
  }

  private buildInverted(): void {
    const counts = new Int32Array(this.numGroups);
    let assigned = 0;
    for (const id of this.ids) {
      if (id === UNASSIGNED || id >= this.numGroups) continue;
      counts[id] = counts[id]! + 1;
      assigned += 1;
    }
    const starts = new Int32Array(this.numGroups + 1);
    for (let id = 0; id < this.numGroups; id += 1) starts[id + 1] = starts[id]! + counts[id]!;

    const items = new Int32Array(assigned);
    const cursor = starts.slice(0, this.numGroups);
    for (let splat = 0; splat < this.ids.length; splat += 1) {
      const id = this.ids[splat]!;
      if (id === UNASSIGNED || id >= this.numGroups) continue;
      items[cursor[id]!] = splat;
      cursor[id] = cursor[id]! + 1;
    }
    this.groupStarts = starts;
    this.groupItems = items;
  }
}
