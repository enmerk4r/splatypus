import { describe, expect, it } from 'vitest';
import { History } from '../src/model/commands';
import type { Command } from '../src/model/commands';

describe('History', () => {
  it('executes, undoes, redoes, and clears redo on a new command', () => {
    const history = new History();
    let value = 0;
    const command = (amount: number): Command => ({
      label: `Add ${amount}`,
      do: () => {
        value += amount;
      },
      undo: () => {
        value -= amount;
      },
    });
    history.push(command(2));
    history.push(command(3));
    expect(value).toBe(5);
    history.undo();
    expect(value).toBe(2);
    expect(history.canRedo()).toBe(true);
    history.redo();
    expect(value).toBe(5);
    history.undo();
    history.push(command(7));
    expect(value).toBe(9);
    expect(history.canRedo()).toBe(false);
  });

  it('keeps only the newest 100 commands', () => {
    const history = new History();
    let value = 0;
    for (let index = 0; index < 101; index += 1)
      history.push({
        label: 'Increment',
        do: () => {
          value += 1;
        },
        undo: () => {
          value -= 1;
        },
      });
    for (let index = 0; index < 101; index += 1) history.undo();
    expect(value).toBe(1);
  });
});
