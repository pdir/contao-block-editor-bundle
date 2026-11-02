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
