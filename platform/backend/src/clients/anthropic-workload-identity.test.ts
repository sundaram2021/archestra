import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { AnthropicWorkloadIdentityConfig } from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const cacheStore = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/cache-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cache-manager")>();
  return {
    ...actual,
    cacheManager: {
      get: vi.fn(async (key: string) => cacheStore.get(key)),
      set: vi.fn(async (key: string, value: unknown, _ttl?: number) => {
        cacheStore.set(key, value);
        return value;
      }),
    },
  };
});

import { cacheManager } from "@/cache-manager";
import {
  createAnthropicWorkloadIdentityFetch,
  getAnthropicWorkloadIdentityAccessToken,
  getAnthropicWorkloadIdentityAuthHeaders,
} from "./anthropic-workload-identity";

const workloadIdentity: AnthropicWorkloadIdentityConfig = {
  enabled: true,
  federationRuleId: "fdrl_test",
  organizationId: "org_test",
  serviceAccountId: "svac_test",
  workspaceId: "wrkspc_test",
  identityToken: "jwt-from-idp",
};

describe("Anthropic Workload Identity Federation", () => {
  beforeEach(() => {
    cacheStore.clear();
    vi.restoreAllMocks();
    vi.mocked(cacheManager.get).mockImplementation(async (key: string) =>
      cacheStore.get(key),
    );
    vi.mocked(cacheManager.set).mockImplementation(
      async (key: string, value: unknown, _ttl?: number) => {
        cacheStore.set(key, value);
        return value;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("exchanges an identity token and caches the access token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeTokenResponse("sk-ant-oat01-token", 3600));

    const token = await getAnthropicWorkloadIdentityAccessToken(
      "https://api.anthropic.com",
      workloadIdentity,
    );

    expect(token).toBe("sk-ant-oat01-token");
    expect(cacheManager.set).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(new Headers(init?.headers).get("anthropic-beta")).toContain(
      "oidc-federation-2026-04-01",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "jwt-from-idp",
      federation_rule_id: "fdrl_test",
      organization_id: "org_test",
      service_account_id: "svac_test",
      workspace_id: "wrkspc_test",
    });
  });

  test("uses a cached token when it is not near expiry", async () => {
    const cachedToken = {
      accessToken: "cached-token",
      expiresAtMs: Date.now() + 3600_000,
    };
    vi.mocked(cacheManager.get).mockResolvedValue(cachedToken);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const token = await getAnthropicWorkloadIdentityAccessToken(
      "https://api.anthropic.com",
      workloadIdentity,
    );

    expect(token).toBe("cached-token");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cacheManager.set).not.toHaveBeenCalled();
  });

  test("refreshes a cached token when it is near expiry", async () => {
    vi.mocked(cacheManager.get).mockResolvedValue({
      accessToken: "stale-token",
      expiresAtMs: Date.now() + 30_000,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeTokenResponse("fresh-token", 3600));

    const token = await getAnthropicWorkloadIdentityAccessToken(
      "https://api.anthropic.com",
      workloadIdentity,
    );

    expect(token).toBe("fresh-token");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(cacheManager.set).toHaveBeenCalledOnce();
  });

  test("reads the identity assertion from a token file without caching it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anthropic-wif-"));
    const tokenFile = path.join(dir, "token");
    await fs.writeFile(tokenFile, "jwt-from-file\n", "utf8");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeTokenResponse("file-token", 3600));

    const token = await getAnthropicWorkloadIdentityAccessToken(
      "https://api.anthropic.com",
      {
        ...workloadIdentity,
        identityToken: undefined,
        identityTokenFile: tokenFile,
      },
    );

    expect(token).toBe("file-token");
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.assertion).toBe("jwt-from-file");

    const cachedValue = cacheStore.values().next().value as {
      accessToken: string;
    };
    expect(cachedValue).toEqual(
      expect.objectContaining({ accessToken: "file-token" }),
    );
    expect(JSON.stringify(cachedValue)).not.toContain("jwt-from-file");
  });

  test("returns auth headers and injects them into wrapped fetch requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeTokenResponse("wrapped-token", 3600),
    );
    const upstreamFetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}"),
    );

    const headers = await getAnthropicWorkloadIdentityAuthHeaders(
      "https://api.anthropic.com",
      workloadIdentity,
    );
    expect(headers).toEqual({
      Authorization: "Bearer wrapped-token",
      "anthropic-beta": "oauth-2025-04-20",
    });

    const wrappedFetch = createAnthropicWorkloadIdentityFetch(
      "https://api.anthropic.com",
      upstreamFetch,
      workloadIdentity,
    );
    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
    });

    const requestHeaders = new Headers(
      upstreamFetch.mock.calls[0]?.[1]?.headers,
    );
    expect(requestHeaders.get("Authorization")).toBe("Bearer wrapped-token");
    expect(requestHeaders.get("anthropic-beta")).toContain(
      "prompt-caching-2024-07-31",
    );
    expect(requestHeaders.get("anthropic-beta")).toContain("oauth-2025-04-20");
  });

  test("redacts non-JSON token exchange failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("assertion jwt-from-idp leaked", { status: 400 }),
    );

    await expect(
      getAnthropicWorkloadIdentityAccessToken(
        "https://api.anthropic.com",
        workloadIdentity,
      ),
    ).rejects.toThrow("[redacted response body]");
  });

  test("refuses to exchange identity assertions over non-local HTTP", async () => {
    await expect(
      getAnthropicWorkloadIdentityAccessToken(
        "http://api.anthropic.example",
        workloadIdentity,
      ),
    ).rejects.toThrow(
      "Refusing to send Anthropic Workload Identity Federation assertion to non-HTTPS endpoint",
    );
  });
});

function makeTokenResponse(accessToken: string, expiresIn: number): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: expiresIn,
      token_type: "Bearer",
    }),
  );
}
