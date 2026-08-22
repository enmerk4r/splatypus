import { Color } from 'three';
import type { Viewer } from '../viewer/Viewer';
import type { Segments } from './Segments';
import { UNASSIGNED } from '../splats/groups';
import { buildPalette, UNASSIGNED_COLOUR } from './groupPalette';

/**
 * Paints the whole scene by group, so the quality of a segmentation is visible at a
 * glance instead of discovered by clicking.
 *
 * Without it the only way to judge a bake is to click around and see what selects,
 * which makes an unassigned splat indistinguishable from a broken picker — and the
 * connectivity bake leaves a lot of them. Here the gaps are simply grey.
 */
export class GroupOverlay extends EventTarget {
  private enabledValue = false;
  private blendValue = 0.85;

  constructor(
    private readonly viewer: Viewer,
    private readonly segments: Segments,
  ) {
    super();
    // A new scene arrives with its own colours, so there is nothing painted to undo.
    viewer.addEventListener('document-changed', () => {
      this.enabledValue = false;
      this.dispatchEvent(new Event('overlay-changed'));
    });
    segments.addEventListener('groups-changed', () => this.refresh());
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get blend(): number {
    return this.blendValue;
  }

  get available(): boolean {
    return this.viewer.document?.groups !== undefined;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledValue) return;
    this.enabledValue = enabled;
    this.apply();
    this.dispatchEvent(new Event('overlay-changed'));
  }

  setBlend(blend: number): void {
    this.blendValue = Math.min(Math.max(blend, 0), 1);
    if (this.enabledValue) this.apply();
    this.dispatchEvent(new Event('overlay-changed'));
  }

  /** Re-paints after the segmentation itself changed. */
  refresh(): void {
    if (this.enabledValue) this.apply();
  }

  private apply(): void {
    const document = this.viewer.document;
    if (!document) return;
    const groups = document.groups;
    if (!this.enabledValue || !groups) {
      document.resetColours();
    } else {
      const palette = buildPalette(groups.numGroups);
      const blend = this.blendValue;
      const label = new Color();
      document.paintBy((index, out) => {
        const id = groups.groupOf(index);
        if (id === UNASSIGNED || id >= groups.numGroups) {
          label.copy(UNASSIGNED_COLOUR);
        } else {
          label.setRGB(palette[id * 3]!, palette[id * 3 + 1]!, palette[id * 3 + 2]!);
        }
        document.baseColour(index, out).lerp(label, blend);
      });
    }
    // The repaint went straight over any highlight; put it back on top.
    this.segments.retint();
  }
}
