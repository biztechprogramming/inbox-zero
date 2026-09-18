import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAzure } from "@ai-sdk/azure";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "@/env";
import { Provider } from "./config";
import { getEmbeddingModel } from "./model";
import type { UserAIFields } from "./types";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({
    textEmbeddingModel: (model: string) => ({ provider: "openai", model }),
  })),
}));

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn(() => ({
    textEmbeddingModel: (model: string) => ({ provider: "azure", model }),
  })),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => ({
    textEmbeddingModel: (model: string) => ({
      provider: "azure-foundry",
      model,
    }),
  })),
}));

vi.mock("@ai-sdk/gateway", () => ({
  createGateway: vi.fn(() => ({
    textEmbeddingModel: (model: string) => ({ provider: "aigateway", model }),
  })),
}));

vi.mock("@/env", () => ({
  env: {
    DEFAULT_LLMS: undefined,
    ECONOMY_LLMS: undefined,
    LLM_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    AZURE_API_KEY: undefined,
    AZURE_RESOURCE_NAME: undefined,
    AZURE_API_VERSION: "2024-10-21",
    AI_GATEWAY_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    AZURE_FOUNDRY_API_KEY: undefined,
    AZURE_FOUNDRY_BASE_URL: undefined,
  },
}));

const user = (fields: Partial<UserAIFields> = {}): UserAIFields => ({
  aiProvider: null,
  aiModel: null,
  aiApiKey: null,
  ...fields,
});

describe("getEmbeddingModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(env).DEFAULT_LLMS = undefined;
    vi.mocked(env).ECONOMY_LLMS = undefined;
    vi.mocked(env).LLM_API_KEY = undefined;
    vi.mocked(env).OPENAI_API_KEY = undefined;
    vi.mocked(env).AZURE_API_KEY = undefined;
    vi.mocked(env).AZURE_RESOURCE_NAME = undefined;
    vi.mocked(env).AI_GATEWAY_API_KEY = undefined;
    vi.mocked(env).ANTHROPIC_API_KEY = undefined;
    vi.mocked(env).AZURE_FOUNDRY_API_KEY = undefined;
    vi.mocked(env).AZURE_FOUNDRY_BASE_URL = undefined;
    delete process.env.LLM_API_KEY;
    delete process.env.AZURE_FOUNDRY_BASE_URL;
  });

  it("follows the configured economy list order", () => {
    vi.mocked(env).ECONOMY_LLMS = "aigateway:x,openai:gpt-5.6-luna";
    vi.mocked(env).AI_GATEWAY_API_KEY = "gateway-key";
    vi.mocked(env).OPENAI_API_KEY = "openai-key";

    expect(getEmbeddingModel(user())).toMatchObject({ provider: "aigateway" });
    expect(createOpenAI).not.toHaveBeenCalled();
  });

  it("honours the operator's order when it puts OpenAI first", () => {
    vi.mocked(env).ECONOMY_LLMS = "openai:gpt-5.6-luna,aigateway:x";
    vi.mocked(env).AI_GATEWAY_API_KEY = "gateway-key";
    vi.mocked(env).OPENAI_API_KEY = "openai-key";

    expect(getEmbeddingModel(user())).toMatchObject({ provider: "openai" });
    expect(createGateway).not.toHaveBeenCalled();
  });

  it("skips a configured provider that cannot embed and takes the next one", () => {
    vi.mocked(env).ECONOMY_LLMS =
      "anthropic:claude-sonnet-5,openai:gpt-5.6-luna";
    vi.mocked(env).ANTHROPIC_API_KEY = "anthropic-key";
    vi.mocked(env).OPENAI_API_KEY = "openai-key";

    expect(getEmbeddingModel(user())).toMatchObject({ provider: "openai" });
  });

  it("skips a configured provider whose credentials are missing", () => {
    vi.mocked(env).ECONOMY_LLMS = "azure:my-deployment,openai:gpt-5.6-luna";
    vi.mocked(env).OPENAI_API_KEY = "openai-key";

    expect(getEmbeddingModel(user())).toMatchObject({ provider: "openai" });
  });

  it("falls back to the default list when no economy list is configured", () => {
    vi.mocked(env).DEFAULT_LLMS = "openai:gpt-5.6-luna";
    vi.mocked(env).OPENAI_API_KEY = "openai-key";

    expect(getEmbeddingModel(user())).toMatchObject({ provider: "openai" });
  });

  it("tries the user's own provider and key before the configured list", () => {
    vi.mocked(env).ECONOMY_LLMS = "aigateway:x";
    vi.mocked(env).AI_GATEWAY_API_KEY = "gateway-key";
    vi.mocked(env).OPENAI_API_KEY = "deployment-openai-key";

    getEmbeddingModel(
      user({ aiProvider: Provider.OPEN_AI, aiApiKey: "user-key" }),
    );

    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: "user-key" });
    expect(createGateway).not.toHaveBeenCalled();
  });

  it("falls through to the configured list when the user's provider cannot embed", () => {
    vi.mocked(env).ECONOMY_LLMS = "openai:gpt-5.6-luna";
    vi.mocked(env).OPENAI_API_KEY = "deployment-openai-key";

    getEmbeddingModel(
      user({ aiProvider: Provider.ANTHROPIC, aiApiKey: "anthropic-user-key" }),
    );

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: "deployment-openai-key",
    });
  });

  it("uses the shared LLM_API_KEY fallback like every other model", () => {
    vi.mocked(env).ECONOMY_LLMS = "openai:gpt-5.6-luna";
    vi.mocked(env).LLM_API_KEY = "shared-key";

    expect(getEmbeddingModel(user())).toMatchObject({ provider: "openai" });
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: "shared-key" });
  });

  it("uses Azure with its resource name when that is what is configured", () => {
    vi.mocked(env).ECONOMY_LLMS = "azure:my-deployment";
    vi.mocked(env).AZURE_API_KEY = "azure-key";
    vi.mocked(env).AZURE_RESOURCE_NAME = "azure-resource";

    expect(getEmbeddingModel(user())).toMatchObject({ provider: "azure" });
    expect(createAzure).toHaveBeenCalledWith({
      apiKey: "azure-key",
      resourceName: "azure-resource",
      apiVersion: "2024-10-21",
    });
  });

  it("embeds through azure-foundry against its own base url", () => {
    vi.mocked(env).ECONOMY_LLMS = "azure-foundry:gpt-5.4-nano";
    vi.mocked(env).AZURE_FOUNDRY_API_KEY = "foundry-key";
    vi.mocked(env).AZURE_FOUNDRY_BASE_URL =
      "https://r.openai.azure.com/openai/v1";

    expect(getEmbeddingModel(user())).toMatchObject({
      provider: "azure-foundry",
    });
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "azure-foundry",
      baseURL: "https://r.openai.azure.com/openai/v1",
      headers: { "api-key": "foundry-key" },
    });
  });

  it("skips azure-foundry when it has no base url configured", () => {
    vi.mocked(env).ECONOMY_LLMS =
      "azure-foundry:gpt-5.4-nano,openai:gpt-5.6-luna";
    vi.mocked(env).AZURE_FOUNDRY_API_KEY = "foundry-key";
    vi.mocked(env).OPENAI_API_KEY = "openai-key";

    expect(getEmbeddingModel(user())).toMatchObject({ provider: "openai" });
  });

  it("returns null when no configured provider can embed", () => {
    vi.mocked(env).ECONOMY_LLMS = "anthropic:claude-sonnet-5";
    vi.mocked(env).ANTHROPIC_API_KEY = "anthropic-key";

    expect(getEmbeddingModel(user())).toBeNull();
  });
});
