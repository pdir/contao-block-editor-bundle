// Choices of the editor that outlast the session: the width of the preview, whether the
// inspector shows and whether corners are rounded. They are only conveniences, so without
// storage a choice lasts until the next reload.

export const VIEWPORTS = ['desktop', 'tablet', 'mobile'] as const;

export type Viewport = (typeof VIEWPORTS)[number];

const VIEWPORT_KEY = 'cbe-viewport';
const INSPECTOR_KEY = 'cbe-inspector';
const CORNERS_KEY = 'cbe-corners';
const NAV_EDIT_KEY = 'cbe-nav-edit';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // See above
  }
}

export function storedViewport(): Viewport {
  const value = read(VIEWPORT_KEY);

  return (VIEWPORTS as readonly string[]).includes(value ?? '') ? (value as Viewport) : 'desktop';
}

export function storedInspector(): boolean {
  return read(INSPECTOR_KEY) !== 'hidden';
}

export function storedRoundCorners(): boolean {
  return read(CORNERS_KEY) !== 'square';
}

/**
 * The layout follows these attributes on the root element, so they can be set before the
 * first paint, without waiting for the module scripts.
 */
export function applyViewport(root: HTMLElement, viewport: Viewport, store = false): void {
  root.dataset.cbeViewport = viewport;

  if (store) {
    write(VIEWPORT_KEY, viewport);
  }
}

export function applyInspector(root: HTMLElement, visible: boolean, store = false): void {
  root.dataset.cbeInspector = visible ? 'visible' : 'hidden';

  if (store) {
    write(INSPECTOR_KEY, visible ? 'visible' : 'hidden');
  }
}

/** Also set on the page in the preview, where the drag handle and the bars follow it. */
export function applyCorners(root: HTMLElement, round: boolean, store = false): void {
  if (round) {
    delete root.dataset.cbeCorners;
  } else {
    root.dataset.cbeCorners = 'square';
  }

  if (store) {
    write(CORNERS_KEY, round ? 'round' : 'square');
  }
}

/** Whether page names can be edited in the navigation. Off by default: links lead to their page. */
export function storedNavEdit(): boolean {
  return read(NAV_EDIT_KEY) === 'on';
}

export function storeNavEdit(enabled: boolean): void {
  write(NAV_EDIT_KEY, enabled ? 'on' : 'off');
}
