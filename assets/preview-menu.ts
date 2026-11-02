// The functions of Contao's preview toolbar, which the editor hides in the page: copy and share
// the address, view the page as a member and show unpublished elements. Contao's own endpoint
// applies the changes, so its permission checks stay in force.
import { FRAME_PARAMETER, publicUrl, type FramePaths } from './navigation';

export interface PreviewMenuOptions {
  token: string;
  paths: FramePaths;
  /** The address of the page in the frame, null while none is loaded. */
  frameHref: () => string | null;
  /** Shows the page again once the preview shows it differently. */
  reload: () => void;
  frame: HTMLIFrameElement;
}

const MEMBER_LOOKUP_DELAY = 300;

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Without the Clipboard API, e.g. in older browsers
    const input = document.createElement('textarea');
    input.value = text;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

/**
 * Loaded on the first click on its button, which the shell hands over. Returns the function
 * that opens and closes the menu.
 */
export function setupPreviewMenu(toggle: HTMLButtonElement, menu: HTMLFormElement, { token, paths, frameHref, reload, frame }: PreviewMenuOptions): (open: boolean) => void {
  const member = menu.querySelector<HTMLInputElement>('[name="user"]');
  const members = menu.querySelector<HTMLDataListElement>('datalist');
  const unpublished = menu.querySelector<HTMLInputElement>('[name="unpublished"]') as HTMLInputElement;
  const message = menu.querySelector('.cbe-preview__message') as HTMLElement;
  const { switch: switchUrl, share: shareUrl } = menu.dataset;
  let lookup: ReturnType<typeof setTimeout> | undefined;
  let applied = member?.value ?? '';

  const say = (text: string, isError = false): void => {
    message.textContent = text;
    message.classList.toggle('is-error', isError);
  };

  const show = (open: boolean): void => {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));

    if (open) {
      say('');
    }
  };

  const post = (body: Record<string, string>): Promise<Response> =>
    fetch(switchUrl as string, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ REQUEST_TOKEN: token, ...body }),
    });

  /** The page without the editor's marker, as the preview shows it. */
  const previewHref = (): string | null => {
    const href = frameHref();

    if (!href) {
      return null;
    }

    const url = new URL(href);
    url.searchParams.delete(FRAME_PARAMETER);

    return url.href;
  };

  async function apply(): Promise<void> {
    const body: Record<string, string> = { FORM_SUBMIT: 'tl_switch', unpublished: unpublished.checked ? 'show' : 'hide' };

    if (member) {
      body.user = member.value.trim();
      member.removeAttribute('aria-invalid');
    }

    say('Wird angewendet …');

    try {
      const response = await post(body);

      if (response.status === 422 && member) {
        say((await response.text()) || 'Dieses Mitglied gibt es nicht.', true);
        member.setAttribute('aria-invalid', 'true');
        member.focus();

        return;
      }

      if (!response.ok) {
        throw new Error(String(response.status));
      }
    } catch {
      say('Die Vorschau konnte nicht umgestellt werden.', true);

      return;
    }

    applied = member?.value.trim() ?? '';
    toggle.toggleAttribute('data-active', applied !== '' || unpublished.checked);
    say('Angewendet.');
    reload();
  }

  toggle.addEventListener('click', () => show(Boolean(menu.hidden)));

  menu.addEventListener('submit', (event) => {
    event.preventDefault();
    void apply();
  });

  unpublished.addEventListener('change', () => void apply());

  menu.querySelector('[data-preview-copy]')?.addEventListener('click', () => {
    const href = frameHref();
    const url = href ? publicUrl(href, window.location.origin, paths) : null;

    if (url) {
      void copyText(url).then(() => say('Die Adresse ist kopiert.'));
    }
  });

  menu.querySelector('[data-preview-share]')?.addEventListener('click', () => {
    const href = previewHref();

    if (shareUrl && href) {
      // Like the toolbar: the back end asks for the details of the link in a new tab
      window.open(`${shareUrl}&showUnpublished=${unpublished.checked ? 1 : ''}&url=${encodeURIComponent(href)}`, '_blank', 'noopener');
    }
  });

  member?.addEventListener('input', () => {
    member.removeAttribute('aria-invalid');
    clearTimeout(lookup);

    if (!members || member.value.trim().length < 2) {
      return;
    }

    lookup = setTimeout(async () => {
      try {
        const response = await post({ FORM_SUBMIT: 'datalist_members', value: member.value.trim() });
        const names = (await response.json()) as unknown;

        members.replaceChildren(
          ...(Array.isArray(names) ? names : []).map((name) => {
            const option = document.createElement('option');
            option.value = String(name);

            return option;
          }),
        );
      } catch {
        // Typing the full name still works
      }
    }, MEMBER_LOOKUP_DELAY);
  });

  // Closes like a menu: Esc, a click elsewhere or into the page
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      if (member && member.value.trim() !== applied) {
        member.value = applied;
      }

      show(false);
      toggle.focus();
    }
  });

  document.addEventListener('pointerdown', ({ target }) => {
    if (!menu.hidden && target instanceof Node && !menu.contains(target) && !toggle.contains(target)) {
      show(false);
    }
  });

  window.addEventListener('blur', () => {
    if (document.activeElement === frame) {
      show(false);
    }
  });

  return show;
}
