function normalized(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The innermost element showing exactly this text. Templates arrange plain fields freely,
 * for example two fields in one heading, so the text is the only thing they all share.
 */
export function findByText(scope: HTMLElement, text: string, accepts: (element: HTMLElement) => boolean = () => true): HTMLElement | null {
  const wanted = normalized(text);

  if (!wanted) {
    return null;
  }

  const candidates = [scope, ...Array.from(scope.querySelectorAll<HTMLElement>('*'))];
  const isMatch = (element: HTMLElement): boolean => normalized(element.textContent) === wanted && !element.matches('script, style, [aria-hidden="true"]') && accepts(element);

  return candidates.find((element) => isMatch(element) && !Array.from(element.children).some((child) => isMatch(child as HTMLElement))) ?? null;
}

/** Unknown to every theme, so no rule for spans or other tags changes how the text looks. */
export const TEXT_RUN_TAG = 'cbe-text';

/**
 * A field that a template writes as bare text beside other markup, for example a headline
 * followed by a span with its highlighted part. Without a tag of its own it could not be
 * edited, so the text gets a neutral one. The spaces around it stay where they are.
 */
export function wrapTextRun(scope: HTMLElement, text: string, accepts: (element: HTMLElement) => boolean = () => true): HTMLElement | null {
  const wanted = normalized(text);

  if (!wanted) {
    return null;
  }

  const walker = scope.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;

    if (!parent || normalized(node.data) !== wanted || parent.matches(`script, style, [aria-hidden="true"], ${TEXT_RUN_TAG}`) || !accepts(parent)) {
      continue;
    }

    const leading = node.data.length - node.data.trimStart().length;
    const core = node.splitText(leading);
    core.splitText(core.data.trimEnd().length);

    const wrapper = scope.ownerDocument.createElement(TEXT_RUN_TAG);
    core.replaceWith(wrapper);
    wrapper.append(core);

    return wrapper;
  }

  return null;
}
