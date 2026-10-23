import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{ name: "md-as-text", transform: (code, id) => (id.endsWith(".md") ? `export default ${JSON.stringify(code)};` : undefined) }],
});
