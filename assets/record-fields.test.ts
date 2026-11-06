// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToShell } from './protocol';
import { paragraphHtml, RecordFields, simpleParagraph } from './record-fields';

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
    fields = new RecordFields((node, scope) => { const element = node.closest('[data-be-id]'); return element !== null && scope.contains(element) && element !== scope; }, (message) => messages.push(message));
  });

  it('finds the headline that a theme splits into parts', () => {
    fields.apply('tl_news.1', '.mod_newsreader', [
      { name: 'headline', value: 'Themes installieren – Schritt für Schritt', editable: true },
      { name: 'subheadline', value: 'In wenigen Minuten', editable: false },
    ]);

    expect(document.querySelector('[data-cbe-field="headline"]')?.tagName).toBe('H1');
    expect(document.querySelector('[data-cbe-field="subheadline"]')?.className).toContain('lead');
    expect(document.querySelector('[data-cbe-field="subheadline"]')?.hasAttribute('data-cbe-editable')).toBe(false);
  });

  it('reports what is typed and only edits allowed fields', () => {
    fields.apply('tl_news.1', '.mod_newsreader', [
      { name: 'headline', value: 'Themes installieren – Schritt für Schritt', editable: true },
      { name: 'subheadline', value: 'In wenigen Minuten', editable: false },
    ]);

    const headline = document.querySelector('h1') as HTMLElement;
    fields.start(headline);
    headline.textContent = 'Neu';
    headline.dispatchEvent(new Event('input'));

    expect(messages).toEqual([{ type: 'cbe:record-select', key: 'tl_news.1' }, { type: 'cbe:record-change', key: 'tl_news.1', field: 'headline', value: 'Neu' }]);

    const lead = document.querySelector('.lead') as HTMLElement;
    fields.start(lead);

    expect(headline.hasAttribute('contenteditable')).toBe(false);
    expect(lead.hasAttribute('contenteditable')).toBe(false);
  });

  it('shows a text typed in the inspector', () => {
    fields.apply('tl_news.1', '.mod_newsreader', [{ name: 'subheadline', value: 'In wenigen Minuten', editable: true }]);
    fields.setValue('tl_news.1', 'subheadline', 'Schnell');

    expect(document.querySelector('.lead')?.textContent).toBe('Schnell');
    expect(document.querySelector('[data-be-id] p')?.textContent).toBe('In wenigen Minuten');
  });

  it('edits the news of a list inside of a content element, each on its own', () => {
    document.body.innerHTML = `
      <div data-be-id="9" class="mod_newslist">
        <div class="layout_latest cbe-news-1"><h2><a href="/a">Erste</a></h2><div class="ce_text"><p>Kurz &amp; gut</p></div></div>
        <div class="layout_latest cbe-news-2"><h2><a href="/b">Zweite</a></h2><div class="ce_text"><p>Eins</p><p>Zwei</p></div></div>
      </div>`;

    fields.apply('tl_news.1', '.cbe-news-1', [
      { name: 'headline', value: 'Erste', editable: true },
      { name: 'teaser', value: '<p>Kurz &amp; gut</p>', editable: true, rich: true },
    ]);
    fields.apply('tl_news.2', '.cbe-news-2', [
      { name: 'headline', value: 'Zweite', editable: true },
      { name: 'teaser', value: '<p>Eins</p>\n<p>Zwei</p>', editable: true, rich: true },
    ]);

    const first = document.querySelector('.cbe-news-1 p') as HTMLElement;
    const second = document.querySelector('.cbe-news-2 .ce_text') as HTMLElement;

    expect(document.querySelector('.cbe-news-2 a')?.getAttribute('data-cbe-record-key')).toBe('tl_news.2');
    expect(first.hasAttribute('data-cbe-editable')).toBe(true);
    // Several paragraphs keep their markup: only the inspector changes them
    expect(second.getAttribute('data-cbe-field')).toBe('teaser');
    expect(second.hasAttribute('data-cbe-editable')).toBe(false);

    fields.start(first);
    first.textContent = 'Kurz & <gut>';
    first.dispatchEvent(new Event('input'));

    expect(messages.at(-1)).toEqual({ type: 'cbe:record-change', key: 'tl_news.1', field: 'teaser', value: '<p>Kurz &amp; &lt;gut&gt;</p>' });

    fields.end();
    fields.setValue('tl_news.1', 'teaser', '<p><strong>Fett</strong></p>');

    expect(first.textContent).toBe('Kurz & <gut>');
    expect(first.hasAttribute('data-cbe-editable')).toBe(false);
  });

  it('takes only a paragraph without markup as plain text', () => {
    expect(simpleParagraph('<p>A &amp; B</p>')).toBe('A & B');
    expect(simpleParagraph('<p>A <em>B</em></p>')).toBeNull();
    expect(paragraphHtml('A & B')).toBe('<p>A &amp; B</p>');
  });
});
