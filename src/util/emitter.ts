/** Minimal typed event emitter with unsubscribe handles and error isolation. */
export class Emitter<T extends Record<string, unknown>> {
  private handlers = new Map<keyof T, Set<(payload: never) => void>>();

  on<K extends keyof T>(event: K, handler: (payload: T[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    const h = handler as (payload: never) => void;
    set.add(h);
    return () => set.delete(h);
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) {
      try {
        (h as (p: T[K]) => void)(payload);
      } catch {
        /* a failing listener must never break the emitter */
      }
    }
  }
}
