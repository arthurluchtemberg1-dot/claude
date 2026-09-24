# Fixtures de conectores

Separação exigida pela regra R03-03:

| Pasta/arquivo | Tipo | Procedência |
| --- | --- | --- |
| `lowify/documented-example.json` | **Exemplo documentado** | Copiado literalmente de `internal-webhook.md` (Lowify, "Documentation version: 1.0.0"), repositório público `github.com/lowify/docs`, commit `b25e43e`, consultado em 24/09/2026. Não é um payload real. |
| gerados nos testes (`*.test.ts`) | **Fixture sintética** | Variações construídas a partir do exemplo documentado para cobrir cenários (pendente, reembolso, bump, repetição). Não são payloads reais. |
| `*/real-anonymized/` | **Amostra real anonimizada** | Nenhuma disponível até o momento (dependência DEP-LOWIFY-SAMPLES). |
