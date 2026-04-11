// Buffer polyfill for Obsidian mobile (Android/iOS).
// isomorphic-git depends on safe-buffer which requires Node.js Buffer.
// On mobile, we provide the browser 'buffer' package polyfill instead.
import { Buffer as BrowserBuffer } from "buffer/";

if (typeof globalThis.Buffer === "undefined") {
	globalThis.Buffer = BrowserBuffer;
}

export { BrowserBuffer as Buffer };
