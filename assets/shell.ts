import { ICONS, iconElement } from './editor-icons';
import { frameUrl, isFrameUrl, pagePath, publicUrl, type FramePaths } from './navigation';
import type { RichField } from './rich-editor';
import type { FrameElement, FramePage, InlineConfig, ToFrame, ToShell, MovePosition } from './protocol';
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
  /** Only missing in a schema cached by an older version. */
  label?: string;
  fields: FieldSchema[];
  inline: InlineConfig[];
  /** Only for elements in an accordion, which is a matter of the record and not of the type. */
  section?: FieldSchema;
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
const title = document.getElementById('cbe-title') as HTMLElement;
const back = document.getElementById('cbe-back') as HTMLButtonElement;

const { token, api, schema: schemaUrl, base, preview, backend, picker: pickerUrl, richEditor: richEditorUrl } = app.dataset as Record<'token' | 'api' | 'schema' | 'base' | 'preview' | 'backend' | 'picker' | 'richEditor', string>;
const framePaths: FramePaths = { base, preview };
/** The back end and internal routes such as the logout are no pages of the website. */
const blockedPaths = [backend, `${base}/_contao`];
const NO_EDITOR_DELAY = 500;
const MAX_REDIRECT_RECOVERIES = 3;

const elements = new Map<number, Element>();
let schema: Record<string, TypeSchema> = {};
let selected: number | null = null;
/** The document in the frame that the shown data belongs to. */
let currentLoad: number | null = null;
let readySinceLoad = false;
let redirectRecoveries = 0;
let noEditorTimer: ReturnType<typeof setTimeout> | undefined;
let saveFailed = false;
let navigation = 0;
let hasLeftStart = false;
const awaitingRender = new Set<number>();
/** Fields last changed by typing in the page: the page shows them correctly already. */
const typedInPage = new Set<string>();
/** Fields that extensions changed during the current saves, shown once these are done. */
const sideEffects = new Set<string>();
/** The element opened from the back end, shown once the page is ready. */
let shownFirst: number | null = Number(new URLSearchParams(window.location.search).get('element')) || null;

/** Keeps the inspector in sync with what is typed in the page. */
const fieldSync = new Map<string, (value: unknown) => void>();

function hasSection(element: Element): boolean {
  return 'sectionHeadline' in element.values && Boolean(schema[element.type]?.section);
}

function inlineOf(element: Element): InlineConfig[] {
  const inline = schema[element.type]?.inline ?? [];
  // Templates can show any text field, which only the page can tell
  const texts: InlineConfig[] = (schema[element.type]?.fields ?? [])
    .filter(({ name, input, multiple, size }) => input === 'text' && !multiple && size <= 1 && name in element.values && !inline.some(({ field }) => field === name))
    .filter(({ name }) => element.values[name] === null || typeof element.values[name] === 'string')
    .map(({ name }) => ({ field: name, selector: null, mode: 'plain', scalar: true }));
  // Rich texts beyond the element's main text, such as those of other bundles
  const riches: InlineConfig[] = (schema[element.type]?.fields ?? [])
    .filter(({ name, input, rich }) => input === 'textarea' && rich && name in element.values && !inline.some(({ field }) => field === name))
    .map(({ name }) => ({ field: name, selector: null, mode: 'rich', scalar: true }));
  const section: InlineConfig[] = hasSection(element) ? [{ field: 'sectionHeadline', selector: null, mode: 'plain', section: true }] : [];

  return [...inline, ...texts, ...riches, ...section];
}

function fieldsOf(element: Element): FieldSchema[] {
  const fields = schema[element.type]?.fields ?? [];

  return hasSection(element) ? [schema[element.type].section as FieldSchema, ...fields] : fields;
}

function renderAwaited(): void {
  for (const id of awaitingRender) {
    post({ type: 'cbe:refresh', id });
  }

  awaitingRender.clear();
}

function post(message: ToFrame): void {
  frame.contentWindow?.postMessage(message, window.location.origin);
}

function setStatus(text: string, isError = false, state?: 'busy' | 'saved'): void {
  status.textContent = text;
  status.classList.toggle('is-error', isError);

  if (state || isError) {
    status.dataset.state = state ?? 'error';
  } else {
    delete status.dataset.state;
  }
}

async function getJson<T>(url: string): Promise<T> {
  // credentials: same-origin is the default; "default" cache mode allows the ETag revalidation
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!response.ok) {
    throw new SaveError('Die Elementdaten konnten nicht geladen werden.', response.status);
  }

  return response.json() as Promise<T>;
}

/** Saves wait for a running move, because it can change the revision of any sibling. */
let moving: Promise<void> = Promise.resolve();

const send = async (id: number, revision: string, values: Record<string, unknown>, keepalive: boolean): Promise<SaveResult> => {
  await moving;

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
      setStatus('Wird gespeichert …', false, 'busy');
    } else if (!status.classList.contains('is-error')) {
      setStatus(sideEffects.size ? `Gespeichert. Eine Erweiterung hat auch das geändert: ${[...sideEffects].join(', ')}` : 'Gespeichert', false, 'saved');
    }

    if (!pending) {
      sideEffects.clear();
    }

    if (!pending) {
      renderAwaited();
    }
  },
  onSaved(id, values, sent, changedFields) {
    const element = elements.get(id);

    if (!element) {
      return;
    }

    element.values = { ...element.values, ...values };
    status.classList.remove('is-error');

    // Inspector changes can affect the rendering (e.g. the headline level), as can insert tags
    const needsRender = changedFields.length > 0 || Object.keys(sent).some((field) => !typedInPage.has(`${id}:${field}`) || JSON.stringify(sent[field]).includes('{{'));

    changedFields.forEach((field) => sideEffects.add(field));

    for (const { field } of inlineOf(element)) {
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

    saveFailed = true;

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

async function moveElement(id: number, target: number, position: MovePosition): Promise<void> {
  await queue.settle();

  const response = await fetch(`${api}/${id}/position`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Block-Editor-Token': token },
    body: JSON.stringify({ revision: queue.revision(id), target, position }),
  });

  const data = (await response.json().catch(() => ({}))) as { error?: string; revisions?: Record<string, string> };

  if (!response.ok) {
    throw new Error(data.error ?? 'Verschieben fehlgeschlagen.');
  }

  for (const [element, revision] of Object.entries(data.revisions ?? {})) {
    queue.setRevision(Number(element), revision);
  }
}

/** Forgets the previous page. The queue stays: its entries are replaced when tracked again. */
function resetPage(): void {
  elements.clear();
  awaitingRender.clear();
  typedInPage.clear();
  sideEffects.clear();
  selected = null;
  back.hidden = true;
  renderInspector();
}

function showPage(page: FramePage | null): void {
  if (page) {
    title.textContent = page.title;
    document.title = `Block-Editor: ${page.title}`;
    frame.title = `Seitenvorschau: ${page.title}`;
  }
}

/** Only pages the user can edit go into the address: the editor refuses all others on reload. */
function rememberPage(page: FramePage | null): void {
  if (page && [...elements.values()].some((element) => element.editable)) {
    const url = new URL(window.location.href);
    url.searchParams.set('id', String(page.id));
    window.history.replaceState(window.history.state, '', url);
  }
}

function loadInFrame(url: string): void {
  // What the page on display announced says nothing about the next one
  clearTimeout(noEditorTimer);
  readySinceLoad = false;
  setStatus('Seite wird geladen …', false, 'busy');
  frame.contentWindow?.location.replace(url);
}

/** Nothing gets lost: the page only changes after everything was saved successfully. */
async function goTo(url: string, addToHistory: boolean): Promise<void> {
  const current = ++navigation;

  redirectRecoveries = 0;
  saveFailed = false;
  await moving;
  await queue.settle();

  if (current !== navigation) {
    return;
  }

  if (saveFailed) {
    // The browser moved on already when coming from its history: back to the page on display
    if (!addToHistory) {
      window.history.pushState({ frame: frame.contentWindow?.location.href }, '');
    }

    return;
  }

  if (addToHistory) {
    window.history.pushState({ frame: url }, '');
  }

  hasLeftStart = true;
  loadInFrame(url);
}

function frameHref(): string | null {
  try {
    return frame.contentWindow?.location.href ?? null;
  } catch {
    return null;
  }
}

/** Returns false if the limit is reached: redirects that go in circles must not run forever. */
function reloadInEditor(url: string): boolean {
  if (redirectRecoveries >= MAX_REDIRECT_RECOVERIES) {
    return false;
  }

  redirectRecoveries++;
  loadInFrame(url);

  return true;
}

/**
 * The address may lie outside of Contao, e.g. a shop or a rule of the web server. The
 * preview entry point only knows Contao's pages, so it can't follow such a redirect:
 * ask for the page as a visitor would and show the page this ends up on.
 */
async function findRedirectTarget(href: string): Promise<string | null> {
  const url = publicUrl(href, window.location.origin, framePaths);

  if (!url) {
    return null;
  }

  try {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const target = new URL(response.url);

    if (!response.redirected || pagePath(target.pathname, framePaths) === pagePath(new URL(url).pathname, framePaths)) {
      return null;
    }

    return frameUrl(target.href, window.location.origin, framePaths, blockedPaths);
  } catch {
    // Another origin or no connection: nothing that could be shown in here
    return null;
  }
}

async function recoverFromMissingEditor(): Promise<void> {
  const href = frameHref();
  const current = navigation;
  const target = href ? await findRedirectTarget(href) : null;

  // The user went on in the meantime
  if (current !== navigation || href !== frameHref()) {
    return;
  }

  if (!target || !reloadInEditor(target)) {
    showNoEditor();
  }
}

function showNoEditor(): void {
  currentLoad = null;
  resetPage();
  back.hidden = !hasLeftStart;
  setStatus('Diese Seite kann im Editor nicht angezeigt werden.', true);
}

async function loadElements(ids: number[], load: number, page: FramePage | null): Promise<void> {
  if (ids.length === 0) {
    setStatus('');

    return;
  }

  const { elements: loaded } = await getJson<{ elements: Record<string, Element> }>(`${api}?ids=${ids.join(',')}`);
  const types = new Set<string>();

  if (load !== currentLoad) {
    return;
  }

  for (const element of Object.values(loaded)) {
    elements.set(element.id, element);
    types.add(element.type);

    if (element.editable) {
      queue.track(element.id, element.revision);
    }
  }

  const { types: loadedSchema } = await getJson<{ types: Record<string, TypeSchema> }>(`${schemaUrl}?types=${[...types].sort().join(',')}`);

  if (load !== currentLoad) {
    return;
  }

  schema = loadedSchema;

  const frameElements: FrameElement[] = [...elements.values()]
    .filter((element) => element.editable)
    .map((element) => {
      const inline = inlineOf(element);

      return { id: element.id, inline, values: Object.fromEntries(inline.map(({ field }) => [field, element.values[field]])) };
    });

  post({ type: 'cbe:elements', elements: frameElements });

  if (shownFirst !== null && frameElements.some(({ id }) => id === shownFirst)) {
    post({ type: 'cbe:show', id: shownFirst });
  }

  shownFirst = null;
  rememberPage(page);
  setStatus(frameElements.length ? '' : 'Nur Ansicht: Auf dieser Seite gibt es nichts, das du bearbeiten darfst.');
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
      control = field.rich ? richControl(element, field, textarea, change) : textarea;
      break;
    }
    case 'select':
    case 'radio': {
      const select = document.createElement('select');
      const current = field.multiple && Array.isArray(value) ? value.map(String) : [String(value ?? '')];

      select.multiple = field.multiple;
      wrapper.classList.toggle('cbe-field--row', !field.multiple);

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
      wrapper.classList.add('cbe-field--switch');
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
      fieldSync.set(field.name, (next) => { input.value = String(next ?? ''); });
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

const tooltip = document.createElement('p');
tooltip.className = 'cbe-tooltip';
tooltip.hidden = true;
document.body.append(tooltip);

/** The full text of a description, next to its line. */
function updateTooltip(hit: EventTarget | null = null): void {
  const hovered = hit instanceof Element ? hit.closest('.cbe-description') : null;
  // Focus also covers the keyboard and touch screens, which have no hover
  const line = hovered ?? document.activeElement?.closest('.cbe-field')?.querySelector('.cbe-description');

  tooltip.hidden = !line;

  if (!line) {
    return;
  }

  tooltip.textContent = line.textContent;

  const gap = 8;
  const panel = inspector.getBoundingClientRect();
  const { top } = line.getBoundingClientRect();
  const beside = panel.left - tooltip.offsetWidth - gap;
  const height = tooltip.offsetHeight;

  // On small screens the inspector is below the page, so there is only room above it
  tooltip.style.left = `${beside >= gap ? beside : gap}px`;
  tooltip.style.top = `${beside >= gap
    ? Math.max(gap, Math.min(top, window.innerHeight - height - gap))
    : Math.max(gap, panel.top - height - gap)}px`;
}

inspector.addEventListener('pointerover', ({ target }) => updateTooltip(target));
inspector.addEventListener('pointerleave', () => updateTooltip());
inspector.addEventListener('focusin', () => updateTooltip());
inspector.addEventListener('focusout', () => queueMicrotask(() => updateTooltip()));
inspector.addEventListener('scroll', () => updateTooltip(), { passive: true });

/** Loaded on demand: most pages are edited in place, and the shell must start fast. */
let richModule: Promise<typeof import('./rich-editor')> | null = null;
const richFields: RichField[] = [];

/** The text as in the back end, with its HTML a click away. Until the editor is loaded, or if it can't take the markup, only the HTML. */
function richControl(element: Element, field: FieldSchema, textarea: HTMLTextAreaElement, change: (value: unknown) => void): HTMLElement {
  const box = document.createElement('div');
  const host = document.createElement('div');
  const toggle = document.createElement('button');

  box.className = 'cbe-rich';
  host.className = 'cbe-rich__host';
  host.hidden = true;
  toggle.type = 'button';
  toggle.className = 'cbe-rich__toggle';
  toggle.append(iconElement(document, ICONS.source));
  toggle.hidden = true;
  box.append(host, textarea, toggle);

  const sync = fieldSync.get(field.name);
  let rich: RichField | null = null;

  const showRich = (on: boolean): void => {
    host.hidden = !on;
    textarea.hidden = on;
    toggle.title = on ? 'Quellcode bearbeiten' : 'Zurück zum formatierten Text';
    toggle.setAttribute('aria-label', 'Quellcode');
    toggle.setAttribute('aria-pressed', String(!on));
  };

  const mount = (module: typeof import('./rich-editor')): void => {
    rich?.destroy();
    rich = module.mountRichField(host, {
      html: textarea.value,
      label: field.label,
      change: (html) => {
        textarea.value = html;
        change(html);
      },
      pick: (current, done) => openPicker(element.id, current, (value) => value !== null && done(value)),
    });

    if (rich) {
      richFields.push(rich);
    }

    toggle.hidden = false;
    showRich(Boolean(rich));
  };

  richModule ??= import(richEditorUrl) as Promise<typeof import('./rich-editor')>;
  richModule.then((module) => box.isConnected && mount(module)).catch((error: unknown) => console.error('[block-editor] Der Editor für formatierten Text fehlt:', error));

  toggle.addEventListener('click', () => {
    if (textarea.hidden) {
      showRich(false);
      textarea.focus();
    } else {
      void richModule?.then((module) => mount(module));
    }
  });

  fieldSync.set(field.name, (next) => {
    sync?.(next);
    rich?.set(String(next ?? ''));
  });

  return box;
}

function renderInspector(): void {
  inspector.replaceChildren();
  richFields.splice(0).forEach((field) => field.destroy());
  tooltip.hidden = true;
  fieldSync.clear();

  const element = selected === null ? undefined : elements.get(selected);

  if (!element) {
    const help = document.querySelector<HTMLTemplateElement>('#cbe-help');

    if (help) {
      inspector.append(help.content.cloneNode(true));
    }

    return;
  }

  const heading = document.createElement('h2');
  heading.textContent = schema[element.type]?.label ?? element.type;
  heading.title = element.type;
  inspector.append(heading);

  for (const field of fieldsOf(element)) {
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
      readySinceLoad = true;
      redirectRecoveries = 0;

      if (message.load === currentLoad) {
        break;
      }

      currentLoad = message.load;
      resetPage();
      showPage(message.page);
      loadElements(message.ids.filter(Number.isInteger), message.load, message.page).catch((error: Error) => setStatus(error.message, true));
      break;
    case 'cbe:navigate': {
      const url = frameUrl(message.href, window.location.origin, framePaths, blockedPaths);

      if (url) {
        void goTo(url, true);
      } else {
        setStatus('Dieser Link führt aus der Website hinaus und wird im Editor nicht geöffnet.', true);
      }
      break;
    }
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
    case 'cbe:pick-link':
      openPicker(message.id, message.value);
      break;
    case 'cbe:move': {
      const { id, target, position } = message;

      setStatus('Wird verschoben …');

      moving = moveElement(id, target, position)
        .then(() => {
          setStatus('Verschoben');
          post({ type: 'cbe:moved', id, ok: true });
        })
        .catch((error: unknown) => {
          setStatus(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Verschieben fehlgeschlagen. Bitte die Verbindung prüfen.', true);
          post({ type: 'cbe:moved', id, ok: false });
        });
      break;
    }
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
document.addEventListener('pointerdown', ({ target }) => {
  // The link picker belongs to the text being edited
  if (!(target instanceof Node && document.getElementById('cbe-picker')?.contains(target))) {
    post({ type: 'cbe:end' });
  }
}, true);

// Either side can start first: the frame announces itself and also answers this
frame.addEventListener('load', () => {
  post({ type: 'cbe:hello' });

  // A redirect outside of Contao has lost the marker on its way
  const href = frameHref();

  if (href && !isFrameUrl(href, framePaths)) {
    const url = frameUrl(href, window.location.origin, framePaths, blockedPaths);

    if (url && reloadInEditor(url)) {
      clearTimeout(noEditorTimer);

      return;
    }
  }

  // Error pages and files come without the editor, so they can't announce themselves
  clearTimeout(noEditorTimer);
  noEditorTimer = setTimeout(() => {
    if (!readySinceLoad) {
      void recoverFromMissingEditor();
    }

    readySinceLoad = false;
  }, NO_EDITOR_DELAY);
});

back.addEventListener('click', () => window.history.back());

/** Only conveniences: without storage a choice lasts until the next reload. */
function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // See above
  }
}

const VIEWPORT_KEY = 'cbe-viewport';
const viewportButtons = [...document.querySelectorAll<HTMLButtonElement>('.cbe-viewport')];

function showViewport(viewport: string): void {
  (frame.parentElement as HTMLElement).dataset.viewport = viewport;
  (viewportButtons[0]?.parentElement as HTMLElement | undefined)?.setAttribute('data-active', viewport);

  for (const button of viewportButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.viewport === viewport));
  }
}

for (const button of viewportButtons) {
  button.addEventListener('click', () => {
    const viewport = button.dataset.viewport as string;

    showViewport(viewport);
    writeSetting(VIEWPORT_KEY, viewport);
  });
}

const storedViewport = readSetting(VIEWPORT_KEY);

if (viewportButtons.some((button) => button.dataset.viewport === storedViewport)) {
  showViewport(storedViewport as string);
}

const INSPECTOR_KEY = 'cbe-inspector';
const inspectorToggle = document.getElementById('cbe-inspector-toggle') as HTMLButtonElement;

function showInspector(visible: boolean): void {
  inspector.hidden = !visible;
  tooltip.hidden = true;
  inspectorToggle.setAttribute('aria-pressed', String(visible));
}

inspectorToggle.addEventListener('click', () => {
  showInspector(Boolean(inspector.hidden));
  writeSetting(INSPECTOR_KEY, inspector.hidden ? 'hidden' : 'visible');
});

showInspector(readSetting(INSPECTOR_KEY) !== 'hidden');

window.history.replaceState({ frame: frame.src }, '');

window.addEventListener('popstate', (event) => {
  const url = (event.state as { frame?: string } | null)?.frame;

  if (url) {
    void goTo(url, false);
  }
});
post({ type: 'cbe:hello' });

// Don't lose the last keystrokes when the tab is closed
window.addEventListener('pagehide', () => queue.flush(true));

window.addEventListener('beforeunload', (event) => {
  if (queue.pending) {
    event.preventDefault();
  }
});

renderInspector();

// The link picker of Contao, with pages, files, news and whatever other bundles add
const pickerDialog = document.getElementById('cbe-picker') as HTMLDialogElement;
const pickerFrame = pickerDialog.querySelector('iframe') as HTMLIFrameElement;
let pickerChoice: string | null = null;
let pickerDone: (value: string | null) => void = () => {};

/** Without a callback, the choice goes to the text being edited in the page. */
function openPicker(id: number, value: string, done: (value: string | null) => void = (choice) => post({ type: 'cbe:picked', value: choice })): void {
  pickerDone = done;
  const url = new URL(pickerUrl, window.location.origin);
  url.searchParams.set('context', 'link');
  url.searchParams.set('extras[fieldType]', 'radio');
  url.searchParams.set('extras[source]', `tl_content.${id}`);
  // Contao adds the flag on save, the picker only knows the plain tag
  url.searchParams.set('value', value.replace(/\|urlattr(?=\}\}$)/, ''));
  url.searchParams.set('popup', '1');

  pickerChoice = null;
  pickerApply.disabled = false;
  pickerFrame.src = url.href;
  pickerDialog.showModal();
}

/** Read like Contao's own modal does: the checked entry of the listing in the frame. */
function readPickerChoice(): string | null {
  const listing = pickerFrame.contentDocument?.querySelector<HTMLElement>('#tl_listing, #tl_select');
  const checked = listing?.querySelector<HTMLInputElement>('input:checked:not([id^="check_all_"]):not([id^="reset_"])');

  if (checked) {
    return checked.value;
  }

  // Chosen before, on another page of the listing
  try {
    const previous = JSON.parse(listing?.dataset.pickerValue ?? '[]') as unknown[];

    return typeof previous[0] === 'string' ? previous[0] : null;
  } catch {
    return null;
  }
}

const pickerApply = pickerDialog.querySelector('[data-picker-apply]') as HTMLButtonElement;

// Contao's picker page switches the apply button of its own modal through the parent document,
// with MooTools. It is off for views without anything to choose, such as a folder of news archives.
(document as Document & { getElements?: unknown }).getElements = (selector: string) => {
  const isApply = selector === '.simple-modal-footer a.primary';

  return {
    addClass: () => { if (isApply) pickerApply.disabled = true; },
    removeClass: () => { if (isApply) pickerApply.disabled = false; },
  };
};

pickerApply.addEventListener('click', () => {
  pickerChoice = readPickerChoice();
  pickerDialog.close();
});

pickerDialog.querySelector('[data-picker-cancel]')?.addEventListener('click', () => pickerDialog.close());

// Esc inside of the listing never reaches the dialog, which only hears its own document
pickerFrame.addEventListener('load', () => {
  pickerFrame.contentDocument?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pickerDialog.open) {
      pickerDialog.close();
    }
  });
});

// Also closed with Esc: the frame always hears back, so it doesn't wait for a choice
pickerDialog.addEventListener('close', () => {
  pickerDone(pickerChoice);
  pickerDone = () => {};
  pickerFrame.src = 'about:blank';
});

