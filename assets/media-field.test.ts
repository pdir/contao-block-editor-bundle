// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { filePickerUrl, isImageField, mergeChoice, toFiles } from './media-field';

const config = { multiple: true, filesOnly: true, folders: false, extensions: ['jpg', 'png'], path: '', sortable: true };

describe('media field', () => {
  it('keeps the order of a gallery and adds new files last', () => {
    expect(mergeChoice(['a', 'b', 'c'], ['c', 'd', 'a'])).toEqual(['a', 'c', 'd']);
    expect(mergeChoice(['a'], [])).toEqual([]);
  });

  it('reads saved files and pending choices', () => {
    const saved = { uuid: 'u1', path: 'files/a.jpg', name: 'a.jpg', image: true, preview: '/assets/a.jpg' };

    expect(toFiles([saved])).toEqual([saved]);
    expect(toFiles('files/b.png')).toEqual([{ uuid: 'files/b.png', path: 'files/b.png', name: 'b.png', image: false, preview: null }]);
    expect(toFiles('')).toEqual([]);
    expect(toFiles(null)).toEqual([]);
  });

  it('speaks of images only if nothing else can be chosen', () => {
    expect(isImageField(config)).toBe(true);
    expect(isImageField({ ...config, extensions: ['jpg', 'pdf'] })).toBe(false);
    expect(isImageField({ ...config, extensions: [] })).toBe(false);
  });

  it('opens the picker with the restrictions of the field', () => {
    const url = new URL(filePickerUrl('/contao/_contao/picker', 5, config, ['u1', 'u2']));

    expect(url.searchParams.get('context')).toBe('file');
    expect(url.searchParams.get('extras[fieldType]')).toBe('checkbox');
    expect(url.searchParams.get('extras[extensions]')).toBe('jpg,png');
    expect(url.searchParams.get('extras[filesOnly]')).toBe('1');
    expect(url.searchParams.get('extras[source]')).toBe('tl_content.5');
    expect(url.searchParams.get('value')).toBe('u1,u2');
    expect(url.searchParams.has('extras[path]')).toBe(false);
  });
});
