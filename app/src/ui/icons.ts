/**
 * Line icons for the object toolbar, drawn on a 16×16 grid.
 *
 * Inline rather than loaded: the toolbar is a dozen glyphs, and a sprite sheet or an
 * icon font would cost a request and a flash of unstyled buttons to save nothing.
 * Every button keeps a real label in `title` and `aria-label`, because an icon alone
 * is a guess for anyone who has not used the tool before.
 */
const PATHS: Record<string, string> = {
  split: 'M1.5 10v4.5h13V10M8 1.5v9M4.6 5 8 1.5 11.4 5',
  translate:
    'M8 1.5v13M1.5 8h13M8 1.5 5.8 3.7M8 1.5l2.2 2.2M8 14.5l-2.2-2.2M8 14.5l2.2-2.2' +
    'M1.5 8l2.2-2.2M1.5 8l2.2 2.2M14.5 8l-2.2-2.2M14.5 8l2.2 2.2',
  rotate: 'M13.5 8a5.5 5.5 0 1 1-1.7-4M13.9 1.6v3.2h-3.2',
  scale: 'M1.5 9.5v5h5M1.5 14.5 6.5 9.5M14.5 6.5v-5h-5M14.5 1.5 9.5 6.5',
  duplicate: 'M1.5 4.5h9v10h-9zM4.5 4.5v-3h9v10h-3',
  array: 'M0.5 5.5h4v5h-4zM6 5.5h4v5h-4zM11.5 5.5h4v5h-4z',
  group: 'M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3M5.5 5.5h5v5h-5z',
  ungroup: 'M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3M4 12 12 4',
  isolate: 'M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  floor: 'M8 1.5v8M4.6 6.1 8 9.5l3.4-3.4M2 13.5h12',
  merge: 'M14 2v12M2 8h9M8 5l3 3-3 3',
  delete: 'M2.5 4h11M5.5 4V2.5h5V4M4 4v10h8V4M6.5 6.5v5M9.5 6.5v5',
  // Panel headers
  view: 'M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  layers: 'M8 2 14 5.5 8 9 2 5.5ZM2 8.5l6 3.5 6-3.5M2 11.5 8 15l6-3.5',
  segment: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z',
  chevron: 'M4 6l4 4 4-4',
};

export function icon(name: string): string {
  return (
    `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" ` +
    `fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" ` +
    `stroke-linejoin="round"><path d="${PATHS[name] ?? ''}"/></svg>`
  );
}
