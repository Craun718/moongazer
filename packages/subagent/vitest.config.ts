import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const rootPackageSource = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@pulonia\/moongazer$/,
        replacement: rootPackageSource,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
