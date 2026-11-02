// The shell's side of editing page names in the navigation: finds the pages behind the links,
// saves new names and shows a page in the inspector. Only loaded once the setting is on.
import { publicUrl, type FramePaths } from './navigation';
import type { NavPage, ToFrame } from './protocol';
import { SaveError, SaveQueue } from './save-queue';

interface PageData {
  id: number;
  revision: string;
  title: string;
  /** The label of the name field, from the back end. */
  label: string;
  editable: boolean;
  details: { label: string; value: string }[];
  classicUrl: string;
}

export interface NavPagesOptions {
  token: string;
  /** The API of the pages. */
  url: string;
  paths: FramePaths;
  post(message: ToFrame): void;
  setStatus(text: string, isError?: boolean, state?: 'busy' | 'saved'): void;
  /** Opens a page in the editor, as a click on its link would. */
  open(href: string): void;
}

export class NavPages {
  private readonly pages = new Map<number, PageData>();
  /** The address of a page's link in the frame, to open it from the inspector. */
  private readonly hrefs = new Map<number, string>();
  private readonly queue: SaveQueue;
  private shown: { id: number; input: HTMLInputElement | null } | null = null;

  constructor(private readonly options: NavPagesOptions) {
    this.queue = new SaveQueue(
      async (id, revision, values, keepalive) => {
        const response = await fetch(`${options.url}/${id}`, {
          method: 'PATCH',
          keepalive,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Block-Editor-Token': options.token },
          body: JSON.stringify({ revision, title: values.title }),
        });

        const data = (await response.json().catch(() => ({}))) as PageData & { error?: string; errors?: Record<string, string> };

        if (!response.ok) {
          throw new SaveError(data.error ?? 'Speichern fehlgeschlagen.', response.status, data.errors);
        }

        this.pages.set(id, data);

        return { revision: data.revision, values: { title: data.title } };
      },
      {
        onStateChange: (pending) => {
          if (pending) {
            options.setStatus('Wird gespeichert …', false, 'busy');
          }
        },
        onSaved: () => options.setStatus('Gespeichert', false, 'saved'),
        onFailed: (id, _sent, error) => {
          const page = this.pages.get(id);

          options.setStatus(Object.values(error.errors).join(' ') || error.message, true);

          // Back to the name the server knows
          if (page) {
            this.rename(id, page.title, 'server');
          }
        },
      },
    );
  }

  /** Asks the server which pages the links of the navigation lead to. */
  async resolve(urls: string[]): Promise<void> {
    const byPublic = new Map<string, string>();

    for (const href of urls) {
      const url = publicUrl(href, window.location.origin, this.options.paths);

      if (url) {
        byPublic.set(url, href);
      }
    }

    if (!byPublic.size) {
      return;
    }

    const query = new URLSearchParams([...byPublic.keys()].map((url) => ['url[]', url]));
    const response = await fetch(`${this.options.url}?${query}`, { headers: { Accept: 'application/json' } });

    if (!response.ok) {
      throw new Error('Die Seiten der Navigation konnten nicht geladen werden.');
    }

    const { pages } = (await response.json()) as { pages: Record<string, PageData> };
    const found: NavPage[] = [];

    for (const [url, page] of Object.entries(pages)) {
      const href = byPublic.get(url);

      if (href) {
        found.push({ url: href, id: page.id, title: page.title, editable: page.editable });
        this.hrefs.set(page.id, href);
      }

      // A name being saved right now stays as it was typed
      if (!this.queue.revision(page.id)) {
        this.pages.set(page.id, page);
        this.queue.track(page.id, page.revision);
      }
    }

    this.options.post({ type: 'cbe:nav-pages', pages: found });
  }

  /** Typed in the page or in the inspector, or the name the server knows after a failed save. */
  rename(id: number, title: string, origin: 'page' | 'inspector' | 'server'): void {
    const page = this.pages.get(id);

    if (!page) {
      return;
    }

    if (origin !== 'server') {
      this.queue.change(id, 'title', title);
    }

    if (origin !== 'page') {
      this.options.post({ type: 'cbe:page-title', id, title });
    }

    if (this.shown?.id === id && this.shown.input && this.shown.input.value !== title) {
      this.shown.input.value = title;
    }
  }

  settle(): Promise<void> {
    return this.queue.settle();
  }

  flush(keepalive: boolean): void {
    this.queue.flush(keepalive);
  }

  forget(): void {
    this.shown = null;
  }

  render(container: HTMLElement, id: number): void {
    const page = this.pages.get(id);

    if (!page) {
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = 'Seite';

    const field = document.createElement('div');
    field.className = 'cbe-field';

    const label = document.createElement('label');
    label.htmlFor = 'cbe-page-title';
    label.textContent = page.label;

    const input = document.createElement('input');
    input.id = 'cbe-page-title';
    input.type = 'text';
    input.value = page.title;
    input.readOnly = !page.editable;
    input.addEventListener('input', () => this.rename(id, input.value, 'inspector'));

    const hint = document.createElement('p');
    hint.className = 'cbe-description';
    hint.textContent = page.editable ? 'Auch direkt im Menü änderbar.' : 'Diesen Namen darfst du nicht ändern.';

    field.append(label, input, hint);

    const details = document.createElement('dl');
    details.className = 'cbe-page-details';

    for (const { label: name, value } of page.details) {
      const term = document.createElement('dt');
      term.textContent = name;

      const description = document.createElement('dd');
      description.textContent = value;

      details.append(term, description);
    }

    container.append(heading, field, details);

    const href = this.hrefs.get(id);

    if (href) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'cbe-button';
      open.textContent = 'Seite öffnen';
      open.addEventListener('click', () => this.options.open(href));
      container.append(open);
    }

    const classic = document.createElement('a');
    classic.className = 'cbe-link';
    classic.href = page.classicUrl;
    classic.textContent = 'Im klassischen Backend bearbeiten';
    container.append(classic);

    this.shown = { id, input };
  }
}

export function setupNavPages(options: NavPagesOptions): NavPages {
  return new NavPages(options);
}
