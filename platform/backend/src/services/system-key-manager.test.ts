import { vi } from "vitest";
import { isAnthropicWorkloadIdentityEnabled } from "@/clients/anthropic-workload-identity";
import { LlmProviderApiKeyModel } from "@/models";
import { fetchAnthropicModels } from "@/routes/chat/model-fetchers/anthropic";
import { describe, expect, test } from "@/test";
import { systemKeyManager } from "./system-key-manager";

vi.mock("@/clients/anthropic-workload-identity", () => ({
  isAnthropicWorkloadIdentityEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
  isAzureOpenAiEntraIdEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/bedrock-credentials", () => ({
  isBedrockIamAuthEnabled: vi.fn(() => false),
}));

vi.mock("@/routes/chat/model-fetchers/anthropic", () => ({
  fetchAnthropicModels: vi.fn(async () => [
    {
      id: "claude-opus-4-1-20250805",
      displayName: "Claude Opus 4.1",
      provider: "anthropic",
      createdAt: "2025-08-05T00:00:00Z",
    },
  ]),
}));

vi.mock("@/clients/models-dev-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/models-dev-client")>();
  return {
    ...actual,
    modelsDevClient: {
      ...actual.modelsDevClient,
      fetchModelsFromApi: vi.fn(async () => ({})),
    },
  };
});

const mockIsAnthropicWorkloadIdentityEnabled = vi.mocked(
  isAnthropicWorkloadIdentityEnabled,
);
const mockFetchAnthropicModels = vi.mocked(fetchAnthropicModels);

describe("systemKeyManager", () => {
  test("creates and syncs an Anthropic WIF system key when WIF is enabled", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(true);

    await systemKeyManager.syncSystemKeys(organization.id);

    const systemKey = await LlmProviderApiKeyModel.findSystemKey("anthropic");
    expect(systemKey).toEqual(
      expect.objectContaining({
        organizationId: organization.id,
        name: "Anthropic Workload Identity Federation",
        provider: "anthropic",
        isSystem: true,
        secretId: null,
      }),
    );
    expect(mockFetchAnthropicModels).toHaveBeenCalledWith(
      "",
      expect.any(String),
    );
  });

  test("deletes the Anthropic system key when WIF is disabled", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await LlmProviderApiKeyModel.createSystemKey({
      organizationId: organization.id,
      name: "Anthropic Workload Identity Federation",
      provider: "anthropic",
    });
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(false);

    await systemKeyManager.syncSystemKeys(organization.id);

    await expect(
      LlmProviderApiKeyModel.findSystemKey("anthropic"),
    ).resolves.toBeNull();
  });
});
