// Fields of records that are not content elements: the headline of a news or event on its
// reader page and the headline and teaser of each news in a list. The server names the
// records (see ReaderRecord and NewsListListener) and the page shows where their fields are:
// by their text, inside of the reader module or the news.
import { editPlainText } from './nav-links';
import type { RecordField, ToShell } from './protocol';
import { findByText, wrapTextRun } from './text-target';

const FIELD_ATTRIBUTE = 'data-cbe-field';
const RECORD_ATTRIBUTE = 'data-cbe-record-key';

function decode(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

/** The text of formatted text that is a single paragraph without any markup, otherwise null. */
export function simpleParagraph(html: string): string | null {
  const match = /^\s*<p>([^<]*)<\/p>\s*$/.exec(html);

  return match ? decode(match[1]) : null;
}

/** Plain text typed in the page as such a paragraph again. */
export function paragraphHtml(text: string): string {
  return `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
}

export class RecordFields {
  /** By record and field. */
  private readonly targets = new Map<string, HTMLElement>();
  private readonly rich = new Set<string>();
  /** Fields the user may change, whatever the text holds now. */
  private readonly editable = new Set<string>();
  private editing: { target: HTMLElement; cleanup(): void } | null = null;

  constructor(
    /** Texts of content elements inside of the scope belong to them. */
    private readonly inElement: (node: Element, scope: HTMLElement) => boolean,
    private readonly toShell: (message: ToShell) => void,
  ) {}

  apply(key: string, scope: string, fields: RecordField[]): void {
    const root = document.querySelector<HTMLElement>(scope);

    if (!root) {
      return;
    }

    const accepts = (element: HTMLElement): boolean => !this.inElement(element, root) && !element.hasAttribute(FIELD_ATTRIBUTE);

    for (const { name, value, editable, rich } of fields) {
      const id = `${key} ${name}`;
      const paragraph = rich ? simpleParagraph(value) : null;
      // Paragraphs of formatted text may be joined without any space in between
      const target = this.targets.get(id)
        ?? (rich ? findByText(root, paragraph ?? decode(value), accepts, paragraph === null) : findByText(root, value, accepts) ?? wrapTextRun(root, value, accepts));

      if (target) {
        this.targets.set(id, target);
        target.setAttribute(FIELD_ATTRIBUTE, name);
        target.setAttribute(RECORD_ATTRIBUTE, key);
        target.classList.add('cbe-record-field');
        // Other formatted text only in the inspector, where the editor keeps its markup
        target.toggleAttribute('data-cbe-editable', editable && (!rich || paragraph !== null));
      }

      if (rich) {
        this.rich.add(id);
      }

      if (editable) {
        this.editable.add(id);
      }
    }
  }

  fieldAt(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(`[${FIELD_ATTRIBUTE}]`) : null;
  }

  /** All fields of the same record, such as headline and teaser of a news. */
  fieldsBeside(target: HTMLElement): HTMLElement[] {
    const key = target.getAttribute(RECORD_ATTRIBUTE);

    return [...this.targets.values()].filter((other) => other.getAttribute(RECORD_ATTRIBUTE) === key);
  }

  isEditing(target: EventTarget | null): boolean {
    return target instanceof Node && Boolean(this.editing?.target.contains(target));
  }

  /** Shows the record in the inspector and, if allowed and wanted, makes the text editable in place. */
  start(target: HTMLElement, edit = true): void {
    const key = target.getAttribute(RECORD_ATTRIBUTE) as string;

    this.end();
    this.toShell({ type: 'cbe:record-select', key });

    if (!edit || !target.hasAttribute('data-cbe-editable')) {
      return;
    }

    const field = target.getAttribute(FIELD_ATTRIBUTE) as string;
    const rich = this.rich.has(`${key} ${field}`);

    this.editing = {
      target,
      cleanup: editPlainText(target, () => {
        const text = target.textContent ?? '';
        this.toShell({ type: 'cbe:record-change', key, field, value: rich ? paragraphHtml(text) : text });
      }, () => this.end()),
    };
  }

  end(): void {
    this.editing?.cleanup();
    this.editing = null;
  }

  /** Typed in the inspector, or the value the server knows after a failed save. */
  setValue(key: string, field: string, value: string): void {
    const id = `${key} ${field}`;
    const target = this.targets.get(id);
    const text = this.rich.has(id) ? simpleParagraph(value) : value;

    if (!target) {
      return;
    }

    // Formatted text beyond a paragraph shows with the next load of the page, and only the
    // inspector can change it from then on
    target.toggleAttribute('data-cbe-editable', this.editable.has(id) && text !== null);

    if (text !== null && target !== this.editing?.target && target.textContent !== text) {
      target.textContent = text;
    }
  }
}
