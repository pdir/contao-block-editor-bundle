// The cells of a table or the items of a list in the inspector: the keyboard's way to them, and
// the only one for those with markup. Loaded with the first table or list.
import { cellText, insertColumn, insertRow, removeColumn, removeRow, setCell, toRows, type Rows } from './table-data';

export interface TableField {
  root: HTMLElement;
  /** Takes over what was typed in the page. */
  sync(value: unknown): void;
}

export interface TableFieldOptions {
  label: string;
  value: unknown;
  /** First and last row are the header and the footer of the table. */
  header: boolean;
  footer: boolean;
  /** One item per row, saved as a list of strings. */
  list?: boolean;
  /** Fixed columns with names, saved as a list of objects (a row wizard). */
  columns?: { name: string; label: string }[];
  change(value: Rows | string[] | Record<string, string>[]): void;
}

export function createTableField({ label, value, header, footer, list = false, columns, change }: TableFieldOptions): TableField {
  const fromValue = (input: unknown): Rows => (columns ? (Array.isArray(input) ? input : []).map((row: Record<string, unknown>) => columns.map(({ name }) => String(row?.[name] ?? ''))) : toRows(input));
  let rows = fromValue(value);
  let focused: [number, number] = [0, 0];

  const root = document.createElement('div');
  root.className = list || columns ? 'cbe-table-field cbe-table-field--fill' : 'cbe-table-field';

  const scroller = document.createElement('div');
  scroller.className = 'cbe-table-field__scroll';

  const grid = document.createElement('table');
  grid.className = 'cbe-table-field__grid';
  scroller.append(grid);

  const actions = document.createElement('div');
  actions.className = 'cbe-table-field__actions';

  const update = (next: Rows): void => {
    rows = next;
    change(list ? rows.map(([item]) => item ?? '') : columns ? rows.map((cells) => Object.fromEntries(columns.map(({ name }, c) => [name, cells[c] ?? '']))) : rows);
  };

  const render = (): void => {
    if (!rows.length) {
      rows = [Array<string>(columns?.length ?? 1).fill('')];
    }

    grid.replaceChildren(...rows.map((cells, r) => {
      const tr = document.createElement('tr');

      tr.classList.toggle('is-header', header && r === 0);
      tr.classList.toggle('is-footer', footer && r === rows.length - 1 && rows.length > 1);
      tr.append(...cells.map((cell, c) => {
        const td = document.createElement('td');
        const input = document.createElement('textarea');

        input.rows = 1;
        // As in the back end: entities are shown as their characters, tags as they are. Columns of a row wizard hold plain text.
        input.value = columns ? cell : cellText(cell);
        input.dataset.cell = `${r}:${c}`;
        input.setAttribute('aria-label', list ? `${label}: Eintrag ${r + 1}` : columns ? `${columns[c].label}, Eintrag ${r + 1}` : `${label}: Zeile ${r + 1}, Spalte ${c + 1}`);
        input.addEventListener('focus', () => { focused = [r, c]; });
        input.addEventListener('input', () => update(setCell(rows, r, c, input.value)));
        td.append(input);

        return td;
      }));

      return tr;
    }));

    if (columns) {
      const head = grid.createTHead().insertRow();

      for (const column of columns) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = column.label;
        head.append(th);
      }
    }
  };

  /** Changes the structure and puts the focus into the cell that takes the place. */
  const structure = (next: Rows, focus: [number, number]): void => {
    update(next);
    render();
    const [r, c] = [Math.min(focus[0], rows.length - 1), Math.min(focus[1], (rows[0]?.length ?? 1) - 1)];
    grid.querySelector<HTMLTextAreaElement>(`[data-cell="${r}:${c}"]`)?.focus();
  };

  const button = (text: string, run: () => void): HTMLButtonElement => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'cbe-button cbe-button--small';
    element.textContent = text;
    // The focused cell stays the reference
    element.addEventListener('pointerdown', (event) => event.preventDefault());
    element.addEventListener('click', run);

    return element;
  };

  const row = list || columns ? 'Eintrag' : 'Zeile';

  actions.append(
    button(`${row} darunter`, () => structure(insertRow(rows, focused[0] + 1), [focused[0] + 1, focused[1]])),
    button(`${row} löschen`, () => rows.length > 1 && structure(removeRow(rows, focused[0]), focused)),
  );

  if (!list && !columns) {
    actions.insertBefore(button('Spalte rechts', () => structure(insertColumn(rows, focused[1] + 1), [focused[0], focused[1] + 1])), actions.lastChild);
    actions.append(button('Spalte löschen', () => (rows[0]?.length ?? 0) > 1 && structure(removeColumn(rows, focused[1]), focused)));
  }

  root.append(scroller, actions);
  render();

  return {
    root,
    sync(next) {
      const fresh = fromValue(next);
      const sameShape = fresh.length === rows.length && fresh.every((cells, r) => cells.length === rows[r].length);

      rows = fresh;

      if (!sameShape) {
        render();

        return;
      }

      // Keep the focus and the caret: only other cells change
      for (const input of Array.from(grid.querySelectorAll<HTMLTextAreaElement>('textarea'))) {
        const [r, c] = (input.dataset.cell ?? '0:0').split(':').map(Number);

        const shown = columns ? rows[r][c] : cellText(rows[r][c]);

        if (input !== document.activeElement && input.value !== shown) {
          input.value = shown;
        }
      }
    },
  };
}
