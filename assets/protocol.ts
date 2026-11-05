// Messages between the editor shell (parent window) and the page in the iframe.
// The security token only lives in the shell; the frame cannot talk to the API.
import type { Shortcut } from './shortcuts';

export interface InlineConfig {
  field: string;
  selector: string | null;
  /** A table or a list: each cell or item is edited where it is shown. A file: the image is replaced. */
  mode: 'rich' | 'plain' | 'table' | 'list' | 'terms' | 'file';
  /** The headline of the accordion section around the element, which is outside of its root. */
  section?: boolean;
  /** Found in the page by its text. A plain value is a string then, not a text with a unit. */
  scalar?: boolean;
  /** A text area without an editor: Shift+Enter starts a new line. */
  multiline?: boolean;
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

/** The news or event of a reader page, named by the server. */
export interface FrameRecord {
  table: string;
  id: number;
  /** The reader module, where the fields of the record are shown. */
  scope: string;
}

export interface RecordField {
  name: string;
  value: string;
  editable: boolean;
}

/** Where a new element went: next to another one or into an empty article. */
export interface InsertPlace {
  after?: number;
  into?: number;
}

export type ToFrame =
  | { type: 'cbe:hello' }
  | { type: 'cbe:end' }
  | { type: 'cbe:elements'; elements: FrameElement[] }
  | { type: 'cbe:value'; id: number; field: string; value: unknown }
  /**
   * A new element is not in the page yet: it goes next to the one it was added after, or into
   * the empty article. Shown means it is brought into view and its text is opened.
   */
  | ({ type: 'cbe:refresh'; id: number; show?: boolean } & InsertPlace)
  /** Deleted, with the elements nested in it. */
  | { type: 'cbe:remove'; id: number }
  /** Brings an element into view, for example the one opened from the back end. */
  | { type: 'cbe:show'; id: number }
  /** Null if the picker was closed without a choice. */
  | { type: 'cbe:picked'; value: string | null }
  | { type: 'cbe:revert'; id: number; field: string; value: unknown }
  | { type: 'cbe:moved'; id: number; ok: boolean }
  /** Whether the names of pages can be edited in the navigation. */
  | { type: 'cbe:nav-edit'; enabled: boolean }
  | { type: 'cbe:nav-pages'; pages: NavPage[] }
  | { type: 'cbe:page-title'; id: number; title: string }
  | { type: 'cbe:record'; scope: string; fields: RecordField[] }
  | { type: 'cbe:record-value'; field: string; value: string };

export type ToShell =
  | { type: 'cbe:ready'; load: number; page: FramePage | null; ids: number[]; record: FrameRecord | null }
  | { type: 'cbe:navigate'; href: string }
  | { type: 'cbe:select'; id: number | null }
  | { type: 'cbe:change'; id: number; field: string; value: unknown }
  | { type: 'cbe:commit'; id: number; render: boolean }
  | { type: 'cbe:move'; id: number; target: number; position: MovePosition }
  /** A new element after this one. */
  | { type: 'cbe:insert'; id: number }
  /** The first element of an article without any. */
  | { type: 'cbe:insert-into'; article: number }
  | { type: 'cbe:pick-link'; id: number; value: string }
  /** Another file for the field, chosen in the shell. */
  | { type: 'cbe:pick-file'; id: number; field: string }
  | { type: 'cbe:nav-links'; urls: string[] }
  | { type: 'cbe:page-select'; id: number }
  | { type: 'cbe:page-change'; id: number; title: string }
  | { type: 'cbe:record-select' }
  | { type: 'cbe:record-change'; field: string; value: string }
  /** Pressed while the page had the focus. */
  | { type: 'cbe:shortcut'; name: Shortcut };

const PREFIX = 'cbe:';

/** Accepts a message only from the expected window on our own origin. */
export function readMessage<T extends { type: string }>(event: MessageEvent, source: unknown): T | null {
  if (event.origin !== window.location.origin || event.source !== source) {
    return null;
  }

  const data = event.data as { type?: unknown } | null;

  return data && typeof data.type === 'string' && data.type.startsWith(PREFIX) ? (data as T) : null;
}
