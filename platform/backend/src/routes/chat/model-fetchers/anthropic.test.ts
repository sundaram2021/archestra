import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getAnthropicWorkloadIdentityAuthHeaders,
  isAnthropicWorkloadIdentityEnabled,
} from "@/clients/anthropic-workload-identity";
import { isAnthropicAzureFoundryEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { fetchAnthropicModels } from "./anthropic";

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(
    () => async () => "azure-foundry-token",
  ),
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/anthropic-workload-identity", () => ({
  getAnthropicWorkloadIdentityAuthHeaders: vi.fn(async () => ({
    Authorization: "Bearer wif-token",
    "anthropic-beta": "oauth-2025-04-20",
  })),
  isAnthropicWorkloadIdentityEnabled: vi.fn(() => false),
}));

const mockIsAnthropicAzureFoundryEntraIdEnabled = vi.mocked(
  isAnthropicAzureFoundryEntraIdEnabled,
);
const mockIsAnthropicWorkloadIdentityEnabled = vi.mocked(
  isAnthropicWorkloadIdentityEnabled,
);
const mockGetAnthropicWorkloadIdentityAuthHeaders = vi.mocked(
  getAnthropicWorkloadIdentityAuthHeaders,
);

describe("fetchAnthropicModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAnthropicAzureFoundryEntraIdEnabled.mockReturnValue(false);
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(false);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-opus-4-1-20250805",
              display_name: "Claude Opus 4.1",
              created_at: "2025-08-05T00:00:00Z",
            },
          ],
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("uses x-api-key when an explicit Anthropic key is provided", async () => {
    await fetchAnthropicModels("sk-ant-api-key", "https://api.anthropic.com");

    const headers = new Headers(
      vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers,
    );
    expect(headers.get("x-api-key")).toBe("sk-ant-api-key");
    expect(headers.get("Authorization")).toBeNull();
    expect(mockGetAnthropicWorkloadIdentityAuthHeaders).not.toHaveBeenCalled();
  });

  test("uses WIF auth headers when no API key is provided and WIF is enabled", async () => {
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(true);

    const models = await fetchAnthropicModels("", "https://api.anthropic.com");

    const headers = new Headers(
      vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers,
    );
    expect(mockGetAnthropicWorkloadIdentityAuthHeaders).toHaveBeenCalledWith(
      "https://api.anthropic.com",
    );
    expect(headers.get("Authorization")).toBe("Bearer wif-token");
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(models).toEqual([
      {
        id: "claude-opus-4-1-20250805",
        displayName: "Claude Opus 4.1",
        provider: "anthropic",
        createdAt: "2025-08-05T00:00:00Z",
      },
    ]);
  });

  test("keeps Azure Foundry Entra ID behavior when it is enabled", async () => {
    mockIsAnthropicAzureFoundryEntraIdEnabled.mockReturnValue(true);
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(true);

    await fetchAnthropicModels(
      "",
      "https://resource.services.ai.azure.com/anthropic",
    );

    const headers = new Headers(
      vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers,
    );
    expect(headers.get("Authorization")).toBe("Bearer azure-foundry-token");
    expect(mockGetAnthropicWorkloadIdentityAuthHeaders).not.toHaveBeenCalled();
  });
});
