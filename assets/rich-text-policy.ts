// The rich-text editor only keeps what its schema knows. To never lose content
// silently, markup outside of that schema must not be opened inline at all.

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  P: [], BR: [], STRONG: [], B: [], EM: [], I: [], U: [], S: [], CODE: [], PRE: [],
  H1: [], H2: [], H3: [], H4: [], H5: [], H6: [],
  UL: [], OL: [], LI: [], BLOCKQUOTE: [], HR: [],
  A: ['href', 'target', 'rel', 'title'],
};

/** Parsed in an inert document: no scripts run and no resources load. */
export function canEditInline(html: string): boolean {
  const { head, body } = new DOMParser().parseFromString(html, 'text/html');

  // The parser moves leading <script>, <style> or <meta> tags into the head
  if (head.childElementCount > 0) {
    return false;
  }

  for (const element of Array.from(body.querySelectorAll('*'))) {
    const allowed = ALLOWED_ATTRIBUTES[element.tagName];

    if (!allowed) {
      return false;
    }

    for (const attribute of Array.from(element.attributes)) {
      if (!allowed.includes(attribute.name)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Links may be web, mail or phone URLs, relative paths or Contao insert tags.
 * Everything else, such as javascript: or data:, is refused. The server sanitizes
 * again on save; this check only keeps such links out of the editor.
 */
export function isSafeLink(url: string): boolean {
  // Browsers ignore control characters and whitespace when resolving a scheme
  const value = url.replace(/[\u0000- \u007f-\u009f]/g, '');

  // An insert tag must be the whole URL: it can resolve to an empty string, which
  // would turn "{{tag}}javascript:…" into an executable link.
  if (value.includes('{{')) {
    return /^\{\{[a-z0-9_]+(::[^{}]*)?\}\}$/i.test(value);
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);

  return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme[1].toLowerCase());
}
