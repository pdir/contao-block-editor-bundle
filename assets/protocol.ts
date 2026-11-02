// Messages between the editor shell (parent window) and the page in the iframe.
// The security token only lives in the shell; the frame cannot talk to the API.

export interface InlineConfig {
  field: string;
  selector: string | null;
  mode: 'rich' | 'plain';
  /** The headline of the accordion section around the element, which is outside of its root. */
  section?: boolean;
  /** Found in the page by its text. A plain value is a string then, not a text with a unit. */
  scalar?: boolean;
}

export interface FrameElement {
  id: number;
  inline: InlineConfig[];
  values: Record<string, unknown>;
}

export type MovePosition = 'before' | 'after';

export interface FramePage {
  id: number;
  title: string;
}

/** A page behind a link of the navigation, by the address the frame knows the link by. */
export interface NavPage {
  url: string;
  id: number;
  title: string;
  editable: boolean;
}

export type ToFrame =
  | { type: 'cbe:hello' }
  | { type: 'cbe:end' }
  | { type: 'cbe:elements'; elements: FrameElement[] }
  | { type: 'cbe:value'; id: number; field: string; value: unknown }
  | { type: 'cbe:refresh'; id: number }
  /** Brings an element into view, for example the one opened from the back end. */
  | { type: 'cbe:show'; id: number }
  /** Null if the picker was closed without a choice. */
  | { type: 'cbe:picked'; value: string | null }
  | { type: 'cbe:revert'; id: number; field: string; value: unknown }
  | { type: 'cbe:moved'; id: number; ok: boolean }
  /** Whether the names of pages can be edited in the navigation. */
  | { type: 'cbe:nav-edit'; enabled: boolean }
  | { type: 'cbe:nav-pages'; pages: NavPage[] }
  | { type: 'cbe:page-title'; id: number; title: string };

export type ToShell =
  | { type: 'cbe:ready'; load: number; page: FramePage | null; ids: number[] }
  | { type: 'cbe:navigate'; href: string }
  | { type: 'cbe:select'; id: number | null }
  | { type: 'cbe:change'; id: number; field: string; value: unknown }
  | { type: 'cbe:commit'; id: number; render: boolean }
  | { type: 'cbe:move'; id: number; target: number; position: MovePosition }
  | { type: 'cbe:pick-link'; id: number; value: string }
  | { type: 'cbe:nav-links'; urls: string[] }
  | { type: 'cbe:page-select'; id: number }
  | { type: 'cbe:page-change'; id: number; title: string };

const PREFIX = 'cbe:';

/** Accepts a message only from the expected window on our own origin. */
export function readMessage<T extends { type: string }>(event: MessageEvent, source: unknown): T | null {
  if (event.origin !== window.location.origin || event.source !== source) {
    return null;
  }

  const data = event.data as { type?: unknown } | null;

  return data && typeof data.type === 'string' && data.type.startsWith(PREFIX) ? (data as T) : null;
}
