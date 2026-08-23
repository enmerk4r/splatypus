import { GroupMap, UNASSIGNED } from './groups';
import type { GroupInfo } from './groups';

/**
 * Adds a set of splats to a layer's segmentation as a new group.
 *
 * This is how a free selection — a SAM mask lifted to 3D, a lasso — enters the group model
 * that the rest of the app already understands. Once it is a group it inherits click
 * selection, hover labels, the overlay palette, split-to-layer, `.groups` export and
 * project persistence with no further work.
 *
 * Labels are flat and last-write-wins, matching `.groups` semantics: a splat claimed by the
 * new group leaves whichever group previously held it, so the existing groups are recounted
 * rather than assumed. A group that loses all its members stays in the list as an empty
 * group — group ids are referenced by selections and must not shift underneath them.
 */
export function withAddedGroup(
  existing: GroupMap | undefined,
  count: number,
  indices: Uint32Array,
  info: { name: string; source: string },
): GroupMap {
  if (existing && existing.ids.length !== count)
    throw new Error(
      `The segmentation covers ${existing.ids.length} splats but the layer has ${count}.`,
    );

  const ids = existing ? existing.ids.slice() : new Uint32Array(count).fill(UNASSIGNED);
  const newId = existing?.numGroups ?? 0;
  for (const index of indices) if (index < count) ids[index] = newId;

  const counts = new Int32Array(newId + 1);
  for (const id of ids) if (id !== UNASSIGNED && id <= newId) counts[id] = counts[id]! + 1;

  const groups: GroupInfo[] = [];
  for (let id = 0; id <= newId; id += 1) {
    const prior = existing?.meta.groups?.find((group) => group.id === id);
    groups.push({
      id,
      name: id === newId ? info.name : (prior?.name ?? `Group ${id}`),
      count: counts[id]!,
      ...(prior?.colour !== undefined && id !== newId ? { colour: prior.colour } : {}),
    });
  }

  return GroupMap.fromIds(ids, {
    numSplats: count,
    numGroups: newId + 1,
    source: info.source,
    groups,
  });
}
