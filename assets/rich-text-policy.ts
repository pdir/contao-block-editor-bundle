// The rich-text editor only keeps what its schema knows. To never lose content
// silently, markup outside of that schema must not be opened inline at all.

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  P: [], BR: [], STRONG: [], B: [], EM: [], I: [], U: [], S: [], CODE: [], PRE: [],
  H1: [], H2: [], H3: [], H4: [], H5: [], H6: [],
  UL: [], OL: [], LI: [], BLOCKQUOTE: [], HR: [],
  A: ['href', 'target', 'rel', 'title'],
};

/** Markup that extensions of other bundles write, see rich-text.ts. */
function extraAttributes(tag: string): string[] | undefined {
  const addons = typeof window === 'undefined' ? undefined : (window as { contaoBlockEditorExtensions?: { allow?: Record<string, string[]> }[] }).contaoBlockEditorExtensions;
  const allowed = Array.isArray(addons) ? addons.flatMap((addon) => {
    const attributes = addon?.allow?.[tag] ?? addon?.allow?.[tag.toLowerCase()];

    return Array.isArray(attributes) ? [attributes.map(String)] : [];
  }) : [];

  return allowed.length ? allowed.flat() : undefined;
}

/** Parsed in an inert document: no scripts run and no resources load. */
export function canEditInline(html: string): boolean {
  const { head, body } = new DOMParser().parseFromString(html, 'text/html');

  // The parser moves leading <script>, <style> or <meta> tags into the head
  if (head.childElementCount > 0) {
    return false;
  }

  for (const element of Array.from(body.querySelectorAll('*'))) {
    const extra = extraAttributes(element.tagName);
    const allowed = ALLOWED_ATTRIBUTES[element.tagName] || extra ? [...(ALLOWED_ATTRIBUTES[element.tagName] ?? []), ...(extra ?? [])] : undefined;

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

/** What was typed as a link address. A bare domain would otherwise become a relative path. */
export function normalizeLinkInput(value: string): string {
  const href = value.trim();

  return /^www\./i.test(href) ? `https://${href}` : href;
}

/**
 * The editor wraps the text of every list item in a paragraph, unlike Contao's own editor.
 * Saved like that, a list would look different in the page, so single paragraphs go again.
 */
export function compactListItems(html: string): string {
  if (!html.includes('<li><p>')) {
    return html;
  }

  const { body } = new DOMParser().parseFromString(html, 'text/html');

  for (const item of Array.from(body.querySelectorAll('li'))) {
    const nodes = Array.from(item.childNodes).filter((node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim());

    if (nodes.length === 1 && nodes[0] instanceof HTMLParagraphElement) {
      nodes[0].replaceWith(...Array.from(nodes[0].childNodes));
    }
  }

  return body.innerHTML;
}

