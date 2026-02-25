import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/**
 * Token prefixes that can be used directly with the Copilot API
 * without requiring a token exchange via /copilot_internal/v2/token.
 *
 * - `github_pat_` - Fine-grained Personal Access Token
 * - `ghp_` - Classic Personal Access Token
 *
 * The official Copilot CLI (as observed via network capture) sends these tokens
 * directly to the Copilot API endpoints with `Authorization: Bearer <token>`.
 */
const DIRECT_USE_TOKEN_PREFIXES = ["github_pat_", "ghp_"] as const;

/**
 * Check if a token can be used directly with the Copilot API
 * without requiring a token exchange.
 */
export function isDirectUseToken(token: string): boolean {
  const trimmed = token.trim();
  return DIRECT_USE_TOKEN_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Default TTL for direct-use tokens (PAT, OAuth).
 * PATs don't have a built-in expiry in the Copilot context, but we cache them
 * for 8 hours to match the Copilot CLI's OAuth token lifetime.
 */
const DIRECT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export type CachedCopilotToken = {
  token: string;
  /** milliseconds since epoch */
  expiresAt: number;
  /** milliseconds since epoch */
  updatedAt: number;
};

function resolveCopilotTokenCachePath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}

function isTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  // Keep a small safety margin when checking expiry.
  return cache.expiresAt - now > 5 * 60 * 1000;
}

function parseCopilotTokenResponse(value: unknown): {
  token: string;
  expiresAt: number;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot token endpoint");
  }
  const asRecord = value as Record<string, unknown>;
  const token = asRecord.token;
  const expiresAt = asRecord.expires_at;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Copilot token response missing token");
  }

  // GitHub returns a unix timestamp (seconds), but we defensively accept ms too.
  let expiresAtMs: number;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    expiresAtMs = expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000;
  } else if (typeof expiresAt === "string" && expiresAt.trim().length > 0) {
    const parsed = Number.parseInt(expiresAt, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error("Copilot token response has invalid expires_at");
    }
    expiresAtMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  } else {
    throw new Error("Copilot token response missing expires_at");
  }

  return { token, expiresAt: expiresAtMs };
}

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
export const BUSINESS_COPILOT_API_BASE_URL = "https://api.business.githubcopilot.com";

/**
 * Resolve the Copilot API base URL.
 * Priority:
 * 1. COPILOT_API_BASE_URL env var (for enterprise/custom endpoints)
 * 2. Derived from exchanged token's proxy-ep field
 * 3. Default to individual endpoint
 */
export function resolveCopilotApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  tokenDerivedUrl?: string | null,
): string {
  const envUrl = env.COPILOT_API_BASE_URL?.trim();
  if (envUrl) {
    return envUrl;
  }
  return tokenDerivedUrl ?? DEFAULT_COPILOT_API_BASE_URL;
}

export function deriveCopilotApiBaseUrlFromToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  // The token returned from the Copilot token endpoint is a semicolon-delimited
  // set of key/value pairs. One of them is `proxy-ep=...`.
  const match = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) {
    return null;
  }

  // pi-ai expects converting proxy.* -> api.*
  // (see upstream getGitHubCopilotBaseUrl).
  const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  if (!host) {
    return null;
  }

  return `https://${host}`;
}

/**
 * Resolve an env-var-based direct-use token.
 * Checks COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN in order.
 * Returns the token only if it is a direct-use token (PAT prefix).
 */
function resolveEnvDirectToken(env: NodeJS.ProcessEnv): string | null {
  const candidates = [env.COPILOT_GITHUB_TOKEN, env.GH_TOKEN, env.GITHUB_TOKEN];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed && isDirectUseToken(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export async function resolveCopilotApiToken(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  loadJsonFileImpl?: (path: string) => unknown;
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): Promise<{
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
}> {
  const env = params.env ?? process.env;
  const cachePath = params.cachePath?.trim() || resolveCopilotTokenCachePath(env);
  const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
  const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;

  // Priority 1: Check env vars for a direct-use PAT token.
  // This takes precedence over stored profiles and cached exchanged tokens,
  // matching the behavior of the official Copilot CLI which sends PATs
  // directly to the API without any exchange.
  const envDirectToken = resolveEnvDirectToken(env);
  if (envDirectToken) {
    const now = Date.now();
    const baseUrl = resolveCopilotApiBaseUrl(env);
    const payload: CachedCopilotToken = {
      token: envDirectToken,
      expiresAt: now + DIRECT_TOKEN_TTL_MS,
      updatedAt: now,
    };
    saveJsonFileFn(cachePath, payload);
    return {
      token: payload.token,
      expiresAt: payload.expiresAt,
      source: "direct:env-pat",
      baseUrl,
    };
  }

  // Priority 2: Check if the passed githubToken itself is a direct-use token.
  if (isDirectUseToken(params.githubToken)) {
    const now = Date.now();
    const baseUrl = resolveCopilotApiBaseUrl(env);
    const payload: CachedCopilotToken = {
      token: params.githubToken,
      expiresAt: now + DIRECT_TOKEN_TTL_MS,
      updatedAt: now,
    };
    saveJsonFileFn(cachePath, payload);
    return {
      token: payload.token,
      expiresAt: payload.expiresAt,
      source: "direct:pat-or-oauth",
      baseUrl,
    };
  }

  // Priority 3: Check cached token.
  const cached = loadJsonFileFn(cachePath) as CachedCopilotToken | undefined;
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    if (isTokenUsable(cached)) {
      // If cached token is itself a PAT, use it with env-based baseUrl resolution.
      const baseUrl = isDirectUseToken(cached.token)
        ? resolveCopilotApiBaseUrl(env)
        : resolveCopilotApiBaseUrl(env, deriveCopilotApiBaseUrlFromToken(cached.token));
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        source: `cache:${cachePath}`,
        baseUrl,
      };
    }
  }

  // Priority 4: Exchange token via API.

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.githubToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
  }

  const json = parseCopilotTokenResponse(await res.json());
  const payload: CachedCopilotToken = {
    token: json.token,
    expiresAt: json.expiresAt,
    updatedAt: Date.now(),
  };
  saveJsonFileFn(cachePath, payload);

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: `fetched:${COPILOT_TOKEN_URL}`,
    baseUrl: resolveCopilotApiBaseUrl(env, deriveCopilotApiBaseUrlFromToken(payload.token)),
  };
}
