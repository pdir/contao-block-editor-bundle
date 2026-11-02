// The editor's global keyboard shortcuts, shared by the shell and the page in the frame.
//
// Browsers use nearly every combination of Ctrl/Cmd with a letter, and with Shift as well.
// Alt opens the browser's menus on Windows, and Option types characters on a Mac (Option+L
// is the @ of a German keyboard), just like AltGr, which is Ctrl+Alt on Windows. So:
// - while typing, only Cmd/Ctrl+Shift+Comma works, which no browser uses
// - otherwise single keys without modifiers, which can be switched off for screen readers
//   (WCAG 2.1.4). Not "/" or "'": Firefox starts its quick find with them.

export type Shortcut = 'help' | 'inspector' | 'nav-edit' | 'desktop' | 'tablet' | 'mobile';

const SINGLE_KEYS: Record<string, Shortcut> = {
  '?': 'help',
  i: 'inspector',
  n: 'nav-edit',
  1: 'desktop',
  2: 'tablet',
  3: 'mobile',
};

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

/** Single keys belong to the text while something is typed. */
export function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

export function shortcutFor(event: KeyboardEvent, singleKeys: boolean): Shortcut | null {
  if (event.isComposing || event.repeat) {
    return null;
  }

  const primary = isMac() ? event.metaKey : event.ctrlKey;

  // The physical key: Shift+Comma is a semicolon on a German keyboard
  if (primary && event.shiftKey && !event.altKey && event.code === 'Comma') {
    return 'inspector';
  }

  if (!singleKeys || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) {
    return null;
  }

  return SINGLE_KEYS[event.key] ?? null;
}
