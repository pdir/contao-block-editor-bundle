// Decides what happens with a link in the editor. A page is only ever loaded into the
// frame through the preview entry point and with the marker that starts the editor.

export const FRAME_PARAMETER = '_block_editor';

export interface FramePaths {
  /** The base path of the installation, empty if it runs in the web root. */
  base: string;
  /** The preview entry point including the base path, e.g. /preview.php. */
  preview: string;
}

/**
 * native: the browser handles it (mail, phone).
 * scroll: an anchor on this page. The browser must not follow it: because of a <base>
 * tag, it could point to the same page without the preview entry point and the marker.
 * open: leaves the website or is no page, so it gets its own tab.
 * page: another page of this website.
 * none: never followed, e.g. javascript: or data: URLs.
 */
export type LinkAction = 'native' | 'scroll' | 'open' | 'page' | 'none';

const PAGE_EXTENSION = /\.(html?|php)$/i;
const ANY_EXTENSION = /\.[a-z0-9]{1,8}$/i;

function isBelow(path: string, prefix: string): boolean {
  return prefix !== '' && (path === prefix || path.startsWith(`${prefix}/`));
}

/** The path of a page, no matter whether the link goes through the preview entry point. */
export function pagePath(pathname: string, { base, preview }: FramePaths): string {
  if (isBelow(pathname, preview)) {
    return pathname.slice(preview.length) || '/';
  }

  return isBelow(pathname, base) ? pathname.slice(base.length) || '/' : pathname;
}

function parse(href: string, current: string): URL | null {
  try {
    return new URL(href, current);
  } catch {
    return null;
  }
}

function searchWithoutMarker(url: URL): string {
  const search = new URLSearchParams(url.search);
  search.delete(FRAME_PARAMETER);

  return search.toString();
}

export function classifyLink(href: string, current: string, paths: FramePaths): LinkAction {
  const url = parse(href, current);
  const page = parse(current, current);

  if (!url || !page) {
    return 'none';
  }

  if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
    return 'native';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'none';
  }

  if (url.origin !== page.origin) {
    return 'open';
  }

  const path = pagePath(url.pathname, paths);
  const samePage = path === pagePath(page.pathname, paths) && searchWithoutMarker(url) === searchWithoutMarker(page);

  if (samePage && (url.hash !== '' || href.endsWith('#'))) {
    return 'scroll';
  }

  return ANY_EXTENSION.test(path) && !PAGE_EXTENSION.test(path) ? 'open' : 'page';
}

/**
 * The URL to load into the frame, or null if the target must not be opened in there.
 *
 * @param blocked Paths outside of the website's pages, such as the back end
 */
export function frameUrl(href: string, origin: string, paths: FramePaths, blocked: string[]): string | null {
  const url = parse(href, origin);

  if (!url || url.origin !== origin) {
    return null;
  }

  const path = pagePath(url.pathname, paths);

  if (blocked.some((prefix) => isBelow(path, pagePath(prefix, paths)))) {
    return null;
  }

  const target = new URL(origin);
  target.pathname = paths.preview + path;
  target.search = url.search;
  target.hash = url.hash;
  target.searchParams.set(FRAME_PARAMETER, '1');

  return target.href;
}

/** Whether a page was loaded in a way that starts the editor. */
export function isFrameUrl(href: string, { preview }: FramePaths): boolean {
  const url = parse(href, 'http://invalid');

  return !!url && isBelow(url.pathname, preview) && url.searchParams.get(FRAME_PARAMETER) === '1';
}

/** The same page as a visitor requests it: without the preview entry point and the marker. */
export function publicUrl(href: string, origin: string, paths: FramePaths): string | null {
  const url = parse(href, origin);

  if (!url || url.origin !== origin) {
    return null;
  }

  const target = new URL(origin);
  target.pathname = (paths.base + pagePath(url.pathname, paths)).replace(/^\/\//, '/');
  target.search = url.search;
  target.searchParams.delete(FRAME_PARAMETER);

  return target.href;
}

/** The address as it is shown to the user: without the preview entry point and the marker. */
export function linkLabel(href: string, origin: string, paths: FramePaths): string {
  const url = parse(href, origin);

  if (!url) {
    return href;
  }

  if (url.origin !== origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return url.protocol === 'mailto:' || url.protocol === 'tel:' ? url.pathname : href;
  }

  const search = searchWithoutMarker(url);

  return pagePath(url.pathname, paths) + (search ? `?${search}` : '') + url.hash;
}
