"use client";

import Link from "next/link";
import { useSetupProgress } from "@/components/setup";
import { Badge, Card, PageHeader, Skeleton, cx } from "@/components/ui";

/** Checklist de configuração (cerca de 20 minutos), conferido automaticamente a partir dos dados reais da conta. */
export default function SetupPage() {
  const p = useSetupProgress();
  const pct = Math.round((p.requiredDone / p.requiredTotal) * 100);
  const remaining = p.steps.filter((s) => !s.optional && s.done !== true).reduce((a, s) => a + s.minutes, 0);
  return (
    <div className="space-y-4">
      <PageHeader title="Primeiros passos" description="Siga na ordem. Cada passo é marcado sozinho quando o sistema confirma que funcionou — nada de marcar à mão." />
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-sm text-muted">Passos essenciais</p>
            <p className="text-2xl font-semibold tabular">
              {p.requiredDone}/{p.requiredTotal}
            </p>
          </div>
          <p className="text-sm text-muted">{p.requiredDone >= p.requiredTotal ? "Tudo pronto. Os opcionais deixam a operação ainda mais completa." : `Tempo estimado restante: ~${remaining} min`}</p>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progresso da configuração">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </Card>
      {p.loading ? (
        <Skeleton className="h-64" />
      ) : (
        <ol className="space-y-3">
          {p.steps.map((s, i) => (
            <li key={s.key} className={cx("flex flex-wrap items-start gap-3 rounded-lg border bg-surface p-4", s.done ? "border-ok/60" : "border-border")}>
              <span
                className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold", s.done ? "border-ok bg-ok text-white" : "border-border text-muted")}
                aria-hidden
              >
                {s.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {s.title} {s.optional && <Badge>opcional</Badge>} {s.done && <Badge tone="ok">concluído</Badge>}
                  {s.done === null && <Badge title="Sem permissão para verificar ou dado indisponível">não verificável</Badge>}
                </p>
                <p className="mt-1 text-sm text-muted">{s.description}</p>
                <p className="mt-1 text-xs text-muted">~{s.minutes} min</p>
              </div>
              {!s.done && (
                <Link href={s.href} className="shrink-0 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-contrast hover:opacity-90">
                  {s.cta}
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted">
        Guia completo de instalação no servidor e configuração em <code>docs/GUIA_RAPIDO.md</code>.
      </p>
    </div>
  );
}
