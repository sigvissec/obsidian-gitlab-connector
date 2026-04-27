import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

export default [
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"tests/**",
			"src/polyfills/**",
			"esbuild.config.mjs",
			"version-bump.mjs",
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": [
				"error",
				{
					allowAutoFix: true,
					acronyms: [...DEFAULT_ACRONYMS, "REST"],
				},
			],
			"@typescript-eslint/require-await": "error",
		},
	},
];
