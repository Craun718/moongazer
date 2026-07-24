type Listener<T> = (value: T) => void;

export interface Emitter<T> {
  subscribe(listener: Listener<T>): () => void;
  emit(value: T): void;
  close(): void;
}

/**
 * Minimal zero-dependency emitter supporting multiple subscribers, so a run can
 * be observed by a logger, a store adapter, and telemetry simultaneously.
 */
export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<Listener<T>>();
  let closed = false;

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      if (closed) return;
      for (const listener of listeners) listener(value);
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}
