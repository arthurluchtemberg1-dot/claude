-- 0011 — Política de consentimento por projeto e sinais de navegador para publicidade (R13-18, R13-19, R17-06).

-- consent_policy.mode:
--   'require_explicit' (padrão): eventos só são armazenados com analytics=true; sinais de publicidade só com ads=true.
--   'analytics_legitimate_interest': analytics armazenado salvo negação explícita (exige justificativa registrada);
--      publicidade continua exigindo ads=true. Não existe opção de bypass global.
alter table public.projects add column settings jsonb not null default '{"consent_policy": {"mode": "require_explicit"}}';

-- Sinais para destinos de publicidade: somente quando capturados com consentimento de publicidade.
alter table public.sessions
  add column ads_consent boolean not null default false,
  add column client_ip inet,
  add column user_agent text check (char_length(user_agent) <= 512),
  add column fbp text check (char_length(fbp) <= 200),
  add column fbc text check (char_length(fbc) <= 500);
