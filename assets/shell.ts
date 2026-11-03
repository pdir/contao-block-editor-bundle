import { ICONS, iconElement } from './editor-icons';
import { frameUrl, isFrameUrl, pagePath, publicUrl, type FramePaths } from './navigation';
import type { RichField } from './rich-editor';
import type { FrameElement, FramePage, FrameRecord, InlineConfig, ToFrame, ToShell, MovePosition } from './protocol';
import { readMessage } from './protocol';
import { SaveError, SaveQueue, type SaveResult } from './save-queue';
import type { NavPages } from './nav-pages';
import type { ReaderRecord, ReaderRecordOptions } from './reader-record';
import { applyCorners, applyInspector, applyViewport, storedInspector, storedNavEdit, storedRoundCorners, storedSingleKeys, storedViewport, storeNavEdit, storeSingleKeys, type Viewport } from './settings';
import { isMac, shortcutFor, type Shortcut } from './shortcuts';

interface FieldSchema {
  name: string;
  label: string;
  description: string;
  input: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'inputUnit' | 'tableWizard' | 'listWizard';
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
  deletable?: boolean;
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
const undoButton = document.getElementById('cbe-undo') as HTMLButtonElement;

const { token, api, schema: schemaUrl, base, preview, backend, picker: pickerUrl, richEditor: richEditorUrl, previewMenu: previewMenuUrl, pages: pagesUrl, navPages: navPagesUrl, records: recordsUrl, readerRecord: readerRecordUrl, inserter: inserterUrl, undo: undoUrl, tableField: tableFieldUrl } = app.dataset as Record<'token' | 'api' | 'schema' | 'base' | 'preview' | 'backend' | 'picker' | 'richEditor' | 'previewMenu' | 'pages' | 'navPages' | 'records' | 'readerRecord' | 'inserter' | 'undo' | 'tableField', string>;
const framePaths: FramePaths = { base, preview };
/** The back end and internal routes such as the logout are no pages of the website. */
const blockedPaths = [backend, `${base}/_contao`];
const NO_EDITOR_DELAY = 500;
const MAX_REDIRECT_RECOVERIES = 3;

const elements = new Map<number, Element>();
let schema: Record<string, TypeSchema> = {};
let selected: number | null = null;
/** A page chosen by its link in the navigation, shown when no element is selected. */
let selectedPage: number | null = null;
/** Loaded once page names can be edited in the navigation. */
let navPages: Promise<NavPages> | null = null;
/** The news or event of a reader page, and whether it is shown in the inspector. */
let readerRecord: Promise<ReaderRecord> | null = null;
let recordSelected = false;
/** Title and description of the page in the frame, for search engines. */
let pageMeta: Promise<ReaderRecord> | null = null;
/** The document in the frame that the shown data belongs to. */
let currentLoad: number | null = null;
let readySinceLoad = false;
let redirectRecoveries = 0;
let noEditorTimer: ReturnType<typeof setTimeout> | undefined;
let saveFailed = false;
let navigation = 0;
let hasLeftStart = false;
const awaitingRender = new Set<number>();
/** New elements by the element they were added after, until the page shows them. */
const insertedAfter = new Map<number, number>();
/** Fields last changed by typing in the page: the page shows them correctly already. */
const typedInPage = new Set<string>();
/** Fields that extensions changed during the current saves, shown once these are done. */
const sideEffects = new Set<string>();
/** The element opened from the back end, shown once the page is ready. */
let shownFirst: number | null = Number(new URLSearchParams(window.location.search).get('element')) || null;
/** Shown once the reloaded page is ready, instead of an empty status. */
let statusAfterLoad: string | null = null;
/** Restores the last deletion, offered until the status changes. */
let undoLast: (() => void) | null = null;

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
    post({ type: 'cbe:refresh', id, after: insertedAfter.get(id) });
  }

  awaitingRender.clear();
}

function post(message: ToFrame): void {
  frame.contentWindow?.postMessage(message, window.location.origin);
}

function setStatus(text: string, isError = false, state?: 'busy' | 'saved'): void {
  status.textContent = text;
  undoButton.hidden = true;
  undoLast = null;
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
      post({ type: 'cbe:refresh', id, after: insertedAfter.get(id) });
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

/** Loaded with the first new element. */
let inserter: Promise<(url: string) => Promise<string | null>> | null = null;

/** Asks for the type, then adds the element after the given one and opens it. */
async function insertAfter(target: number): Promise<void> {
  const load = currentLoad;

  inserter ??= (import(inserterUrl) as Promise<typeof import('./inserter')>).then(({ setupInserter }) => setupInserter(document.getElementById('cbe-inserter') as HTMLDialogElement));

  const type = await (await inserter)(`${api}/${target}/types`);

  if (!type || load !== currentLoad) {
    return;
  }

  setStatus('Wird eingefügt …', false, 'busy');

  // Like a move, it can renumber the siblings
  let done = (): void => {};
  const previous = moving;
  moving = new Promise((resolve) => { done = resolve; });

  try {
    await previous;
    await queue.settle();

    const response = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Block-Editor-Token': token },
      body: JSON.stringify({ target, position: 'after', type }),
    });

    const data = (await response.json().catch(() => ({}))) as { error?: string; element?: Element; revisions?: Record<string, string> };

    if (!response.ok || !data.element) {
      throw new Error(data.error ?? 'Einfügen fehlgeschlagen.');
    }

    for (const [sibling, revision] of Object.entries(data.revisions ?? {})) {
      queue.setRevision(Number(sibling), revision);
    }

    const element = data.element;

    if (!schema[element.type]) {
      const { types } = await getJson<{ types: Record<string, TypeSchema> }>(`${schemaUrl}?types=${element.type}`);
      schema = { ...schema, ...types };
    }

    if (load !== currentLoad) {
      return;
    }

    elements.set(element.id, element);
    insertedAfter.set(element.id, target);

    if (element.editable) {
      const inline = inlineOf(element);

      queue.track(element.id, element.revision);
      post({ type: 'cbe:elements', elements: [{ id: element.id, inline, values: Object.fromEntries(inline.map(({ field }) => [field, element.values[field]])) }] });
    }

    post({ type: 'cbe:refresh', id: element.id, after: target, show: true });
    selected = element.id;
    selectedPage = null;
    recordSelected = false;
    renderInspector();
    setStatus(`Eingefügt: ${schema[element.type]?.label ?? element.type}`, false, 'saved');
  } catch (error) {
    setStatus(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Einfügen fehlgeschlagen. Bitte die Verbindung prüfen.', true);
  } finally {
    done();
  }
}

/** Deletes an element with the elements nested in it. Contao keeps them for "Wiederherstellen". */
async function deleteElement(id: number): Promise<void> {
  const element = elements.get(id);
  const load = currentLoad;

  if (!element) {
    return;
  }

  const label = schema[element.type]?.label ?? element.type;

  post({ type: 'cbe:end' });
  setStatus('Wird gelöscht …', false, 'busy');

  // Like a move, it waits for what is still being saved
  let done = (): void => {};
  const previous = moving;
  moving = new Promise((resolve) => { done = resolve; });

  try {
    await previous;
    await queue.settle();

    const response = await fetch(`${api}/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Block-Editor-Token': token },
      body: JSON.stringify({ revision: queue.revision(id) ?? element.revision }),
    });

    const data = (await response.json().catch(() => ({}))) as { error?: string; deleted?: number[]; undo?: number | null };

    if (!response.ok) {
      throw new Error(data.error ?? 'Löschen fehlgeschlagen.');
    }

    for (const gone of data.deleted ?? [id]) {
      elements.delete(gone);
      queue.forget(gone);
      insertedAfter.delete(gone);
      awaitingRender.delete(gone);
    }

    if (load === currentLoad) {
      post({ type: 'cbe:remove', id });
    }

    if (selected !== null && !elements.has(selected)) {
      selected = null;
      renderInspector();
    }

    setStatus(`Gelöscht: ${label}`, false, 'saved');

    if (data.undo) {
      const undo = data.undo;

      undoButton.hidden = false;
      undoLast = () => void restoreElement(undo, id, label);
    }
  } catch (error) {
    setStatus(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Löschen fehlgeschlagen. Bitte die Verbindung prüfen.', true);
  } finally {
    done();
  }
}

/** Puts a deleted element back and shows it in the reloaded page. */
async function restoreElement(undo: number, id: number, label: string): Promise<void> {
  setStatus('Wird wiederhergestellt …', false, 'busy');

  try {
    const response = await fetch(`${undoUrl}/${undo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Block-Editor-Token': token },
      body: '{}',
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };

      throw new Error(data.error ?? 'Wiederherstellen fehlgeschlagen.');
    }
  } catch (error) {
    setStatus(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Wiederherstellen fehlgeschlagen. Bitte die Verbindung prüfen.', true);

    return;
  }

  // Its place and its wrappers come from the server: the page is loaded again
  const href = frameHref();

  shownFirst = id;
  statusAfterLoad = `Wiederhergestellt: ${label}`;

  if (href) {
    await goTo(href, false);
  }
}

/** Forgets the previous page. The queue stays: its entries are replaced when tracked again. */
function resetPage(): void {
  elements.clear();
  awaitingRender.clear();
  insertedAfter.clear();
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
  await navPages?.then((pages) => pages.settle());
  await readerRecord?.then((record) => record.settle());
  await pageMeta?.then((meta) => meta.settle());

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

  if (frameElements.length && statusAfterLoad) {
    setStatus(statusAfterLoad, false, 'saved');
  } else {
    setStatus(frameElements.length ? '' : 'Nur Ansicht: Auf dieser Seite gibt es nichts, das du bearbeiten darfst.');
  }

  statusAfterLoad = null;
}

/** Loaded with the first table. */
let tableField: Promise<typeof import('./table-field')> | null = null;

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
    case 'tableWizard':
    case 'listWizard': {
      const holder = document.createElement('div');
      const flag = (name: string): boolean => Boolean(element.values[name]) && element.values[name] !== '0';

      holder.setAttribute('role', 'group');
      holder.setAttribute('aria-label', field.label);
      tableField ??= import(tableFieldUrl) as Promise<typeof import('./table-field')>;
      tableField.then(({ createTableField }) => {
        // The inspector may show another element by now
        if (!holder.isConnected) {
          return;
        }

        const list = field.input === 'listWizard';
        const table = createTableField({ label: field.label, value: element.values[field.name], header: !list && flag('thead'), footer: !list && flag('tfoot'), list, change });

        holder.append(table.root);
        fieldSync.set(field.name, (next) => table.sync(next));
      }).catch((error: unknown) => console.error('[block-editor] Das Feld fehlt:', error));
      control = holder;
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

  // The table wizard's description is about its form in the back end
  if (field.description && field.input !== 'tableWizard' && field.input !== 'listWizard') {
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

  void readerRecord?.then((record) => record.forget());
  void pageMeta?.then((meta) => meta.forget());

  if (!element && recordSelected && readerRecord) {
    void readerRecord.then((record) => {
      if (recordSelected && selected === null) {
        inspector.replaceChildren();
        record.render(inspector);
      }
    });

    return;
  }

  if (!element && selectedPage !== null && navPages) {
    const page = selectedPage;

    void navPages.then((pages) => {
      if (selectedPage === page && selected === null) {
        inspector.replaceChildren();
        pages.render(inspector, page);
      }
    });

    return;
  }

  void navPages?.then((pages) => pages.forget());

  if (!element) {
    const help = document.querySelector<HTMLTemplateElement>('#cbe-help');

    if (help) {
      inspector.append(help.content.cloneNode(true));
      bindSettings();
      labelKeys(inspector);

      const section = inspector.querySelector<HTMLElement>('.cbe-page-meta');

      void pageMeta?.then((meta) => {
        if (section?.isConnected) {
          meta.render(section);
        }
      });
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

  // Also the keyboard's way to a new element
  const actions = document.createElement('div');
  actions.className = 'cbe-element-actions';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'cbe-button';
  add.textContent = 'Element darunter einfügen';
  add.addEventListener('click', () => void insertAfter(element.id));
  actions.append(add);

  // Without asking: it can be undone right away and later in "Wiederherstellen"
  if (element.deletable) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'cbe-button cbe-button--danger';
    remove.textContent = 'Löschen';
    remove.addEventListener('click', () => void deleteElement(element.id));
    actions.append(remove);
  }

  const classic = document.createElement('a');
  classic.className = 'cbe-link';
  classic.href = element.classicUrl;
  classic.textContent = 'Im klassischen Backend bearbeiten';
  inspector.append(actions, classic);
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
      showCorners(storedRoundCorners());
      showEditing(editing);
      selectedPage = null;
      recordSelected = false;

      if (navPages) {
        post({ type: 'cbe:nav-edit', enabled: true });
      }
      loadRecord(message.record);
      loadPageMeta(message.page);
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
      if (selected !== message.id || selectedPage !== null || recordSelected) {
        selected = message.id;
        selectedPage = null;
        recordSelected = false;
        renderInspector();
      }
      break;
    case 'cbe:page-select':
      selected = null;
      selectedPage = message.id;
      recordSelected = false;
      renderInspector();
      break;
    case 'cbe:record-select':
      selected = null;
      selectedPage = null;
      recordSelected = true;
      renderInspector();
      break;
    case 'cbe:record-change':
      void readerRecord?.then((record) => record.change(message.field, message.value, 'page'));
      break;
    case 'cbe:page-change':
      void navPages?.then((pages) => pages.rename(message.id, message.title, 'page'));
      break;
    case 'cbe:shortcut':
      runShortcut(message.name);
      break;
    case 'cbe:nav-links':
      void navPages?.then((pages) => pages.resolve(message.urls)).catch((error: Error) => setStatus(error.message, true));
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
    case 'cbe:insert':
      void insertAfter(message.id);
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

const root = document.documentElement;
const viewportButtons = [...document.querySelectorAll<HTMLButtonElement>('.cbe-viewport')];

function showViewport(viewport: Viewport, store = false): void {
  applyViewport(root, viewport, store);

  for (const button of viewportButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.viewport === viewport));
  }
}

for (const button of viewportButtons) {
  button.addEventListener('click', () => showViewport(button.dataset.viewport as Viewport, true));
}

showViewport(storedViewport());

const inspectorToggle = document.getElementById('cbe-inspector-toggle') as HTMLButtonElement;

function showInspector(visible: boolean, store = false): void {
  applyInspector(root, visible, store);
  inspector.hidden = !visible;
  tooltip.hidden = true;
  inspectorToggle.setAttribute('aria-pressed', String(visible));
}

inspectorToggle.addEventListener('click', () => showInspector(Boolean(inspector.hidden), true));

showInspector(storedInspector());

/** The page in the preview is same-origin, so its root gets attributes directly. */
function pageRoot(): HTMLElement | null {
  try {
    return frame.contentDocument?.documentElement ?? null;
  } catch {
    // Not loaded yet: the next cbe:ready applies them
    return null;
  }
}

function showCorners(round: boolean, store = false): void {
  applyCorners(root, round, store);

  const page = pageRoot();

  if (page) {
    applyCorners(page, round);
  }
}

const editToggle = document.getElementById('cbe-edit-toggle') as HTMLButtonElement;
let editing = true;

/** Off, the page is only looked at and every link leads to its page. On with every new editor. */
function showEditing(enabled: boolean): void {
  editing = enabled;
  editToggle.setAttribute('aria-pressed', String(enabled));

  for (const node of [root, pageRoot()]) {
    node?.toggleAttribute('data-cbe-viewing', !enabled);
  }
}

function setEditing(enabled: boolean): void {
  showEditing(enabled);

  if (!enabled) {
    // Saves what is being typed and forgets the selection
    post({ type: 'cbe:end' });
    selected = null;
    selectedPage = null;
    recordSelected = false;
    renderInspector();
  }

  setStatus(enabled ? 'Bearbeiten: an' : 'Bearbeiten: aus, nur ansehen');
}

editToggle.addEventListener('click', () => setEditing(!editing));

/** One that is still being saved keeps its queue until done. */
function setupRecord(previous: Promise<ReaderRecord> | null, record: FrameRecord, options: Pick<ReaderRecordOptions, 'post' | 'hint' | 'lengths'>): Promise<ReaderRecord> {
  return (import(readerRecordUrl) as Promise<typeof import('./reader-record')>).then(async ({ setupReaderRecord }) => {
    await previous?.then((loaded) => loaded.settle());

    const loaded = setupReaderRecord(record, { token, url: recordsUrl, setStatus, ...options });
    await loaded.load().catch((error: Error) => setStatus(error.message, true));

    return loaded;
  });
}

/** Only a reader page has a record. */
function loadRecord(record: FrameRecord | null): void {
  readerRecord = record ? setupRecord(readerRecord, record, { post, hint: 'Auch direkt in der Seite änderbar. Weitere Angaben im klassischen Backend.' }) : null;
}

/** The meta data of the page, shown when no element is selected. */
function loadPageMeta(page: FramePage | null): void {
  pageMeta = page ? setupRecord(pageMeta, { table: 'tl_page', id: page.id, scope: '' }, { lengths: { pageTitle: 60, description: 160 } }) : null;
}

function loadNavPages(): Promise<NavPages> {
  navPages ??= (import(navPagesUrl) as Promise<typeof import('./nav-pages')>).then(({ setupNavPages }) => setupNavPages({
    token,
    url: pagesUrl,
    paths: framePaths,
    post,
    setStatus,
    open: (href) => {
      const url = frameUrl(href, window.location.origin, framePaths, blockedPaths);

      if (url) {
        void goTo(url, true);
      }
    },
  }));

  return navPages;
}

/** Off again, the links lead to their pages. Unsaved names are saved first. */
function showNavEdit(enabled: boolean): void {
  if (enabled) {
    void loadNavPages().then(() => post({ type: 'cbe:nav-edit', enabled: true })).catch((error: unknown) => console.error('[block-editor] Die Bearbeitung der Navigation fehlt:', error));
  } else if (navPages) {
    const loaded = navPages;

    navPages = null;
    selectedPage = null;
    post({ type: 'cbe:nav-edit', enabled: false });
    void loaded.then((pages) => pages.settle());
  }
}

function bindSettings(): void {
  const corners = inspector.querySelector<HTMLInputElement>('[data-setting="corners"]');
  const navEdit = inspector.querySelector<HTMLInputElement>('[data-setting="nav-edit"]');

  if (corners) {
    corners.checked = storedRoundCorners();
    corners.addEventListener('change', () => showCorners(corners.checked, true));
  }

  if (navEdit) {
    navEdit.checked = storedNavEdit();
    navEdit.addEventListener('change', () => setNavEdit(navEdit.checked));
  }

  const singleKeys = inspector.querySelector<HTMLInputElement>('[data-setting="single-keys"]');

  if (singleKeys) {
    singleKeys.checked = storedSingleKeys();
    singleKeys.addEventListener('change', () => storeSingleKeys(singleKeys.checked));
  }
}

function setNavEdit(enabled: boolean): void {
  storeNavEdit(enabled);
  showNavEdit(enabled);

  const box = inspector.querySelector<HTMLInputElement>('[data-setting="nav-edit"]');

  if (box) {
    box.checked = enabled;
  }

  // Also for screen readers: the status is a live region
  setStatus(`Navigationslinks bearbeiten: ${enabled ? 'an' : 'aus'}`);
}

/** The keys as printed on the keyboard: Strg and Umschalt on Windows, symbols on a Mac. */
function labelKeys(scope: ParentNode): void {
  if (!isMac()) {
    return;
  }

  const symbols: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥' };

  for (const key of scope.querySelectorAll<HTMLElement>('kbd[data-key]')) {
    key.textContent = symbols[key.dataset.key as string] ?? key.textContent;
  }
}

function showShortcuts(): void {
  post({ type: 'cbe:end' });
  selected = null;
  selectedPage = null;
  recordSelected = false;
  showInspector(true, true);
  renderInspector();

  const shortcuts = inspector.querySelector<HTMLDetailsElement>('#cbe-shortcuts');

  if (shortcuts) {
    shortcuts.open = true;
    shortcuts.scrollIntoView({ block: 'nearest' });
    shortcuts.querySelector('summary')?.focus();
  }
}

function runShortcut(name: Shortcut): void {
  if (name === 'help') {
    showShortcuts();
  } else if (name === 'edit') {
    setEditing(!editing);
  } else if (name === 'inspector') {
    showInspector(Boolean(inspector.hidden), true);
  } else if (name === 'nav-edit') {
    setNavEdit(!storedNavEdit());
  } else {
    showViewport(name, true);
  }
}

// The page in the frame passes on what is pressed there
document.addEventListener('keydown', (event) => {
  const shortcut = shortcutFor(event, storedSingleKeys());

  if (shortcut) {
    event.preventDefault();
    runShortcut(shortcut);
  }
});

if (storedNavEdit()) {
  void loadNavPages();
}

const previewToggle = document.getElementById('cbe-preview-toggle') as HTMLButtonElement | null;
const previewMenu = document.getElementById('cbe-preview-menu') as HTMLFormElement | null;

// Contao's preview toolbar: rarely needed, so its script only loads with the first click
previewToggle?.addEventListener('click', () => {
  (import(previewMenuUrl) as Promise<typeof import('./preview-menu')>)
    .then(({ setupPreviewMenu }) => setupPreviewMenu(previewToggle, previewMenu as HTMLFormElement, {
      token,
      paths: framePaths,
      frame,
      frameHref,
      // Saves first, like any other change of the page
      reload: () => {
        const href = frameHref();

        if (href) {
          void goTo(href, false);
        }
      },
    })(true))
    .catch((error: unknown) => console.error('[block-editor] Das Vorschau-Menü fehlt:', error));
}, { once: true });

undoButton.addEventListener('click', () => undoLast?.());

window.history.replaceState({ frame: frame.src }, '');

window.addEventListener('popstate', (event) => {
  const url = (event.state as { frame?: string } | null)?.frame;

  if (url) {
    void goTo(url, false);
  }
});
post({ type: 'cbe:hello' });

// Don't lose the last keystrokes when the tab is closed
window.addEventListener('pagehide', () => {
  queue.flush(true);
  void navPages?.then((pages) => pages.flush(true));
  void readerRecord?.then((record) => record.flush(true));
  void pageMeta?.then((meta) => meta.flush(true));
});

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

