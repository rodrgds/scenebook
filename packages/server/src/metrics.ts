function labelsKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/"/gu, '\\"');
}

interface MetricValue {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge';
  readonly labels: Readonly<Record<string, string>>;
  value: number;
}

export class MetricsRegistry {
  private readonly values = new Map<string, MetricValue>();

  increment(
    name: string,
    help: string,
    labels: Readonly<Record<string, string>> = {},
    amount = 1,
  ): void {
    this.mutate('counter', name, help, labels, amount);
  }

  gauge(
    name: string,
    help: string,
    value: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    this.mutate('gauge', name, help, labels, value, true);
  }

  private mutate(
    type: MetricValue['type'],
    name: string,
    help: string,
    labels: Readonly<Record<string, string>>,
    value: number,
    replace = false,
  ): void {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(name))
      throw new TypeError(`Invalid metric name: ${name}`);
    if (!Number.isFinite(value)) throw new TypeError('Metric values must be finite');
    const key = `${name}\u0000${labelsKey(labels)}`;
    const existing = this.values.get(key);
    if (existing) {
      if (existing.type !== type) throw new TypeError(`Metric ${name} changed type`);
      existing.value = replace ? value : existing.value + value;
      return;
    }
    this.values.set(key, { name, help, type, labels: { ...labels }, value });
  }

  render(): string {
    const groups = new Map<string, MetricValue[]>();
    for (const metric of this.values.values()) {
      const group = groups.get(metric.name) ?? [];
      group.push(metric);
      groups.set(metric.name, group);
    }
    const lines: string[] = [];
    for (const [name, metrics] of [...groups].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const first = metrics[0]!;
      lines.push(`# HELP ${name} ${first.help}`, `# TYPE ${name} ${first.type}`);
      for (const metric of metrics.sort((left, right) =>
        labelsKey(left.labels).localeCompare(labelsKey(right.labels)),
      )) {
        const entries = Object.entries(metric.labels).sort(([left], [right]) =>
          left.localeCompare(right),
        );
        const suffix = entries.length
          ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`
          : '';
        lines.push(`${metric.name}${suffix} ${metric.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
