import esbuild from "esbuild";
import { copyFile } from "node:fs/promises";

await esbuild.build({
  entryPoints: ["src/main.js"], bundle: true, external: ["obsidian"],
  format: "cjs", platform: "browser", target: "chrome110",
  outfile: "main.js", logLevel: "info"
});
await copyFile("src/styles.css", "styles.css");
