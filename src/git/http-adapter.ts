/**
 * isomorphic-git HTTP plugin backed by Obsidian's requestUrl API.
 *
 * isomorphic-git/http/web uses native fetch, which is blocked by CORS when
 * Obsidian's webview makes cross-origin requests to GitLab. requestUrl
 * bypasses CORS by handling HTTP at the native OS level.
 */

import { requestUrl } from "obsidian";
import type { GitHttpRequest } from "isomorphic-git";

export const httpAdapter = {
	async request({ url, method = "GET", headers, body }: GitHttpRequest) {
		// Collect the request body (git pack data) from the async iterator
		let bodyBuffer: ArrayBuffer | undefined;
		if (body) {
			const chunks: Uint8Array[] = [];
			for await (const chunk of body) {
				chunks.push(chunk);
			}
			if (chunks.length > 0) {
				const total = chunks.reduce((n, c) => n + c.byteLength, 0);
				const merged = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					merged.set(chunk, offset);
					offset += chunk.byteLength;
				}
				bodyBuffer = merged.buffer;
			}
		}

		// throw: false — let isomorphic-git handle 401/403 via onAuth/onAuthFailure
		const response = await requestUrl({
			url,
			method,
			headers,
			body: bodyBuffer,
			throw: false,
		});

		// Normalize header keys to lowercase (Obsidian already returns single string values)
		const responseHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(response.headers)) {
			responseHeaders[key.toLowerCase()] = value;
		}

		// Wrap the buffered response body as an async generator
		const buf = response.arrayBuffer;
		async function* bodyStream(): AsyncGenerator<Uint8Array> {
			yield new Uint8Array(buf);
		}

		return {
			url,
			method,
			statusCode: response.status,
			statusMessage: "",
			headers: responseHeaders,
			body: bodyStream(),
		};
	},
};
