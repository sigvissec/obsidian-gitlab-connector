// Polyfill for the Node.js `crypto` module.
//
// Android Obsidian throws "Attempting to load NodeJS package: crypto" the
// moment any bundled code calls require("crypto"). isomorphic-git's CJS bundle
// does this unconditionally at module-load time:
//   var crypto$1 = require("crypto");
//
// This file is wired in via esbuild's `alias` option so that every
// require("crypto") in the bundle resolves to this module instead of the
// native one. It implements only createHash — the one function that
// isomorphic-git actually calls (in shasumRange() for packfile verification)
// — using sha.js, a pure-JS SHA implementation already bundled as a
// transitive dependency of isomorphic-git. No extra packages are required.

import shajs from "sha.js";

export function createHash(algorithm) {
	return shajs(algorithm);
}
