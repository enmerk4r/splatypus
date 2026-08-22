import type { GroupInfo } from '../splats/groups';
import type { Segments } from '../select/Segments';

interface HoverDetail {
  info?: GroupInfo;
  x?: number;
  y?: number;
}

/**
 * Names the group under the cursor, next to the cursor.
 *
 * The panel already says what is *selected*; this says what a click would select, which
 * is the part that is otherwise pure guesswork on a cloud with no visible edges.
 */
export function createHoverLabel(host: HTMLElement, segments: Segments): { dispose: () => void } {
  const onHover = (event: Event): void => {
    const { info, x, y } = (event as CustomEvent<HoverDetail>).detail;
    if (!info || x === undefined || y === undefined) {
      host.hidden = true;
      return;
    }
    host.textContent = `${info.name} · ${info.count.toLocaleString()}`;
    host.hidden = false;
    // Measured after unhiding, so a label near the right or bottom edge flips inside.
    const width = host.offsetWidth;
    const height = host.offsetHeight;
    const left = x + 14 + width > window.innerWidth ? x - 14 - width : x + 14;
    const top = y + 14 + height > window.innerHeight ? y - 14 - height : y + 14;
    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  segments.addEventListener('hover-changed', onHover);
  return {
    dispose: (): void => segments.removeEventListener('hover-changed', onHover),
  };
}
