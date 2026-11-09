import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://milagre.dev",
  output: "static",
  trailingSlash: "ignore",
  // Inlined styles: the page is small, and separate stylesheets block its first paint.
  build: { format: "directory", inlineStylesheets: "always" },
});
