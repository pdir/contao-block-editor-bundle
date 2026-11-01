// Debounced, per-element saving. Requests for one element never overlap, because
// each save depends on the revision returned by the previous one.

export interface SaveResult {
  revision: string;
  values: Record<string, unknown>;
  /** Labels of fields that callbacks changed although they were not sent. */
  sideEffects?: string[];
}

export class SaveError extends Error {
  constructor(message: string, readonly status: number, readonly errors: Record<string, string> = {}) {
    super(message);
  }
}

export type Send = (id: number, revision: string, values: Record<string, unknown>, keepalive: boolean) => Promise<SaveResult>;

export interface QueueEvents {
  onStateChange(pending: boolean): void;
  onSaved(id: number, values: Record<string, unknown>, sent: Record<string, unknown>, sideEffects: string[]): void;
  onFailed(id: number, sent: Record<string, unknown>, error: SaveError): void;
}

interface Entry {
  revision: string;
  dirty: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
}

export class SaveQueue {
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly send: Send, private readonly events: QueueEvents, private readonly delay = 600) {}

  track(id: number, revision: string): void {
    this.entries.set(id, { revision, dirty: {}, timer: null, inFlight: false });
  }

  change(id: number, field: string, value: unknown): void {
    const entry = this.entries.get(id);

    if (!entry) {
      return;
    }

    entry.dirty[field] = value;
    this.schedule(id, entry);
    this.events.onStateChange(true);
  }

  /** Saves everything right away, e.g. on blur. */
  flush(keepalive = false): void {
    for (const [id, entry] of this.entries) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }

      void this.run(id, entry, keepalive);
    }
  }

  get pending(): boolean {
    return [...this.entries.values()].some((entry) => entry.inFlight || Object.keys(entry.dirty).length > 0);
  }

  private schedule(id: number, entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.run(id, entry, false);
    }, this.delay);
  }

  private async run(id: number, entry: Entry, keepalive: boolean): Promise<void> {
    if (entry.inFlight || Object.keys(entry.dirty).length === 0) {
      return;
    }

    const sent = entry.dirty;
    entry.dirty = {};
    entry.inFlight = true;

    try {
      const result = await this.send(id, entry.revision, sent, keepalive);
      entry.revision = result.revision;
      this.events.onSaved(id, result.values, sent, result.sideEffects ?? []);
    } catch (error) {
      // Later edits are based on a state the server rejected, so they are dropped too
      entry.dirty = {};
      this.events.onFailed(id, sent, error instanceof SaveError ? error : new SaveError('Speichern fehlgeschlagen. Bitte die Verbindung prüfen.', 0));
    } finally {
      entry.inFlight = false;
    }

    if (Object.keys(entry.dirty).length > 0) {
      void this.run(id, entry, keepalive);
    }

    this.events.onStateChange(this.pending);
  }
}
