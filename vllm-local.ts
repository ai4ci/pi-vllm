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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  contextWindow: 128000,
  maxTokens: 16384,
  thinkingFormat: null as "deepseek" | "qwen-chat-template" | null,
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

function getOrDefaultModelConfig(modelId: string): VllmConfig["models"][string] {
  const heuristic = detectCapabilities(modelId);
  return { ...DEFAULT_MODEL_CONFIG, ...heuristic };
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

async function discoverModels(endpoint: string): Promise<Array<{
  id: string;
  name?: string;
  context_window?: number;
  max_tokens?: number;
}>> {
  const response = await fetch(`${endpoint}/models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.statusText}`);
  }
  const data = await response.json();
  // vLLM returns { object: "list", data: [...] }
  return data.data || data.models || [];
}

// =============================================================================
// Extension
// =============================================================================

export default async function (pi: ExtensionAPI) {
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
      const currentConfigValue = config.models[modelId] || getOrDefaultModelConfig(modelId);

      // Show current configuration and ask user to accept or modify
      const configText = `Current Configuration for ${modelId}:

API Type: ${currentConfigValue.api}
Thinking Format: ${currentConfigValue.thinkingFormat || "null"}
Reasoning: ${currentConfigValue.reasoning ? "on" : "off"}
Context Window: ${currentConfigValue.contextWindow}
Max Tokens: ${currentConfigValue.maxTokens}

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
        // Use current config without changes
        const result = currentConfigValue;

        // Update config file (ensure it's saved)
        if (!config.models[modelId]) {
          config.models[modelId] = getOrDefaultModelConfig(modelId);
        }
        config.models[modelId] = { ...config.models[modelId], ...result };
        saveConfig(config);

        // Proceed to model switch with current config
        const switchSuccess = await switchToModel(pi, ctx, modelId, result, endpoint);
        return;
      }

      // User wants to modify - show individual config options
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
        `Context Window (tokens) [current: ${currentConfigValue.contextWindow}]:`,
        ""
      );

      if (contextWindowStr === undefined) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // If user left blank, use default
      const contextWindow = contextWindowStr.trim() === "" 
        ? currentConfigValue.contextWindow 
        : parseInt(contextWindowStr, 10);

      if (isNaN(contextWindow) || contextWindow < 1024) {
        ctx.ui.notify("Invalid context window, using default", "warning");
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // Max Tokens (using input dialog with default in title)
      const maxTokensStr = await ctx.ui.input(
        `Max Tokens (tokens) [current: ${currentConfigValue.maxTokens}]:`,
        ""
      );

      if (maxTokensStr === undefined) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // If user left blank, use default
      const maxTokens = maxTokensStr.trim() === ""
        ? currentConfigValue.maxTokens
        : parseInt(maxTokensStr, 10);

      if (isNaN(maxTokens) || maxTokens < 1024) {
        ctx.ui.notify("Invalid max tokens, using default", "warning");
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }

      // Build result
      const result = {
        api: selectedApi as "openai-completions" | "openai-responses" | "anthropic-messages",
        reasoning: selectedReasoning === "on",
        contextWindow,
        maxTokens,
        thinkingFormat: selectedThinkingFormat === "null" ? null : selectedThinkingFormat,
      };

      // Update config file
      if (!config.models[modelId]) {
        config.models[modelId] = getOrDefaultModelConfig(modelId);
      }
      config.models[modelId] = {
        ...config.models[modelId],
        ...result,
      };
      saveConfig(config);

      // Register a temporary provider with just this model so we can switch to it
      // Create a model object for setModel
      const modelObj = {
        id: modelId,
        name: modelId,
        api: result.api as any,
        provider: "vllm-local",
        baseUrl: endpoint,
        reasoning: result.reasoning,
        input: ["text"] as const,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
        },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: result.contextWindow,
        maxTokens: result.maxTokens,
      };

      // Register provider with just this model
      pi.registerProvider("vllm-local", {
        baseUrl: endpoint,
        apiKey: "local-model",
        api: result.api,
        models: [modelObj],
      });

      // Switch to the selected model
      const success = await pi.setModel(modelObj);

      if (success) {
        ctx.ui.notify(`Switched to ${modelId} with custom configuration`, "success");
      } else {
        ctx.ui.notify(`Failed to switch to ${modelId}. Check if API key is configured.`, "error");
      }
    },
  });
}



// Helper function to switch to model with given configuration
async function switchToModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  modelId: string,
  result: ModelConfig,
  endpoint: string
): Promise<void> {
  // Update config file (ensure it's saved)
  const config = loadConfig();
  if (!config.models[modelId]) {
    config.models[modelId] = getOrDefaultModelConfig(modelId);
  }
  config.models[modelId] = { ...config.models[modelId], ...result };
  saveConfig(config);

  // Register a temporary provider with just this model so we can switch to it
  // Create a model object for setModel
  const modelObj = {
    id: modelId,
    name: modelId,
    api: result.api as any,
    provider: "vllm-local",
    baseUrl: endpoint,
    reasoning: result.reasoning,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: result.contextWindow,
    maxTokens: result.maxTokens,
  };

  // Register provider with just this model
  pi.registerProvider("vllm-local", {
    baseUrl: endpoint,
    apiKey: "local-model",
    api: result.api,
    models: [modelObj],
  });

  // Switch to the selected model
  const success = await pi.setModel(modelObj);

  if (success) {
    ctx.ui.notify(`Switched to ${modelId} with custom configuration`, "success");
  } else {
    ctx.ui.notify(`Failed to switch to ${modelId}. Check if API key is configured.`, "error");
  }
}
