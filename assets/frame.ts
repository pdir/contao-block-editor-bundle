import { Editor } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import StarterKit from '@tiptap/starter-kit';
import { LinkBar } from './link-bar';
import { classifyLink, linkLabel, type FramePaths } from './navigation';
import type { FrameElement, FramePage, InlineConfig, MovePosition, ToFrame, ToShell } from './protocol';
import { readMessage } from './protocol';
import { canEditInline, isSafeLink, normalizeLinkInput } from './rich-text-policy';
import { findByText } from './text-target';

const ID_ATTRIBUTE = 'data-be-id';
const BUDGET_MS = 50;
const HANDLE_SPACE = 30;
/** Rounded corners and hover effects put the handle's way outside of the element. */
const HANDLE_CORNER = 32;
const HANDLE_MARGIN = 8;
const HANDLE_SWITCH_DELAY = 200;

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
    return base;
  }

  // Only a tag of its own can be replaced as a whole: others may hold further fields as well
  if (!inline.scalar && base && !base.children.length) {
    return base;
  }

  const element = known.get(Number(root.getAttribute(ID_ATTRIBUTE)));
  const rich = element?.inline.find(({ mode }) => mode === 'rich');
  const richTarget = rich ? inlineTarget(rich, root) : null;
  const value = shown === undefined ? element?.values[inline.field] : shown;

  return findByText(inline.scalar || !base ? root : base, plainText(value), (candidate) => candidate.closest(`[${ID_ATTRIBUTE}]`) === root && !richTarget?.contains(candidate));
}

/** The part under the pointer, otherwise the element's main text. */
function chooseInline(element: FrameElement, root: HTMLElement, hit: EventTarget | null): InlineConfig | null {
  const plains = element.inline.filter(({ mode }) => mode === 'plain');
  const rich = element.inline.find(({ mode }) => mode === 'rich');
  const plain = plains.find(({ section }) => !section);
  const plainTarget = plain ? inlineTarget(plain, root) : null;
  const clicked = hit instanceof Node ? plains.find((inline) => inlineTarget(inline, root)?.contains(hit)) : null;

  if (clicked) {
    return clicked;
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
        // Without the null values, every link would get the extension's target and rel
        Link.configure({ openOnClick: false, autolink: false, isAllowedUri: (url) => isSafeLink(url ?? ''), HTMLAttributes: { target: null, rel: null, class: null } }),
      ],
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
    editor: started,
    cleanup: () => started.destroy(),
    showValue: () => setHtml(target, String(element.values[field] ?? '')),
  };

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

function endSession(): void {
  linkBar.hide();

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
  const element = known.get(id) as FrameElement;
  const inline = chooseInline(element, root, event?.target ?? null);
  let caretPlaced = false;

  if (inline) {
    caretPlaced = inline.mode === 'rich' ? startRich(element, inline, root, event) : startPlain(element, inline, root, event);
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

function linkIn(target: EventTarget | null): HTMLAnchorElement | HTMLAreaElement | null {
  return target instanceof Element ? target.closest<HTMLAnchorElement | HTMLAreaElement>('a[href], area[href]') : null;
}

/** The rich text the link is part of, if it can be opened in the editor. */
function editableText(element: FrameElement, root: HTMLElement, link: Element): InlineConfig | null {
  const rich = element.inline.find(({ mode }) => mode === 'rich');

  return rich && inlineTarget(rich, root)?.contains(link) && canEditInline(String(element.values?.[rich.field] ?? '')) ? rich : null;
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
      activate(id, root, null);
      selectLink(text, index);
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

  if (!editor || !element) {
    return;
  }

  const inLink = editor.isActive('link');

  if (!inLink && !(requested && !editor.state.selection.empty)) {
    linkBar.hide();

    return;
  }

  const attributes = editor.getAttributes('link');
  const href = String(attributes.href ?? '');
  const resolved = document.createElement('a');
  resolved.href = href;

  linkBar.showEdit({
    anchor: () => editor.isDestroyed ? null : editor.view.coordsAtPos(editor.state.selection.from),
    href,
    title: String(attributes.title ?? ''),
    newWindow: attributes.target === '_blank',
    pick: (current, done) => pickLink(element.id, current, done),
    // Without the server, an insert tag has no address yet
    open: href && !href.includes('{{') ? () => openLink(resolved.href) : null,
    apply: (value, { title, newWindow }) => {
      const next = normalizeLinkInput(value);

      if (next !== '' && !isSafeLink(next)) {
        return false;
      }

      const chain = editor.chain().focus().extendMarkRange('link');
      const done = next === '' ? chain.unsetLink().run() : chain.setLink({
        ...editor.getAttributes('link'),
        href: next,
        title: title || null,
        // Like Contao: a new window without access to this one
        target: newWindow ? '_blank' : null,
        rel: newWindow ? 'noopener' : null,
      } as { href: string }).run();

      // The selection doesn't have to change, and then nothing else would update the bar
      refreshLinkBar();

      return done;
    },
    remove: inLink ? () => {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      refreshLinkBar();
    } : null,
    cancel: () => {
      linkBar.hide();
      editor.view.focus();
    },
    focus: requested,
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

const handle = document.createElement('button');
handle.type = 'button';
handle.className = 'cbe-handle';
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
let nextHandleRoot: HTMLElement | null = null;
let handleSwitch: ReturnType<typeof setTimeout> | undefined;
let pointerX = 0;
let pointerY = 0;

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

/** On the way to the handle, the pointer may cross a parent or a neighbour. */
function isTowardsHandle(x: number, y: number): boolean {
  if (handle.hidden || !handleRoot) {
    return false;
  }

  const { left, right, top, bottom } = handle.getBoundingClientRect();
  const edge = Math.max(right + HANDLE_MARGIN, handleRoot.getBoundingClientRect().left + HANDLE_CORNER);

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

document.addEventListener('pointerover', (event) => {
  const root = closestId(event.target)?.root;

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
  if (event.button !== 0 || !known.size) {
    return;
  }

  if (event.target === handle || (event.target instanceof Node && linkBar.root.contains(event.target))) {
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

  // A link is both a way to another page and a part of the text, so the user decides
  if (link && hit.root.contains(link)) {
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
const framePage: FramePage | null = script?.dataset.cbePageId ? { id: Number(script.dataset.cbePageId), title: script.dataset.cbePageTitle ?? '' } : null;

// The page is a canvas in here: only links outside of editable elements navigate
document.addEventListener('click', (event) => {
  const control = event.target instanceof Element ? event.target.closest('a, area, button, [type="submit"]') : null;

  if (!control) {
    return;
  }

  event.preventDefault();

  const link = linkIn(control);

  if (!link) {
    return;
  }

  if (!closestId(link)) {
    openLink(link.href);
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
  document.body.append(handle, dropLine, linkBar.root);
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
    const freshHeadline = known.get(id)?.inline.some(({ section }) => section) ? sectionButton(fresh) : null;

    current.replaceWith(replacement);
    prepareRoot(replacement);

    if (freshHeadline) {
      sectionButton(replacement)?.replaceChildren(...Array.from(freshHeadline.childNodes, (node) => document.importNode(node, true)));
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
      void refresh(message.id);
      break;
    case 'cbe:picked':
      if (message.value !== null) {
        picked?.(message.value);
      }

      picked = null;
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
  toShell({ type: 'cbe:ready', load: performance.timeOrigin, page: framePage, ids: [...new Set(ids)] });
}

announce();
