/**
 * Authentication callbacks for isomorphic-git.
 *
 * isomorphic-git only supports HTTPS Basic Auth — no SSH.
 * For GitLab, we use the Personal Access Token as the password
 * with the username being arbitrary (but non-empty).
 */

import type { GitAuth, AuthCallback, AuthFailureCallback } from "isomorphic-git";

/**
 * Create an `onAuth` callback for isomorphic-git operations.
 *
 * @param token GitLab Personal Access Token
 * @param username Optional username (defaults to "oauth2" for token auth)
 */
export function createAuthCallback(
	token: string,
	username = "oauth2",
): AuthCallback {
	return () => ({
		username,
		password: token,
	});
}

/**
 * Create an `onAuthFailure` callback that signals isomorphic-git to
 * stop retrying.  The callback receives only the URL — the auth object
 * (which contains the plaintext token) is deliberately not forwarded to
 * prevent accidental credential leakage via logging.
 */
export function createAuthFailureCallback(
	onFailure?: (url: string) => void,
): AuthFailureCallback {
	return (url: string, _auth: GitAuth) => {
		if (onFailure) {
			onFailure(url);
		}
		return undefined as unknown as void;
	};
}
