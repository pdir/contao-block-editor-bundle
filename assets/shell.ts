import type { FrameElement, InlineConfig, ToFrame, ToShell } from './protocol';
import { readMessage } from './protocol';
import { SaveError, SaveQueue, type SaveResult } from './save-queue';

interface FieldSchema {
  name: string;
  label: string;
  description: string;
  input: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'inputUnit';
  rich: boolean;
  multiple: boolean;
  mandatory: boolean;
  maxlength: number | null;
  size: number;
  options: { value: string; label: string }[];
  unitOptions: string[];
}

interface TypeSchema {
  fields: FieldSchema[];
  inline: InlineConfig[];
}

interface Element {
  id: number;
  type: string;
  editable: boolean;
  revision: string;
  values: Record<string, unknown>;
  classicUrl: string;
}

const app = document.getElementById('cbe-app') as HTMLElement;
const frame = document.getElementById('cbe-frame') as HTMLIFrameElement;
const inspector = document.getElementById('cbe-inspector') as HTMLElement;
const status = document.getElementById('cbe-status') as HTMLElement;

const { token, api, schema: schemaUrl } = app.dataset as { token: string; api: string; schema: string };

const elements = new Map<number, Element>();
let schema: Record<string, TypeSchema> = {};
let selected: number | null = null;
let loaded = false;
const awaitingRender = new Set<number>();
/** Fields last changed by typing in the page: the page shows them correctly already. */
const typedInPage = new Set<string>();
/** Keeps the inspector in sync with what is typed in the page. */
const fieldSync = new Map<string, (value: unknown) => void>();

function renderAwaited(): void {
  for (const id of awaitingRender) {
    post({ type: 'cbe:refresh', id });
  }

  awaitingRender.clear();
}

function post(message: ToFrame): void {
  frame.contentWindow?.postMessage(message, window.location.origin);
}

function setStatus(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle('is-error', isError);
}

async function getJson<T>(url: string): Promise<T> {
  // credentials: same-origin is the default; "default" cache mode allows the ETag revalidation
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!response.ok) {
    throw new SaveError('Die Elementdaten konnten nicht geladen werden.', response.status);
  }

  return response.json() as Promise<T>;
}

const send = async (id: number, revision: string, values: Record<string, unknown>, keepalive: boolean): Promise<SaveResult> => {
  const response = await fetch(`${api}/${id}`, {
    method: 'PATCH',
    keepalive,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Block-Editor-Token': token },
    body: JSON.stringify({ revision, values }),
  });

  const data = (await response.json().catch(() => ({}))) as SaveResult & { error?: string; errors?: Record<string, string> };

  if (!response.ok) {
    throw new SaveError(data.error ?? 'Speichern fehlgeschlagen.', response.status, data.errors);
  }

  return data;
};

const queue = new SaveQueue(send, {
  onStateChange(pending) {
    if (pending) {
      setStatus('Wird gespeichert …');
    } else if (!status.classList.contains('is-error')) {
      setStatus('Gespeichert');
    }

    if (!pending) {
      renderAwaited();
    }
  },
  onSaved(id, values, sent) {
    const element = elements.get(id);

    if (!element) {
      return;
    }

    element.values = { ...element.values, ...values };
    status.classList.remove('is-error');

    // Inspector changes can affect the rendering (e.g. the headline level), as can insert tags
    const needsRender = Object.keys(sent).some((field) => !typedInPage.has(`${id}:${field}`) || JSON.stringify(sent[field]).includes('{{'));

    for (const { field } of schema[element.type]?.inline ?? []) {
      if (field in values) {
        post({ type: 'cbe:value', id, field, value: values[field] });
      }
    }

    if (needsRender) {
      post({ type: 'cbe:refresh', id });
    }
  },
  onFailed(id, sent, error) {
    const element = elements.get(id);
    const details = Object.values(error.errors).join(' ');

    setStatus(details || error.message, true);

    if (element) {
      // Roll back the optimistic change to the last state the server confirmed
      for (const field of Object.keys(sent)) {
        post({ type: 'cbe:revert', id, field, value: element.values[field] });

        if (JSON.stringify(element.values[field] ?? '').includes('{{')) {
          awaitingRender.add(id);
        }
      }

      if (selected === id) {
        renderInspector();
      }
    }
  },
});

async function loadElements(ids: number[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const { elements: loaded } = await getJson<{ elements: Record<string, Element> }>(`${api}?ids=${ids.join(',')}`);
  const types = new Set<string>();

  for (const element of Object.values(loaded)) {
    elements.set(element.id, element);
    types.add(element.type);

    if (element.editable) {
      queue.track(element.id, element.revision);
    }
  }

  const { types: loadedSchema } = await getJson<{ types: Record<string, TypeSchema> }>(`${schemaUrl}?types=${[...types].sort().join(',')}`);
  schema = loadedSchema;

  const frameElements: FrameElement[] = [...elements.values()]
    .filter((element) => element.editable)
    .map((element) => {
      const inline = schema[element.type]?.inline ?? [];

      return { id: element.id, inline, values: Object.fromEntries(inline.map(({ field }) => [field, element.values[field]])) };
    });

  post({ type: 'cbe:elements', elements: frameElements });
}

function createField(element: Element, field: FieldSchema): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'cbe-field';

  const id = `cbe-field-${field.name}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = field.label + (field.mandatory ? ' *' : '');

  const change = (value: unknown): void => {
    element.values[field.name] = value;
    typedInPage.delete(`${element.id}:${field.name}`);
    queue.change(element.id, field.name, value);
  };

  const value = element.values[field.name];
  let control: HTMLElement;

  // Values are only ever assigned as properties or text, never parsed as HTML
  switch (field.input) {
    case 'textarea': {
      const textarea = document.createElement('textarea');
      textarea.rows = field.rich ? 8 : 4;
      textarea.value = String(value ?? '');
      textarea.addEventListener('input', () => change(textarea.value));
      fieldSync.set(field.name, (next) => { textarea.value = String(next ?? ''); });
      control = textarea;
      break;
    }
    case 'select':
    case 'radio': {
      const select = document.createElement('select');
      const current = field.multiple && Array.isArray(value) ? value.map(String) : [String(value ?? '')];

      select.multiple = field.multiple;

      for (const option of field.options) {
        const isSelected = current.includes(option.value);
        select.add(new Option(option.label, option.value, isSelected, isSelected));
      }

      select.addEventListener('change', () => change(field.multiple ? Array.from(select.selectedOptions, (option) => option.value) : select.value));
      control = select;
      break;
    }
    case 'checkbox': {
      if (field.multiple) {
        const group = document.createElement('div');
        const current = Array.isArray(value) ? value.map(String) : [];
        const boxes: HTMLInputElement[] = [];

        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', field.label);

        for (const option of field.options) {
          const row = document.createElement('label');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = option.value;
          box.checked = current.includes(option.value);
          box.addEventListener('change', () => change(boxes.filter((item) => item.checked).map((item) => item.value)));
          boxes.push(box);
          row.append(box, ` ${option.label}`);
          group.append(row);
        }

        control = group;
        break;
      }

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(value) && value !== '0';
      checkbox.addEventListener('change', () => change(checkbox.checked ? '1' : ''));
      control = checkbox;
      break;
    }
    case 'inputUnit': {
      const current = (value ?? {}) as { value?: string; unit?: string };
      const group = document.createElement('div');
      group.className = 'cbe-unit';

      const input = document.createElement('input');
      input.value = current.value ?? '';

      const unit = document.createElement('select');
      unit.setAttribute('aria-label', `${field.label}: Einheit`);

      for (const option of field.unitOptions) {
        unit.add(new Option(option, option, false, option === current.unit));
      }

      const update = (): void => change({ value: input.value, unit: unit.value });
      fieldSync.set(field.name, (next) => { input.value = (next as { value?: string } | null)?.value ?? ''; });
      input.addEventListener('input', update);
      unit.addEventListener('change', update);
      input.id = id;
      group.append(input, unit);
      control = group;
      break;
    }
    default: {
      if (field.multiple) {
        // E.g. cssID: several inputs that are stored together
        const group = document.createElement('div');
        const parts = Array.isArray(value) ? value.map((part) => String(part ?? '')) : [];
        const inputs = Array.from({ length: Math.max(field.size, parts.length, 1) }, (_, index) => {
          const input = document.createElement('input');
          input.value = parts[index] ?? '';
          input.setAttribute('aria-label', `${field.label} ${index + 1}`);
          input.addEventListener('input', () => change(inputs.map((item) => item.value)));

          return input;
        });

        group.className = 'cbe-unit';
        inputs[0].id = id;
        group.append(...inputs);
        control = group;
        break;
      }

      const input = document.createElement('input');
      input.value = String(value ?? '');

      if (field.maxlength) {
        input.maxLength = field.maxlength;
      }

      input.addEventListener('input', () => change(input.value));
      control = input;
    }
  }

  // Groups have set the ID on their first input already
  if (!control.id && !control.classList.contains('cbe-unit')) {
    control.id = id;
  }

  wrapper.append(label, control);

  if (field.description) {
    const description = document.createElement('p');
    description.className = 'cbe-description';
    description.textContent = field.description;
    wrapper.append(description);
  }

  return wrapper;
}

function renderInspector(): void {
  inspector.replaceChildren();
  fieldSync.clear();

  const element = selected === null ? undefined : elements.get(selected);

  if (!element) {
    const hint = document.createElement('p');
    hint.className = 'cbe-hint';
    hint.textContent = 'Klicke auf ein Element, um es zu bearbeiten.';
    inspector.append(hint);

    return;
  }

  const heading = document.createElement('h2');
  heading.textContent = element.type;
  inspector.append(heading);

  for (const field of schema[element.type]?.fields ?? []) {
    inspector.append(createField(element, field));
  }

  const classic = document.createElement('a');
  classic.className = 'cbe-link';
  classic.href = element.classicUrl;
  classic.textContent = 'Im klassischen Backend bearbeiten';
  inspector.append(classic);
}

window.addEventListener('message', (event) => {
  const message = readMessage<ToShell>(event, frame.contentWindow);

  switch (message?.type) {
    case 'cbe:ready':
      if (loaded) {
        break;
      }

      loaded = true;
      loadElements(message.ids.filter(Number.isInteger)).catch((error: Error) => setStatus(error.message, true));
      break;
    case 'cbe:select':
      if (selected !== message.id) {
        selected = message.id;
        renderInspector();
      }
      break;
    case 'cbe:change':
      if (elements.has(message.id)) {
        const element = elements.get(message.id) as Element;
        element.values[message.field] = message.value;
        typedInPage.add(`${message.id}:${message.field}`);

        if (selected === message.id) {
          fieldSync.get(message.field)?.(message.value);
        }

        queue.change(message.id, message.field, message.value);
      }
      break;
    case 'cbe:commit':
      if (message.render) {
        awaitingRender.add(message.id);
      }

      queue.flush();

      if (!queue.pending) {
        renderAwaited();
      }
      break;
  }
});

// A click into the inspector or the toolbar never reaches the frame's own listener
document.addEventListener('pointerdown', () => post({ type: 'cbe:end' }), true);

// Either side can start first: the frame announces itself and also answers this
frame.addEventListener('load', () => post({ type: 'cbe:hello' }));
post({ type: 'cbe:hello' });

// Don't lose the last keystrokes when the tab is closed
window.addEventListener('pagehide', () => queue.flush(true));

window.addEventListener('beforeunload', (event) => {
  if (queue.pending) {
    event.preventDefault();
  }
});
