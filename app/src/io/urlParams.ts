export interface InitialSource {
  url?: string;
  sample?: string;
}

export function getInitialSource(search = window.location.search): InitialSource {
  const params = new URLSearchParams(search);
  const url = params.get('url')?.trim();
  const sample = params.get('sample')?.trim();
  return {
    ...(url ? { url } : {}),
    ...(sample ? { sample } : {}),
  };
}
