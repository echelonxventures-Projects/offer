/**
 * Telemetry port.
 *
 * Deliberately not an OpenTelemetry, Prometheus or StatsD client. Those are
 * transports, and binding the platform to one would undo the agnosticism the
 * rest of the design pays for. This is four methods; an adapter for any backend
 * is a short file, and `NoopTelemetry` means instrumentation costs nothing when
 * nobody is collecting.
 *
 * Emission is synchronous and fire-and-forget. A telemetry call must never fail
 * a decision, so implementations swallow their own errors - a metrics outage is
 * not an incident in the platform.
 */

export type Labels = Readonly<Record<string, string>>;

export interface TelemetryEvent {
  /** Dotted event name, from `METRICS` where one exists. */
  readonly name: string;
  readonly severity: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly labels?: Labels;
  /** Structured payload. Must be JSON-safe; bigints are stringified by callers. */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface Telemetry {
  /** Monotonically increasing count. */
  count(metric: string, value?: number, labels?: Labels): void;
  /** A distribution: durations, sizes, candidate counts. */
  observe(metric: string, value: number, labels?: Labels): void;
  /** A point-in-time value that can go up or down. */
  gauge(metric: string, value: number, labels?: Labels): void;
  /** A discrete, describable occurrence. */
  event(event: TelemetryEvent): void;
  /** Start a timer; the returned function records the elapsed milliseconds. */
  timer(metric: string, labels?: Labels): () => void;
}

/** Monotonic milliseconds. Injectable so durations are testable. */
export interface Stopwatch {
  now(): number;
}

export const systemStopwatch: Stopwatch = { now: () => performance.now() };

/** A stopwatch that only moves when you move it. */
export function fixedStopwatch(start = 0): Stopwatch & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

export const noopTelemetry: Telemetry = {
  count: () => {},
  observe: () => {},
  gauge: () => {},
  event: () => {},
  timer: () => () => {},
};

/* ------------------------------------------------------------------ */

export interface Distribution {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /** Ascending samples, capped. Percentiles are computed from these. */
  readonly samples: readonly number[];
}

export interface MetricSnapshot {
  readonly metric: string;
  readonly labels: Labels;
  readonly kind: "counter" | "histogram" | "gauge";
  readonly value?: number;
  readonly distribution?: Distribution;
}

/**
 * In-memory collector. The reference implementation and what the tests assert
 * against.
 *
 * Samples are capped per series: an unbounded sample buffer in a metrics
 * collector is the classic way to turn observability into an outage.
 */
export class MemoryTelemetry implements Telemetry {
  readonly #counters = new Map<string, { metric: string; labels: Labels; value: number }>();
  readonly #gauges = new Map<string, { metric: string; labels: Labels; value: number }>();
  readonly #histograms = new Map<string, { metric: string; labels: Labels; samples: number[] }>();
  readonly #events: TelemetryEvent[] = [];
  readonly #stopwatch: Stopwatch;
  readonly #maxSamples: number;
  readonly #maxEvents: number;

  constructor(options: { stopwatch?: Stopwatch; maxSamples?: number; maxEvents?: number } = {}) {
    this.#stopwatch = options.stopwatch ?? systemStopwatch;
    this.#maxSamples = options.maxSamples ?? 1024;
    this.#maxEvents = options.maxEvents ?? 512;
  }

  count(metric: string, value = 1, labels: Labels = {}): void {
    const key = seriesKey(metric, labels);
    const existing = this.#counters.get(key);
    if (existing) existing.value += value;
    else this.#counters.set(key, { metric, labels, value });
  }

  observe(metric: string, value: number, labels: Labels = {}): void {
    const key = seriesKey(metric, labels);
    const existing = this.#histograms.get(key);
    if (existing) {
      existing.samples.push(value);
      if (existing.samples.length > this.#maxSamples) existing.samples.shift();
    } else {
      this.#histograms.set(key, { metric, labels, samples: [value] });
    }
  }

  gauge(metric: string, value: number, labels: Labels = {}): void {
    this.#gauges.set(seriesKey(metric, labels), { metric, labels, value });
  }

  event(event: TelemetryEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) this.#events.shift();
  }

  timer(metric: string, labels: Labels = {}): () => void {
    const started = this.#stopwatch.now();
    return () => this.observe(metric, this.#stopwatch.now() - started, labels);
  }

  /* ----------------------------- reading ----------------------------- */

  counter(metric: string, labels: Labels = {}): number {
    return this.#counters.get(seriesKey(metric, labels))?.value ?? 0;
  }

  /** Sum across every label combination for a metric. */
  counterTotal(metric: string): number {
    let total = 0;
    for (const series of this.#counters.values()) {
      if (series.metric === metric) total += series.value;
    }
    return total;
  }

  gaugeValue(metric: string, labels: Labels = {}): number | undefined {
    return this.#gauges.get(seriesKey(metric, labels))?.value;
  }

  distribution(metric: string, labels: Labels = {}): Distribution | undefined {
    const series = this.#histograms.get(seriesKey(metric, labels));
    if (!series || series.samples.length === 0) return undefined;
    const sorted = [...series.samples].sort((a, b) => a - b);
    return {
      count: sorted.length,
      sum: sorted.reduce((total, value) => total + value, 0),
      min: sorted[0] as number,
      max: sorted[sorted.length - 1] as number,
      samples: sorted,
    };
  }

  events(filter?: { severity?: TelemetryEvent["severity"]; name?: string }): TelemetryEvent[] {
    return this.#events.filter(
      (event) =>
        (filter?.severity === undefined || event.severity === filter.severity) &&
        (filter?.name === undefined || event.name === filter.name),
    );
  }

  /** Everything collected, for an exporter or a test assertion. */
  snapshot(): MetricSnapshot[] {
    const out: MetricSnapshot[] = [];
    for (const series of this.#counters.values()) {
      out.push({ metric: series.metric, labels: series.labels, kind: "counter", value: series.value });
    }
    for (const series of this.#gauges.values()) {
      out.push({ metric: series.metric, labels: series.labels, kind: "gauge", value: series.value });
    }
    for (const series of this.#histograms.values()) {
      const distribution = this.distribution(series.metric, series.labels);
      if (distribution) {
        out.push({ metric: series.metric, labels: series.labels, kind: "histogram", distribution });
      }
    }
    return out.sort(
      (a, b) => a.metric.localeCompare(b.metric) || seriesKey("", a.labels).localeCompare(seriesKey("", b.labels)),
    );
  }

  reset(): void {
    this.#counters.clear();
    this.#gauges.clear();
    this.#histograms.clear();
    this.#events.length = 0;
  }
}

/** Percentile from an ascending sample array, nearest-rank. */
export function percentile(distribution: Distribution, p: number): number {
  const samples = distribution.samples;
  if (samples.length === 0) return 0;
  const rank = Math.ceil((p / 100) * samples.length) - 1;
  return samples[Math.min(Math.max(rank, 0), samples.length - 1)] as number;
}

/** Fan out to several sinks: collect in memory and ship to a backend at once. */
export function multiTelemetry(...sinks: readonly Telemetry[]): Telemetry {
  return {
    count: (metric, value, labels) => {
      for (const sink of sinks) sink.count(metric, value, labels);
    },
    observe: (metric, value, labels) => {
      for (const sink of sinks) sink.observe(metric, value, labels);
    },
    gauge: (metric, value, labels) => {
      for (const sink of sinks) sink.gauge(metric, value, labels);
    },
    event: (event) => {
      for (const sink of sinks) sink.event(event);
    },
    timer: (metric, labels) => {
      const stops = sinks.map((sink) => sink.timer(metric, labels));
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

function seriesKey(metric: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`);
  return parts.length === 0 ? metric : `${metric}{${parts.join(",")}}`;
}
