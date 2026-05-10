import { describe, expect, test } from "@/test";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";

describe("resolveProviderApiKey", () => {
  test("resolves personal key for user", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-personal-key" } });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-personal-key");
    expect(result.source).toBe("personal");
    expect(result.chatApiKeyId).toBeDefined();
    expect(result.baseUrl).toBeNull();
  });

  test("resolves org key when no user provided", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-org-key" } });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-org-key");
    expect(result.source).toBe("org");
    expect(result.chatApiKeyId).toBeDefined();
  });

  test("returns baseUrl when key has custom base URL", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-custom-base" } });

    const { LlmProviderApiKeyModel } = await import("@/models");
    await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Custom Base URL Key",
      provider: "openai",
      scope: "personal",
      userId: user.id,
      baseUrl: "https://my-proxy.example.com/v1",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-custom-base");
    expect(result.baseUrl).toBe("https://my-proxy.example.com/v1");
  });

  test("returns undefined apiKey when no key configured and no env var", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "cerebras",
    });

    expect(result.source).toBe("environment");
    expect(result.baseUrl).toBeNull();
  });

  test("personal key takes priority over org", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const orgSecret = await makeSecret({ secret: { apiKey: "sk-org-wide" } });
    await makeLlmProviderApiKey(org.id, orgSecret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const personalSecret = await makeSecret({
      secret: { apiKey: "sk-personal" },
    });
    await makeLlmProviderApiKey(org.id, personalSecret.id, {
      provider: "anthropic",
      scope: "personal",
      userId: user.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-personal");
    expect(result.source).toBe("personal");
  });

  test("team key takes priority over org when user is in team", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id, { name: "Test Team" });
    await makeTeamMember(team.id, user.id);

    const orgSecret = await makeSecret({ secret: { apiKey: "sk-org-wide" } });
    await makeLlmProviderApiKey(org.id, orgSecret.id, {
      provider: "openai",
      scope: "org",
    });

    const teamSecret = await makeSecret({ secret: { apiKey: "sk-team" } });
    await makeLlmProviderApiKey(org.id, teamSecret.id, {
      provider: "openai",
      scope: "team",
      teamId: team.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-team");
    expect(result.source).toBe("team");
  });

  test("supports legacy secret formats (anthropicApiKey)", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { anthropicApiKey: "sk-legacy-key" },
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-legacy-key");
  });

  test("resolves Anthropic system key without a secret for a user", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const { LlmProviderApiKeyModel } = await import("@/models");
    const systemKey = await LlmProviderApiKeyModel.createSystemKey({
      organizationId: org.id,
      name: "Anthropic Workload Identity Federation",
      provider: "anthropic",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "anthropic",
    });

    expect(result).toEqual({
      apiKey: undefined,
      source: "system",
      chatApiKeyId: systemKey.id,
      baseUrl: null,
    });
  });

  test("resolves Anthropic system key without a user", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const { LlmProviderApiKeyModel } = await import("@/models");
    const systemKey = await LlmProviderApiKeyModel.createSystemKey({
      organizationId: org.id,
      name: "Anthropic Workload Identity Federation",
      provider: "anthropic",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "anthropic",
    });

    expect(result).toEqual({
      apiKey: undefined,
      source: "system",
      chatApiKeyId: systemKey.id,
      baseUrl: null,
    });
  });

  test("prefers a real org key over an Anthropic system key for a user", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const { LlmProviderApiKeyModel } = await import("@/models");
    await LlmProviderApiKeyModel.createSystemKey({
      organizationId: org.id,
      name: "Anthropic Workload Identity Federation",
      provider: "anthropic",
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-real-org-key" } });
    const orgKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "anthropic",
    });

    expect(result).toEqual({
      apiKey: "sk-real-org-key",
      source: "org",
      chatApiKeyId: orgKey.id,
      baseUrl: null,
    });
  });

  test("prefers a real org key over an Anthropic system key without a user", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();

    const { LlmProviderApiKeyModel } = await import("@/models");
    await LlmProviderApiKeyModel.createSystemKey({
      organizationId: org.id,
      name: "Anthropic Workload Identity Federation",
      provider: "anthropic",
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-real-org-key" } });
    const orgKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "anthropic",
    });

    expect(result).toEqual({
      apiKey: "sk-real-org-key",
      source: "org",
      chatApiKeyId: orgKey.id,
      baseUrl: null,
    });
  });
});
