import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveCopilotApiBaseUrlFromToken,
  isDirectUseToken,
  resolveCopilotApiToken,
  resolveCopilotApiBaseUrl,
  DEFAULT_COPILOT_API_BASE_URL,
  BUSINESS_COPILOT_API_BASE_URL,
} from "./github-copilot-token.js";

describe("github-copilot token", () => {
  const loadJsonFile = vi.fn();
  const saveJsonFile = vi.fn();
  const cachePath = "/tmp/openclaw-state/credentials/github-copilot.token.json";

  beforeEach(() => {
    loadJsonFile.mockClear();
    saveJsonFile.mockClear();
  });

  it("derives baseUrl from token", async () => {
    expect(
      deriveCopilotApiBaseUrlFromToken("token;proxy-ep=proxy.example.com;"),
    ).toBe("https://api.example.com");
    expect(
      deriveCopilotApiBaseUrlFromToken("token;proxy-ep=https://proxy.foo.bar;"),
    ).toBe("https://api.foo.bar");
  });

  it("uses cache when token is still valid", async () => {
    const now = Date.now();
    loadJsonFile.mockReturnValue({
      token: "cached;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
    });

    const fetchImpl = vi.fn();
    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("cached;proxy-ep=proxy.example.com;");
    expect(res.baseUrl).toBe("https://api.example.com");
    expect(String(res.source)).toContain("cache:");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and stores token when cache is missing", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "fresh;proxy-ep=https://proxy.contoso.test;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const { resolveCopilotApiToken } =
      await import("./github-copilot-token.js");

    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("fresh;proxy-ep=https://proxy.contoso.test;");
    expect(res.baseUrl).toBe("https://api.contoso.test");
    expect(saveJsonFile).toHaveBeenCalledTimes(1);
  });

  describe("direct-use tokens (PAT/OAuth)", () => {
    it("identifies github_pat_ tokens as direct-use", () => {
      expect(isDirectUseToken("github_pat_11BZNJENQ0b3Gwu6kSoWpl_xxxx")).toBe(
        true,
      );
    });

    it("identifies ghp_ tokens as direct-use", () => {
      expect(isDirectUseToken("ghp_xxxxxxxxxxxxxxxxxxxxxx")).toBe(true);
    });

    it("does not identify device-flow tokens as direct-use", () => {
      expect(isDirectUseToken("some-device-flow-token")).toBe(false);
    });

    it("uses PAT directly without exchange", async () => {
      loadJsonFile.mockReturnValue(undefined);
      const fetchImpl = vi.fn();

      const res = await resolveCopilotApiToken({
        githubToken: "github_pat_11BZNJENQ0b3Gwu6kSoWpl_test",
        cachePath,
        loadJsonFileImpl: loadJsonFile,
        saveJsonFileImpl: saveJsonFile,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      // PAT should be used directly without calling the exchange endpoint
      expect(res.token).toBe("github_pat_11BZNJENQ0b3Gwu6kSoWpl_test");
      expect(res.source).toBe("direct:pat-or-oauth");
      expect(res.baseUrl).toBe(DEFAULT_COPILOT_API_BASE_URL);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(saveJsonFile).toHaveBeenCalledTimes(1);
    });

    it("uses ghp_ token directly without exchange", async () => {
      loadJsonFile.mockReturnValue(undefined);
      const fetchImpl = vi.fn();

      const res = await resolveCopilotApiToken({
        githubToken: "ghp_testtoken123456789012345",
        cachePath,
        loadJsonFileImpl: loadJsonFile,
        saveJsonFileImpl: saveJsonFile,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(res.token).toBe("ghp_testtoken123456789012345");
      expect(res.source).toBe("direct:pat-or-oauth");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("uses COPILOT_API_BASE_URL env var for direct-use tokens", async () => {
      loadJsonFile.mockReturnValue(undefined);
      const fetchImpl = vi.fn();

      const res = await resolveCopilotApiToken({
        githubToken: "github_pat_test",
        env: { COPILOT_API_BASE_URL: BUSINESS_COPILOT_API_BASE_URL },
        cachePath,
        loadJsonFileImpl: loadJsonFile,
        saveJsonFileImpl: saveJsonFile,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(res.token).toBe("github_pat_test");
      expect(res.baseUrl).toBe(BUSINESS_COPILOT_API_BASE_URL);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("exchanges non-direct tokens via API", async () => {
      loadJsonFile.mockReturnValue(undefined);
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          token: "exchanged;proxy-ep=https://proxy.github.test;",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      });

      const res = await resolveCopilotApiToken({
        githubToken: "some-device-flow-token",
        cachePath,
        loadJsonFileImpl: loadJsonFile,
        saveJsonFileImpl: saveJsonFile,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      // Non-direct tokens should go through the exchange
      expect(res.token).toBe("exchanged;proxy-ep=https://proxy.github.test;");
      expect(String(res.source)).toContain("fetched:");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("env PAT takes priority over device-flow githubToken", async () => {
      // Simulates: user logged in via device flow (profile has OAuth token),
      // but also set GH_TOKEN=github_pat_xxx in env.
      // The env PAT should win even though the passed githubToken is the profile token.
      loadJsonFile.mockReturnValue(undefined);
      const fetchImpl = vi.fn();

      const res = await resolveCopilotApiToken({
        githubToken: "some-device-flow-oauth-token",
        env: { GH_TOKEN: "github_pat_from_env_override" },
        cachePath,
        loadJsonFileImpl: loadJsonFile,
        saveJsonFileImpl: saveJsonFile,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(res.token).toBe("github_pat_from_env_override");
      expect(res.source).toBe("direct:env-pat");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("env PAT takes priority over cached exchanged token", async () => {
      const now = Date.now();
      // Cache has a valid exchanged token
      loadJsonFile.mockReturnValue({
        token: "tid=xxx;proxy-ep=proxy.business.githubcopilot.com;",
        expiresAt: now + 60 * 60 * 1000,
        updatedAt: now,
      });
      const fetchImpl = vi.fn();

      const res = await resolveCopilotApiToken({
        githubToken: "some-device-flow-token",
        env: { COPILOT_GITHUB_TOKEN: "github_pat_env_wins" },
        cachePath,
        loadJsonFileImpl: loadJsonFile,
        saveJsonFileImpl: saveJsonFile,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      // Env PAT should override even a valid cached token
      expect(res.token).toBe("github_pat_env_wins");
      expect(res.source).toBe("direct:env-pat");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("cached PAT is used directly with correct baseUrl", async () => {
      const now = Date.now();
      // User manually placed PAT in cache file
      loadJsonFile.mockReturnValue({
        token: "github_pat_manually_cached",
        expiresAt: now + 60 * 60 * 1000,
        updatedAt: now,
      });
      const fetchImpl = vi.fn();

      const res = await resolveCopilotApiToken({
        githubToken: "some-device-flow-token",
        env: { COPILOT_API_BASE_URL: BUSINESS_COPILOT_API_BASE_URL },
        cachePath,
        loadJsonFileImpl: loadJsonFile,
        saveJsonFileImpl: saveJsonFile,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(res.token).toBe("github_pat_manually_cached");
      expect(res.baseUrl).toBe(BUSINESS_COPILOT_API_BASE_URL);
      expect(String(res.source)).toContain("cache:");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("resolveCopilotApiBaseUrl", () => {
    it("returns env var when set", () => {
      expect(
        resolveCopilotApiBaseUrl({
          COPILOT_API_BASE_URL: "https://custom.api",
        }),
      ).toBe("https://custom.api");
    });

    it("returns token-derived URL when no env var", () => {
      expect(resolveCopilotApiBaseUrl({}, "https://api.business.test")).toBe(
        "https://api.business.test",
      );
    });

    it("returns default when no env var and no token-derived URL", () => {
      expect(resolveCopilotApiBaseUrl({})).toBe(DEFAULT_COPILOT_API_BASE_URL);
    });

    it("prefers env var over token-derived URL", () => {
      expect(
        resolveCopilotApiBaseUrl(
          { COPILOT_API_BASE_URL: "https://env.api" },
          "https://token.api",
        ),
      ).toBe("https://env.api");
    });
  });
});
