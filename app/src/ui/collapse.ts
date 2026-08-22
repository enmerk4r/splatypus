import { icon } from './icons';

export interface PanelShell {
  /** Where the panel renders its content. */
  body: HTMLElement;
  setCollapsed(collapsed: boolean): void;
  dispose(): void;
}

/**
 * Gives a right-rail panel a header (icon, title, chevron) that collapses its body.
 * The collapsed state is remembered per title in localStorage.
 */
export function createPanelShell(
  root: HTMLElement,
  title: string,
  iconName: string,
  defaultCollapsed = false,
): PanelShell {
  const key = `splatypus.panel.${title.toLowerCase()}.collapsed`;
  root.replaceChildren();
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'panel-head';
  head.innerHTML = `${icon(iconName)}<span>${title}</span><span class="panel-chevron">${icon('chevron')}</span>`;
  const body = document.createElement('div');
  body.className = 'panel-body';
  root.append(head, body);

  const setCollapsed = (collapsed: boolean): void => {
    root.classList.toggle('collapsed', collapsed);
    head.setAttribute('aria-expanded', String(!collapsed));
    head.title = collapsed ? `Expand ${title}` : `Collapse ${title}`;
    try {
      localStorage.setItem(key, collapsed ? '1' : '0');
    } catch {
      // Storage can be unavailable (private mode); the state then lives for the session only.
    }
  };
  let initial = defaultCollapsed;
  try {
    const saved = localStorage.getItem(key);
    initial = saved === null ? defaultCollapsed : saved === '1';
  } catch {
    initial = defaultCollapsed;
  }
  setCollapsed(initial);
  const onClick = (): void => setCollapsed(!root.classList.contains('collapsed'));
  head.addEventListener('click', onClick);
  return {
    body,
    setCollapsed,
    dispose: (): void => head.removeEventListener('click', onClick),
  };
}
