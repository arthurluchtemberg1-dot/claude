import type { NextConfig } from "next";

const apiInternal = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@tracker/domain"],
  poweredByHeader: false,
  // A API é servida sob o mesmo domínio do painel (/api/*): cookies de sessão first-party, sem CORS com credenciais.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiInternal}/:path*` },
      { source: "/sdk/:path*", destination: `${apiInternal}/sdk/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      // Service worker do PWA/Web Push: sempre revalidado, para que correções cheguem aos dispositivos instalados.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ];
  },
};

export default config;
