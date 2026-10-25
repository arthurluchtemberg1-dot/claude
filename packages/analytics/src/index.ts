/**
 * Leitura de agregados para métricas e detalhamentos (resumo, campanhas, regras e Gestor IA): mesma consulta para
 * a API e o worker, com as fórmulas do pacote de domínio. Só somas/contagens com filtros explícitos aqui.
 */
export * from "./metrics-repo";
export * from "./breakdown";
export * from "./rules";
export * from "./meta-store";
export * from "./media-actions";
