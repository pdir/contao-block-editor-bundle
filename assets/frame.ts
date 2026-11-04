import type { Editor } from '@tiptap/core';
import { ICONS, iconElement } from './editor-icons';
import { LinkBar } from './link-bar';
import { NavLinks } from './nav-links';
import { RecordFields } from './record-fields';
import { classifyLink, linkLabel, type FramePaths } from './navigation';
import type { FrameElement, FramePage, FrameRecord, InlineConfig, MovePosition, ToFrame, ToShell } from './protocol';
import { readMessage } from './protocol';
import type * as RichText from './rich-text';
import { canEditInline } from './rich-text-policy';
import { storedSingleKeys } from './settings';
import { cellHtml, cellText, insertColumn, insertRow, isPlainCell, matchRows, removeColumn, removeRow, setCell, toRows, type Rows } from './table-data';
import { isTyping, shortcutFor } from './shortcuts';
import { findByText, wrapTextRun } from './text-target';

const ID_ATTRIBUTE = 'data-be-id';
const BUDGET_MS = 50;
const HANDLE_SPACE = 30;
/** Rounded corners and hover effects put the handle's way outside of the element. */
const HANDLE_CORNER = 32;
const HANDLE_MARGIN = 8;
const HANDLE_SWITCH_DELAY = 200;
/** The button for a new element, below the handle. */
const HANDLE_GAP = 32;
const ADDER_HEIGHT = 28;

const known = new Map<number, FrameElement>();

interface Session {
  element: FrameElement;
  inline: InlineConfig;
  /** The value when editing started, to detect whether anything changed. */
  initial: string;
  /** Whether the shown content was rendered, or still contained raw insert tags. */
  showedRaw: boolean;
  /** The rendered nodes, shown again if nothing changed: no request is needed for that. */
  rendered: ChildNode[];
  target: HTMLElement;
  /** Only rich text has one: its links can be changed. */
  editor?: Editor;
  cleanup(): void;
  showValue(): void;
  /** Runs last, when the content of the target is final. */
  restore?(): void;
  /** Where the bar goes instead of above the target, e.g. above the whole table. */
  barAnchor?: HTMLElement;
}

let session: Session | null = null;
/** Set up once the paths of the page are known. */
let nav: NavLinks | null = null;
let record: RecordFields | null = null;

function hasInsertTag(value: unknown): boolean {
  return (JSON.stringify(value) ?? '').includes('{{');
}

function snapshot(element: FrameElement, inline: InlineConfig, target: HTMLElement): Pick<Session, 'element' | 'inline' | 'initial' | 'showedRaw' | 'rendered' | 'target'> {
  return {
    element,
    inline,
    initial: JSON.stringify(element.values[inline.field]) ?? '',
    showedRaw: target.innerHTML.includes('{{'),
    rendered: Array.from(target.childNodes),
    target,
  };
}

/** The button with the headline of the accordion section around an element. */
function sectionButton(root: HTMLElement): HTMLElement | null {
  const header = root.closest('.handorgel__content')?.previousElementSibling;

  return header?.querySelector<HTMLElement>('.handorgel__header__button') ?? null;
}

/** The element whose section headline this is: the headline itself is outside of all elements. */
function sectionOwner(hit: EventTarget | null): { id: number; root: HTMLElement } | null {
  const button = hit instanceof Element ? hit.closest('.handorgel__header__button') : null;
  const child = button?.closest('.handorgel__header')?.nextElementSibling?.querySelector(`[${ID_ATTRIBUTE}]`);
  const owner = child ? closestId(child) : null;

  return owner && known.get(owner.id)?.inline.some(({ section }) => section) ? owner : null;
}

/** The button is as wide as the accordion: only its text edits, the rest still folds. */
function isOnText(button: Element, x: number, y: number): boolean {
  const range = document.createRange();
  range.selectNodeContents(button);

  const rects = Array.from(range.getClientRects());

  return rects.length === 0 || rects.some(({ left, right, top, bottom }) => x >= left && x <= right && y >= top && y <= bottom);
}

/** What a rich text shows, to find it in the page. */
function htmlText(value: unknown): string {
  return new DOMParser().parseFromString(String(value ?? ''), 'text/html').body.textContent ?? '';
}

/** The text of a plain field, which is either a string or a text with a unit. */
function plainText(value: unknown): string {
  return decodeEntities((typeof value === 'string' ? value : (value as { value?: string } | null)?.value) ?? '');
}

/** The value is passed in when the element shows another one than the record has by now. */
function inlineTarget(inline: InlineConfig, root: HTMLElement, shown?: unknown): HTMLElement | null {
  if (inline.section) {
    return sectionButton(root);
  }

  const base = inline.selector ? root.querySelector<HTMLElement>(inline.selector) : root;

  if (inline.mode === 'rich') {
    return inline.scalar ? findByText(root, htmlText(shown === undefined ? known.get(Number(root.getAttribute(ID_ATTRIBUTE)))?.values[inline.field] : shown), (candidate) => candidate.closest(`[${ID_ATTRIBUTE}]`) === root) : base;
  }

  // Only a tag of its own can be replaced as a whole: others may hold further fields as well
  if (!inline.scalar && base && !base.children.length) {
    return base;
  }

  const element = known.get(Number(root.getAttribute(ID_ATTRIBUTE)));
  const richTargets = (element?.inline ?? []).filter(({ mode }) => mode === 'rich').map((rich) => inlineTarget(rich, root));
  const value = shown === undefined ? element?.values[inline.field] : shown;

  const scope = inline.scalar || !base ? root : base;
  const accepts = (candidate: HTMLElement): boolean => candidate.closest(`[${ID_ATTRIBUTE}]`) === root && !richTargets.some((target) => target?.contains(candidate));

  return findByText(scope, plainText(value), accepts) ?? wrapTextRun(scope, plainText(value), accepts);
}

/** The part under the pointer, otherwise the element's main text. */
function chooseInline(element: FrameElement, root: HTMLElement, hit: EventTarget | null): InlineConfig | null {
  const table = element.inline.find(({ mode }) => mode === 'table');
  const cell = hit instanceof Element ? hit.closest('td, th') : null;

  if (table && cell && root.querySelector(table.selector ?? 'table')?.contains(cell)) {
    return table;
  }

  const terms = element.inline.find(({ mode }) => mode === 'terms');
  const term = hit instanceof Element ? hit.closest('dt, dd') : null;

  if (terms && term && term.closest('dl') === root.querySelector(terms.selector ?? 'dl')) {
    return terms;
  }

  const list = element.inline.find(({ mode }) => mode === 'list');
  const item = hit instanceof Element ? hit.closest('li') : null;

  if (list && item && item.parentElement === root.querySelector(list.selector ?? 'ul, ol')) {
    return list;
  }

  const plains = element.inline.filter(({ mode }) => mode === 'plain');
  const riches = element.inline.filter(({ mode }) => mode === 'rich');
  const plain = plains.find(({ section }) => !section);
  const plainTarget = plain ? inlineTarget(plain, root) : null;
  // The innermost one: a headline can hold another field, such as its highlighted part
  const clicked = hit instanceof Node
    ? [...plains, ...riches]
      .map((inline) => ({ inline, target: inlineTarget(inline, root) }))
      .filter(({ target }) => target?.contains(hit))
      .sort((a, b) => (a.target?.contains(b.target as Node) ? 1 : -1))[0]?.inline
    : null;

  if (clicked) {
    return clicked;
  }

  // The main text, which the element's own configuration names first
  if (riches.length && !riches[0].scalar) {
    return riches[0];
  }

  return hit ? null : plainTarget ? (plain as InlineConfig) : table ?? list ?? terms ?? null;
}

function toShell(message: ToShell): void {
  window.parent.postMessage(message, window.location.origin);
}

function findElement(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${ID_ATTRIBUTE}="${id}"]`);
}

function closestId(target: EventTarget | null): { id: number; root: HTMLElement } | null {
  const root = target instanceof Element ? target.closest<HTMLElement>(`[${ID_ATTRIBUTE}]`) : null;
  const id = Number(root?.getAttribute(ID_ATTRIBUTE));

  return root && known.has(id) ? { id, root } : null;
}

/**
 * Turns a stored plain value into display text. Contao 5 stores "a &amp; b" and
 * Contao 6 stores "a & b <b>": entities are decoded, tags stay literal text.
 */
function decodeEntities(value: string): string {
  return new DOMParser().parseFromString(value.replace(/</g, '&lt;'), 'text/html').body.textContent ?? '';
}

function setHtml(target: HTMLElement, html: string): void {
  // Parsing in an inert document first, then moving the nodes: scripts stay inactive
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  target.replaceChildren(...Array.from(parsed.body.childNodes).map((node) => document.adoptNode(node)));
}

/**
 * The text editor (Tiptap) is most of the code of the frame. It is loaded when the page is idle,
 * so the page shows up without waiting for it, and at the latest with the first click into a text.
 */
let rich: typeof RichText | null = null;
let richLoading: Promise<void> | null = null;

function loadRich(): Promise<void> {
  richLoading ??= (import(script?.dataset.cbeRichText ?? '') as Promise<typeof RichText>).then((module) => {
    rich = module;
  }, (error: unknown) => {
    // Another try with the next click
    richLoading = null;
    console.error('[block-editor] Der Texteditor konnte nicht geladen werden:', error);
  });

  return richLoading;
}

/** Counts the activations: a start that waited for the editor only happens if nothing came after it. */
let activations = 0;

function startRich(element: FrameElement, inline: InlineConfig, root: HTMLElement, event: PointerEvent | null): boolean {
  const target = inlineTarget(inline, root);
  const { field } = inline;

  if (!rich) {
    const current = activations;

    void loadRich().then(() => {
      if (rich && current === activations && !session && !viewing() && root.isConnected) {
        startRich(element, inline, root, event);
        addParentButton(root);
      }
    });

    return false;
  }

  const { createRichEditor, renderFormatBar, richValue } = rich;

  // No data for this field: never empty the rendered content because of that
  if (element.values?.[field] === undefined) {
    return false;
  }

  const html = String(element.values[field] ?? '');

  // Markup outside of the schema (tables, images, classes) must not get lost silently
  if (!target || !canEditInline(html)) {
    return false;
  }

  const state = snapshot(element, inline, target);

  let editor: Editor | undefined;

  // A failed start must never leave the element empty
  try {
    target.replaceChildren();

    editor = createRichEditor({
      element: target,
      content: html,
      editorProps: {
        handleKeyDown: (_, keyEvent) => {
          if ((keyEvent.metaKey || keyEvent.ctrlKey) && !keyEvent.altKey && keyEvent.key.toLowerCase() === 'k') {
            keyEvent.preventDefault();
            refreshLinkBar(true);

            return true;
          }

          return false;
        },
      },
      onSelectionUpdate: () => refreshLinkBar(),
      onTransaction: () => {
        updateFormatBar?.();
        placeFormatBar();
      },
      onUpdate: ({ editor: instance }) => {
        element.values[field] = richValue(instance);
        toShell({ type: 'cbe:change', id: element.id, field, value: element.values[field] });
      },
    });

    // Put the caret where the user clicked
    if (event) {
      const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });

      if (position) {
        editor.commands.setTextSelection(position.pos);
      }
    }

    editor.view.focus();
  } catch (error) {
    console.error('[block-editor] Der Editor konnte nicht gestartet werden:', error);
    editor?.destroy();
    target.replaceChildren(...state.rendered);

    return false;
  }

  const started = editor;

  updateFormatBar = renderFormatBar(formatBar, started, () => refreshLinkBar(true));
  formatBar.hidden = false;

  session = {
    ...state,
    editor: started,
    cleanup: () => {
      formatBar.hidden = true;
      updateFormatBar = null;
      started.destroy();
    },
    showValue: () => setHtml(target, String(element.values[field] ?? '')),
  };

  placeFormatBar();
  refreshLinkBar();

  return true;
}

function placeCaret(x: number, y: number): void {
  const position = document.caretPositionFromPoint?.(x, y);
  const selection = window.getSelection();

  if (position && selection) {
    selection.collapse(position.offsetNode, position.offset);
  }
}

function startPlain(element: FrameElement, inline: InlineConfig, root: HTMLElement, event: PointerEvent | null): boolean {
  const button = inlineTarget(inline, root);

  if (!button) {
    return false;
  }

  const { field } = inline;

  if (element.values?.[field] === undefined) {
    return false;
  }

  const stored = element.values[field];
  const unit = (stored as { unit?: string } | null)?.unit;
  // Browsers can't edit inside of a button reliably, and the accordion listens to its keys and
  // clicks. So a stand-in takes its place for the time being, which looks the same.
  const target = inline.section ? document.createElement('div') : button;

  if (inline.section) {
    target.className = button.className;
    target.style.cursor = 'text';
    target.style.outline = '2px solid #f47c00';
    target.style.outlineOffset = '-2px';
    target.append(...Array.from(button.childNodes));
    button.replaceWith(target);
    // Closed, its content would stay out of sight during the edit
    (target.parentElement as (Element & { handorgelFold?: { open(): void } }) | null)?.handorgelFold?.open();
  }

  const state = snapshot(element, inline, target);

  target.textContent = plainText(stored);

  try {
    target.contentEditable = 'plaintext-only';
  } catch {
    // Browsers without this mode: only textContent is read, so no markup can get in
    target.contentEditable = 'true';
  }

  // Set focus and caret ourselves: the browser's own handling of the following mousedown
  // differs, and WebKit loses the focus when another editor was closed by the same click
  target.focus();

  if (event) {
    placeCaret(event.clientX, event.clientY);
  }

  const onInput = (): void => {
    element.values[field] = inline.scalar ? target.textContent ?? '' : { value: target.textContent ?? '', unit };
    toShell({ type: 'cbe:change', id: element.id, field, value: element.values[field] });
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      endSession();
    }
  };

  target.addEventListener('input', onInput);
  target.addEventListener('keydown', onKeydown);

  session = {
    ...state,
    cleanup() {
      target.removeEventListener('input', onInput);
      target.removeEventListener('keydown', onKeydown);
      target.removeAttribute('contenteditable');
    },
    // The text is in place already, as it was typed
    showValue() {},
    restore: inline.section ? () => {
      button.replaceChildren(...Array.from(target.childNodes));
      target.replaceWith(button);
    } : undefined,
  };

  return true;
}

/** The row of the data that a row of the table shows: header and footer at the ends. */
function dataRow(table: HTMLTableElement, row: HTMLTableRowElement, rows: Rows): number {
  const head = table.tHead?.rows.length ?? 0;
  const foot = table.tFoot?.rows.length ?? 0;
  const all = Array.from(table.rows);
  const body = all.slice(head, all.length - foot);
  const at = all.indexOf(row);

  if (at < head) {
    return at;
  }

  if (at >= all.length - foot) {
    return rows.length - (all.length - at);
  }

  const textOf = (cells: string[]): string[] => cells.map((cell) => cellText(cell.replace(/<[^>]*>/g, ' ')));
  const matched = matchRows(body.map((tr) => Array.from(tr.cells, (cell) => cell.textContent ?? '')), rows.slice(head, rows.length - foot).map(textOf));

  return head + (matched[at - head] ?? at - head);
}

/**
 * The image under the pointer. Found by its position: cards often lay their link over the
 * whole card, so the click itself hits the link.
 */
function imageAt(element: FrameElement, root: HTMLElement, event: PointerEvent | null): HTMLElement | null {
  if (!event || !element.inline.some(({ mode }) => mode === 'file')) {
    return null;
  }

  return Array.from(root.querySelectorAll<HTMLElement>('img, video')).find((image) => {
    const { left, right, top, bottom } = image.getBoundingClientRect();

    return event.clientX >= left && event.clientX <= right && event.clientY >= top && event.clientY <= bottom;
  }) ?? null;
}

/** A click on an image: the bar offers another one, which the shell lets the user choose. */
function startFile(element: FrameElement, inline: InlineConfig, image: HTMLElement): boolean {

  const many = Array.isArray(element.values[inline.field]) && (element.values[inline.field] as unknown[]).length > 1;
  const title = many ? 'Bilder auswählen' : 'Bild austauschen';
  const button = document.createElement('button');

  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.append(iconElement(document, ICONS.image));
  button.addEventListener('pointerdown', (down) => down.preventDefault());
  button.addEventListener('click', () => {
    endSession();
    toShell({ type: 'cbe:pick-file', id: element.id, field: inline.field });
  });

  formatBar.setAttribute('role', 'toolbar');
  formatBar.setAttribute('aria-label', 'Bild');
  formatBar.replaceChildren(button);
  formatBar.hidden = false;

  session = {
    ...snapshot(element, inline, image),
    cleanup() {},
    showValue() {},
    barAnchor: image,
  };

  placeFormatBar();

  // The caret stays where it was: nothing to type here
  return false;
}

type Term = { key: string; value: string };
const TERM_COLUMNS = [['key', 'DT'], ['value', 'DD']] as const;

/**
 * Which row and column each term (dt) and detail (dd) of the page shows. Templates leave out
 * empty ones; those added or emptied here are marked, so they are still counted.
 */
function termLayout(dl: HTMLElement, rows: Term[]): { part: HTMLElement; row: number; column: 'key' | 'value' }[] | null {
  const parts = Array.from(dl.querySelectorAll<HTMLElement>('dt, dd')).filter((part) => part.closest('dl') === dl);
  const layout: { part: HTMLElement; row: number; column: 'key' | 'value' }[] = [];

  rows.forEach((row, index) => {
    for (const [column, tag] of TERM_COLUMNS) {
      const part = parts[layout.length];

      if (row[column] !== '' || (part?.tagName === tag && part.hasAttribute('data-cbe-blank'))) {
        layout.push({ part, row: index, column });
      }
    }
  });

  return layout.length === parts.length && layout.every(({ part, column }) => part?.tagName === (column === 'key' ? 'DT' : 'DD')) ? layout : null;
}

/** The clicked term, or the first one for the keyboard. */
function startTerms(element: FrameElement, inline: InlineConfig, root: HTMLElement, event: PointerEvent | null): boolean {
  const dl = root.querySelector<HTMLElement>(inline.selector ?? 'dl');
  const hit = event?.target instanceof Element ? event.target.closest<HTMLElement>('dt, dd') : dl?.querySelector<HTMLElement>('dt, dd');

  return Boolean(dl && hit && hit.closest('dl') === dl && startTerm(element, inline, dl, hit, event));
}

/** A term or a detail: Enter goes on to the detail, then to a new entry. */
function startTerm(element: FrameElement, inline: InlineConfig, dl: HTMLElement, part: HTMLElement, event: PointerEvent | null, select = true): boolean {
  const { field } = inline;
  const rows = (): Term[] => (Array.isArray(element.values[field]) ? element.values[field] as Term[] : []).map((row) => ({ key: String(row?.key ?? ''), value: String(row?.value ?? '') }));
  const save = (next: Term[]): void => saveParts(element, field, next);
  const layout = termLayout(dl, rows());
  const place = layout?.find((entry) => entry.part === part);
  const restart = (next: HTMLElement, selectNext = true): void => void startTerm(element, inline, dl, next, null, selectNext);

  // A template of its own may show the entries in another way
  if (!layout || !place) {
    return false;
  }

  const { row, column } = place;
  const ofRow = layout.filter((entry) => entry.row === row).map((entry) => entry.part);
  // Wrapped per entry (dl > div > dt + dd) or one after the other
  const wrapper = part.parentElement !== dl ? part.parentElement : null;

  const blank = (tag: 'dt' | 'dd'): HTMLElement => {
    const created = document.createElement(tag);
    created.setAttribute('data-cbe-blank', '');

    return created;
  };

  const detail = (): HTMLElement => {
    const existing = ofRow.find((entry) => entry.tagName === 'DD');

    if (existing) {
      return existing;
    }

    const created = blank('dd');
    part.after(created);

    return created;
  };

  const add = (): HTMLElement => {
    const term = blank('dt');
    const created = blank('dd');

    save([...rows().slice(0, row + 1), { key: '', value: '' }, ...rows().slice(row + 1)]);

    if (wrapper) {
      const copy = wrapper.cloneNode(false) as HTMLElement;
      copy.append(term, created);
      wrapper.after(copy);
    } else {
      (ofRow.at(-1) as HTMLElement).after(term, created);
    }

    return term;
  };

  const remove = (): HTMLElement | undefined => {
    const others = layout.filter((entry) => entry.row !== row);
    const next = others.find((entry) => entry.row > row) ?? others.at(-1);

    save(rows().filter((_, index) => index !== row));

    if (wrapper) {
      wrapper.remove();
    } else {
      ofRow.forEach((entry) => entry.remove());
    }

    return next?.part;
  };

  return startPart(element, inline, part, rows()[row][column], event, select, {
    label: 'Beschreibungsliste',
    anchor: dl,
    text: true,
    input(typed) {
      part.toggleAttribute('data-cbe-blank', typed === '');
      save(rows().map((entry, index) => (index === row ? { ...entry, [column]: typed } : entry)));
    },
    keydown(key) {
      const all = layout.map((entry) => entry.part);
      const empty = !part.innerText.trim() && ofRow.every((entry) => !entry.innerText.trim());
      let next: HTMLElement | undefined;

      if (key.key === 'Enter' && !key.shiftKey) {
        next = column === 'key' ? detail() : add();
      } else if (key.key === 'Tab') {
        next = all[all.indexOf(part) + (key.shiftKey ? -1 : 1)];
      } else if (key.key === 'Backspace' && empty && rows().length > 1) {
        next = remove();
      }

      if (next) {
        key.preventDefault();
        endSession();
        restart(next, key.key === 'Tab');
      } else if (key.key === 'Enter') {
        key.preventDefault();
      }
    },
    restart,
    tools: [
      ['rowAfter', 'Eintrag darunter einfügen', true, add],
      ['rowDelete', 'Eintrag löschen', rows().length > 1, remove],
    ],
  });
}

/** The clicked item, or the first one for the keyboard. */
function startList(element: FrameElement, inline: InlineConfig, root: HTMLElement, event: PointerEvent | null): boolean {
  const list = root.querySelector<HTMLElement>(inline.selector ?? 'ul, ol');
  const hit = event?.target instanceof Element ? event.target.closest<HTMLElement>('li') : list?.querySelector<HTMLElement>(':scope > li');

  return Boolean(list && hit && hit.parentElement === list && startItem(element, inline, list, hit, event));
}

/** The clicked cell, or the first one of the body for the keyboard. */
function startTable(element: FrameElement, inline: InlineConfig, root: HTMLElement, event: PointerEvent | null): boolean {
  const table = root.querySelector<HTMLTableElement>(inline.selector ?? 'table');
  const hit = event?.target instanceof Element ? event.target.closest<HTMLTableCellElement>('td, th') : table?.tBodies[0]?.rows[0]?.cells[0];

  return Boolean(table && hit && hit.closest('table') === table && startCell(element, inline, table, hit, event));
}

type Tool = [icon: keyof typeof ICONS, title: string, enabled: boolean, run: () => HTMLElement | undefined];

/**
 * A cell of a table or an item of a list: text without markup, typed in place. The bar above
 * changes the structure, the data first and then the same in the page.
 */
function startPart(element: FrameElement, inline: InlineConfig, target: HTMLElement, html: string, event: PointerEvent | null, select: boolean, options: {
  label: string;
  anchor: HTMLElement;
  input(html: string): void;
  keydown(event: KeyboardEvent): void;
  tools: Tool[];
  restart(next: HTMLElement): void;
  /** Stored as plain text, which the template escapes: no entities and no markup. */
  text?: boolean;
}): boolean {
  // Markup can only be kept in the inspector
  if (!options.text && !isPlainCell(html)) {
    return false;
  }

  const state = snapshot(element, inline, target);

  target.innerText = options.text ? html : cellText(html);

  try {
    target.contentEditable = 'plaintext-only';
  } catch {
    target.contentEditable = 'true';
  }

  target.focus();

  if (event) {
    placeCaret(event.clientX, event.clientY);
  } else {
    // Reached with the keyboard, as in a spreadsheet: typing replaces the content
    const selection = getSelection();
    selection?.selectAllChildren(target);

    if (!select) {
      selection?.collapseToEnd();
    }
  }

  const onInput = (): void => {
    const typed = target.innerText.replace(/\n$/, '');
    options.input(options.text ? typed : cellHtml(typed));
  };

  target.addEventListener('input', onInput);
  target.addEventListener('keydown', options.keydown);

  formatBar.setAttribute('role', 'toolbar');
  formatBar.setAttribute('aria-label', options.label);
  formatBar.replaceChildren(...options.tools.map(([icon, title, enabled, run]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.disabled = !enabled;
    button.append(iconElement(document, ICONS[icon]));
    button.addEventListener('pointerdown', (down) => down.preventDefault());
    button.addEventListener('click', () => {
      const next = run();
      endSession();

      if (next) {
        options.restart(next);
      }
    });

    return button;
  }));
  formatBar.hidden = false;

  session = {
    ...state,
    cleanup() {
      target.removeEventListener('input', onInput);
      target.removeEventListener('keydown', options.keydown);
      target.removeAttribute('contenteditable');
    },
    // The text is in place already, as it was typed
    showValue() {},
    // Above the part, the bar would cover the one before
    barAnchor: options.anchor,
  };

  placeFormatBar();

  return true;
}

/** Sends the new value of a table or a list. */
function saveParts(element: FrameElement, field: string, next: unknown): void {
  element.values[field] = next;
  toShell({ type: 'cbe:change', id: element.id, field, value: next });
}

/** A cell of a table: Tab moves on, also into a new row. */
function startCell(element: FrameElement, inline: InlineConfig, table: HTMLTableElement, cell: HTMLTableCellElement, event: PointerEvent | null): boolean {
  const { field } = inline;
  const rows = (): Rows => toRows(element.values[field]);
  const save = (next: Rows): void => saveParts(element, field, next);
  const row = cell.parentElement as HTMLTableRowElement;
  const r = dataRow(table, row, rows());
  const c = cell.cellIndex;
  const html = rows()[r]?.[c];
  const inBody = row.parentElement !== table.tHead && row.parentElement !== table.tFoot;
  const restart = (next: HTMLElement): void => void startCell(element, inline, table, next as HTMLTableCellElement, null);

  if (html === undefined) {
    return false;
  }

  const blank = (tag: string): HTMLTableCellElement => {
    const created = document.createElement(tag) as HTMLTableCellElement;

    if (tag === 'th' && row.parentElement !== table.tHead) {
      created.scope = 'row';
    }

    return created;
  };

  /** Below this row: the header gets the first row of the body, the footer the last one. */
  const addRow = (): HTMLTableRowElement => {
    const at = row.parentElement === table.tHead ? 1 : row.parentElement === table.tFoot ? r : r + 1;
    const tr = document.createElement('tr');
    const first = table.tBodies[0]?.rows[0]?.cells[0];

    tr.append(...Array.from(row.cells, (_, index) => blank(index === 0 && first?.tagName === 'TH' ? 'th' : 'td')));
    save(insertRow(rows(), at));

    if (inBody) {
      row.after(tr);
    } else if (row.parentElement === table.tHead) {
      table.tBodies[0]?.prepend(tr);
    } else {
      table.tBodies[0]?.append(tr);
    }

    return tr;
  };

  return startPart(element, inline, cell, html, event, true, {
    label: 'Tabelle',
    anchor: table,
    input: (typed) => save(setCell(rows(), r, c, typed)),
    keydown(key) {
      if (key.key === 'Enter' && !key.shiftKey) {
        key.preventDefault();
        endSession();
      } else if (key.key === 'Tab') {
        const all = Array.from(table.rows).flatMap((tr) => Array.from(tr.cells));
        const next = all[all.indexOf(cell) + (key.shiftKey ? -1 : 1)];

        // As in a word processor: Tab in the last cell adds a row
        if (next || !key.shiftKey) {
          key.preventDefault();
          const target = next ?? addRow().cells[0];
          endSession();
          restart(target);
        }
      }
    },
    restart,
    tools: [
      ['rowAfter', 'Zeile darunter einfügen', true, () => addRow().cells[c]],
      ['columnAfter', 'Spalte rechts einfügen', true, () => {
        save(insertColumn(rows(), c + 1));

        for (const tr of Array.from(table.rows)) {
          tr.cells[c]?.after(blank(tr.parentElement === table.tHead ? 'th' : 'td'));
        }

        return row.cells[c + 1];
      }],
      ['rowDelete', 'Zeile löschen', inBody && (table.tBodies[0]?.rows.length ?? 0) > 1, () => {
        const next = (row.nextElementSibling ?? row.previousElementSibling) as HTMLTableRowElement | null;

        save(removeRow(rows(), r));
        row.remove();

        return next?.cells[c];
      }],
      ['columnDelete', 'Spalte löschen', row.cells.length > 1, () => {
        save(removeColumn(rows(), c));

        for (const tr of Array.from(table.rows)) {
          tr.cells[c]?.remove();
        }

        return row.cells[Math.min(c, row.cells.length - 1)];
      }],
    ],
  });
}

/** An item of a list: Enter adds the next one, Backspace removes an empty one. */
function startItem(element: FrameElement, inline: InlineConfig, list: HTMLElement, item: HTMLElement, event: PointerEvent | null, select = true): boolean {
  const { field } = inline;
  const items = (): string[] => toRows(element.values[field]).map(([text]) => text ?? '');
  const save = (next: string[]): void => saveParts(element, field, next);
  const all = Array.from(list.children).filter((child) => child.tagName === 'LI');
  const at = all.indexOf(item);
  const restart = (next: HTMLElement, selectNext = true): void => void startItem(element, inline, list, next, null, selectNext);

  // A template of its own may show something else than one item per entry
  if (all.length !== items().length || at < 0) {
    return false;
  }

  const add = (): HTMLElement => {
    const created = document.createElement('li');

    save([...items().slice(0, at + 1), '', ...items().slice(at + 1)]);
    item.after(created);

    return created;
  };

  const remove = (): HTMLElement | undefined => {
    const next = (item.previousElementSibling ?? item.nextElementSibling) as HTMLElement | null;

    save(items().filter((_, index) => index !== at));
    item.remove();

    return next ?? undefined;
  };

  return startPart(element, inline, item, items()[at], event, select, {
    label: 'Liste',
    anchor: list,
    input: (typed) => save(items().map((text, index) => (index === at ? typed : text))),
    keydown(key) {
      const empty = !item.innerText.trim();
      const next = key.key === 'Enter' ? add() : key.key === 'Backspace' && empty && all.length > 1 ? remove() : null;

      if (next) {
        key.preventDefault();
        endSession();
        restart(next, false);
      } else if (key.key === 'Enter') {
        key.preventDefault();
      }
    },
    restart,
    tools: [
      ['rowAfter', 'Eintrag darunter einfügen', true, add],
      ['rowDelete', 'Eintrag löschen', all.length > 1, remove],
    ],
  });
}

function endSession(): void {
  linkBar.hide();
  nav?.end();
  record?.end();
  formatBar.hidden = true;

  if (!session) {
    return;
  }

  const { element, inline, initial, showedRaw, rendered, target } = session;
  const value = element.values[inline.field];
  const changed = (JSON.stringify(value) ?? '') !== initial;
  // An emptied headline has to disappear from the page altogether
  const emptied = changed && inline.mode === 'plain' && !plainText(value);

  session.cleanup();

  if (changed) {
    session.showValue();
  } else {
    target.replaceChildren(...rendered);
  }

  session.restore?.();
  session = null;

  // Insert tags can only be resolved by the server, and only after the save is through
  toShell({ type: 'cbe:commit', id: element.id, render: emptied || (hasInsertTag(value) && (changed || showedRaw)) });
}

function activate(id: number, root: HTMLElement, event: PointerEvent | null): boolean {
  activations++;
  const element = known.get(id) as FrameElement;
  const image = imageAt(element, root, event);
  const inline = image ? element.inline.find(({ mode }) => mode === 'file') ?? null : chooseInline(element, root, event?.target ?? null);
  let caretPlaced = false;

  if (inline) {
    caretPlaced = inline.mode === 'file' && image ? startFile(element, inline, image) : inline.mode === 'table' ? startTable(element, inline, root, event) : inline.mode === 'list' ? startList(element, inline, root, event) : inline.mode === 'terms' ? startTerms(element, inline, root, event) : inline.mode === 'rich' ? startRich(element, inline, root, event) : startPlain(element, inline, root, event);
  }

  if (session) {
    addParentButton(root);
  }

  toShell({ type: 'cbe:select', id });

  return caretPlaced;
}

/** Opens a link from wherever it is shown. Only called by a user's click. */
function openLink(href: string): void {
  const action = classifyLink(href, window.location.href, framePaths);

  if (action === 'scroll') {
    window.location.hash = new URL(href, document.baseURI).hash;
  } else if (action === 'native') {
    window.location.href = href;
  } else if (action === 'open') {
    window.open(href, '_blank', 'noopener');
  } else if (action === 'page') {
    endSession();
    toShell({ type: 'cbe:navigate', href });
  }
}

/** Editing switched off in the shell, which marks the page: it is only looked at. */
function viewing(): boolean {
  return document.documentElement.hasAttribute('data-cbe-viewing');
}

function linkIn(target: EventTarget | null): HTMLAnchorElement | HTMLAreaElement | null {
  return target instanceof Element ? target.closest<HTMLAnchorElement | HTMLAreaElement>('a[href], area[href]') : null;
}

/** The rich text the link is part of, if it can be opened in the editor. */
function editableText(element: FrameElement, root: HTMLElement, link: Element): InlineConfig | null {
  return element.inline.find((inline) => inline.mode === 'rich' && inlineTarget(inline, root)?.contains(link) && canEditInline(String(element.values?.[inline.field] ?? ''))) ?? null;
}

function rectAnchor(link: Element): () => DOMRect | null {
  return () => (link.isConnected ? link.getBoundingClientRect() : null);
}

/** The link as rendered: its address is resolved, unlike the raw insert tag in the editor. */
function showLinkActions(link: HTMLAnchorElement | HTMLAreaElement, id: number, root: HTMLElement, focus: boolean): void {
  const element = known.get(id) as FrameElement;
  const canOpen = classifyLink(link.href, window.location.href, framePaths) !== 'none';

  toShell({ type: 'cbe:select', id });

  linkBar.showRead({
    anchor: rectAnchor(link),
    label: linkLabel(link.href, window.location.origin, framePaths),
    open: canOpen ? () => openLink(link.href) : null,
    edit: editableText(element, root, link) ? () => {
      const index = Array.from(root.querySelectorAll('a')).indexOf(link as HTMLAnchorElement);
      const text = link.textContent ?? '';

      linkBar.hide();
      // The editor must be there to select the link in it
      void loadRich().then(() => {
        if (!rich) {
          return;
        }

        activate(id, root, null);
        selectLink(text, index);
      });
    } : null,
    hint: 'Änderbar in der Seitenleiste oder im klassischen Backend',
    close: () => {
      linkBar.hide();
      link.focus();
    },
    focus,
  });
}

/**
 * Puts the caret into the link that was clicked. Links can differ from the rendered ones
 * (insert tags are plain text in here), so the text decides and the position only helps.
 */
function selectLink(text: string, index: number): void {
  if (!session?.editor) {
    return;
  }

  const { editor, target } = session;
  const links = Array.from(target.querySelectorAll('a'));
  const link = links[index]?.textContent === text ? links[index] : links.find((candidate) => candidate.textContent === text);

  if (link) {
    const from = editor.view.posAtDOM(link, 0);
    const to = editor.view.posAtDOM(link, link.childNodes.length);

    // The edge of a link counts as outside, so a single character has to be selected
    editor.commands.setTextSelection(to - from < 2 ? { from, to } : Math.floor((from + to) / 2));
  }

  refreshLinkBar();
}

/** The choice of the picker, which the shell opens over the whole editor. */
let picked: ((href: string) => void) | null = null;

function pickLink(id: number, current: string, done: (href: string) => void): void {
  picked = done;
  toShell({ type: 'cbe:pick-link', id, value: current });
}

/** Keeps the bar in line with the caret: it shows up inside of links, or on request. */
function refreshLinkBar(requested = false): void {
  const editor = session?.editor;
  const element = session?.element;

  if (!editor || !element || !rich) {
    return;
  }

  rich.editLink(linkBar, editor, {
    requested,
    anchor: () => (editor.isDestroyed ? null : editor.view.coordsAtPos(editor.state.selection.from)),
    pick: (current, done) => pickLink(element.id, current, done),
    // Without the server, an insert tag has no address yet
    open: (href) => {
      if (href.includes('{{')) {
        return null;
      }

      const resolved = document.createElement('a');
      resolved.href = href;

      return () => openLink(resolved.href);
    },
  });
}

/** Where a moved element came from, to put it back if the server rejects the move. */
let pendingMove: { root: HTMLElement; parent: ParentNode; next: ChildNode | null; focus: boolean } | null = null;

function requestMove(root: HTMLElement, target: HTMLElement, position: MovePosition, focus: boolean): void {
  // One at a time: a later move is based on the result of this one
  if (pendingMove || !root.parentNode) {
    return;
  }

  endSession();

  pendingMove = { root, parent: root.parentNode, next: root.nextSibling, focus };

  if (position === 'before') {
    target.before(root);
  } else {
    target.after(root);
  }

  if (focus) {
    root.focus();
  }

  toShell({ type: 'cbe:move', id: Number(root.getAttribute(ID_ATTRIBUTE)), target: Number(target.getAttribute(ID_ATTRIBUTE)), position });
}

function finishMove(ok: boolean): void {
  if (pendingMove && !ok) {
    pendingMove.parent.insertBefore(pendingMove.root, pendingMove.next);

    if (pendingMove.focus) {
      pendingMove.root.focus();
    }
  }

  pendingMove = null;
}

function editableRoots(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${ID_ATTRIBUTE}]`)).filter((root) => known.has(Number(root.getAttribute(ID_ATTRIBUTE))));
}

/** The next element in reading order, skipping its own children and its parents. */
function neighbour(root: HTMLElement, direction: -1 | 1): HTMLElement | null {
  const roots = editableRoots().filter((other) => other === root || (!root.contains(other) && !other.contains(root)));

  return roots[roots.indexOf(root) + direction] ?? null;
}

const linkBar = new LinkBar();

// Bold, italic, link and lists, above the text being edited
const formatBar = document.createElement('div');
formatBar.className = 'cbe-link-bar cbe-format-bar';
formatBar.hidden = true;
let updateFormatBar: (() => void) | null = null;

/**
 * Nested elements, e.g. in a group or a module, cover their parent: it can only be reached
 * from here. Before the formats, or alone in the bar for a plain text.
 */
function addParentButton(root: HTMLElement): void {
  const parent = closestId(root.parentElement);

  if (!parent) {
    return;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.title = 'Übergeordnetes Element auswählen';
  button.setAttribute('aria-label', button.title);
  button.append(iconElement(document, ICONS.parent));
  // The text keeps its selection until the click selects the parent
  button.addEventListener('pointerdown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    endSession();
    parent.root.focus({ preventScroll: true });
    showHandleOn(parent.root);
    toShell({ type: 'cbe:select', id: parent.id });
  });

  if (formatBar.hidden) {
    formatBar.setAttribute('role', 'toolbar');
    formatBar.setAttribute('aria-label', 'Element');
    formatBar.replaceChildren(button);
    formatBar.hidden = false;
  } else {
    const divider = document.createElement('span');
    divider.className = 'cbe-format-bar__divider';
    formatBar.prepend(button, divider);
  }

  placeFormatBar();
}

function placeFormatBar(): void {
  const target = session?.barAnchor ?? session?.target;

  if (!target || formatBar.hidden) {
    return;
  }

  const { left, top, bottom } = target.getBoundingClientRect();
  const { width, height } = formatBar.getBoundingClientRect();
  const above = top - height - 8;

  formatBar.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  // Below the text if it starts at the top of the window, but never on top of the text
  formatBar.style.top = `${above >= 8 ? above : Math.min(bottom + 8, window.innerHeight - height - 8)}px`;
}

const handle = document.createElement('button');
handle.type = 'button';
handle.className = 'cbe-handle';
handle.title = 'Ziehen zum Verschieben (Tastatur: Alt + Pfeil hoch/runter)';
handle.draggable = true;
// Mouse only: the keyboard moves the focused element directly with Alt + arrow keys
handle.tabIndex = -1;
handle.setAttribute('aria-hidden', 'true');

// A new element below this one. Mouse only as well: the inspector has a button for it
const adder = document.createElement('button');
adder.type = 'button';
adder.className = 'cbe-handle cbe-handle--add';
adder.title = 'Element darunter einfügen';
adder.tabIndex = -1;
adder.setAttribute('aria-hidden', 'true');
adder.addEventListener('click', () => {
  const id = Number(handleRoot?.getAttribute(ID_ATTRIBUTE));

  if (id) {
    endSession();
    toShell({ type: 'cbe:insert', id });
  }
});

const dropLine = document.createElement('div');
dropLine.className = 'cbe-drop-line';
dropLine.setAttribute('aria-hidden', 'true');

let handleRoot: HTMLElement | null = null;
let dragged: HTMLElement | null = null;
let drop: { target: HTMLElement; position: MovePosition } | null = null;
let nextHandleRoot: HTMLElement | null = null;
let handleSwitch: ReturnType<typeof setTimeout> | undefined;
let pointerX = 0;
let pointerY = 0;

function placeHandle(): void {
  if (!handleRoot?.isConnected) {
    handle.hidden = adder.hidden = true;
    handleRoot = null;

    return;
  }

  const { left, right, top, bottom } = handleRoot.getBoundingClientRect();
  const fitsBeside = left >= HANDLE_SPACE;
  const x = `${fitsBeside ? left - HANDLE_SPACE : right - HANDLE_SPACE}px`;
  const handleTop = Math.max(top, 2);

  // Inside of the element it would cover text, which must not happen while typing
  handle.hidden = adder.hidden = !fitsBeside && session?.element.id === Number(handleRoot.getAttribute(ID_ATTRIBUTE));
  handle.style.left = adder.style.left = x;
  handle.style.top = `${handleTop}px`;
  // At the bottom edge, where the new element goes, but below the handle and in the window
  adder.style.top = `${Math.max(handleTop + HANDLE_GAP, Math.min(bottom - ADDER_HEIGHT, window.innerHeight - ADDER_HEIGHT - 2))}px`;
}

function hideDropLine(): void {
  dropLine.hidden = true;
  drop = null;
}

/** On the way to the handle, the pointer may cross a parent or a neighbour. */
function isTowardsHandle(x: number, y: number): boolean {
  if (handle.hidden || !handleRoot) {
    return false;
  }

  const { left, right, top } = handle.getBoundingClientRect();
  const { bottom } = adder.getBoundingClientRect();
  const edge = Math.max(right + HANDLE_MARGIN, handleRoot.getBoundingClientRect().left + HANDLE_CORNER);

  // Also on the way down to the button for a new element
  return x >= left - HANDLE_MARGIN && x <= edge && y >= top - HANDLE_MARGIN && y <= bottom + HANDLE_MARGIN;
}

function showHandleOn(root: HTMLElement): void {
  handleRoot = root;
  placeHandle();
}

function cancelHandleSwitch(): void {
  clearTimeout(handleSwitch);
  handleSwitch = undefined;
  nextHandleRoot = null;
}

function waitForHandleSwitch(): void {
  handleSwitch = setTimeout(() => {
    if (isTowardsHandle(pointerX, pointerY)) {
      waitForHandleSwitch();

      return;
    }

    const root = nextHandleRoot;
    cancelHandleSwitch();

    if (root?.isConnected && !dragged) {
      showHandleOn(root);
    }
  }, HANDLE_SWITCH_DELAY);
}

document.addEventListener('pointermove', ({ clientX, clientY }) => {
  pointerX = clientX;
  pointerY = clientY;
}, { passive: true });

/** Spare room for the frame of an element, which is drawn outside of it. */
const OUTLINE_ROOM = 4;

/**
 * A frame outside of an element as wide as the page would lie beyond the edges, where many
 * themes cut off anything (overflow-x: clip). Such elements get it drawn inside.
 */
function placeOutlines(target: EventTarget | null): void {
  const width = document.documentElement.clientWidth;

  for (let root = target instanceof Element ? target.closest<HTMLElement>('.cbe-editable') : null; root; root = root.parentElement?.closest<HTMLElement>('.cbe-editable') ?? null) {
    const { left, right } = root.getBoundingClientRect();
    root.classList.toggle('cbe-editable--inset', left < OUTLINE_ROOM || right > width - OUTLINE_ROOM);
  }
}

document.addEventListener('focusin', ({ target }) => placeOutlines(target));

document.addEventListener('pointerover', (event) => {
  const root = closestId(event.target)?.root;

  placeOutlines(event.target);

  pointerX = event.clientX;
  pointerY = event.clientY;

  // Also on the handle itself and on anything that isn't an element: the handle just stays
  if (!root || dragged || root === handleRoot) {
    cancelHandleSwitch();

    return;
  }

  if (!handleRoot || handleRoot.contains(root)) {
    cancelHandleSwitch();
    showHandleOn(root);

    return;
  }

  nextHandleRoot = root;

  if (handleSwitch === undefined) {
    waitForHandleSwitch();
  }
});

const placeControls = (): void => {
  placeHandle();
  linkBar.place();
  placeFormatBar();
};

window.addEventListener('scroll', placeControls, { passive: true, capture: true });
window.addEventListener('resize', placeControls, { passive: true });

handle.addEventListener('dragstart', (event) => {
  if (!handleRoot || !event.dataTransfer || pendingMove) {
    event.preventDefault();

    return;
  }

  dragged = handleRoot;
  endSession();
  event.dataTransfer.effectAllowed = 'move';
  // Firefox only starts a drag with data
  event.dataTransfer.setData('text/plain', '');
  event.dataTransfer.setDragImage(dragged, 0, 0);
});

document.addEventListener('dragover', (event) => {
  const hit = closestId(event.target);

  // Only our own drag: dropped files or text are not handled here
  if (!dragged || !hit || dragged.contains(hit.root) || hit.root.contains(dragged)) {
    hideDropLine();

    return;
  }

  event.preventDefault();

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }

  const { left, top, width, height } = hit.root.getBoundingClientRect();
  const position: MovePosition = event.clientY < top + height / 2 ? 'before' : 'after';

  drop = { target: hit.root, position };
  dropLine.hidden = false;
  dropLine.style.left = `${left}px`;
  dropLine.style.top = `${position === 'before' ? top : top + height}px`;
  dropLine.style.width = `${width}px`;
});

document.addEventListener('drop', (event) => {
  if (dragged && drop) {
    event.preventDefault();
    requestMove(dragged, drop.target, drop.position, false);
  }

  hideDropLine();
});

document.addEventListener('dragend', () => {
  dragged = null;
  hideDropLine();
  placeHandle();
});

// One delegated listener instead of one per element. pointerdown fires well before
// click; no network request or rendering happens on this path.
document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || viewing()) {
    return;
  }

  if (event.target === handle || event.target === adder || (event.target instanceof Node && (linkBar.root.contains(event.target) || formatBar.contains(event.target)))) {
    return;
  }

  const field = record?.fieldAt(event.target);

  if (field && record) {
    if (!record.isEditing(event.target)) {
      endSession();
      record.start(field);
    }

    return;
  }

  const navLink = nav?.linkAt(event.target);

  if (navLink && nav) {
    // The caret moves within the name that is being edited
    if (!nav.isEditing(event.target)) {
      endSession();
      showNavActions(navLink, nav.start(navLink));
    }

    return;
  }

  if (!known.size) {
    return;
  }

  if (session && event.target instanceof Node && session.target.contains(event.target)) {
    return;
  }

  const owner = sectionOwner(event.target);
  const onSectionText = owner && event.target instanceof Element && isOnText(event.target, event.clientX, event.clientY);
  const hit = onSectionText ? owner : closestId(event.target);

  endSession();

  if (!hit) {
    toShell({ type: 'cbe:select', id: null });

    return;
  }

  const link = linkIn(event.target);
  // An image that opens a larger version is chosen anew rather than followed
  const onImage = imageAt(known.get(hit.id) as FrameElement, hit.root, event);

  // A link is both a way to another page and a part of the text, so the user decides
  if (link && hit.root.contains(link) && !onImage) {
    showLinkActions(link, hit.id, hit.root, false);
    placeHandle();

    return;
  }

  performance.mark('cbe:pointerdown');

  if (activate(hit.id, hit.root, event)) {
    // Otherwise the browser would move the caret away again on mousedown
    document.addEventListener('mousedown', (mouse) => mouse.preventDefault(), { once: true, capture: true });
  }

  placeHandle();

  const { duration } = performance.measure('cbe:click-to-edit', 'cbe:pointerdown');

  if (duration > BUDGET_MS) {
    console.warn(`[block-editor] Klick → Editieren: ${duration.toFixed(1)} ms (Budget: ${BUDGET_MS} ms)`);
  }
}, true);

const script = document.querySelector<HTMLScriptElement>('script[data-cbe-preview]');
const framePaths: FramePaths = { base: script?.dataset.cbeBase ?? '', preview: script?.dataset.cbePreview ?? '' };
nav = new NavLinks(framePaths, (link) => closestId(link) !== null, toShell);
record = new RecordFields((node) => closestId(node) !== null, toShell);

/** A link of the navigation still leads to its page, from the bar above it. */
function showNavActions(link: HTMLAnchorElement, editable: boolean): void {
  linkBar.showRead({
    anchor: rectAnchor(link),
    label: linkLabel(link.href, window.location.origin, framePaths),
    open: () => openLink(link.href),
    edit: null,
    hint: editable ? 'Den Namen direkt im Menü ändern' : 'Änderbar im klassischen Backend',
    close: () => {
      endSession();
      link.focus();
    },
    focus: false,
  });
}

const framePage: FramePage | null = script?.dataset.cbePageId ? { id: Number(script.dataset.cbePageId), title: script.dataset.cbePageTitle ?? '' } : null;
const [recordTable, recordId] = (script?.dataset.cbeRecord ?? '').split('.');
const frameRecord: FrameRecord | null = recordId ? { table: recordTable, id: Number(recordId), scope: script?.dataset.cbeRecordScope ?? '' } : null;

// Ready before the first click into a text in most cases, without delaying the page
(window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 300)))(() => void loadRich());

// The page is a canvas in here: only links outside of editable elements navigate. Only
// looked at, every link leads to its page and the page's own buttons work.
document.addEventListener('click', (event) => {
  const control = event.target instanceof Element ? event.target.closest('a, area, button, [type="submit"]') : null;
  const link = linkIn(control);

  if (!control || (!link && viewing())) {
    return;
  }

  event.preventDefault();

  if (!link) {
    return;
  }

  if (viewing() || (!closestId(link) && !nav?.linkAt(link))) {
    openLink(link.href);
  }
}, true);

document.addEventListener('submit', (event) => event.preventDefault(), true);

// While typing, the page's own shortcuts must not take the keys, such as "/" for its search.
// Added on the way down, the listener stops the key at the text, after the editor had it.
document.addEventListener('keydown', (event) => {
  if (session && event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.target instanceof Node && session.target.contains(event.target)) {
    event.target.addEventListener('keydown', (typed) => typed.stopPropagation(), { once: true });
  }
}, true);

document.addEventListener('keydown', (event) => {
  const shortcut = shortcutFor(event, storedSingleKeys());

  if (shortcut) {
    event.preventDefault();
    toShell({ type: 'cbe:shortcut', name: shortcut });

    return;
  }

  if (viewing()) {
    return;
  }

  // Not while typing: on a Mac, Option+Up moves the caret to the start of the paragraph
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && !isTyping(event.target)) {
    const root = closestId(event.target)?.root;
    const target = root ? neighbour(root, event.key === 'ArrowUp' ? -1 : 1) : null;

    if (root && target) {
      event.preventDefault();
      requestMove(root, target, event.key === 'ArrowUp' ? 'before' : 'after', true);
    }

    return;
  }

  if (event.key === 'Escape') {
    endSession();
    toShell({ type: 'cbe:select', id: null });

    return;
  }

  const focusedLink = event.key === 'Enter' ? linkIn(event.target) : null;
  const linkHit = focusedLink ? closestId(focusedLink) : null;

  // The keyboard's way to the bar: there is no pointerdown, and browsers differ in the click
  if (focusedLink && linkHit && !session?.target.contains(focusedLink)) {
    event.preventDefault();
    endSession();
    showLinkActions(focusedLink, linkHit.id, linkHit.root, true);

    return;
  }

  if ((event.key === 'Enter' || event.key === ' ') && !session && event.target instanceof HTMLElement && event.target.hasAttribute(ID_ATTRIBUTE)) {
    const hit = closestId(event.target);

    if (hit) {
      event.preventDefault();
      activate(hit.id, hit.root, null);
    }
  }
});

function applyElements(elements: FrameElement[]): void {
  document.body.append(handle, adder, dropLine, linkBar.root, formatBar);
  handle.hidden = adder.hidden = true;
  dropLine.hidden = true;

  for (const element of elements) {
    known.set(element.id, element);

    const root = findElement(element.id);

    if (root) {
      prepareRoot(root);
    }
  }

  document.documentElement.classList.add('cbe-ready');
}

function prepareRoot(root: HTMLElement): void {
  root.classList.add('cbe-editable');
  root.tabIndex = 0;

  // Gives bare text its tag now, so that already the first click hits it
  for (const inline of known.get(Number(root.getAttribute(ID_ATTRIBUTE)))?.inline ?? []) {
    if (inline.mode === 'plain' && !inline.section) {
      inlineTarget(inline, root);
    }
  }
}

/**
 * A new element goes where the server rendered it. Some parents wrap each child, such as the
 * slides of a slider: the wrapper comes along, next to the wrapper of the previous element.
 */
function placeNew(fresh: HTMLElement, after: number): HTMLElement | null {
  const freshPrevious = fresh.ownerDocument.querySelector(`[${ID_ATTRIBUTE}="${after}"]`);
  let previous: Element | null = findElement(after);
  let branch: Element = fresh;
  let other = freshPrevious;

  while (branch.parentElement && freshPrevious && !branch.parentElement.contains(freshPrevious)) {
    branch = branch.parentElement;
  }

  while (other && previous && other.parentElement !== branch.parentElement) {
    other = other.parentElement;
    previous = previous.parentElement;
  }

  if (!other || !previous) {
    return null;
  }

  previous.after(document.importNode(branch, true));

  return findElement(Number(fresh.getAttribute(ID_ATTRIBUTE)));
}

/** Brings a new element into view and opens its main text. */
function showNew(id: number, root: HTMLElement): void {
  root.scrollIntoView({ block: 'center', behavior: 'instant' });
  root.focus({ preventScroll: true });
  showHandleOn(root);
  activate(id, root, null);
}

/**
 * A deleted element leaves the page, with the wrappers that only held it, such as a section of
 * an accordion. The shell ended the session before.
 */
function removeElement(id: number): void {
  let node: HTMLElement | null = findElement(id);

  for (let depth = 0; node; ++depth) {
    const parent: HTMLElement | null = node.parentElement;

    if (node.classList.contains('handorgel__content')) {
      node.previousElementSibling?.remove();
    }

    node.remove();
    node = depth < 3 && parent && (!parent.id || parent.matches('.handorgel__content')) && !parent.childElementCount && !parent.textContent?.trim() && !parent.hasAttribute(ID_ATTRIBUTE) ? parent : null;
  }

  placeHandle();
}

async function refresh(id: number, after?: number, show = false): Promise<void> {
  if (session?.element.id === id) {
    return;
  }

  // Renders the element with the real templates and the real page context
  const response = await fetch(window.location.href, { headers: { Accept: 'text/html' }, cache: 'no-store' });

  if (!response.ok) {
    return;
  }

  // The user may have started editing again in the meantime
  if (session?.element.id === id) {
    return;
  }

  const fresh = new DOMParser().parseFromString(await response.text(), 'text/html').querySelector<HTMLElement>(`[${ID_ATTRIBUTE}="${id}"]`);
  const current = findElement(id);

  if (fresh && current) {
    const replacement = document.importNode(fresh, true);
    const freshHeadline = known.get(id)?.inline.some(({ section }) => section) ? sectionButton(fresh) : null;

    current.replaceWith(replacement);
    prepareRoot(replacement);

    if (freshHeadline) {
      sectionButton(replacement)?.replaceChildren(...Array.from(freshHeadline.childNodes, (node) => document.importNode(node, true)));
    }
  } else if (fresh && after) {
    // An element without content may render nothing yet: it shows up with its first save
    const root = placeNew(fresh, after);

    if (root) {
      prepareRoot(root);

      if (show && known.has(id)) {
        showNew(id, root);
      }
    }
  }
}

function applyValue(id: number, field: string, value: unknown, force: boolean): void {
  const element = known.get(id);
  const inline = element?.inline.find((item) => item.field === field);

  if (!element || !inline) {
    return;
  }

  const editing = session?.element.id === id && session.inline.field === field;
  const shown = element.values[field];

  // Never overwrite what the user is typing right now, unless it was rejected
  if (editing && !force) {
    return;
  }

  element.values[field] = value;

  if (editing) {
    endSession();
  }

  // Only the server knows how the cells and items look: a rejected change is rendered by it again
  if (inline.mode === 'table' || inline.mode === 'list' || inline.mode === 'terms' || inline.mode === 'file') {
    if (force) {
      void refresh(id);
    }

    return;
  }

  const root = findElement(id);
  const target = root ? inlineTarget(inline, root, shown) : null;

  // Raw insert tags must not be shown: a refresh with the rendered content follows
  if (!target || hasInsertTag(value)) {
    return;
  }

  if (inline.mode === 'rich') {
    setHtml(target, String(value ?? ''));
  } else {
    target.textContent = plainText(value);
  }
}

window.addEventListener('message', (event) => {
  const message = readMessage<ToFrame>(event, window.parent);

  switch (message?.type) {
    case 'cbe:hello':
      announce();
      break;
    case 'cbe:end':
      endSession();
      break;
    case 'cbe:elements':
      applyElements(message.elements);
      break;
    case 'cbe:value':
      applyValue(message.id, message.field, message.value, false);
      break;
    case 'cbe:revert':
      applyValue(message.id, message.field, message.value, true);
      break;
    case 'cbe:refresh':
      void refresh(message.id, message.after, message.show);
      break;
    case 'cbe:nav-edit':
      nav?.enable(message.enabled);
      break;
    case 'cbe:nav-pages':
      nav?.apply(message.pages);
      break;
    case 'cbe:page-title':
      nav?.setTitle(message.id, message.title);
      break;
    case 'cbe:record':
      record?.apply(message.scope, message.fields);
      break;
    case 'cbe:record-value':
      record?.setValue(message.field, message.value);
      break;
    case 'cbe:picked':
      if (message.value !== null) {
        picked?.(message.value);
      }

      picked = null;
      break;
    case 'cbe:remove':
      removeElement(message.id);
      break;
    case 'cbe:show': {
      const root = findElement(message.id);

      if (root) {
        root.scrollIntoView({ block: 'center', behavior: 'instant' });
        root.focus({ preventScroll: true });
        toShell({ type: 'cbe:select', id: message.id });
      }
      break;
    }
    case 'cbe:moved':
      finishMove(message.ok);
      placeHandle();
      break;
  }
});

function announce(): void {
  const ids = Array.from(document.querySelectorAll(`[${ID_ATTRIBUTE}]`), (node) => Number(node.getAttribute(ID_ATTRIBUTE)));
  // The time origin identifies this document: the shell may get several announcements
  toShell({ type: 'cbe:ready', load: performance.timeOrigin, page: framePage, ids: [...new Set(ids)], record: frameRecord });
}

announce();
