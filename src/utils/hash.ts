/**
 * Content hashing utilities using the Web Crypto API (SubtleCrypto).
 * Works on both desktop and mobile — no Node.js crypto dependency.
 */

/**
 * Compute the SHA-256 hex digest of a string.
 * Uses SubtleCrypto which is available in all modern browsers and WebViews.
 */
export async function sha256(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
