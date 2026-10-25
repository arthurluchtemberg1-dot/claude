import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

/** Manifesto do PWA instalável (R35-01); nome e cores vêm da configuração de marca (R01-05). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/painel",
    name: BRAND.name,
    short_name: BRAND.name.slice(0, 12),
    description: BRAND.tagline,
    start_url: "/painel?origem=app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0f1216",
    theme_color: "#1d5fd1",
    lang: "pt-BR",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    shortcuts: [
      { name: "Vendas", url: "/vendas", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Notificações", url: "/notificacoes", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
