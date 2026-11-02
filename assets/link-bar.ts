// The small toolbar next to a link. It only knows its own DOM, the frame decides what
// its buttons do. All values are assigned as text or properties, never parsed as HTML.

const GAP = 6;
const MARGIN = 8;

export interface BarAnchor {
  left: number;
  top: number;
  bottom: number;
}

interface BarOptions {
  /** Null as soon as the link is gone: the bar disappears then. */
  anchor(): BarAnchor | null;
  open: (() => void) | null;
}

export interface ReadOptions extends BarOptions {
  label: string;
  edit: (() => void) | null;
  /** Shown instead of the edit button if the link can't be changed here. */
  hint: string;
  /** Called when the bar is closed with the keyboard. */
  close(): void;
  focus: boolean;
}

export interface LinkDetails {
  title: string;
  newWindow: boolean;
}

export interface EditOptions extends BarOptions, LinkDetails {
  href: string;
  /** Returns false if the address is not allowed. */
  apply(href: string, details: LinkDetails): boolean;
  /** Opens the Contao picker for pages, files, news and more, and hands back the choice. */
  pick: ((current: string, done: (href: string) => void) => void) | null;
  remove: (() => void) | null;
  cancel(): void;
  focus: boolean;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.addEventListener('click', onClick);

  return element;
}

export class LinkBar {
  readonly root = document.createElement('div');
  private anchor: BarOptions['anchor'] | null = null;

  constructor() {
    this.root.className = 'cbe-link-bar';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Link');
    this.root.hidden = true;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  showRead(options: ReadOptions): void {
    const label = document.createElement('span');
    label.className = 'cbe-link-bar__url';
    label.textContent = options.label;
    label.title = options.label;

    const controls: HTMLElement[] = [label];

    if (options.open) {
      controls.push(button('Öffnen', options.open));
    }

    if (options.edit) {
      controls.push(button('Bearbeiten', options.edit));
    } else if (options.hint) {
      const hint = document.createElement('span');
      hint.className = 'cbe-link-bar__hint';
      hint.textContent = options.hint;
      controls.push(hint);
    }

    this.root.onkeydown = (event) => {
      event.stopPropagation();

      if (event.key === 'Escape') {
        options.close();
      }
    };

    this.render(controls, options);

    if (options.focus) {
      this.root.querySelector('button')?.focus();
    }
  }

  showEdit(options: EditOptions): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cbe-link-bar__input';
    input.value = options.href;
    input.placeholder = 'https://… oder {{link_url::ID}}';
    input.setAttribute('aria-label', 'Linkadresse');

    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'cbe-link-bar__input cbe-link-bar__title';
    title.value = options.title;
    title.placeholder = 'Titel (optional)';
    title.setAttribute('aria-label', 'Titel des Links');

    const newWindow = document.createElement('input');
    newWindow.type = 'checkbox';
    newWindow.checked = options.newWindow;

    const newWindowLabel = document.createElement('label');
    newWindowLabel.className = 'cbe-link-bar__check';
    newWindowLabel.append(newWindow, 'Neues Fenster');

    const error = document.createElement('span');
    error.className = 'cbe-link-bar__error';
    error.setAttribute('role', 'alert');

    const apply = (): void => {
      const valid = options.apply(input.value, { title: title.value.trim(), newWindow: newWindow.checked });

      input.toggleAttribute('aria-invalid', !valid);
      error.textContent = valid ? '' : 'Diese Adresse ist nicht erlaubt.';
    };

    this.root.onkeydown = (event) => {
      // The session goes on: only the bar is left
      event.stopPropagation();

      if (event.key === 'Escape') {
        options.cancel();
      } else if (event.key === 'Enter' && (event.target === input || event.target === title)) {
        event.preventDefault();
        apply();
      }
    };

    const controls: HTMLElement[] = [input];

    if (options.pick) {
      const pick = options.pick;

      controls.push(button('Auswählen …', () => pick(input.value, (href) => {
        input.value = href;
        apply();
      })));
    }

    controls.push(button('Übernehmen', apply));

    if (options.open) {
      controls.push(button('Öffnen', options.open));
    }

    if (options.remove) {
      controls.push(button('Entfernen', options.remove));
    }

    controls.push(title, newWindowLabel, error);
    this.render(controls, options);

    if (options.focus) {
      input.focus();
      input.select();
    }
  }

  hide(): void {
    this.root.hidden = true;
    this.anchor = null;
  }

  /** Below the link, or above it if there is no room left. */
  place(): void {
    const anchor = this.anchor?.();

    if (!this.anchor) {
      return;
    }

    if (!anchor) {
      this.hide();

      return;
    }

    const { width, height } = this.root.getBoundingClientRect();
    const below = anchor.bottom + GAP;
    const fits = below + height + MARGIN <= window.innerHeight;

    this.root.style.left = `${Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN))}px`;
    this.root.style.top = `${fits ? below : Math.max(MARGIN, anchor.top - height - GAP)}px`;
  }

  private render(controls: HTMLElement[], { anchor }: BarOptions): void {
    this.root.replaceChildren(...controls);
    this.root.hidden = false;
    this.anchor = anchor;
    this.place();
  }
}
