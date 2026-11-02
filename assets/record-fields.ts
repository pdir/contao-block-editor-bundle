// The headline of a news or event on its reader page. It is a field of the record, not a
// content element, so the server names the record (see ReaderRecord) and the page shows
// where its fields are: by their text, inside of the reader module.
import { editPlainText } from './nav-links';
import type { RecordField, ToShell } from './protocol';
import { findByText, wrapTextRun } from './text-target';

const FIELD_ATTRIBUTE = 'data-cbe-field';

export class RecordFields {
  private readonly targets = new Map<string, HTMLElement>();
  private editing: { target: HTMLElement; cleanup(): void } | null = null;

  constructor(
    /** Texts of content elements in the reader belong to them. */
    private readonly inElement: (node: Element) => boolean,
    private readonly toShell: (message: ToShell) => void,
  ) {}

  apply(scope: string, fields: RecordField[]): void {
    const root = document.querySelector<HTMLElement>(scope);

    if (!root) {
      return;
    }

    const accepts = (element: HTMLElement): boolean => !this.inElement(element) && !element.hasAttribute(FIELD_ATTRIBUTE);

    for (const { name, value, editable } of fields) {
      const target = this.targets.get(name) ?? findByText(root, value, accepts) ?? wrapTextRun(root, value, accepts);

      if (target) {
        this.targets.set(name, target);
        target.setAttribute(FIELD_ATTRIBUTE, name);
        target.classList.add('cbe-record-field');
        target.toggleAttribute('data-cbe-editable', editable);
      }
    }
  }

  fieldAt(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(`[${FIELD_ATTRIBUTE}]`) : null;
  }

  isEditing(target: EventTarget | null): boolean {
    return target instanceof Node && Boolean(this.editing?.target.contains(target));
  }

  /** Shows the record in the inspector and, if allowed, makes the text editable in place. */
  start(target: HTMLElement): void {
    this.end();
    this.toShell({ type: 'cbe:record-select' });

    if (!target.hasAttribute('data-cbe-editable')) {
      return;
    }

    const field = target.getAttribute(FIELD_ATTRIBUTE) as string;

    this.editing = {
      target,
      cleanup: editPlainText(target, () => this.toShell({ type: 'cbe:record-change', field, value: target.textContent ?? '' }), () => this.end()),
    };
  }

  end(): void {
    this.editing?.cleanup();
    this.editing = null;
  }

  /** Typed in the inspector, or the value the server knows after a failed save. */
  setValue(field: string, value: string): void {
    const target = this.targets.get(field);

    if (target && target !== this.editing?.target && target.textContent !== value) {
      target.textContent = value;
    }
  }
}
