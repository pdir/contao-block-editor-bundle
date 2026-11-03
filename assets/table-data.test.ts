import { describe, expect, it } from 'vitest';
import { cellHtml, cellText, insertColumn, insertRow, isPlainCell, matchRows, removeColumn, removeRow, setCell, toRows } from './table-data';

describe('table data', () => {
  const rows = [['A', 'B'], ['1', '2'], ['3', '4']];

  it('adds and removes rows and columns', () => {
    expect(insertRow(rows, 1)).toEqual([['A', 'B'], ['', ''], ['1', '2'], ['3', '4']]);
    expect(removeRow(rows, 0)).toEqual([['1', '2'], ['3', '4']]);
    expect(insertColumn(rows, 2)).toEqual([['A', 'B', ''], ['1', '2', ''], ['3', '4', '']]);
    expect(removeColumn(rows, 0)).toEqual([['B'], ['2'], ['4']]);
    expect(insertRow([], 0)).toEqual([['']]);
  });

  it('changes one cell without touching the others', () => {
    const changed = setCell(rows, 1, 1, 'x');

    expect(changed).toEqual([['A', 'B'], ['1', 'x'], ['3', '4']]);
    expect(rows[1][1]).toBe('2');
  });

  it('reads stored arrays with gaps as lists', () => {
    expect(toRows({ 0: { 0: 'a', 2: 'b' }, 3: ['c', 'd'] })).toEqual([['a', 'b'], ['c', 'd']]);
    expect(toRows(null)).toEqual([]);
  });

  it('turns cells into text and back', () => {
    expect(cellText('a &amp; b &lt;c&gt; &#8364; &#x41; &unknown;')).toBe('a & b <c> € A &unknown;');
    expect(cellHtml('a & b <c>\nd')).toBe('a &amp; b &lt;c&gt;\nd');
    expect(cellText(cellHtml('x < y & "z"'))).toBe('x < y & "z"');
  });

  it('only edits cells without markup in the page', () => {
    expect(isPlainCell('a &amp; b\nc')).toBe(true);
    expect(isPlainCell('a <strong>b</strong>')).toBe(false);
    expect(isPlainCell('a < b')).toBe(true);
  });

  it('finds sorted rows by their text', () => {
    expect(matchRows([['3', '4'], ['1', '2']], [['1', '2'], ['3', '4']])).toEqual([1, 0]);
    // Changed in the meantime: by position
    expect(matchRows([['9', '9'], ['1', '2']], [['1', '2'], ['3', '4']])).toEqual([1, 0]);
    expect(matchRows([['1', ' 2 ']], [['1', '2']])).toEqual([0]);
  });
});
