import type { Document } from './Document';
import type { Layer } from './Layer';

export interface Command {
  readonly label: string;
  do(): void;
  undo(): void;
  dispose?(): void;
}

export class LockedLayerError extends Error {}

export class History extends EventTarget {
  readonly limit = 100;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  push(command: Command): void {
    command.do();
    this.redoStack.forEach((item) => item.dispose?.());
    this.redoStack = [];
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift()?.dispose?.();
    this.changed('do', command.label);
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.changed('undo', command.label);
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    command.do();
    this.undoStack.push(command);
    this.changed('redo', command.label);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    [...this.undoStack, ...this.redoStack].forEach((command) => command.dispose?.());
    this.undoStack = [];
    this.redoStack = [];
    this.changed('clear', '');
  }

  private changed(action: string, label: string): void {
    this.dispatchEvent(new CustomEvent('history-changed', { detail: { action, label } }));
  }
}

export abstract class LayerValueCommand<T> implements Command {
  abstract readonly label: string;
  constructor(
    protected readonly document: Document,
    protected readonly id: string,
    protected readonly before: T,
    protected readonly after: T,
  ) {}
  abstract apply(value: T): void;
  do(): void {
    this.apply(this.after);
  }
  undo(): void {
    this.apply(this.before);
  }
  protected layer(): Layer {
    const layer = this.document.getLayer(this.id);
    if (!layer) throw new Error('Layer no longer exists');
    return layer;
  }
}
