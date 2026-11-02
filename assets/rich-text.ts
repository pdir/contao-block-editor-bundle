// The rich text editor of the page and of the inspector. Deliberately small: other bundles
// add marks, nodes and buttons through window.contaoBlockEditorExtensions (see README).

import { Editor, Extension, Mark, mergeAttributes, Node, type AnyExtension, type EditorOptions } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import StarterKit from '@tiptap/starter-kit';
import { ICONS, iconElement } from './editor-icons';
import type { BarAnchor, EditOptions, LinkBar } from './link-bar';
import { compactListItems, isSafeLink, normalizeLinkInput } from './rich-text-policy';

export interface FormatButton {
  /** Short, shown on the button if it has no icon. */
  label: string;
  /** Path data of a 24 × 24 icon, like those of Contao's editor. Only the path: no markup. */
  icon?: { d: string; rule?: 'evenodd' | 'nonzero' };
  title: string;
  run(editor: Editor): void;
  active?(editor: Editor): boolean;
}

/** What another bundle can add. It is read when an editor starts, so the order of scripts doesn't matter. */
export interface RichTextAddon {
  extensions?(tiptap: typeof TIPTAP): AnyExtension[];
  buttons?: FormatButton[];
  /** Tags and their attributes the extensions write, which may be opened in the editor again. */
  allow?: Record<string, string[]>;
}

declare global {
  interface Window {
    contaoBlockEditorExtensions?: RichTextAddon[];
  }
}

const TIPTAP = { Extension, Mark, Node, mergeAttributes };

export function addons(): RichTextAddon[] {
  const list = window.contaoBlockEditorExtensions;

  return Array.isArray(list) ? list.filter((addon) => addon && typeof addon === 'object') : [];
}

export function createRichEditor(options: Partial<EditorOptions>): Editor {
  const extra = addons().flatMap((addon) => {
    try {
      return addon.extensions?.(TIPTAP) ?? [];
    } catch (error) {
      // One broken extension must not take the editor down
      console.error('[block-editor] Eine Erweiterung des Editors ist fehlerhaft:', error);

      return [];
    }
  });

  return new Editor({
    ...options,
    extensions: [
      StarterKit.configure({ link: false }),
      // Without the null values, every link would get the extension's target and rel
      Link.configure({ openOnClick: false, autolink: false, isAllowedUri: (url) => isSafeLink(url ?? ''), HTMLAttributes: { target: null, rel: null, class: null } }),
      ...extra,
    ],
  });
}

/** The value to store: like Contao's own editor writes it. */
export function richValue(editor: Editor): string {
  return compactListItems(editor.getHTML());
}

function defaultButtons(link: (editor: Editor) => void): FormatButton[] {
  return [
    { label: 'B', icon: ICONS.bold, title: 'Fett (Strg/Cmd + B)', run: (editor) => editor.chain().focus().toggleBold().run(), active: (editor) => editor.isActive('bold') },
    { label: 'I', icon: ICONS.italic, title: 'Kursiv (Strg/Cmd + I)', run: (editor) => editor.chain().focus().toggleItalic().run(), active: (editor) => editor.isActive('italic') },
    { label: 'Link', icon: ICONS.link, title: 'Link (Strg/Cmd + K)', run: link, active: (editor) => editor.isActive('link') },
    { label: '•', icon: ICONS.bulletList, title: 'Aufzählung', run: (editor) => editor.chain().focus().toggleBulletList().run(), active: (editor) => editor.isActive('bulletList') },
    { label: '1.', icon: ICONS.orderedList, title: 'Nummerierte Liste', run: (editor) => editor.chain().focus().toggleOrderedList().run(), active: (editor) => editor.isActive('orderedList') },
  ];
}

/** Fills the bar with buttons and returns a function that shows which formats are active. */
export function renderFormatBar(bar: HTMLElement, editor: Editor, link: (editor: Editor) => void): () => void {
  const buttons = [...defaultButtons(link), ...addons().flatMap((addon) => (Array.isArray(addon.buttons) ? addon.buttons : []))];
  const elements = buttons.map((definition) => {
    const button = bar.ownerDocument.createElement('button');
    button.type = 'button';
    const icon = definition.icon && typeof definition.icon.d === 'string' ? iconElement(bar.ownerDocument, { d: definition.icon.d, rule: definition.icon.rule === 'evenodd' ? 'evenodd' : 'nonzero' }) : null;

    if (icon) {
      button.append(icon);
    } else {
      button.textContent = definition.label;
    }

    button.title = definition.title;
    button.setAttribute('aria-label', definition.title);
    // The selection in the text must stay where it is
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => definition.run(editor));

    return button;
  });

  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Textformat');
  bar.replaceChildren(...elements);

  const update = (): void => {
    buttons.forEach((definition, index) => {
      let active = false;

      try {
        active = definition.active?.(editor) ?? false;
      } catch {
        // A broken button of an extension only loses its state
      }

      elements[index].setAttribute('aria-pressed', String(active));
    });
  };

  update();

  return update;
}

export interface LinkEditing {
  /** Also outside of a link, for the selected text. */
  requested: boolean;
  anchor(): BarAnchor | null;
  pick: EditOptions['pick'];
  /** Opens the link target, if that is possible from here. */
  open(href: string): (() => void) | null;
}

/** Shows the bar for the link at the caret, or hides it outside of links. */
export function editLink(bar: LinkBar, editor: Editor, options: LinkEditing): void {
  const inLink = editor.isActive('link');

  if (!inLink && !(options.requested && !editor.state.selection.empty)) {
    bar.hide();

    return;
  }

  const attributes = editor.getAttributes('link');
  const href = String(attributes.href ?? '');
  // The selection doesn't have to change, and then nothing else would update the bar
  const refresh = (): void => editLink(bar, editor, { ...options, requested: false });

  bar.showEdit({
    anchor: options.anchor,
    href,
    title: String(attributes.title ?? ''),
    newWindow: attributes.target === '_blank',
    pick: options.pick,
    open: href ? options.open(href) : null,
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

      refresh();

      return done;
    },
    remove: inLink ? () => {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      refresh();
    } : null,
    cancel: () => {
      bar.hide();
      editor.view.focus();
    },
    focus: options.requested,
  });
}

