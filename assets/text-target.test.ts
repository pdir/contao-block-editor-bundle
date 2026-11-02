// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { findByText } from './text-target';

describe('findByText', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.innerHTML = `
      <p class="kicker">  Über   uns </p>
      <h2><span class="first">Mehr als ein</span> <span class="main">Theme Shop.</span></h2>
      <h3>Nur <b>ein</b> Teil</h3>
      <span aria-hidden="true">6</span>`;
  });

  it('finds one of several fields inside of a heading', () => {
    expect(findByText(root, 'Theme Shop.')?.className).toBe('main');
    expect(findByText(root, 'Mehr als ein')?.className).toBe('first');
  });

  it('compares without regard to the white space of the template', () => {
    expect(findByText(root, 'Über uns')?.className).toBe('kicker');
  });

  it('finds the element around all of its children', () => {
    expect(findByText(root, 'Nur ein Teil')?.tagName).toBe('H3');
  });

  it('does not take a part of a text', () => {
    expect(findByText(root, 'Mehr als')).toBeNull();
  });

  it('ignores empty values and hidden helpers', () => {
    expect(findByText(root, '  ')).toBeNull();
    expect(findByText(root, '6')).toBeNull();
  });

  it('leaves out what is not accepted', () => {
    expect(findByText(root, 'Theme Shop.', (element) => !element.matches('.main'))).toBeNull();
  });
});
