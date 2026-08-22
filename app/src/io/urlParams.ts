export interface InitialSource {
  url?: string;
  sample?: string;
  /** Explicit `.groups` sidecar URL, overriding the one the splat URL implies. */
  groups?: string;
}

export function getInitialSource(search = window.location.search): InitialSource {
  const params = new URLSearchParams(search);
  const url = params.get('url')?.trim();
  const sample = params.get('sample')?.trim();
  const groups = params.get('groups')?.trim();
  return {
    ...(url ? { url } : {}),
    ...(sample ? { sample } : {}),
    ...(groups ? { groups } : {}),
  };
}
