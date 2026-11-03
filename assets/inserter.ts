// The choice of the type for a new element, in the groups of the back end. Only the types
// that the user may add in that place are listed. Loaded with the first new element.

interface TypeGroup {
  label: string;
  types: { type: string; label: string }[];
}

const LOAD_ERROR = 'Die Elementtypen konnten nicht geladen werden.';

/** Returns the function that opens the dialog and resolves with the chosen type, or null. */
export function setupInserter(dialog: HTMLDialogElement): (url: string) => Promise<string | null> {
  const search = dialog.querySelector('input') as HTMLInputElement;
  const list = dialog.querySelector('.cbe-inserter__list') as HTMLElement;
  const message = dialog.querySelector('.cbe-inserter__message') as HTMLElement;
  let loaded = false;
  let chosen: string | null = null;
  let done: (type: string | null) => void = () => {};

  const firstShown = (): HTMLButtonElement | null => list.querySelector('section:not([hidden]) button:not([hidden])');

  const filter = (): void => {
    const query = search.value.trim().toLowerCase();

    for (const group of list.querySelectorAll('section')) {
      let any = false;

      for (const button of group.querySelectorAll('button')) {
        const match = !query || `${button.textContent} ${button.dataset.type}`.toLowerCase().includes(query);
        button.hidden = !match;
        any ||= match;
      }

      group.hidden = !any;
    }

    if (loaded) {
      message.textContent = firstShown() ? '' : query ? 'Kein Element gefunden.' : 'Hier kann kein Element eingefügt werden.';
    }
  };

  search.addEventListener('input', filter);

  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      firstShown()?.click();
    }
  });

  list.addEventListener('click', ({ target }) => {
    const button = target instanceof Element ? target.closest<HTMLButtonElement>('button[data-type]') : null;

    if (button) {
      chosen = button.dataset.type ?? null;
      dialog.close();
    }
  });

  dialog.querySelector('[data-inserter-cancel]')?.addEventListener('click', () => dialog.close());

  // Also closed with Esc
  dialog.addEventListener('close', () => {
    done(chosen);
    done = () => {};
  });

  const render = (groups: TypeGroup[]): void => {
    list.replaceChildren(...groups.map(({ label, types }, index) => {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      const buttons = document.createElement('div');

      heading.id = `cbe-inserter-group-${index}`;
      heading.textContent = label;
      section.setAttribute('aria-labelledby', heading.id);

      buttons.append(...types.map(({ type, label: text }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.type = type;
        button.textContent = text;

        return button;
      }));

      section.append(heading, buttons);

      return section;
    }));
  };

  return (url) => {
    chosen = null;
    loaded = false;
    search.value = '';
    list.replaceChildren();
    message.textContent = 'Wird geladen …';
    dialog.showModal();

    const result = new Promise<string | null>((resolve) => {
      done = resolve;
    });

    fetch(url, { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { groups?: TypeGroup[]; error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? LOAD_ERROR);
        }

        loaded = true;
        render(data.groups ?? []);
        filter();
      })
      .catch((error: unknown) => {
        message.textContent = error instanceof Error && !(error instanceof TypeError) ? error.message : LOAD_ERROR;
      });

    return result;
  };
}
