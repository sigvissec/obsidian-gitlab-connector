import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			// Replace the real Obsidian browser bundle with a minimal Node stub
			obsidian: resolve(__dirname, "tests/mocks/obsidian.ts"),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
