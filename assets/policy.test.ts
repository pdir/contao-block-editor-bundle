// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { canEditInline, isSafeLink } from './rich-text-policy';
import { SaveError, SaveQueue } from './save-queue';

describe('canEditInline', () => {
  it.each(['<p>Text <strong>fett</strong></p>', '<ul><li>a</li></ul>', '<p><a href="{{link_url::1}}">x</a></p>', 'nur Text'])('accepts %s', (html) => {
    expect(canEditInline(html)).toBe(true);
  });

  it.each(['<table><tr><td>x</td></tr></table>', '<p class="intro">x</p>', '<img src="a.jpg">', '<p style="color:red">x</p>', '<script>alert(1)</script>', '<a href="x" onclick="y">z</a>'])('refuses %s, as it would be lost', (html) => {
    expect(canEditInline(html)).toBe(false);
  });
});

describe('isSafeLink', () => {
  it.each(['https://contao.org', 'mailto:a@b.de', 'tel:+49', '/seite.html', '#top', '{{link_url::12}}', 'seite.html'])('accepts %s', (url) => {
    expect(isSafeLink(url)).toBe(true);
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'vbscript:x', '{{x}}javascript:alert(1)'])('refuses %j', (url) => {
    expect(isSafeLink(url)).toBe(false);
  });
});

describe('SaveQueue', () => {
  const setup = (send: ReturnType<typeof vi.fn>) => {
    const events = { onStateChange: vi.fn(), onSaved: vi.fn(), onFailed: vi.fn() };
    const queue = new SaveQueue(send as never, events, 10);
    queue.track(1, 'r1');

    return { queue, events };
  };

  it('coalesces changes and uses the new revision for the next save', async () => {
    const send = vi.fn().mockResolvedValueOnce({ revision: 'r2', values: {} }).mockResolvedValue({ revision: 'r3', values: {} });
    const { queue } = setup(send);

    queue.change(1, 'text', 'a');
    queue.change(1, 'text', 'ab');
    queue.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(1, 'r1', { text: 'ab' }, false);

    await vi.waitFor(() => expect(queue.pending).toBe(false));
    queue.change(1, 'text', 'abc');
    queue.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1]).toBe('r2');
  });

  it('never runs two requests for one element at once', async () => {
    let release: (value: unknown) => void = () => {};
    const send = vi.fn().mockReturnValueOnce(new Promise((resolve) => { release = resolve; })).mockResolvedValue({ revision: 'r3', values: {} });
    const { queue } = setup(send);

    queue.change(1, 'text', 'a');
    queue.flush();
    queue.change(1, 'text', 'ab');
    queue.flush();
    expect(send).toHaveBeenCalledTimes(1);

    release({ revision: 'r2', values: {} });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1].slice(1, 3)).toEqual(['r2', { text: 'ab' }]);
  });

  it('reports a rejected save, so that the UI can roll back', async () => {
    const error = new SaveError('Konflikt', 409);
    const { queue, events } = setup(vi.fn().mockRejectedValue(error));

    queue.change(1, 'text', 'a');
    queue.flush();
    await vi.waitFor(() => expect(events.onFailed).toHaveBeenCalledWith(1, { text: 'a' }, error));
    expect(queue.pending).toBe(false);
  });
});
