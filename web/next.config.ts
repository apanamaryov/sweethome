import type { NextConfig } from "next";

const dev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // В проде — чистая статика для раздачи Express-демоном.
  // В dev нужен обычный dev-сервер + прокси API на демона (:3000).
  output: dev ? undefined : "export",
  ...(dev
    ? {
        async rewrites() {
          return [{ source: "/api/:path*", destination: "http://localhost:3000/api/:path*" }];
        },
      }
    : {}),
};

export default nextConfig;
