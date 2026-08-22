import type { Document } from '../model/Document';
import type { Layer, LayerKind } from '../model/Layer';
import {
  DuplicateLayer,
  LockedLayerError,
  MergeLayers,
  MoveLayer,
  RemoveLayers,
  RenameLayer,
  SetLayerLocked,
  SetLayerVisible,
} from '../model/commands';
import type { Viewer } from '../viewer/Viewer';
import { createPanelShell } from './collapse';
import type { ToastLevel } from './hud';
import { icon } from './icons';

export interface LayersPanelCallbacks {
  onAdd: () => void;
  notify: (message: string, level?: ToastLevel) => void;
}

const KIND_COLORS: Record<LayerKind, string> = {
  scan: '#73a7ff',
  pointcloud: '#b8f34a',
  sketch: '#ff7868',
  segment: '#d49cff',
};

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

export function createLayersPanel(
  viewer: Viewer,
  root: HTMLElement,
  callbacks: LayersPanelCallbacks,
): { dispose: () => void } {
  let observed: Document | undefined;
  let anchorId: string | undefined;
  const shell = createPanelShell(root, 'LAYERS', 'layers');
  const body = shell.body;

  const execute = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      const locked = error instanceof LockedLayerError;
      callbacks.notify(
        locked ? error.message : 'That layer action failed.',
        locked ? 'warning' : 'error',
      );
      if (!locked) console.error(error);
    }
  };

  const button = (label: string, title: string, action: () => void): HTMLButtonElement => {
    const value = document.createElement('button');
    value.type = 'button';
    value.textContent = label;
    value.title = title;
    value.addEventListener('click', action);
    return value;
  };

  const selectRow = (event: MouseEvent, id: string, displayed: readonly Layer[]): void => {
    const document = observed;
    if (!document) return;
    if (event.shiftKey && anchorId) {
      const from = displayed.findIndex((layer) => layer.id === anchorId);
      const to = displayed.findIndex((layer) => layer.id === id);
      if (from >= 0 && to >= 0)
        document.setSelection(
          displayed.slice(Math.min(from, to), Math.max(from, to) + 1).map((layer) => layer.id),
        );
    } else if (event.ctrlKey || event.metaKey) {
      const next = new Set(document.selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      document.setSelection([...next]);
      anchorId = id;
    } else {
      document.setSelection([id]);
      anchorId = id;
    }
  };

  const startRename = (name: HTMLElement, layer: Layer): void => {
    if (!observed || layer.locked) return;
    const input = document.createElement('input');
    input.className = 'layer-name-input';
    input.value = layer.name;
    name.replaceWith(input);
    input.focus();
    input.select();
    const finish = (commit: boolean): void => {
      if (!input.isConnected) return;
      if (commit) {
        const next = input.value.trim();
        if (next && next !== layer.name)
          execute(() =>
            observed?.history.push(new RenameLayer(observed, layer.id, layer.name, next)),
          );
      }
      render();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true), { once: true });
  };

  const layerRow = (layer: Layer, displayed: readonly Layer[]): HTMLElement => {
    const row = document.createElement('div');
    row.className = `layer-row${observed?.selection.has(layer.id) ? ' selected' : ''}${layer.locked ? ' locked' : ''}`;
    row.dataset.layerId = layer.id;
    const eye = button('', layer.visible ? 'Hide layer' : 'Show layer', () => {
      if (observed)
        execute(() =>
          observed!.history.push(
            new SetLayerVisible(observed!, layer.id, layer.visible, !layer.visible),
          ),
        );
    });
    eye.innerHTML = icon(layer.visible ? 'visible' : 'hidden');
    eye.className = 'layer-icon';
    eye.setAttribute('aria-label', eye.title);
    eye.setAttribute('aria-pressed', String(layer.visible));
    const lock = button('', layer.locked ? 'Unlock layer' : 'Lock layer', () => {
      if (observed)
        execute(() =>
          observed!.history.push(
            new SetLayerLocked(observed!, layer.id, layer.locked, !layer.locked),
          ),
        );
    });
    lock.innerHTML = icon(layer.locked ? 'lock' : 'unlock');
    lock.className = 'layer-icon';
    lock.setAttribute('aria-label', lock.title);
    lock.setAttribute('aria-pressed', String(layer.locked));
    const tag = document.createElement('i');
    tag.className = 'layer-tag';
    tag.style.background = KIND_COLORS[layer.kind];
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;
    name.title = layer.name;
    name.addEventListener('dblclick', () => startRename(name, layer));
    const count = document.createElement('span');
    count.className = 'layer-count';
    count.textContent = compactCount(layer.store.liveCount());
    const sh = document.createElement('span');
    sh.className = `layer-sh${layer.store.shDegree ? ' present' : ''}`;
    sh.title = layer.store.shDegree ? `SH degree ${layer.store.shDegree}` : 'DC color only';
    row.append(eye, lock, tag, name, count, sh);
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button,input')) return;
      selectRow(event, layer.id, displayed);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      startRename(name, layer);
    });
    return row;
  };

  const render = (): void => {
    const model = observed;
    body.replaceChildren();
    root.hidden = !model || model.layers.length === 0;
    if (!model || model.layers.length === 0) return;
    const list = document.createElement('div');
    list.className = 'layers-list';
    const displayed = [...model.layers].reverse();
    displayed.forEach((layer) => list.append(layerRow(layer, displayed)));
    const selected = [...model.selection]
      .map((id) => model.getLayer(id))
      .filter((layer): layer is Layer => Boolean(layer));
    const active = model.active();
    const toolbar = document.createElement('div');
    toolbar.className = 'layers-toolbar';
    const toolButton = (
      iconName: string,
      label: string,
      title: string,
      action: () => void,
    ): HTMLButtonElement => {
      const value = button('', title, action);
      value.innerHTML = icon(iconName);
      value.setAttribute('aria-label', label);
      return value;
    };
    const add = toolButton('add', 'Add layer', 'Add files as layers', callbacks.onAdd);
    const duplicate = toolButton('duplicate', 'Duplicate', 'Duplicate selected layer', () => {
      if (!active) return;
      execute(() => {
        const command = new DuplicateLayer(model, active);
        model.history.push(command);
        model.setSelection([command.duplicate.id]);
      });
    });
    const merge = toolButton('merge', 'Merge', 'Merge selected layers', () => {
      if (selected.length < 2) return;
      execute(() => {
        const command = new MergeLayers(
          model,
          selected.map((layer) => layer.id),
          `${selected[0]?.name ?? 'Layer'} merge`,
        );
        model.history.push(command);
        model.setSelection([command.merged.id]);
      });
    });
    const remove = toolButton('delete', 'Delete', 'Delete selected layers', () => {
      if (selected.length)
        execute(() =>
          model.history.push(
            new RemoveLayers(
              model,
              selected.map((layer) => layer.id),
            ),
          ),
        );
    });
    const move = (delta: number): void => {
      if (!active) return;
      const from = model.layers.findIndex((layer) => layer.id === active.id);
      const to = Math.max(0, Math.min(model.layers.length - 1, from + delta));
      if (to !== from) execute(() => model.history.push(new MoveLayer(model, active.id, from, to)));
    };
    const up = toolButton('up', 'Move up', 'Move layer up', () => move(1));
    const down = toolButton('down', 'Move down', 'Move layer down', () => move(-1));
    const visibility = toolButton(
      active?.visible ? 'visible' : 'hidden',
      active?.visible ? 'Hide' : 'Show',
      active?.visible ? 'Hide selected layer' : 'Show selected layer',
      () => {
        if (!active) return;
        execute(() =>
          model.history.push(
            new SetLayerVisible(model, active.id, active.visible, !active.visible),
          ),
        );
      },
    );
    const lock = toolButton(
      active?.locked ? 'lock' : 'unlock',
      active?.locked ? 'Unlock' : 'Lock',
      active?.locked ? 'Unlock selected layer' : 'Lock selected layer',
      () => {
        if (!active) return;
        execute(() =>
          model.history.push(new SetLayerLocked(model, active.id, active.locked, !active.locked)),
        );
      },
    );
    visibility.setAttribute('aria-pressed', String(active?.visible === true));
    lock.setAttribute('aria-pressed', String(active?.locked === true));
    visibility.disabled = !active;
    lock.disabled = !active;
    duplicate.disabled = !active || active.locked;
    merge.disabled = selected.length < 2 || selected.some((layer) => layer.locked);
    remove.disabled = selected.length === 0 || selected.some((layer) => layer.locked);
    up.disabled = !active || active.locked || model.layers.at(-1)?.id === active.id;
    down.disabled = !active || active.locked || model.layers[0]?.id === active.id;
    toolbar.append(add, duplicate, merge, up, down, visibility, lock, remove);
    const footer = document.createElement('div');
    footer.className = 'layers-footer';
    footer.textContent = `${model.layers.length} layers · ${compactCount(model.totalLive())} splats · ${compactCount(model.hiddenCount())} hidden`;
    body.append(toolbar, list, footer);
  };

  const observe = (): void => {
    observed?.removeEventListener('layers-changed', render);
    observed?.removeEventListener('layer-changed', render);
    observed?.removeEventListener('selection-changed', render);
    observed = viewer.document;
    observed?.addEventListener('layers-changed', render);
    observed?.addEventListener('layer-changed', render);
    observed?.addEventListener('selection-changed', render);
    render();
  };
  viewer.addEventListener('document-changed', observe);
  observe();
  return {
    dispose: () => {
      viewer.removeEventListener('document-changed', observe);
      observed?.removeEventListener('layers-changed', render);
      observed?.removeEventListener('layer-changed', render);
      observed?.removeEventListener('selection-changed', render);
      shell.dispose();
    },
  };
}
