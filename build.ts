import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/mod.js";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11";

await esbuild.build({
  plugins: [...denoPlugins({
    configPath: new URL("./deno.json", import.meta.url).pathname,
  })],
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  target: "esnext",
  outfile: "dist/server.js",
  external: ["@bunny.net/edgescript-sdk"],
  minify: true,
  treeShaking: true,
});

console.log("Build complete: dist/server.js");
esbuild.stop();
