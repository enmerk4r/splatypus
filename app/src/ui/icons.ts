/**
 * Line icons for the object toolbar, drawn on a 16×16 grid.
 *
 * Inline rather than loaded: the toolbar is a dozen glyphs, and a sprite sheet or an
 * icon font would cost a request and a flash of unstyled buttons to save nothing.
 * Every button keeps a real label in `title` and `aria-label`, because an icon alone
 * is a guess for anyone who has not used the tool before.
 */
const PATHS: Record<string, string> = {
  pen: 'M3 12.8 4.2 9.3 11.1 2.4a1.4 1.4 0 0 1 2 2L6.2 11.3ZM4.2 9.3l2 2M2 14h5',
  eraser:
    'M3 9.5 8.8 3.7a1.5 1.5 0 0 1 2.1 0l2.3 2.3a1.5 1.5 0 0 1 0 2.1L7.3 14H4.8L2.9 12a1.7 1.7 0 0 1 .1-2.5ZM8.5 12.8l-4.3-4.3M8 14h6',
  split:
    'M5.5 11.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z' +
    'M14.5 11.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z' +
    'M5.1 10.1 14 2M10.9 10.1 2 2',
  select: 'M3.5 1.5v11l2.8-2.8h4z',
  rectangle: 'M2 3h12v10H2z',
  lasso:
    'M12.8 4.2c-2.1-2.5-7.7-2-9.5.8-1.8 2.9.2 6.8 4.4 6.5 4.1-.3 6.9-2.8 5.6-5.1-.8-1.5-3.5-1.7-4.7-.4-.9 1 .2 2.8 2 2.2',
  polygon: 'M8 1.5 14 5.8 11.7 13H4.3L2 5.8Z',
  brush: 'M10.5 2 14 5.5 7.2 12.3 3.7 8.8ZM3.7 8.8C1.8 10 1.4 12.6 2 14c1.5.5 4-.1 5.2-1.7',
  undo: 'M5.5 4H2v-3M2 4l3.2-3M2.5 4.2A6 6 0 1 1 4 12.5',
  redo: 'M10.5 4H14v-3M14 4l-3.2-3M13.5 4.2A6 6 0 1 0 12 12.5',
  add: 'M8 2v12M2 8h12',
  up: 'M3 10.5 8 5l5 5.5',
  down: 'M3 5.5 8 11l5-5.5',
  translate:
    'M8 1.5v13M1.5 8h13M8 1.5 5.8 3.7M8 1.5l2.2 2.2M8 14.5l-2.2-2.2M8 14.5l2.2-2.2' +
    'M1.5 8l2.2-2.2M1.5 8l2.2 2.2M14.5 8l-2.2-2.2M14.5 8l2.2 2.2',
  rotate: 'M13.5 8a5.5 5.5 0 1 1-1.7-4M13.9 1.6v3.2h-3.2',
  scale: 'M1.5 9.5v5h5M1.5 14.5 6.5 9.5M14.5 6.5v-5h-5M14.5 1.5 9.5 6.5',
  duplicate: 'M1.5 4.5h9v10h-9zM4.5 4.5v-3h9v10h-3',
  array: 'M1.5 1.5h5v5h-5zM9.5 1.5h5v5h-5zM1.5 9.5h5v5h-5zM9.5 9.5h5v5h-5z',
  crop: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4M5 5h6v6H5z',
  cropKeep: 'M2 2h12v12H2zM5 5h6v6H5zM8 3v2M8 13v-2M3 8h2M13 8h-2',
  cropCut: 'M2 2h12v12H2zM5 5h6v6H5zM3 3l10 10',
  group: 'M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3M5.5 5.5h5v5h-5z',
  ungroup: 'M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3M4 12 12 4',
  isolate: 'M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  floor: 'M8 1.5v8M4.6 6.1 8 9.5l3.4-3.4M2 13.5h12',
  merge: 'M14 2v12M2 8h9M8 5l3 3-3 3',
  delete: 'M2.5 4h11M5.5 4V2.5h5V4M4 4v10h8V4M6.5 6.5v5M9.5 6.5v5',
  // Panel headers
  view: 'M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  visible: 'M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  hidden: 'M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8ZM2 2l12 12',
  lock: 'M3.5 7h9v7h-9zM5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 10v1.5',
  unlock: 'M3.5 7h9v7h-9zM5.5 7V5a2.5 2.5 0 0 1 4.8-1M8 10v1.5',
  layers: 'M8 2 14 5.5 8 9 2 5.5ZM2 8.5l6 3.5 6-3.5M2 11.5 8 15l6-3.5',
  segment: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z',
  chevron: 'M4 6l4 4 4-4',
  // Brushes
  recolor: 'M3 13.5 1.5 12l4-4M9.5 3.5 12.5 6.5 6 13H3v-3zM11 2l3 3',
  fade: 'M8 1.5a6.5 6.5 0 1 0 0 13zM8 1.5a6.5 6.5 0 0 1 0 13',
  grab: 'M5 8V3.5a1 1 0 0 1 2 0V7M7 7V2.5a1 1 0 0 1 2 0V7M9 7V3.5a1 1 0 0 1 2 0V8M11 8a1 1 0 0 1 2 0v3.5c0 2-1.5 3-3.5 3H8c-1 0-2-.6-2.8-1.5L3.5 11a1 1 0 0 1 1.5-1.3L6 10.5',
  inflate: 'M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM8 1v2M8 13v2M1 8h2M13 8h2',
  measure: 'M2.5 10.5 10.5 2.5l3 3-8 8zM5 8l1.5 1.5M7 6l1.5 1.5M9 4l1.5 1.5',
  polyline: 'M2 13.5 5 3.5l5 7 4-8.5M2 13.5h12',
};

export function icon(name: string): string {
  return (
    `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" ` +
    `fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" ` +
    `stroke-linejoin="round"><path d="${PATHS[name] ?? ''}"/></svg>`
  );
}
