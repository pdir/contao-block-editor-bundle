// The rich text editor of the inspector. The shell loads it only for fields that need it,
// so the editor stays fast to open.

import { LinkBar } from './link-bar';
import { createRichEditor, editLink, renderFormatBar, richValue } from './rich-text';
import { canEditInline } from './rich-text-policy';

export interface RichField {
  /** A change from elsewhere, e.g. typed in the page. */
  set(html: string): void;
  destroy(): void;
}

export interface RichFieldOptions {
  html: string;
  label: string;
  change(html: string): void;
  pick(current: string, done: (href: string) => void): void;
}

let linkBar: LinkBar | null = null;

/** Null if the text holds markup the editor would lose: it stays HTML source then. */
export function mountRichField(container: HTMLElement, options: RichFieldOptions): RichField | null {
  if (!canEditInline(options.html)) {
    return null;
  }

  if (!linkBar) {
    linkBar = new LinkBar();
    document.body.append(linkBar.root);
  }

  const bar = linkBar;
  const formatBar = document.createElement('div');
  const text = document.createElement('div');

  formatBar.className = 'cbe-link-bar cbe-format-bar';
  text.className = 'cbe-rich__text';

  let update: (() => void) | null = null;

  const editor = createRichEditor({
    // The editor's CSP forbids style tags: shell.css has the few rules instead
    injectCSS: false,
    element: text,
    content: options.html,
    editorProps: {
      attributes: { 'aria-label': options.label, 'aria-multiline': 'true', role: 'textbox' },
      handleKeyDown: (_, event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          showLink(true);

          return true;
        }

        return false;
      },
    },
    onSelectionUpdate: () => showLink(false),
    onTransaction: () => update?.(),
    onUpdate: ({ editor: instance }) => options.change(richValue(instance)),
    onBlur: ({ event }) => {
      // The bar itself takes the focus while a link is edited
      if (!(event.relatedTarget instanceof Node && bar.root.contains(event.relatedTarget))) {
        bar.hide();
      }
    },
  });

  function showLink(requested: boolean): void {
    editLink(bar, editor, {
      requested,
      anchor: () => (editor.isDestroyed ? null : editor.view.coordsAtPos(editor.state.selection.from)),
      pick: options.pick,
      open: () => null,
    });
  }

  update = renderFormatBar(formatBar, editor, () => showLink(true));
  container.replaceChildren(formatBar, text);

  return {
    set(html) {
      if (!editor.isFocused && html !== richValue(editor)) {
        editor.commands.setContent(html, { emitUpdate: false });
      }
    },
    destroy() {
      bar.hide();
      editor.destroy();
    },
  };
}
