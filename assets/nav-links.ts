// The links of the navigation menus, whose text is the name of a page. Switched on in the
// inspector's help, they no longer lead to their page on a click but let the name be edited
// in place. Which page a link leads to only the server can tell (see PageInspector).
import { classifyLink, type FramePaths } from './navigation';
import type { NavPage, ToShell } from './protocol';
import { findByText } from './text-target';

const NAVIGATION = 'nav, .mod_navigation, .mod_customnav, .mod_breadcrumb';
const PAGE_ATTRIBUTE = 'data-cbe-page';
const LINK_CLASS = 'cbe-nav-link';

export class NavLinks {
  private enabled = false;
  private titles = new Map<number, string>();
  private editing: { id: number; target: HTMLElement; cleanup(): void } | null = null;

  constructor(
    private readonly paths: FramePaths,
    /** Links inside of content elements belong to their text, not to a menu. */
    private readonly inElement: (link: Element) => boolean,
    private readonly toShell: (message: ToShell) => void,
  ) {}

  private links(): HTMLAnchorElement[] {
    return Array.from(document.querySelectorAll<HTMLAnchorElement>(`:is(${NAVIGATION}) a[href]`))
      .filter((link) => !this.inElement(link) && classifyLink(link.href, window.location.href, this.paths) === 'page');
  }

  enable(enabled: boolean): void {
    this.enabled = enabled;

    if (enabled) {
      this.toShell({ type: 'cbe:nav-links', urls: [...new Set(this.links().map(({ href }) => href))] });

      return;
    }

    this.end();
    this.titles.clear();

    for (const link of document.querySelectorAll(`[${PAGE_ATTRIBUTE}]`)) {
      link.removeAttribute(PAGE_ATTRIBUTE);
      link.classList.remove(LINK_CLASS);
    }
  }

  /** Marks the links whose page is known. Only a link that shows the name can change it. */
  apply(pages: NavPage[]): void {
    if (!this.enabled) {
      return;
    }

    const byUrl = new Map(pages.map((page) => [page.url, page]));

    for (const link of this.links()) {
      const page = byUrl.get(link.href);

      if (page) {
        this.titles.set(page.id, page.title);
        link.setAttribute(PAGE_ATTRIBUTE, String(page.id));
        link.classList.add(LINK_CLASS);
        link.toggleAttribute('data-cbe-editable', page.editable && findByText(link, page.title) !== null);
      }
    }
  }

  /** The marked link around the target, if editing names is switched on. */
  linkAt(target: EventTarget | null): HTMLAnchorElement | null {
    return this.enabled && target instanceof Element ? target.closest<HTMLAnchorElement>(`[${PAGE_ATTRIBUTE}]`) : null;
  }

  isEditing(target: EventTarget | null): boolean {
    return target instanceof Node && Boolean(this.editing?.target.contains(target));
  }

  /** Shows the page in the inspector and, if allowed, makes its name editable in place. */
  start(link: HTMLAnchorElement): boolean {
    this.end();

    const id = Number(link.getAttribute(PAGE_ATTRIBUTE));
    const target = link.hasAttribute('data-cbe-editable') ? findByText(link, this.titles.get(id) ?? '') : null;

    this.toShell({ type: 'cbe:page-select', id });

    if (!target) {
      return false;
    }

    this.editing = {
      id,
      target,
      cleanup: editPlainText(target, () => {
        const title = target.textContent ?? '';

        this.setTitle(id, title, target);
        this.toShell({ type: 'cbe:page-change', id, title });
      }, () => this.end()),
    };

    return true;
  }

  end(): void {
    this.editing?.cleanup();
    this.editing = null;
  }

  /** The same page can be in several menus, e.g. the main navigation and the breadcrumb. */
  setTitle(id: number, title: string, except: HTMLElement | null = null): void {
    const previous = this.titles.get(id);

    for (const link of document.querySelectorAll<HTMLElement>(`[${PAGE_ATTRIBUTE}="${id}"][data-cbe-editable]`)) {
      const target = previous === undefined ? null : findByText(link, previous);

      if (target && target !== except && target !== this.editing?.target && target.textContent !== title) {
        target.textContent = title;
      }
    }

    this.titles.set(id, title);
  }
}

/**
 * Makes a text editable without any markup: only its text is read. Enter ends editing.
 *
 * @return Ends editing again.
 */
export function editPlainText(target: HTMLElement, onInput: () => void, onEnter: () => void): () => void {
  try {
    target.contentEditable = 'plaintext-only';
  } catch {
    // Browsers without this mode: only textContent is read, so no markup can get in
    target.contentEditable = 'true';
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onEnter();
    }
  };

  target.addEventListener('input', onInput);
  target.addEventListener('keydown', onKeydown);
  target.focus();

  return () => {
    target.removeEventListener('input', onInput);
    target.removeEventListener('keydown', onKeydown);
    target.removeAttribute('contenteditable');
  };
}
