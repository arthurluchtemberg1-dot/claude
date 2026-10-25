/* Service worker do painel (R34-01, R35-01): exibe Web Push e abre o link ao clicar.
 * Não guarda dados de vendas em cache: o conteúdo do push já vem sem dados pessoais (R34-04) e o painel
 * sempre busca dados atuais da API. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Tracker", body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 120) : "Nova notificação";
  const link = typeof data.link === "string" && data.link.startsWith("/") ? data.link : "/notificacoes";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body.slice(0, 300) : "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: false,
      data: { link, id: data.id },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/notificacoes";
  const target = new URL(link, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          w.navigate(target).catch(() => undefined);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

// Rede sempre: o painel exige dados atuais. Sem conexão, mostra uma página simples e datada pelo próprio navegador.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sem conexão</title>' +
            '<body style="font-family:system-ui;padding:24px;background:#0f1216;color:#e6e9ee"><h1>Sem conexão</h1>' +
            "<p>O painel precisa de internet para mostrar vendas e métricas atuais. Nenhuma ação é executada sem conexão.</p>" +
            '<p><a style="color:#7aa7ff" href="/painel">Tentar novamente</a></p></body>',
          { headers: { "content-type": "text/html; charset=utf-8" }, status: 503 },
        ),
    ),
  );
});
