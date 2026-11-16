import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://milagre.dev",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory", inlineStylesheets: "always" },
});
