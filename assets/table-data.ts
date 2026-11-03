// The cells of Contao's table element: rows of HTML strings, all rows equally long. The first
// row is the header and the last one the footer if the element says so.

export type Rows = string[][];

/** Whatever the record holds, as rows of strings. */
export function toRows(value: unknown): Rows {
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];

  return rows.map((row: unknown) => (Array.isArray(row) ? row : row && typeof row === 'object' ? Object.values(row) : [row]).map((cell) => (typeof cell === 'string' ? cell : String(cell ?? ''))));
}

export function insertRow(rows: Rows, at: number): Rows {
  return [...rows.slice(0, at), Array<string>(rows[0]?.length || 1).fill(''), ...rows.slice(at)];
}

export function removeRow(rows: Rows, at: number): Rows {
  return rows.filter((_, index) => index !== at);
}

export function insertColumn(rows: Rows, at: number): Rows {
  return rows.map((row) => [...row.slice(0, at), '', ...row.slice(at)]);
}

export function removeColumn(rows: Rows, at: number): Rows {
  return rows.map((row) => row.filter((_, index) => index !== at));
}

export function setCell(rows: Rows, row: number, column: number, html: string): Rows {
  return rows.map((cells, index) => (index === row ? cells.map((cell, place) => (place === column ? html : cell)) : cells));
}

/** Text without markup can be typed in the page. Cells with HTML keep it in the inspector. */
export function isPlainCell(html: string): boolean {
  return !/<[a-z/!]/i.test(html);
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** What a cell without markup shows. */
export function cellText(html: string): string {
  return html.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);

      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }

    return NAMED[name.toLowerCase()] ?? entity;
  });
}

/** Typed text as a cell: line breaks stay, the template turns them into <br>. */
export function cellHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** For finding a row of the page in the data: the visible text, whitespace collapsed. */
export function rowKey(cells: string[]): string {
  return cells.map((cell) => cell.replace(/\s+/g, ' ').trim()).join('\u0001');
}

/**
 * Which row of the data each body row of the page shows. Sorting in the browser changes the
 * order of the page, so rows are matched by their text, the others by their position.
 *
 * @param shown the text of the body rows in the page
 * @param data the text of the body rows in the data
 */
export function matchRows(shown: string[][], data: string[][]): number[] {
  const free = new Set(data.keys());
  const keys = data.map(rowKey);
  const result = shown.map((cells) => {
    const key = rowKey(cells);
    const found = [...free].find((index) => keys[index] === key);

    if (found !== undefined) {
      free.delete(found);
    }

    return found ?? -1;
  });

  return result.map((index, place) => {
    if (index >= 0) {
      return index;
    }

    const fallback = free.has(place) ? place : [...free][0] ?? place;
    free.delete(fallback);

    return fallback;
  });
}
