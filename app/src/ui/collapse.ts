/**
 * Makes a panel fold down to its header.
 *
 * Collapsing hides the body rather than the whole panel, so the header stays as the
 * handle that brings it back — a panel that vanished entirely would need a second
 * control somewhere else to restore it.
 */
export function wireCollapse(
  panel: HTMLElement,
  button: HTMLButtonElement,
  body: HTMLElement,
): { dispose: () => void } {
  const apply = (collapsed: boolean): void => {
    panel.classList.toggle('is-collapsed', collapsed);
    body.hidden = collapsed;
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? 'Expand' : 'Collapse';
  };
  const onClick = (): void => apply(!panel.classList.contains('is-collapsed'));
  button.addEventListener('click', onClick);
  apply(false);
  return { dispose: (): void => button.removeEventListener('click', onClick) };
}
