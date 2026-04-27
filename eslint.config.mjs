import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

// Mirrors the older eslint-plugin-obsidianmd@0.1.x looksLikePath heuristic
// (slash AND extension required). 0.2.x loosened it to extension-only,
// which causes emails like "name@example.com" to be skipped locally even
// though the Obsidian review-bot still flags them.
const UI_TEXT_METHODS = new Set([
	"setName",
	"setDesc",
	"setPlaceholder",
	"setButtonText",
	"setTooltip",
	"setText",
	"setTitle",
]);

function isStrictlySkippable(text) {
	if (!text) return true;
	if (text.includes("`") || /<\/?[a-z][^>]*>/i.test(text)) return true;
	if (/(\$\{[^}]+\}|\{[^}]+\}|%\d*\$?s|%s)/.test(text)) return true;
	if (/^\.{1,2}\//.test(text)) return true;
	if (/[\\/]/.test(text) && /\.[a-z0-9]{1,4}(\b|$)/i.test(text)) return true;
	if (/(Ctrl|Cmd|Alt|Shift|Option|⌘|⌥|⌃|⇧)\s*\+\s*[A-Za-z]/.test(text))
		return true;
	if (/^v?\d+(?:[._-]\d+)+$/.test(text)) return true;
	if (/^[A-Z0-9_]+$/.test(text)) return true;
	return false;
}

const uiSentenceFirstCap = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Catch UI strings the obsidianmd review-bot flags but eslint-plugin-obsidianmd@0.2.x skips",
		},
		messages: {
			lowerStart:
				"Use sentence case for UI text. Capitalize the first letter — expected: '{{suggestion}}'",
		},
		schema: [],
	},
	create(context) {
		function check(node, text) {
			if (isStrictlySkippable(text)) return;
			const m = text.match(/[A-Za-z]/);
			if (!m) return;
			const first = m[0];
			if (first === first.toUpperCase()) return;
			const idx = m.index;
			const suggestion =
				text.slice(0, idx) + first.toUpperCase() + text.slice(idx + 1);
			context.report({
				node,
				messageId: "lowerStart",
				data: { suggestion },
			});
		}
		return {
			CallExpression(node) {
				if (node.callee.type !== "MemberExpression") return;
				if (node.callee.property.type !== "Identifier") return;
				if (!UI_TEXT_METHODS.has(node.callee.property.name)) return;
				const arg = node.arguments[0];
				if (!arg) return;
				if (arg.type === "Literal" && typeof arg.value === "string") {
					check(arg, arg.value);
				} else if (
					arg.type === "TemplateLiteral" &&
					arg.expressions.length === 0
				) {
					check(arg, arg.quasis[0].value.raw);
				}
			},
		};
	},
};

const localPlugin = {
	meta: { name: "local", version: "0.0.0" },
	rules: { "ui-sentence-first-cap": uiSentenceFirstCap },
};

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
		plugins: { local: localPlugin },
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
			"local/ui-sentence-first-cap": "error",
		},
	},
];
