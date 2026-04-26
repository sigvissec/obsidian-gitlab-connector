import obsidianmd from "eslint-plugin-obsidianmd";

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
				{ allowAutoFix: true },
			],
		},
	},
];
