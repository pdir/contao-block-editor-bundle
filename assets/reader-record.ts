// The shell's side of records with fields besides the content elements: the news or event
// on a reader page and the meta data of the page itself. Loads their fields, saves them and
// shows them in the inspector. Only loaded when needed.
import type { FrameRecord, ToFrame } from './protocol';
import { SaveError, SaveQueue } from './save-queue';

interface RecordField {
  name: string;
  label: string;
  value: string;
  editable: boolean;
  multiline: boolean;
  /** Shown while the field is empty: what Contao uses instead. */
  placeholder: string;
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
}

export class ReaderRecord {
  private data: RecordData | null = null;
  private readonly queue: SaveQueue;
  private readonly inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  private readonly counts = new Map<string, HTMLElement>();
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

    this.options.post?.({ type: 'cbe:record', scope: this.record.scope, fields: this.data.fields });
  }

  /** Typed in the page or in the inspector, or the text the server knows after a failed save. */
  change(field: string, value: string, origin: 'page' | 'inspector' | 'server'): void {
    this.values.set(field, value);

    if (origin !== 'server') {
      this.queue.change(this.record.id, field, value);
    }

    if (origin !== 'page') {
      this.options.post?.({ type: 'cbe:record-value', field, value });
    }

    const input = this.inputs.get(field);

    if (input && input.value !== value) {
      input.value = value;
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
    this.counts.clear();
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

    for (const { name, label: text, value, editable, multiline, placeholder } of data.fields) {
      const id = `cbe-record-${name}`;
      const field = document.createElement('div');
      field.className = 'cbe-field';

      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = text;

      const input = document.createElement(multiline ? 'textarea' : 'input');
      input.id = id;
      input.value = this.values.get(name) ?? value;
      input.placeholder = placeholder ?? '';
      input.readOnly = !editable;
      input.addEventListener('input', () => this.change(name, input.value, 'inspector'));

      if (input instanceof HTMLTextAreaElement) {
        input.rows = 4;
      }

      field.append(label, input);

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
