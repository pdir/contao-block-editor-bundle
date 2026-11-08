// The shell's side of records with fields besides the content elements: the news or event
// on a reader page and the meta data of the page itself. Loads their fields, saves them and
// shows them in the inspector. Only loaded when needed.
import { recordKey, type FrameRecord, type ToFrame } from './protocol';
import { SaveError, SaveQueue } from './save-queue';

interface RecordField {
  name: string;
  label: string;
  value: string;
  editable: boolean;
  multiline: boolean;
  /** Formatted text, edited with the editor of the inspector. */
  rich?: boolean;
  /** Shown while the field is empty: what Contao uses instead. */
  placeholder: string;
  /** A date, a time or both, typed in the browser's own field. */
  date?: 'date' | 'time' | 'datim';
  checkbox?: boolean;
  /** The checkbox that shows the field, such as "Zeit hinzufügen" for the times of an event. */
  subpalette?: string;
}

interface RecordData {
  table: string;
  id: number;
  label: string;
  revision: string;
  fields: RecordField[];
  classicUrl: string;
}

export interface ReaderRecordOptions {
  token: string;
  /** The API of the records. */
  url: string;
  /** Only for fields shown in the page, which follow what is typed in the inspector. */
  post?: (message: ToFrame) => void;
  setStatus(text: string, isError?: boolean, state?: 'busy' | 'saved'): void;
  /** Below the fields in the inspector. */
  hint?: string;
  /** The number of characters that search engines show, by field. */
  lengths?: Record<string, number>;
  /** After a save of fields that the page shows formatted, such as the date of an event. */
  onFormattedSaved?: () => void;
  /** The editor for formatted text around the text area, from the shell. */
  rich?: (source: string, textarea: HTMLTextAreaElement, label: string, change: (html: string) => void) => { root: HTMLElement; set(html: string): void };
}

export class ReaderRecord {
  private data: RecordData | null = null;
  private readonly queue: SaveQueue;
  private readonly inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  /** The fields that a checkbox shows, by checkbox. */
  private readonly subpalettes = new Map<string, HTMLElement[]>();
  private readonly counts = new Map<string, HTMLElement>();
  private readonly richSync = new Map<string, (html: string) => void>();
  /** The texts as typed, which the inspector shows again when it opens. */
  private readonly values = new Map<string, string>();

  constructor(private readonly record: FrameRecord, private readonly options: ReaderRecordOptions) {
    this.queue = new SaveQueue(
      async (_id, revision, values, keepalive) => {
        const response = await fetch(this.address(), {
          method: 'PATCH',
          keepalive,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Block-Editor-Token': options.token },
          body: JSON.stringify({ revision, values }),
        });

        const data = (await response.json().catch(() => ({}))) as RecordData & { error?: string; errors?: Record<string, string> };

        if (!response.ok) {
          throw new SaveError(data.error ?? 'Speichern fehlgeschlagen.', response.status, data.errors);
        }

        this.data = data;

        if (Object.keys(values).some((name) => data.fields.some((field) => field.name === name && (field.date || field.checkbox)))) {
          options.onFormattedSaved?.();
        }

        return { revision: data.revision, values: Object.fromEntries(data.fields.map(({ name, value }) => [name, value])) };
      },
      {
        onStateChange: (pending) => {
          if (pending) {
            options.setStatus('Wird gespeichert …', false, 'busy');
          }
        },
        onSaved: () => options.setStatus('Gespeichert', false, 'saved'),
        onFailed: (_id, _sent, error) => {
          options.setStatus(Object.values(error.errors).join(' ') || error.message, true);

          // Back to the texts the server knows
          for (const { name, value } of this.data?.fields ?? []) {
            this.change(name, value, 'server');
          }
        },
      },
    );
  }

  private address(): string {
    return `${this.options.url}/${this.record.table}/${this.record.id}`;
  }

  async load(): Promise<void> {
    const response = await fetch(this.address(), { headers: { Accept: 'application/json' } });

    // A record the user may not see stays as it is
    if (!response.ok) {
      return;
    }

    this.data = (await response.json()) as RecordData;
    this.queue.track(this.record.id, this.data.revision);

    for (const { name, value } of this.data.fields) {
      this.values.set(name, value);
    }

    this.options.post?.({ type: 'cbe:record', key: recordKey(this.record), scope: this.record.scope, fields: this.data.fields });
  }

  /** Typed in the page or in the inspector, or the text the server knows after a failed save. */
  change(field: string, value: string, origin: 'page' | 'inspector' | 'server'): void {
    this.values.set(field, value);

    if (origin !== 'server') {
      this.queue.change(this.record.id, field, value);
    }

    if (origin !== 'page') {
      this.options.post?.({ type: 'cbe:record-value', key: recordKey(this.record), field, value });
    }

    const input = this.inputs.get(field);

    if (input instanceof HTMLInputElement && input.type === 'checkbox') {
      input.checked = value === '1';
      this.showSubpalette(field);
    } else if (input && input.value !== value) {
      input.value = value;

      if (origin !== 'inspector') {
        this.richSync.get(field)?.(value);
      }
    }

    this.count(field);
  }

  /** What search engines get: an empty field stands for its placeholder. */
  private count(field: string): void {
    const count = this.counts.get(field);
    const length = this.options.lengths?.[field];
    const text = this.values.get(field) || (this.data?.fields.find(({ name }) => name === field)?.placeholder ?? '');

    if (count && length) {
      count.textContent = `${[...text].length} Zeichen, Suchmaschinen zeigen etwa ${length}`;
    }
  }

  /** Only with the checkbox on, as in the back end. */
  private showSubpalette(selector: string): void {
    const on = this.values.get(selector) === '1';

    for (const field of this.subpalettes.get(selector) ?? []) {
      field.hidden = !on;
    }
  }

  /** Clicked in the page, where the field is shown formatted, such as the date of an event. */
  focus(field: string): void {
    this.inputs.get(field)?.focus();
  }

  get pending(): boolean {
    return this.queue.pending;
  }

  settle(): Promise<void> {
    return this.queue.settle();
  }

  flush(keepalive: boolean): void {
    this.queue.flush(keepalive);
  }

  forget(): void {
    this.inputs.clear();
    this.subpalettes.clear();
    this.counts.clear();
    this.richSync.clear();
  }

  render(container: HTMLElement): void {
    const data = this.data;

    this.forget();

    if (!data) {
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = data.label;
    container.append(heading);

    for (const { name, label: text, value, editable, multiline, rich, placeholder, date, checkbox, subpalette } of data.fields) {
      const id = `cbe-record-${name}`;
      const field = document.createElement('div');
      field.className = checkbox ? 'cbe-field cbe-field--switch' : 'cbe-field';

      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = text;

      const input = document.createElement(multiline ? 'textarea' : 'input');
      input.id = id;

      if (input instanceof HTMLInputElement && checkbox) {
        input.type = 'checkbox';
        input.checked = (this.values.get(name) ?? value) === '1';
        input.disabled = !editable;
        input.addEventListener('change', () => this.change(name, input.checked ? '1' : '', 'inspector'));
      } else if (input instanceof HTMLInputElement && date) {
        // The browser's own picker; saved once the date is complete, not with each digit
        input.type = { date: 'date', time: 'time', datim: 'datetime-local' }[date];
        input.value = this.values.get(name) ?? value;
        input.readOnly = !editable;
        input.addEventListener('change', () => this.change(name, input.value, 'inspector'));
      } else {
        input.value = this.values.get(name) ?? value;
        input.placeholder = placeholder ?? '';
        input.readOnly = !editable;
        input.addEventListener('input', () => this.change(name, input.value, 'inspector'));
      }

      if (subpalette) {
        this.subpalettes.set(subpalette, [...(this.subpalettes.get(subpalette) ?? []), field]);
      }

      if (input instanceof HTMLTextAreaElement) {
        input.rows = 4;
      }

      if (rich && editable && input instanceof HTMLTextAreaElement && this.options.rich) {
        const control = this.options.rich(recordKey(this.record), input, text, (html) => this.change(name, html, 'inspector'));

        this.richSync.set(name, control.set);
        field.append(label, control.root);
      } else {
        field.append(label, input);
      }

      if (this.options.lengths?.[name]) {
        const count = document.createElement('p');
        count.className = 'cbe-description';
        count.id = `${id}-count`;
        input.setAttribute('aria-describedby', count.id);
        field.append(count);
        this.counts.set(name, count);
        this.count(name);
      }

      container.append(field);
      this.inputs.set(name, input);
    }

    for (const selector of this.subpalettes.keys()) {
      this.showSubpalette(selector);
    }

    if (this.options.hint) {
      const hint = document.createElement('p');
      hint.className = 'cbe-description';
      hint.textContent = this.options.hint;
      container.append(hint);
    }

    const classic = document.createElement('a');
    classic.className = 'cbe-link';
    classic.href = data.classicUrl;
    classic.textContent = 'Im klassischen Backend bearbeiten';

    container.append(classic);
  }
}

export function setupReaderRecord(record: FrameRecord, options: ReaderRecordOptions): ReaderRecord {
  return new ReaderRecord(record, options);
}
