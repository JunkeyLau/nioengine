import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const buildTime = new Date().toISOString();

mkdirSync(dist, { recursive: true });

const html = readFileSync(join(src, "index.html"), "utf8");
const css = readFileSync(join(src, "styles.css"), "utf8");
const i18n = readFileSync(join(src, "i18n.js"), "utf8");
const app = readFileSync(join(src, "app.js"), "utf8");
const worklet = readFileSync(join(src, "worklet.js"), "utf8");

const inlineParts = [
  ["styles.css", css],
  ["i18n.js", i18n],
  ["app.js", app],
  ["worklet.js", worklet],
];

for (const [name, code] of inlineParts) {
  if (code.includes("</script")) {
    throw new Error(`${name} contains </script and cannot be inlined safely`);
  }
}

const output = html
  .replace("<!-- INLINE_STYLES -->", `<style>\n${css}\n</style>`)
  .replace("/*__WORKLET__*/", worklet)
  .replace("/*__I18N__*/", i18n)
  .replace("/*__APP__*/", app)
  .replace("__VERSION__", version)
  .replace("__BUILD_TIME__", buildTime);

writeFileSync(join(dist, "index.html"), output);
copyFileSync(join(src, "worklet.js"), join(dist, "worklet.js"));

const bytes = statSync(join(dist, "index.html")).size;
console.log(`Built dist/index.html (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`Copied dist/worklet.js (${(statSync(join(dist, "worklet.js")).size / 1024).toFixed(1)} KiB)`);
console.log(`Version ${version} · ${buildTime}`);
