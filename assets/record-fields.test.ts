// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToShell } from './protocol';
import { RecordFields } from './record-fields';

describe('RecordFields', () => {
  let messages: ToShell[];
  let fields: RecordFields;

  beforeEach(() => {
    document.body.innerHTML = `
      <div class="mod_newsreader">
        <header>
          <h1><span class="accent">Themes installieren</span> – Schritt für Schritt</h1>
          <p class="lead">In wenigen Minuten</p>
        </header>
        <div data-be-id="5"><p>In wenigen Minuten</p></div>
      </div>`;
    messages = [];
    fields = new RecordFields((node) => node.closest('[data-be-id]') !== null, (message) => messages.push(message));
  });

  it('finds the headline that a theme splits into parts', () => {
    fields.apply('.mod_newsreader', [
      { name: 'headline', value: 'Themes installieren – Schritt für Schritt', editable: true },
      { name: 'subheadline', value: 'In wenigen Minuten', editable: false },
    ]);

    expect(document.querySelector('[data-cbe-field="headline"]')?.tagName).toBe('H1');
    expect(document.querySelector('[data-cbe-field="subheadline"]')?.className).toContain('lead');
    expect(document.querySelector('[data-cbe-field="subheadline"]')?.hasAttribute('data-cbe-editable')).toBe(false);
  });

  it('reports what is typed and only edits allowed fields', () => {
    fields.apply('.mod_newsreader', [
      { name: 'headline', value: 'Themes installieren – Schritt für Schritt', editable: true },
      { name: 'subheadline', value: 'In wenigen Minuten', editable: false },
    ]);

    const headline = document.querySelector('h1') as HTMLElement;
    fields.start(headline);
    headline.textContent = 'Neu';
    headline.dispatchEvent(new Event('input'));

    expect(messages).toEqual([{ type: 'cbe:record-select' }, { type: 'cbe:record-change', field: 'headline', value: 'Neu' }]);

    const lead = document.querySelector('.lead') as HTMLElement;
    fields.start(lead);

    expect(headline.hasAttribute('contenteditable')).toBe(false);
    expect(lead.hasAttribute('contenteditable')).toBe(false);
  });

  it('shows a text typed in the inspector', () => {
    fields.apply('.mod_newsreader', [{ name: 'subheadline', value: 'In wenigen Minuten', editable: true }]);
    fields.setValue('subheadline', 'Schnell');

    expect(document.querySelector('.lead')?.textContent).toBe('Schnell');
    expect(document.querySelector('[data-be-id] p')?.textContent).toBe('In wenigen Minuten');
  });
});
