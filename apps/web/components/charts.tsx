"use client";

/**
 * Gráficos SVG leves e acessíveis (cada gráfico tem tabela equivalente para leitores de tela).
 * Séries sobrepostas são desenhadas lado a lado/linhas, nunca empilhadas como se fossem exclusivas (R23-08).
 */

export interface Series {
  label: string;
  color: string;
  values: number[];
}

export function BarLineChart({ labels, series, format, title }: { labels: string[]; series: Series[]; format: (v: number) => string; title: string }) {
  const w = 720;
  const h = 220;
  const pad = { l: 56, r: 12, t: 12, b: 28 };
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = Math.max(labels.length, 1);
  const bw = (w - pad.l - pad.r) / n;
  const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  return (
    <figure className="w-full">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} className="h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="3 3" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
              {format(t)}
            </text>
          </g>
        ))}
        {series.map((s, si) =>
          s.values.map((v, i) => {
            const gw = bw / (series.length + 1);
            const x = pad.l + i * bw + gw * (si + 0.5);
            return <rect key={`${si}-${i}`} x={x} y={y(v)} width={Math.max(gw - 2, 1)} height={Math.max(h - pad.b - y(v), 0)} fill={s.color} rx="2" />;
          }),
        )}
        {labels.map((l, i) =>
          n <= 16 || i % Math.ceil(n / 12) === 0 ? (
            <text key={l + i} x={pad.l + i * bw + bw / 2} y={h - 10} textAnchor="middle" fontSize="10" fill="var(--muted)">
              {l}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Rótulo</th>
            {series.map((s) => (
              <th key={s.label}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={l + i}>
              <td>{l}</td>
              {series.map((s) => (
                <td key={s.label}>{format(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function DistributionBar({ items, title }: { items: { label: string; value: number; color: string }[]; title: string }) {
  const total = items.reduce((a, i) => a + i.value, 0);
  if (!total) return <p className="text-sm text-muted">Sem dados no período.</p>;
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden rounded" role="img" aria-label={`${title}: ${items.map((i) => `${i.label} ${i.value}`).join(", ")}`}>
        {items.filter((i) => i.value > 0).map((i) => (
          <div key={i.label} style={{ width: `${(i.value / total) * 100}%`, background: i.color }} title={`${i.label}: ${i.value}`} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
        {items.map((i) => (
          <li key={i.label} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm" style={{ background: i.color }} aria-hidden />
            {i.label}: <span className="tabular text-text">{i.value}</span> ({Math.round((i.value / total) * 100)}%)
          </li>
        ))}
      </ul>
    </div>
  );
}
