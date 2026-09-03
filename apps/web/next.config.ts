import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // `standalone` = mały produkcyjny image: Next sam wybiera tylko te pliki
  // node_modules których naprawdę używa runtime (server.js + static + public).
  // Bez tego Docker image waży 1+ GB przez pełny pnpm-store wokół.
  // W trybie `next dev` ten flag jest ignorowany — działa tylko przy build.
  output: "standalone",
  // outputFileTracingRoot wskazuje root monorepo, żeby trace plików znalazł
  // workspace deps (@gatelynk/device-drivers) leżące w `packages/`. Bez tego
  // standalone tracuje tylko `apps/web/` i runtime ma ENOENT.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
