/**
 * vLLM Local Provider Extension
 *
 * Provides a single /vllm command that:
 * 1. Queries local vLLM API for available models
 * 2. Lets user select which model to switch to
 * 3. Allows editing model configuration
 * 4. Saves config and switches to selected model
 *
 * No provider registration - vLLM models don't appear in /model dialog.
 */

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

// =============================================================================
// Types
// =============================================================================

interface VllmConfig {
  endpoint: string;
  defaults: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    supportsUsageInStreaming: boolean;
    maxTokensField: "max_tokens" | "max_completion_tokens";
    requiresAssistantAfterToolResult: boolean;
    requiresToolResultName: boolean;
    supportsStore: boolean;
  };
  models: {
    [modelId: string]: {
      api: "openai-completions" | "openai-responses" | "anthropic-messages";
      reasoning: boolean;
      contextWindow: number;
      maxTokens: number;
      thinkingFormat?: "deepseek" | "qwen-chat-template" | null;
      temperatureScale: number;
    };
  };
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: VllmConfig = {
  endpoint: "http://localhost:11434/v1",
  defaults: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    maxTokensField: "max_tokens",
    requiresAssistantAfterToolResult: false,
    requiresToolResultName: false,
    supportsStore: false,
  },
  models: {},
};

const DEFAULT_MODEL_CONFIG = {
  api: "openai-completions" as const,
  reasoning: true,
  contextWindow: 131072,
  maxTokens: 16384,
  thinkingFormat: null as "deepseek" | "qwen-chat-template" | null,
  temperatureScale: 1,
};

// =============================================================================
// Configuration File Management
// =============================================================================

const CONFIG_PATH = path.join(process.env.HOME || "/", ".pi/agent/vllm-local.json");

function loadConfig(): VllmConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, "utf8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    } else {
      // Config file doesn't exist - write defaults
      saveConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
  } catch (error) {
    console.error("Failed to load vLLM config:", error);
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: VllmConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error("Failed to save vLLM config:", error);
  }
}

// Parse token counts like "64K", "1M", "131072" (K=1024, M=1024*1024). NaN if invalid.
export function parseTokenCount(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!m) return NaN;
  const mult = !m[2] ? 1 : m[2].toUpperCase() === "K" ? 1024 : 1024 * 1024;
  return Math.floor(parseFloat(m[1]) * mult);
}

function getOrDefaultModelConfig(
  modelId: string,
  maxModelLen?: number
): VllmConfig["models"][string] {
  const heuristic = detectCapabilities(modelId);
  return {
    ...DEFAULT_MODEL_CONFIG,
    ...heuristic,
    contextWindow: maxModelLen ?? DEFAULT_MODEL_CONFIG.contextWindow,
    maxTokens: (maxModelLen) ? Math.floor(maxModelLen / 16) : DEFAULT_MODEL_CONFIG.maxTokens
  };
}

function detectCapabilities(modelId: string): Partial<VllmConfig["models"][string]> {
  const lowerId = modelId.toLowerCase();

  if (lowerId.includes("deepseek")) {
    return { thinkingFormat: "deepseek" };
  }

  if (lowerId.includes("qw")) {
    return { thinkingFormat: "qwen-chat-template" };
  }

  return {};
}

// =============================================================================
// Model Discovery
// =============================================================================

interface ServedModel {
  id: string;
  name?: string;
  max_model_len?: number;
  context_window?: number;
  max_tokens?: number;
}

async function discoverModels(endpoint: string): Promise<ServedModel[]> {
  // Short timeout: pi awaits the extension factory, so a dead server must not stall startup
  const response = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.statusText}`);
  }
  const data = await response.json();
  // vLLM returns { object: "list", data: [...] }
  // each model has max_model_len from vLLM API
  return (data.data || data.models || []).map((m: any) => ({
    ...m,
    context_window: m.max_model_len,
    max_tokens: 16384,
  }));
}

// =============================================================================
// Model Registry
// =============================================================================

function toModelObj(
  id: string,
  cfg: VllmConfig["models"][string],
  endpoint: string
): ProviderModelConfig & { provider: string } {
  return {
    id,
    name: id,
    provider: "vllm-local", // setModel resolves auth via model.provider — must be set
    api: cfg.api as any,
    baseUrl: endpoint,
    reasoning: cfg.reasoning,
    input: ["text"],
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: cfg.thinkingFormat ?? undefined,
      temperatureScale: cfg.temperatureScale,
    } as ProviderModelConfig["compat"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
  };
}

// Union of saved configs and currently-served models; saved values win,
// unsaved/newly-served models get heuristics + live max_model_len.
export function buildModelRegistry(
  config: VllmConfig,
  served: ServedModel[]
): ProviderModelConfig[] {
  const ids = [...new Set([...Object.keys(config.models), ...served.map((m) => m.id)])];
  return ids.map((id) => {
    const maxModelLen = served.find((m) => m.id === id)?.max_model_len;
    const cfg = { ...getOrDefaultModelConfig(id, maxModelLen), ...config.models[id] };
    return toModelObj(id, cfg, config.endpoint);
  });
}

// =============================================================================
// Extension
// =============================================================================

export default async function (pi: ExtensionAPI) {
  // Register saved + served models at startup so pi can resolve the persisted
  // model choice (pi.setModel also records defaultModel; unregistered provider
  // was why boot/resume fell back to the next provider).
  const bootConfig = loadConfig();
  let served: ServedModel[] = [];
  try {
    served = await discoverModels(bootConfig.endpoint);
  } catch {
    // Server down: still register saved models below so resume binds.
  }
  const bootModels = buildModelRegistry(bootConfig, served);
  if (bootModels.length > 0) {
    pi.registerProvider("vllm-local", {
      baseUrl: bootConfig.endpoint,
      apiKey: "local-model",
      api: "openai-completions",
      models: bootModels,
    });
  }

  // pi.setModel is a runtime action — calling it in the factory throws
  // "Extension runtime not initialized". Auto-adopt happens at session_start,
  // and only if pi restored a vllm-local model that the server no longer serves.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider !== "vllm-local" || served.length === 0) return;
    const staleId = ctx.model.id;
    if (served.some((m) => m.id === staleId)) return; // model still served, nothing to do
    const target = served.length === 1
      ? buildModelRegistry(bootConfig, served).find((m) => m.id === served[0].id)
      : undefined;
    if (target) {
      await pi.setModel(target);
      ctx.ui.notify(`vLLM no longer serves ${staleId}; switched to ${target.id}`, "info");
    } else {
      ctx.ui.notify(`vLLM no longer serves ${staleId}. Run /vllm to pick a model.`, "warning");
    }
  });

  // Intercept outgoing requests to vLLM and apply temperature scaling
  pi.on("before_provider_request", (event, ctx) => {
    // Only apply to our provider
    if (ctx.model?.provider !== "vllm-local") return;

    const modelId = ctx.model?.id;
    if (!modelId) return;

    const config = loadConfig();
    const modelConfig = config.models[modelId];
    if (!modelConfig) return;

    const scale = modelConfig.temperatureScale ?? 1;
    if (scale === 1) return; // No scaling needed

    // Apply to OpenAI Chat Completions payload (most common for local servers)
    if ("temperature" in event.payload) {
      event.payload.temperature = (event.payload.temperature ?? 1) * scale;
    }
  });
  // Command: /vllm - Discover models, select one, edit config, switch to it
  pi.registerCommand("vllm", {
    description: "Switch to a vLLM model and configure it",
    handler: async (args, ctx) => {
      // Check if we're in TUI mode
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/vllm is only available in TUI mode", "warning");
        return;
      }

      // Load config to get endpoint
      const config = loadConfig();
      const endpoint = config.endpoint;

      // Discover models from local vLLM API
      let availableModels: Array<{
        id: string;
        name?: string;
        max_model_len?: number;
        context_window?: number;
        max_tokens?: number;
      }> = [];

      try {
        availableModels = await discoverModels(endpoint);
      } catch (error) {
        ctx.ui.notify(`Failed to discover vLLM models: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      if (availableModels.length === 0) {
        ctx.ui.notify("No models found on vLLM server", "warning");
        return;
      }

      // Show model selection menu
      const selectedModelId = await ctx.ui.custom((tui, theme, _kb, done) => {
        const items = availableModels.map((m) => ({
          value: m.id,
          label: m.name ?? m.id,
          description: `Ctx: ${m.context_window ?? "?"}, Max: ${m.max_tokens ?? "?"}`,
        }));

        const selectList = new SelectList(
          items,
          Math.min(items.length, 12),
          {
            selectedPrefix: (t) => theme.fg("accent", ` > ${t}`),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("dim", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("yellow", t),
          }
        );

        let selectedId = items[0]?.value;
        selectList.onSelect = (item) => {
          done({ selectedModelId: item.value });
        };
        selectList.onCancel = () => {
          done(undefined);
        };
        selectList.onSelectionChange = (item) => {
          selectedId = item.value;
        };

        const header = theme.fg("accent", theme.bold("Select vLLM Model"));
        const footer = theme.fg("dim", "↑↓: Select  Enter: Confirm  Esc: Cancel");

        const component = {
          render(width: number) {
            const headerLines = [header, ""];
            const listLines = selectList.render(width);
            const footerLines = [footer];
            return [...headerLines, ...listLines, ...footerLines];
          },
          invalidate() {
            selectList.invalidate();
          },
          handleInput(data: string) {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };

        return component;
      });

      if (!selectedModelId || !selectedModelId.selectedModelId) {
        ctx.ui.notify("No model selected", "info");
        return;
      }

      const modelId = selectedModelId.selectedModelId;

      // Get or create config for selected model
      // User config takes precedence over vLLM values, which take precedence over hardcoded defaults
      const maxModelLen = availableModels.find(m => m.id === modelId)?.max_model_len;
      const currentConfigValue = config.models[modelId] || getOrDefaultModelConfig(modelId, maxModelLen);

      // Show current configuration and ask user to accept or modify
      const configText = `Current Configuration for ${modelId}:

API Type: ${currentConfigValue.api}
Thinking Format: ${currentConfigValue.thinkingFormat || "null"}
Reasoning: ${currentConfigValue.reasoning ? "on" : "off"}
Context Window: ${currentConfigValue.contextWindow}
Max Tokens: ${currentConfigValue.maxTokens}
Temperature Scale: ${currentConfigValue.temperatureScale ?? 1}

Accept current configuration?`;

      const acceptConfig = await ctx.ui.confirm(
        "Configuration Preview",
        configText
      );

      if (acceptConfig === undefined) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      if (acceptConfig) {
        // Use current config without changes (switchToModel re-saves it)
        await switchToModel(pi, ctx, modelId, currentConfigValue, endpoint);
        return;
      }

      // User wants to modify - fall back to API-discovered defaults for sizing
      const apiDefaults = getOrDefaultModelConfig(modelId, maxModelLen);

      // API Type
      const apiOptions = ["openai-completions", "openai-responses", "anthropic-messages"];
      const selectedApi = await ctx.ui.select(
        "Select API Type:",
        apiOptions,
        { default: currentConfigValue.api }
      );

      if (!selectedApi) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // Thinking Format - use "null" string to match options array
      const tfOptions = ["null", "deepseek", "qwen-chat-template"];
      const currentTf = currentConfigValue.thinkingFormat || "null";
      const selectedThinkingFormat = await ctx.ui.select(
        "Select Thinking Format:",
        tfOptions,
        { default: currentTf }
      );

      if (!selectedThinkingFormat) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // Reasoning - default to "on" or "off" based on config
      const reasoningOptions = ["on", "off"];
      const currentReasoning = currentConfigValue.reasoning ? "on" : "off";
      const selectedReasoning = await ctx.ui.select(
        "Enable Reasoning?",
        reasoningOptions,
        { default: currentReasoning }
      );

      if (!selectedReasoning) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // Context Window (using input dialog with default in title)
      const contextWindowStr = await ctx.ui.input(
        `Context Window (tokens) [api default: ${apiDefaults.contextWindow}]:`,
        ""
      );

      if (contextWindowStr === undefined) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // If user left blank, use default
      const contextWindow = contextWindowStr.trim() === "" 
        ? apiDefaults.contextWindow 
        : parseTokenCount(contextWindowStr);

      if (isNaN(contextWindow) || contextWindow < 1024) {
        ctx.ui.notify("Invalid context window, using default", "warning");
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // Max Tokens (using input dialog with default in title)
      const maxTokensStr = await ctx.ui.input(
        `Max Tokens (tokens) [api default: ${apiDefaults.maxTokens}]:`,
        ""
      );

      if (maxTokensStr === undefined) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // If user left blank, use default
      const maxTokens = maxTokensStr.trim() === ""
        ? apiDefaults.maxTokens
        : parseTokenCount(maxTokensStr);

      if (isNaN(maxTokens) || maxTokens < 1024) {
        ctx.ui.notify("Invalid max tokens, using default", "warning");
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // Temperature scale input
      const tempScaleStr = await ctx.ui.input(
        `Temperature Scale [${config.models[modelId]?.temperatureScale ?? 1}]:`,
        modelId,
      );
      const tempScaleNum = parseFloat(tempScaleStr || "1");
      if (isNaN(tempScaleNum) || tempScaleNum <= 0) {
        ctx.ui.notify("Invalid temperature scale, using default", "warning");
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // Build result
      const result = {
        api: selectedApi as "openai-completions" | "openai-responses" | "anthropic-messages",
        reasoning: selectedReasoning === "on",
        contextWindow,
        maxTokens,
        temperatureScale: tempScaleNum,
        thinkingFormat: selectedThinkingFormat === "null" ? null : selectedThinkingFormat,
      };

      await switchToModel(pi, ctx, modelId, result, endpoint);
    },
  });
}



// Save config, (re)register all known models, remember the choice, switch to it.
async function switchToModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  modelId: string,
  result: VllmConfig["models"][string],
  endpoint: string
): Promise<void> {
  const config = loadConfig();
  config.models[modelId] = { ...getOrDefaultModelConfig(modelId), ...config.models[modelId], ...result };
  saveConfig(config);

  const models = buildModelRegistry(config, []);
  pi.registerProvider("vllm-local", {
    baseUrl: endpoint,
    apiKey: "local-model",
    api: "openai-completions",
    models,
  });

  const target = models.find((m) => m.id === modelId)!;
  const success = await pi.setModel(target);

  if (success) {
    ctx.ui.notify(`Switched to ${modelId} with custom configuration`, "success");
  } else {
    ctx.ui.notify(`Failed to switch to ${modelId}. Check if API key is configured.`, "error");
  }
}
