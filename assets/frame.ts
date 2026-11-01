import { Editor } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import StarterKit from '@tiptap/starter-kit';
import type { FrameElement, InlineConfig, MovePosition, ToFrame, ToShell } from './protocol';
import { readMessage } from './protocol';
import { canEditInline, isSafeLink } from './rich-text-policy';

const ID_ATTRIBUTE = 'data-be-id';
const BUDGET_MS = 50;
const HANDLE_SPACE = 30;

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
  cleanup(): void;
  showValue(): void;
}

let session: Session | null = null;

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

function inlineTarget(inline: InlineConfig, root: HTMLElement): HTMLElement | null {
  return inline.selector ? root.querySelector<HTMLElement>(inline.selector) : root;
}

/** The part under the pointer, otherwise the element's main text. */
function chooseInline(element: FrameElement, root: HTMLElement, hit: EventTarget | null): InlineConfig | null {
  const plain = element.inline.find(({ mode }) => mode === 'plain');
  const rich = element.inline.find(({ mode }) => mode === 'rich');
  const plainTarget = plain ? inlineTarget(plain, root) : null;

  if (plain && plainTarget && hit instanceof Node && plainTarget.contains(hit)) {
    return plain;
  }

  if (rich) {
    return rich;
  }

  return !hit && plainTarget ? (plain as InlineConfig) : null;
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

function startRich(element: FrameElement, inline: InlineConfig, root: HTMLElement, event: PointerEvent | null): boolean {
  const target = inlineTarget(inline, root);
  const { field } = inline;

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

    editor = new Editor({
      element: target,
      content: html,
      extensions: [
        StarterKit.configure({ link: false }),
        Link.configure({ openOnClick: false, autolink: false, isAllowedUri: (url) => isSafeLink(url ?? '') }),
      ],
      onUpdate: ({ editor: instance }) => {
        element.values[field] = instance.getHTML();
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

  session = {
    ...state,
    cleanup: () => started.destroy(),
    showValue: () => setHtml(target, String(element.values[field] ?? '')),
  };

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
  const target = inlineTarget(inline, root);

  if (!target) {
    return false;
  }

  const { field } = inline;

  if (element.values?.[field] === undefined) {
    return false;
  }

  const stored = element.values[field] as { value?: string; unit?: string } | null;
  const state = snapshot(element, inline, target);

  target.textContent = decodeEntities(stored?.value ?? '');

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
    element.values[field] = { value: target.textContent ?? '', unit: stored?.unit };
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
  };

  return true;
}

function endSession(): void {
  if (!session) {
    return;
  }

  const { element, inline, initial, showedRaw, rendered, target } = session;
  const value = element.values[inline.field];
  const changed = (JSON.stringify(value) ?? '') !== initial;
  // An emptied headline has to disappear from the page altogether
  const emptied = changed && inline.mode === 'plain' && !(value as { value?: string }).value;

  session.cleanup();

  if (changed) {
    session.showValue();
  } else {
    target.replaceChildren(...rendered);
  }

  session = null;

  // Insert tags can only be resolved by the server, and only after the save is through
  toShell({ type: 'cbe:commit', id: element.id, render: emptied || (hasInsertTag(value) && (changed || showedRaw)) });
}

function activate(id: number, root: HTMLElement, event: PointerEvent | null): boolean {
  const element = known.get(id) as FrameElement;
  const inline = chooseInline(element, root, event?.target ?? null);
  let caretPlaced = false;

  if (inline) {
    caretPlaced = inline.mode === 'rich' ? startRich(element, inline, root, event) : startPlain(element, inline, root, event);
  }

  toShell({ type: 'cbe:select', id });

  return caretPlaced;
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

const handle = document.createElement('button');
handle.type = 'button';
handle.className = 'cbe-handle';
handle.textContent = '⠿';
handle.title = 'Ziehen zum Verschieben (Tastatur: Alt + Pfeil hoch/runter)';
handle.draggable = true;
// Mouse only: the keyboard moves the focused element directly with Alt + arrow keys
handle.tabIndex = -1;
handle.setAttribute('aria-hidden', 'true');

const dropLine = document.createElement('div');
dropLine.className = 'cbe-drop-line';
dropLine.setAttribute('aria-hidden', 'true');

let handleRoot: HTMLElement | null = null;
let dragged: HTMLElement | null = null;
let drop: { target: HTMLElement; position: MovePosition } | null = null;

function placeHandle(): void {
  if (!handleRoot?.isConnected) {
    handle.hidden = true;
    handleRoot = null;

    return;
  }

  const { left, right, top } = handleRoot.getBoundingClientRect();
  const fitsBeside = left >= HANDLE_SPACE;

  // Inside of the element it would cover text, which must not happen while typing
  handle.hidden = !fitsBeside && session?.element.id === Number(handleRoot.getAttribute(ID_ATTRIBUTE));
  handle.style.left = `${fitsBeside ? left - HANDLE_SPACE : right - HANDLE_SPACE}px`;
  handle.style.top = `${Math.max(top, 2)}px`;
}

function hideDropLine(): void {
  dropLine.hidden = true;
  drop = null;
}

document.addEventListener('pointerover', (event) => {
  const root = closestId(event.target)?.root;

  if (root && !dragged) {
    handleRoot = root;
    placeHandle();
  }
});

window.addEventListener('scroll', placeHandle, { passive: true, capture: true });
window.addEventListener('resize', placeHandle, { passive: true });

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
  if (event.button !== 0 || !known.size) {
    return;
  }

  if (event.target === handle) {
    return;
  }

  const hit = closestId(event.target);

  if (session && event.target instanceof Node && session.target.contains(event.target)) {
    return;
  }

  endSession();

  if (!hit) {
    toShell({ type: 'cbe:select', id: null });

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

// The page is a canvas in here: links and forms must not navigate away
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('a, button, [type="submit"]')) {
    event.preventDefault();
  }
}, true);

document.addEventListener('submit', (event) => event.preventDefault(), true);

document.addEventListener('keydown', (event) => {
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
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

  if ((event.key === 'Enter' || event.key === ' ') && !session && event.target instanceof HTMLElement && event.target.hasAttribute(ID_ATTRIBUTE)) {
    const hit = closestId(event.target);

    if (hit) {
      event.preventDefault();
      activate(hit.id, hit.root, null);
    }
  }
});

function applyElements(elements: FrameElement[]): void {
  document.body.append(handle, dropLine);
  handle.hidden = true;
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
}

async function refresh(id: number): Promise<void> {
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
    current.replaceWith(replacement);
    prepareRoot(replacement);
  }
}

function applyValue(id: number, field: string, value: unknown, force: boolean): void {
  const element = known.get(id);
  const inline = element?.inline.find((item) => item.field === field);

  if (!element || !inline) {
    return;
  }

  const editing = session?.element.id === id && session.inline.field === field;

  // Never overwrite what the user is typing right now, unless it was rejected
  if (editing && !force) {
    return;
  }

  element.values[field] = value;

  if (editing) {
    endSession();
  }

  const root = findElement(id);
  const target = root ? inlineTarget(inline, root) : null;

  // Raw insert tags must not be shown: a refresh with the rendered content follows
  if (!target || hasInsertTag(value)) {
    return;
  }

  if (inline.mode === 'rich') {
    setHtml(target, String(value ?? ''));
  } else {
    target.textContent = decodeEntities((value as { value?: string } | null)?.value ?? '');
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
      void refresh(message.id);
      break;
    case 'cbe:moved':
      finishMove(message.ok);
      placeHandle();
      break;
  }
});

function announce(): void {
  const ids = Array.from(document.querySelectorAll(`[${ID_ATTRIBUTE}]`), (node) => Number(node.getAttribute(ID_ATTRIBUTE)));
  toShell({ type: 'cbe:ready', ids: [...new Set(ids)] });
}

announce();
