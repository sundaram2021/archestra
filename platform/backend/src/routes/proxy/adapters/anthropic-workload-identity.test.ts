import type AnthropicProvider from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createAnthropicWorkloadIdentityFetch,
  isAnthropicWorkloadIdentityEnabled,
} from "@/clients/anthropic-workload-identity";
import { isAnthropicAzureFoundryEntraIdEnabled } from "@/clients/azure-openai-credentials";

vi.mock("@/observability", () => ({
  metrics: { llm: { getObservableFetch: vi.fn() } },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(
    () => async () => "azure-foundry-token",
  ),
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/anthropic-workload-identity", () => ({
  createAnthropicWorkloadIdentityFetch: vi.fn(
    (_baseUrl: string | undefined, upstreamFetch?: typeof globalThis.fetch) =>
      upstreamFetch ?? globalThis.fetch,
  ),
  isAnthropicWorkloadIdentityEnabled: vi.fn(() => true),
}));

import { anthropicAdapterFactory } from "./anthropic";

const mockIsAnthropicAzureFoundryEntraIdEnabled = vi.mocked(
  isAnthropicAzureFoundryEntraIdEnabled,
);
const mockIsAnthropicWorkloadIdentityEnabled = vi.mocked(
  isAnthropicWorkloadIdentityEnabled,
);
const mockCreateAnthropicWorkloadIdentityFetch = vi.mocked(
  createAnthropicWorkloadIdentityFetch,
);

describe("anthropicAdapterFactory Workload Identity Federation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAnthropicAzureFoundryEntraIdEnabled.mockReturnValue(false);
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(true);
    mockCreateAnthropicWorkloadIdentityFetch.mockImplementation(
      (_baseUrl, upstreamFetch) => upstreamFetch ?? globalThis.fetch,
    );
  });

  test("creates a keyless client that uses the Anthropic WIF fetch wrapper", () => {
    const client = anthropicAdapterFactory.createClient(undefined, {
      baseUrl: "https://api.anthropic.com",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        apiKey?: unknown;
        authToken?: unknown;
        defaultHeaders?: Record<string, string>;
        fetch?: typeof globalThis.fetch;
      };
    };

    expect(client._options?.apiKey).toBeNull();
    expect(client._options?.authToken).toBeNull();
    expect(client._options?.defaultHeaders?.Authorization).toBe(
      "Bearer <anthropic-wif-managed>",
    );
    expect(mockCreateAnthropicWorkloadIdentityFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com",
      undefined,
    );
  });

  test("does not use WIF when a request supplies an API key", () => {
    const client = anthropicAdapterFactory.createClient("sk-ant-api-key", {
      baseUrl: "https://api.anthropic.com",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        apiKey?: unknown;
        defaultHeaders?: Record<string, string>;
      };
    };

    expect(client._options?.apiKey).toBe("sk-ant-api-key");
    expect(client._options?.defaultHeaders?.Authorization).toBeUndefined();
    expect(mockCreateAnthropicWorkloadIdentityFetch).not.toHaveBeenCalled();
  });

  test("keeps Azure Foundry Entra ID precedence when it is enabled", () => {
    mockIsAnthropicAzureFoundryEntraIdEnabled.mockReturnValue(true);
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(true);

    const client = anthropicAdapterFactory.createClient(undefined, {
      baseUrl: "https://resource.services.ai.azure.com/anthropic",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        defaultHeaders?: Record<string, string>;
      };
    };

    expect(client._options?.defaultHeaders?.Authorization).toBe(
      "Bearer <entra-id-managed>",
    );
    expect(mockCreateAnthropicWorkloadIdentityFetch).not.toHaveBeenCalled();
  });
});
