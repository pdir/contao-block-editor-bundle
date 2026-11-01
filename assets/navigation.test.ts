import { describe, expect, it } from 'vitest';
import { classifyLink, frameUrl, pagePath } from './navigation';

const paths = { base: '', preview: '/preview.php' };
const nested = { base: '/sub', preview: '/sub/preview.php' };
const current = 'https://example.com/preview.php/start.html?_block_editor=1';
const blocked = ['/contao', '/_contao'];

describe('pagePath', () => {
  it.each([
    ['/preview.php/a.html', paths, '/a.html'],
    ['/preview.php', paths, '/'],
    ['/a.html', paths, '/a.html'],
    ['/preview.phpx/a.html', paths, '/preview.phpx/a.html'],
    ['/sub/preview.php/a.html', nested, '/a.html'],
    ['/sub/a.html', nested, '/a.html'],
    ['/subway.html', nested, '/subway.html'],
  ])('%s', (pathname, config, expected) => {
    expect(pagePath(pathname, config)).toBe(expected);
  });
});

describe('classifyLink', () => {
  it.each([
    ['/other.html', 'page'],
    ['/preview.php/other.html', 'page'],
    ['/alias-without-suffix', 'page'],
    ['/', 'page'],
    ['/start.html', 'page'],
    ['/start.html?page=2', 'page'],
    ['/start.html#part', 'scroll'],
    ['/preview.php/start.html?_block_editor=1#part', 'scroll'],
    ['#part', 'scroll'],
    ['#', 'scroll'],
    ['/other.html#part', 'page'],
    ['mailto:a@example.com', 'native'],
    ['tel:+49123', 'native'],
    ['https://other.example/', 'open'],
    ['//other.example/', 'open'],
    ['/files/manual.pdf', 'open'],
    ['javascript:alert(1)', 'none'],
    ['data:text/html,x', 'none'],
  ])('%s → %s', (href, expected) => {
    expect(classifyLink(href, current, paths)).toBe(expected);
  });
});

describe('frameUrl', () => {
  const origin = 'https://example.com';

  it('loads pages through the preview entry point, with the marker', () => {
    expect(frameUrl('https://example.com/a.html?x=1#y', origin, paths, blocked)).toBe('https://example.com/preview.php/a.html?x=1&_block_editor=1#y');
  });

  it('does not add the entry point or the marker twice', () => {
    expect(frameUrl('https://example.com/preview.php/a.html?_block_editor=1', origin, paths, blocked)).toBe('https://example.com/preview.php/a.html?_block_editor=1');
  });

  it('respects the base path', () => {
    expect(frameUrl('https://example.com/sub/a.html', origin, nested, ['/sub/contao'])).toBe('https://example.com/sub/preview.php/a.html?_block_editor=1');
    expect(frameUrl('https://example.com/sub/contao/login', origin, nested, ['/sub/contao'])).toBeNull();
  });

  it.each([
    'https://other.example/a.html',
    '//other.example/a.html',
    'javascript:alert(1)',
    'https://example.com/contao',
    'https://example.com/contao/login',
    'https://example.com/preview.php/contao/login',
    'https://example.com/a/../contao/login',
    'https://example.com/%2e%2e/contao/login',
    'https://example.com/_contao/logout',
  ])('refuses %s', (href) => {
    expect(frameUrl(href, origin, paths, blocked)).toBeNull();
  });

  it('keeps pages whose path only starts like a blocked one', () => {
    expect(frameUrl('https://example.com/contao-tipps.html', origin, paths, blocked)).toBe('https://example.com/preview.php/contao-tipps.html?_block_editor=1');
  });
});
