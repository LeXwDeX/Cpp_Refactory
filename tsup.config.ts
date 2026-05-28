import { defineConfig } from "tsup"

export default defineConfig({
    entry: ["index.ts", "bin/cpp-refactory.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
})
