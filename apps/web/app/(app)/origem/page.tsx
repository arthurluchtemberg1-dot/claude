"use client";

import { buildTrackedUrl, MACRO_CATALOGS, readUtms } from "@tracker/domain";
import { useMemo, useState } from "react";
import { Alert, Badge, Card, CopyButton, Field, Input, PageHeader, Select } from "@/components/ui";

const PRESETS: Record<string, Record<string, string>> = {
  meta_ids: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "{{campaign.name}}|{{campaign.id}}", utm_content: "{{ad.name}}|{{ad.id}}", utm_term: "{{adset.name}}|{{adset.id}}" },
  google: { utm_source: "google", utm_medium: "cpc", utm_campaign: "{campaignid}", utm_content: "{creative}", utm_term: "{keyword}" },
  tiktok: { utm_source: "tiktok", utm_medium: "paid_social", utm_campaign: "__CAMPAIGN_NAME__|__CAMPAIGN_ID__", utm_content: "__CID_NAME__|__CID__", utm_term: "__AID_NAME__|__AID__" },
  manual: { utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "", utm_term: "" },
};

export default function OriginPage() {
  const [base, setBase] = useState("https://sua-pagina.com.br/oferta?aff=123#topo");
  const [preset, setPreset] = useState("meta_ids");
  const [params, setParams] = useState<Record<string, string>>(PRESETS.meta_ids!);
  const [check, setCheck] = useState("");
  const result = useMemo(() => buildTrackedUrl({ baseUrl: base, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v || null])) }), [base, params]);
  const checked = useMemo(() => (check ? readUtms(check) : null), [check]);
  const network = preset === "meta_ids" ? "meta" : preset;
  const catalog = MACRO_CATALOGS.find((c) => c.network === network);

  return (
    <div className="space-y-4">
      <PageHeader title="Origem e UTMs" description="Gerador de URLs com UTMs e IDs estáveis. Preserva parâmetros existentes (afiliado, cupom), acentos e fragmentos; nunca sobrescreve parâmetros protegidos." />
      <Card title="Gerador de URL">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="md:col-span-2">
            <Field label="URL de destino">{(id) => <Input id={id} value={base} onChange={(e) => setBase(e.target.value)} />}</Field>
          </div>
          <Field label="Preset">
            {(id) => (
              <Select
                id={id}
                value={preset}
                onChange={(e) => {
                  setPreset(e.target.value);
                  setParams(PRESETS[e.target.value]!);
                }}
              >
                <option value="meta_ids">Meta Ads (nome|ID)</option>
                <option value="google">Google Ads (ValueTrack)</option>
                <option value="tiktok">TikTok Ads</option>
                <option value="manual">Manual</option>
              </Select>
            )}
          </Field>
          {Object.keys(params).map((k) => (
            <Field key={k} label={k}>
              {(id) => <Input id={id} value={params[k] ?? ""} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />}
            </Field>
          ))}
        </div>
        {catalog && (
          <p className="mt-2 text-xs text-muted">
            Macros de {catalog.network}: {catalog.macros.map((m) => m.token).join(", ")}{" "}
            {!catalog.verified && <Badge tone="warn">a verificar na documentação oficial</Badge>}
          </p>
        )}
        <div className="mt-4 space-y-2">
          <Field label="URL final">{(id) => <Input id={id} readOnly value={result.url ?? ""} className="font-mono" />}</Field>
          {result.url && <CopyButton value={result.url} label="Copiar URL" />}
          {result.issues.map((i, n) => (
            <Alert key={n} tone={i.severity === "error" ? "err" : "warn"} title={i.message} />
          ))}
        </div>
      </Card>
      <Card title="Validar URL recebida (placeholders e codificação)">
        <Field label="Cole a URL de uma visita ou link de anúncio">{(id) => <Input id={id} value={check} onChange={(e) => setCheck(e.target.value)} />}</Field>
        {checked && (
          <div className="mt-3 space-y-2 text-sm">
            <pre className="overflow-x-auto rounded bg-surface-2 p-2 text-xs">{JSON.stringify(checked.utms, null, 2)}</pre>
            {checked.issues.length === 0 ? <Alert tone="ok" title="Sem problemas detectados" /> : checked.issues.map((i, n) => <Alert key={n} tone={i.severity === "error" ? "err" : "warn"} title={i.message} />)}
          </div>
        )}
      </Card>
    </div>
  );
}
