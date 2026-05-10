import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { OAUTH_GRANT_TYPE, TimeInMs } from "@shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config, { type AnthropicWorkloadIdentityConfig } from "@/config";
import logger from "@/logging";

const TOKEN_ENDPOINT = "/v1/oauth/token";
const OAUTH_API_BETA_HEADER = "oauth-2025-04-20";
const FEDERATION_BETA_HEADER = "oidc-federation-2026-04-01";
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 2 * TimeInMs.Minute;
const MAX_IDENTITY_TOKEN_BYTES = 16 * 1024;

type Fetch = typeof globalThis.fetch;

type CachedAnthropicWifToken = {
  accessToken: string;
  expiresAtMs: number;
};

type AnthropicTokenExchangeResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
};

export function isAnthropicWorkloadIdentityEnabled(): boolean {
  return config.llm.anthropic.workloadIdentity.enabled;
}

export async function getAnthropicWorkloadIdentityAuthHeaders(
  baseUrl = config.llm.anthropic.baseUrl,
  workloadIdentity = config.llm.anthropic.workloadIdentity,
): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await getAnthropicWorkloadIdentityAccessToken(
      baseUrl,
      workloadIdentity,
    )}`,
    "anthropic-beta": OAUTH_API_BETA_HEADER,
  };
}

export function createAnthropicWorkloadIdentityFetch(
  baseUrl = config.llm.anthropic.baseUrl,
  upstreamFetch?: Fetch,
  workloadIdentity = config.llm.anthropic.workloadIdentity,
): Fetch {
  const fetchForUpstream = upstreamFetch ?? globalThis.fetch.bind(globalThis);

  return async (input, init = {}) => {
    const authHeaders = await getAnthropicWorkloadIdentityAuthHeaders(
      baseUrl,
      workloadIdentity,
    );
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authHeaders)) {
      if (key.toLowerCase() === "anthropic-beta") {
        appendAnthropicBeta(headers, value);
      } else {
        headers.set(key, value);
      }
    }

    return fetchForUpstream(input, {
      ...init,
      headers,
    });
  };
}

export async function getAnthropicWorkloadIdentityAccessToken(
  baseUrl = config.llm.anthropic.baseUrl,
  workloadIdentity = config.llm.anthropic.workloadIdentity,
): Promise<string> {
  if (!workloadIdentity.enabled) {
    throw new Error("Anthropic Workload Identity Federation is not enabled");
  }

  const cacheKey = getAnthropicWorkloadIdentityCacheKey(
    baseUrl,
    workloadIdentity,
  );
  const cached = await cacheManager.get<CachedAnthropicWifToken>(cacheKey);

  if (
    cached?.accessToken &&
    cached.expiresAtMs - Date.now() > ACCESS_TOKEN_REFRESH_WINDOW_MS
  ) {
    return cached.accessToken;
  }

  const exchanged = await exchangeAnthropicWorkloadIdentityToken(
    baseUrl,
    workloadIdentity,
  );
  const ttlMs =
    exchanged.expiresAtMs - Date.now() - ACCESS_TOKEN_REFRESH_WINDOW_MS;

  if (ttlMs > TimeInMs.Second) {
    try {
      await cacheManager.set(cacheKey, exchanged, ttlMs);
    } catch (error) {
      logger.warn(
        {
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "Failed to cache Anthropic Workload Identity Federation access token",
      );
    }
  }

  return exchanged.accessToken;
}

async function exchangeAnthropicWorkloadIdentityToken(
  baseUrl: string,
  workloadIdentity: AnthropicWorkloadIdentityConfig,
): Promise<CachedAnthropicWifToken> {
  requireSecureTokenEndpoint(baseUrl);

  const assertion = await readIdentityToken(workloadIdentity);
  if (Buffer.byteLength(assertion, "utf8") > MAX_IDENTITY_TOKEN_BYTES) {
    throw new Error(
      "Anthropic identity token exceeds the 16 KiB Workload Identity Federation assertion limit",
    );
  }

  const body: Record<string, string> = {
    grant_type: OAUTH_GRANT_TYPE.JwtBearer,
    assertion,
    federation_rule_id: workloadIdentity.federationRuleId,
    organization_id: workloadIdentity.organizationId,
    service_account_id: workloadIdentity.serviceAccountId,
  };

  if (workloadIdentity.workspaceId) {
    body.workspace_id = workloadIdentity.workspaceId;
  }

  const response = await globalThis.fetch(
    `${normalizeBaseUrl(baseUrl)}${TOKEN_ENDPOINT}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": `${OAUTH_API_BETA_HEADER},${FEDERATION_BETA_HEADER}`,
      },
      body: JSON.stringify(body),
    },
  );

  const requestId = response.headers.get("request-id");

  if (!response.ok) {
    throw new Error(
      `Anthropic Workload Identity Federation token exchange failed with status ${
        response.status
      }${requestId ? ` (request-id ${requestId})` : ""}: ${await getSafeErrorBody(
        response,
      )}`,
    );
  }

  const payload = (await response.json()) as AnthropicTokenExchangeResponse;

  if (
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0 ||
    typeof payload.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in)
  ) {
    throw new Error("Anthropic WIF token exchange response is missing fields");
  }

  if (
    typeof payload.token_type === "string" &&
    payload.token_type.toLowerCase() !== "bearer"
  ) {
    throw new Error(
      `Anthropic WIF token exchange returned unsupported token_type "${payload.token_type}"`,
    );
  }

  return {
    accessToken: payload.access_token,
    expiresAtMs: Date.now() + payload.expires_in * TimeInMs.Second,
  };
}

async function readIdentityToken(
  workloadIdentity: AnthropicWorkloadIdentityConfig,
): Promise<string> {
  if (workloadIdentity.identityToken) {
    return workloadIdentity.identityToken;
  }

  if (!workloadIdentity.identityTokenFile) {
    throw new Error("Anthropic Workload Identity Federation token is missing");
  }

  const token = (
    await fs.readFile(workloadIdentity.identityTokenFile, "utf8")
  ).trim();

  if (!token) {
    throw new Error(
      `Anthropic identity token file is empty: ${workloadIdentity.identityTokenFile}`,
    );
  }

  return token;
}

function getAnthropicWorkloadIdentityCacheKey(
  baseUrl: string,
  workloadIdentity: AnthropicWorkloadIdentityConfig,
): AllowedCacheKey {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        baseUrl: normalizeBaseUrl(baseUrl),
        federationRuleId: workloadIdentity.federationRuleId,
        organizationId: workloadIdentity.organizationId,
        serviceAccountId: workloadIdentity.serviceAccountId,
        workspaceId: workloadIdentity.workspaceId,
        tokenSource: workloadIdentity.identityTokenFile
          ? `file:${workloadIdentity.identityTokenFile}`
          : `inline:${hashValue(workloadIdentity.identityToken ?? "")}`,
      }),
    )
    .digest("hex");

  return `${CacheKey.AnthropicWifAccessToken}-${fingerprint}`;
}

function requireSecureTokenEndpoint(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") return;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  ) {
    return;
  }

  throw new Error(
    `Refusing to send Anthropic Workload Identity Federation assertion to non-HTTPS endpoint: ${baseUrl}`,
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function appendAnthropicBeta(headers: Headers, beta: string): void {
  const current = headers.get("anthropic-beta");
  if (!current) {
    headers.set("anthropic-beta", beta);
    return;
  }

  const values = current.split(",").map((value) => value.trim());
  if (!values.includes(beta)) {
    headers.set("anthropic-beta", `${current},${beta}`);
  }
}

async function getSafeErrorBody(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  if (!body) return "";

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return JSON.stringify({
      error: parsed.error,
      error_uri: parsed.error_uri,
    });
  } catch {
    return "[redacted response body]";
  }
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
