// Files and image sizes in the inspector: the image of a text or a hero, the images of a gallery,
// a download. Loaded with the first element that has such a field.

export interface FileInfo {
  uuid: string;
  path: string;
  name: string;
  image: boolean;
  preview: string | null;
}

export interface FileConfig {
  multiple: boolean;
  filesOnly: boolean;
  folders: boolean;
  extensions: string[];
  path: string;
  sortable: boolean;
}

export interface MediaField {
  root: HTMLElement;
  /** Takes over the value saved by the server. */
  sync(value: unknown): void;
}

const IMAGES = ['jpg', 'jpeg', 'gif', 'png', 'webp', 'avif', 'svg', 'svgz', 'heic', 'jxl', 'tif', 'tiff', 'bmp'];

/** The files of a value: the server sends descriptions, a pending change only paths or UUIDs. */
export function toFiles(value: unknown): FileInfo[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(',') : [];

  return list.map((entry): FileInfo => (entry && typeof entry === 'object'
    ? entry as FileInfo
    : { uuid: String(entry), path: String(entry), name: String(entry).split('/').pop() ?? '', image: false, preview: null }));
}

/** Only images allowed: the field speaks of images then. */
export function isImageField(config: FileConfig): boolean {
  return config.extensions.length > 0 && config.extensions.every((extension) => IMAGES.includes(extension));
}

/**
 * The order of the field after a choice in the picker: what stays keeps its place, new files
 * come last. The picker lists by folder and knows nothing about the order of a gallery. It
 * names files by their path, the field by their UUID.
 */
export function mergeChoice(current: FileInfo[], chosen: string[]): string[] {
  const known = (entry: string): FileInfo | undefined => current.find(({ uuid, path }) => uuid === entry || path === entry);
  const kept = current.filter((file) => chosen.some((entry) => known(entry) === file)).map(({ uuid }) => uuid);

  return [...kept, ...chosen.filter((entry) => !known(entry))];
}

/** Contao's picker for files, with the restrictions of the field. */
export function filePickerUrl(picker: string, id: number, config: FileConfig, current: string[]): string {
  const url = new URL(picker, window.location.origin);
  const extras: Record<string, string> = {
    fieldType: config.multiple ? 'checkbox' : 'radio',
    source: `tl_content.${id}`,
    ...(config.filesOnly ? { filesOnly: '1' } : {}),
    ...(config.folders ? {} : { files: '1' }),
    ...(config.extensions.length ? { extensions: config.extensions.join(',') } : {}),
    ...(config.path ? { path: config.path } : {}),
  };

  url.searchParams.set('context', 'file');

  for (const [key, value] of Object.entries(extras)) {
    url.searchParams.set(`extras[${key}]`, value);
  }

  url.searchParams.set('value', current.join(','));
  url.searchParams.set('popup', '1');

  return url.href;
}

function smallButton(text: string, label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cbe-button cbe-button--small';
  button.textContent = text;

  if (label !== text) {
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  button.addEventListener('click', run);

  return button;
}

export function createFileField(options: {
  label: string;
  value: unknown;
  config: FileConfig;
  mandatory: boolean;
  /** Opens the picker with the current files; gets the paths or UUIDs of the choice. */
  pick(current: string[], done: (chosen: string[]) => void): void;
  change(value: string | string[]): void;
}): MediaField {
  const { label, config, mandatory, pick, change } = options;
  let files = toFiles(options.value);
  const images = isImageField(config);
  const noun = images ? (config.multiple ? 'Bilder' : 'Bild') : (config.multiple ? 'Dateien' : 'Datei');

  const root = document.createElement('div');
  root.className = 'cbe-files';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);

  const list = document.createElement('ul');
  list.className = 'cbe-files__list';

  const actions = document.createElement('div');
  actions.className = 'cbe-files__actions';

  const ids = (): string[] => files.map(({ uuid }) => uuid);

  const save = (next: FileInfo[]): void => {
    files = next;
    change(config.multiple ? ids() : (ids()[0] ?? ''));
    render();
  };

  const render = (): void => {
    list.replaceChildren(...files.map((file, index) => {
      const item = document.createElement('li');
      item.className = 'cbe-files__item';

      const thumb = document.createElement('span');
      thumb.className = 'cbe-files__thumb';

      if (file.preview) {
        const img = document.createElement('img');
        img.src = file.preview;
        img.alt = '';
        img.loading = 'lazy';
        thumb.append(img);
      } else {
        thumb.textContent = (file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase();
      }

      const name = document.createElement('span');
      name.className = 'cbe-files__name';
      name.textContent = file.name;
      name.title = file.path;

      item.append(thumb, name);

      if (config.multiple && config.sortable && files.length > 1) {
        const move = (by: number): void => {
          const next = [...files];
          next.splice(index + by, 0, ...next.splice(index, 1));
          save(next);
          list.children[index + by]?.querySelector<HTMLButtonElement>(`[data-move="${by}"]`)?.focus();
        };
        const up = smallButton('↑', `${file.name} nach vorne`, () => move(-1));
        const down = smallButton('↓', `${file.name} nach hinten`, () => move(1));

        up.dataset.move = '-1';
        down.dataset.move = '1';
        up.disabled = index === 0;
        down.disabled = index === files.length - 1;
        item.append(up, down);
      }

      if (config.multiple || !mandatory) {
        item.append(smallButton('×', `${file.name} entfernen`, () => save(files.filter((_, place) => place !== index))));
      }

      return item;
    }));

    list.hidden = !files.length;
    chooser.textContent = files.length && !config.multiple ? (images ? 'Anderes Bild …' : 'Andere Datei …') : `${noun} auswählen …`;
  };

  const chooser = smallButton('', '', () => {
    pick(ids(), (chosen) => {
      if (!chosen.length && mandatory) {
        return;
      }

      const order = config.multiple ? mergeChoice(files, chosen) : chosen.slice(0, 1).map((entry) => files.find(({ path }) => path === entry)?.uuid ?? entry);
      // Known files keep their preview until the server describes the new ones
      save(order.map((entry) => files.find(({ uuid, path }) => uuid === entry || path === entry) ?? toFiles([entry])[0]));
    });
  });

  actions.append(chooser);
  root.append(list, actions);
  render();

  return {
    root,
    sync(value) {
      files = toFiles(value);
      render();
    },
  };
}

interface SizeGroup {
  label: string;
  options: { value: string; label: string }[];
}

/** A size of the theme, or a mode with width and height of its own. */
export function createSizeField(options: { id: string; label: string; value: unknown; groups: SizeGroup[]; change(value: string[]): void }): MediaField {
  const { id, label, groups, change } = options;
  const root = document.createElement('div');
  root.className = 'cbe-size';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);

  const select = document.createElement('select');
  select.id = id;

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '-';
  select.append(blank);

  for (const group of groups) {
    const parent = group.label ? document.createElement('optgroup') : select;

    if (parent instanceof HTMLOptGroupElement) {
      parent.label = group.label;
      select.append(parent);
    }

    for (const option of group.options) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      parent.append(element);
    }
  }

  const dimension = (name: string): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.inputMode = 'numeric';
    input.placeholder = name;
    input.setAttribute('aria-label', `${label}: ${name}`);

    return input;
  };

  const width = dimension('Breite');
  const height = dimension('Höhe');
  const dimensions = document.createElement('div');
  dimensions.className = 'cbe-size__dimensions';
  dimensions.append(width, '×', height);

  // A size of the theme (a number) or a predefined one (_name) brings its own dimensions
  const update = (): void => {
    dimensions.hidden = !select.value || /^\d+$/.test(select.value) || select.value.startsWith('_');
  };

  const set = (value: unknown): void => {
    const [w = '', h = '', mode = ''] = Array.isArray(value) ? value.map(String) : [];

    // An option the user may not choose stays as it is
    if (mode && !Array.from(select.options).some((option) => option.value === mode)) {
      const unknown = document.createElement('option');
      unknown.value = mode;
      unknown.textContent = `Unbekannt (${mode})`;
      select.append(unknown);
    }

    select.value = mode;
    width.value = w;
    height.value = h;
    update();
  };

  const send = (): void => {
    update();
    change(dimensions.hidden ? ['', '', select.value] : [width.value, height.value, select.value]);
  };

  select.addEventListener('change', send);
  width.addEventListener('input', send);
  height.addEventListener('input', send);

  root.append(select, dimensions);
  set(options.value);

  return {
    root,
    sync(value) {
      if (!root.contains(document.activeElement)) {
        set(value);
      }
    },
  };
}
