const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const workerConfig = {
  entryPoints: ["src/indexing/indexWorker.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/indexWorker.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const wrkCtx = await esbuild.context(workerConfig);
    await Promise.all([extCtx.watch(), wrkCtx.watch()]);
    console.log("[watch] Build started...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(workerConfig),
    ]);
    console.log("[build] Done.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
