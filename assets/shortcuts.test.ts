// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shortcutFor } from './shortcuts';

function press(init: KeyboardEventInit, target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, ...init });
  Object.defineProperty(event, 'target', { value: target });

  return event;
}

function onPlatform(platform: string): void {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
}

describe('shortcutFor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('knows the single keys', () => {
    expect(shortcutFor(press({ key: '?' }), true)).toBe('help');
    expect(shortcutFor(press({ key: 'e' }), true)).toBe('edit');
    expect(shortcutFor(press({ key: 'i' }), true)).toBe('inspector');
    expect(shortcutFor(press({ key: 'n' }), true)).toBe('nav-edit');
    expect(shortcutFor(press({ key: '3' }), true)).toBe('mobile');
  });

  it('leaves single keys to the text that is being typed', () => {
    document.body.innerHTML = '<input><div contenteditable="plaintext-only"><b>x</b></div>';

    expect(shortcutFor(press({ key: 'i' }, document.querySelector('input') as Element), true)).toBeNull();
    expect(shortcutFor(press({ key: 'n' }, document.querySelector('b') as Element), true)).toBeNull();
  });

  it('never takes a combination of the browser or of a character', () => {
    // Ctrl+N: new window; Option+N on a Mac and AltGr on Windows type characters
    expect(shortcutFor(press({ key: 'n', ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(press({ key: 'n', metaKey: true }), true)).toBeNull();
    expect(shortcutFor(press({ key: 'n', altKey: true }), true)).toBeNull();
    expect(shortcutFor(press({ key: 'n', ctrlKey: true, altKey: true }), true)).toBeNull();
  });

  it('can do without single keys, e.g. for screen readers', () => {
    expect(shortcutFor(press({ key: 'i' }), false)).toBeNull();
  });

  it('toggles the inspector with the primary modifier, Shift and comma, also while typing', () => {
    document.body.innerHTML = '<textarea></textarea>';
    const field = document.querySelector('textarea') as Element;

    onPlatform('MacIntel');
    expect(shortcutFor(press({ key: ';', code: 'Comma', metaKey: true, shiftKey: true }, field), false)).toBe('inspector');
    expect(shortcutFor(press({ key: ';', code: 'Comma', ctrlKey: true, shiftKey: true }, field), false)).toBeNull();

    onPlatform('Win32');
    expect(shortcutFor(press({ key: ';', code: 'Comma', ctrlKey: true, shiftKey: true }, field), false)).toBe('inspector');
  });
});
