import { GroupMap, GroupMapError } from '../splats/groups';

/** Where a `.groups` sidecar can come from. */
export type GroupsSource = { kind: 'file'; file: File } | { kind: 'url'; url: string };

const GROUPS_FILE = /\.groups$/i;

export function isGroupsFile(file: File): boolean {
  return GROUPS_FILE.test(file.name);
}

/** The sidecar path a splat URL implies: `scan.ply` → `scan.groups`. */
export function sidecarUrlFor(splatUrl: string): string {
  return `${splatUrl.replace(/\.[^./]+$/, '')}.groups`;
}

export async function loadGroups(source: GroupsSource, expectedSplats: number): Promise<GroupMap> {
  const bytes =
    source.kind === 'file'
      ? await source.file.arrayBuffer()
      : await (async (): Promise<ArrayBuffer> => {
          const response = await fetch(source.url);
          if (!response.ok) throw new GroupMapError(`No sidecar at ${source.url}.`);
          return response.arrayBuffer();
        })();
  return GroupMap.parse(bytes, expectedSplats);
}

/**
 * Loads the sidecar a splat URL implies, or resolves to undefined if there is none.
 * A missing sidecar is normal — most scenes have not been baked — so it is not an
 * error, but a sidecar that exists and fails to parse is worth surfacing.
 */
export async function tryLoadSidecar(
  splatUrl: string,
  expectedSplats: number,
  onError: (message: string) => void,
): Promise<GroupMap | undefined> {
  const url = sidecarUrlFor(splatUrl);
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return GroupMap.parse(await response.arrayBuffer(), expectedSplats);
  } catch (error) {
    if (error instanceof GroupMapError) onError(error.message);
    return undefined;
  }
}
