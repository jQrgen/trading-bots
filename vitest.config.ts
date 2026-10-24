import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    { name: "md-as-text", transform: (code, id) => (id.endsWith(".md") ? `export default ${JSON.stringify(code)};` : undefined) },
    {
      // lp.ts reaches the worker-only socket import through live.ts. Tests never connect.
      name: "cf-sockets-stub",
      resolveId: (id) => (id === "cloudflare:sockets" ? "\0cloudflare:sockets" : undefined),
      load: (id) => (id === "\0cloudflare:sockets" ? "export function connect() { throw new Error('cloudflare:sockets is workers-only'); }" : undefined),
    },
  ],
});
