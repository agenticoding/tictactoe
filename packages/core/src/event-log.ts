import type { EventLog, InMemoryEventLog, StampedEvent } from './domain';

export type { EventLog, StampedEvent } from './domain';

/**
 * In-memory append-only log. Sequence numbers are strictly monotonic and
 * gapless starting at 0 (seq == its position), so the whole log is the replay
 * window and no persistence/trimming is needed.
 */
export const createInMemoryEventLog: InMemoryEventLog = () => {
  const events: StampedEvent[] = [];

  return {
    append(event) {
      const stamped: StampedEvent = { seq: events.length, event };
      events.push(stamped);
      return stamped;
    },
    fetchAfter(lastSeq) {
      // The array is already ascending, so filter preserves order.
      return events.filter((stamped) => stamped.seq > lastSeq);
    },
    latestSeq() {
      const last = events[events.length - 1];
      return last === undefined ? -1 : last.seq;
    },
  };
};
