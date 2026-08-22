/**
 * The `.groups` container's constants and shape, in one dependency-free module.
 *
 * It has no imports on purpose: `bakeConnectivity.ts` is loaded directly by
 * `tools/bake-connectivity.mjs` under Node's TypeScript stripping, which resolves
 * specifiers the way Node does rather than the way a bundler does. Keeping the format
 * definition importable from both sides is what lets the CLI and the viewer share one
 * bake implementation instead of drifting apart.
 *
 * Full description of the file layout: docs/GROUPS_FORMAT.md
 */

/** Group id meaning "no group claimed this splat" — background, or an unlabelled splat. */
export const UNASSIGNED = 0xffffffff;

/** First line of the file. A different value means do not attempt to parse. */
export const MAGIC = 'SPGRP1';

export interface GroupInfo {
  id: number;
  name: string;
  count: number;
  /** Mean colour of the group as `#rrggbb`, for a UI swatch. */
  colour?: string;
}

export interface GroupsMeta {
  numSplats: number;
  numGroups: number;
  /** Which baker produced this, e.g. `connectivity` or `gaga`. */
  source: string;
  groups?: GroupInfo[];
}
