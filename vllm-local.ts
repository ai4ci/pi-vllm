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
import { createHash } from "node:crypto";
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
      // Per-model override of pi's thinking-level menu. null hides a level.
      // When unset the extension derives it from the server's reasoning_effort enum.
      thinkingLevelMap?: { [level: string]: string | null };
      // Accepted reasoning_effort levels, stored per model id (like contextWindow)
      // when you reload them in the /vllm configure flow. Absent = not yet stored.
      thinkingLevels?: string[];
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

// Build identity. package.json gives the release number; the content hash of this
// file gives the actual loaded build. /vllm --version compares the two so a stale
// extension (edited on disk, not reloaded) is visible instead of silently assumed.
const EXTENSION_URL = import.meta.url;
export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("./package.json", EXTENSION_URL), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function buildFingerprint(): string {
  try {
    return createHash("sha256").update(fs.readFileSync(new URL(EXTENSION_URL), "utf8")).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}
export const LOADED_BUILD = buildFingerprint();

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

export function endpointForPort(portOrEndpoint: string | number, baseEndpoint = "http://localhost:11434/v1"): string {
  const p = String(portOrEndpoint).trim();
  if (!p) return baseEndpoint;
  if (/^\d+$/.test(p)) {
    const url = new URL(baseEndpoint);
    url.port = p;
    return url.toString().replace(/\/$/, "");
  }
  return p;
}

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

const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Translate the server's accepted reasoning_effort literals into pi's level map.
// A level the server rejects is set to null so pi hides it instead of sending a
// value vLLM will 400 on. "off" only maps to "none" when the server accepts it;
// otherwise it is left undefined so pi applies its per-format disable instead.
export function thinkingLevelMapFrom(levels: string[]): { [level: string]: string | null } {
  const accepted = new Set(levels);
  const map: { [level: string]: string | null } = {};
  for (const level of EXTENDED_THINKING_LEVELS) {
    if (level === "off") {
      if (accepted.has("none")) map.off = "none";
      continue;
    }
    map[level] = accepted.has(level) ? level : null;
  }
  return map;
}

// pi's request builder sends `thinkingLevelMap[level] ?? level`, so a level the map
// marks null (hidden) still goes out as its own name. Catch that here: if the map
// hides this value, or (no map) the schema enum rejects it, drop it rather than 400.
export function shouldDropEffort(
  level: string,
  modelMap?: { [l: string]: string | null },
  schemaLevels?: string[] | null
): boolean {
  if (modelMap) return modelMap[level] === null;
  return Array.isArray(schemaLevels) ? !schemaLevels.includes(level) : false;
}

// =============================================================================
// Model Discovery
// =============================================================================

interface ServedModel {
  id: string;
  name?: string;
  root?: string;
  max_model_len?: number;
  context_window?: number;
  max_tokens?: number;
}

// The reasoning_effort enum lives in the request schema and is validated before
// model lookup, so it is server-wide. It is only the *universe* of values the
// server will parse: each model's chat template can reject more (e.g. DeepSeek
// V4.1 accepts only low|high|xhigh|max and 400s on medium/minimal). Probe it once
// per endpoint; null means "no signals", leave pi's defaults.
const levelCache = new Map<string, string[] | null>();

const DEFAULT_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export async function probeReasoningLevels(endpoint: string): Promise<string[] | null> {
  const cached = levelCache.get(endpoint);
  if (cached !== undefined) return cached;
  let levels: string[] | null = null;
  try {
    const url = new URL(endpoint);
    url.pathname = "/openapi.json";
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const spec = await response.json();
      const anyOf = spec?.components?.schemas?.ChatCompletionRequest?.properties?.reasoning_effort?.anyOf;
      const enumVals = Array.isArray(anyOf) ? anyOf.find((o: any) => Array.isArray(o?.enum))?.enum : undefined;
      if (Array.isArray(enumVals)) levels = enumVals as string[];
    }
  } catch {
    // Unreachable/older server: fall through with null.
  }
  levelCache.set(endpoint, levels);
  return levels;
}

// Which of the schema-valid levels this specific model's chat template accepts.
// vLLM exposes this nowhere, so probe it: one 1-token request per level, and the
// template 400s on the ones it rejects. null = undetermined (network/5xx), so we
// leave pi's defaults instead of hiding levels we couldn't confirm.
const modelLevelCache = new Map<string, string[] | null>();

async function levelAccepted(endpoint: string, modelId: string, level: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        reasoning_effort: level,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) return true;
    if (response.status === 400) return false; // template rejected this level
    return null;
  } catch {
    return null;
  }
}

export async function probeModelLevels(
  endpoint: string,
  modelId: string,
  candidates: string[],
  force = false
): Promise<string[] | null> {
  const key = `${endpoint}|${modelId}`;
  if (!force) {
    const cached = modelLevelCache.get(key);
    if (cached !== undefined) return cached;
  }
  const results = await Promise.all(candidates.map(async (l) => [l, await levelAccepted(endpoint, modelId, l)] as const));
  // Any indeterminate probe (network/5xx) makes a partial set untrustworthy.
  const accepted = results.every(([, ok]) => ok !== null)
    ? results.filter(([, ok]) => ok).map(([l]) => l)
    : [];
  const value = accepted.length > 0 ? accepted : null;
  modelLevelCache.set(key, value);
  return value;
}

// Probe once per distinct root (aliases share one chat template) and fan the
// result out to every served id. Capped so a big catalog can't stall startup.
export async function probeServedLevels(
  endpoint: string,
  served: ServedModel[],
  candidates: string[],
  force = false
): Promise<{ [id: string]: string[] | null }> {
  const out: { [id: string]: string[] | null } = {};
  const roots = new Map<string, string>();
  for (const m of served) {
    const root = m.root ?? m.id;
    if (!roots.has(root)) roots.set(root, m.id);
  }
  if (roots.size > 12) return out; // ponytail: skip probing big catalogs; persist a cache if it ever matters
  await Promise.all([...roots].map(async ([root, id]) => {
    const accepted = await probeModelLevels(endpoint, id, candidates, force);
    for (const m of served) if ((m.root ?? m.id) === root) out[m.id] = accepted;
  }));
  return out;
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
    thinkingLevelMap: cfg.thinkingLevelMap,
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

// The registry mirrors what the server actually serves; config.models is a
// *config store* (settings persist for models that come and go), not a model
// list. Registering the union meant every model ever configured stayed
// selectable and resumable long after the server stopped serving it.
//
// Pass served=[] only when the server is unreachable: then we fall back to the
// saved set so pi can still bind a restored vllm-local model on resume.
export function buildModelRegistry(
  config: VllmConfig,
  served: ServedModel[],
  servedLevels?: string[] | null,
  perModelLevels?: { [id: string]: string[] | null }
): ProviderModelConfig[] {
  const ids = served.length > 0 ? served.map((m) => m.id) : Object.keys(config.models);
  return [...new Set(ids)].map((id) => {
    const maxModelLen = served.find((m) => m.id === id)?.max_model_len;
    const cfg = { ...getOrDefaultModelConfig(id, maxModelLen), ...config.models[id] };
    // Explicit thinkingLevelMap wins, then levels stored on the model config, then
    // an in-memory probe, then the schema universe.
    const levels = cfg.thinkingLevels ?? perModelLevels?.[id] ?? servedLevels;
    if (cfg.reasoning && !cfg.thinkingLevelMap && levels?.length) {
      cfg.thinkingLevelMap = thinkingLevelMapFrom(levels);
    }
    return toModelObj(id, cfg, config.endpoint);
  });
}

// vLLM serves each model under several ids (its repo path, "default", and any
// --served-model-name aliases), all sharing one `root`. Alias count is not
// model count, so collapse by root before deciding "is there exactly one?".
export function distinctServedModels(served: ServedModel[]): ServedModel[] {
  const byRoot = new Map<string, ServedModel>();
  for (const m of served) {
    const root = m.root ?? m.id;
    const incumbent = byRoot.get(root);
    // Prefer the canonical id (id === root), then any non-"default" alias.
    if (!incumbent || m.id === root || (incumbent.id !== root && incumbent.id === "default")) {
      byRoot.set(root, m);
    }
  }
  return [...byRoot.values()];
}

// =============================================================================
// Extension
// =============================================================================

export default async function (pi: ExtensionAPI) {
  // Register saved + served models at startup so pi can resolve the persisted
  // model choice (pi.setModel also records defaultModel; unregistered provider
  // was why boot/resume fell back to the next provider).
  const bootConfig = loadConfig();
  const [served, schemaLevels] = await Promise.all([
    discoverModels(bootConfig.endpoint).catch(() => [] as ServedModel[]), // down: still register saved models so resume binds
    probeReasoningLevels(bootConfig.endpoint),
  ]);
  // Models with levels stored on their config skip probing; the rest are probed
  // in memory only (nothing is persisted until you reload in /vllm).
  const unknown = served.filter((m) => !bootConfig.models[m.id]?.thinkingLevels && !bootConfig.models[m.id]?.thinkingLevelMap);
  const perModelLevels = unknown.length > 0
    ? await probeServedLevels(bootConfig.endpoint, unknown, schemaLevels ?? DEFAULT_REASONING_LEVELS)
    : {};
  const bootModels = buildModelRegistry(bootConfig, served, schemaLevels, perModelLevels);
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
    const distinct = distinctServedModels(served);
    const target = distinct.length === 1
      ? buildModelRegistry(bootConfig, served, schemaLevels, perModelLevels).find((m) => m.id === distinct[0].id)
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

    // Never ship a reasoning_effort a gate rejects: vLLM validates the schema
    // before model lookup and the chat template after it, so either can 400. Use
    // the registered model's map (pi sends map[level] ?? level, so a level hidden
    // with null still goes out as itself), falling back to the schema enum.
    const payload = event.payload as any;
    if (typeof payload.reasoning_effort === "string" &&
        shouldDropEffort(payload.reasoning_effort, (ctx.model as any)?.thinkingLevelMap, levelCache.get(config.endpoint))) {
      delete payload.reasoning_effort;
    }

    const modelConfig = config.models[modelId];
    if (!modelConfig) return;

    const scale = modelConfig.temperatureScale ?? 1;
    if (scale === 1) return; // No scaling needed

    // Apply to OpenAI Chat Completions payload (most common for local servers)
    if ("temperature" in event.payload) {
      event.payload.temperature = (event.payload.temperature ?? 1) * scale;
    }
  });
  // Command: /vllm [port] - Discover models, select one, edit config, switch to it
  pi.registerCommand("vllm", {
    description: "Switch to a vLLM model and configure it (optional: /vllm [port] | --version)",
    handler: async (args, ctx) => {
      const flag = args?.trim();
      if (flag === "--version" || flag === "-v") {
        // Report the loaded build, and flag if disk has moved on since load.
        const disk = buildFingerprint();
        const suffix = disk !== LOADED_BUILD ? ` (disk has ${disk}; run /reload)` : "";
        ctx.ui.notify(`vllm-local ${VERSION} · build ${LOADED_BUILD}${suffix}`, "info");
        return;
      }

      // Check if we're in TUI mode
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/vllm is only available in TUI mode", "warning");
        return;
      }

      // Load config to get endpoint, override with port arg if provided
      const config = loadConfig();
      let endpoint = args?.trim() ? endpointForPort(args.trim(), config.endpoint) : config.endpoint;

      // Discover models from local vLLM API
      let availableModels: ServedModel[] = [];

      try {
        availableModels = await discoverModels(endpoint);
      } catch (error) {
        // If not explicitly passed as arg, prompt user for an alternate port/endpoint
        if (!args?.trim()) {
          const customPort = await ctx.ui.input(
            `No server detected at ${endpoint}. Enter local port or URL:`,
            "11434"
          );
          if (customPort?.trim()) {
            endpoint = endpointForPort(customPort.trim(), config.endpoint);
            try {
              availableModels = await discoverModels(endpoint);
            } catch (retryErr) {
              ctx.ui.notify(`Failed to discover vLLM models at ${endpoint}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`, "error");
              return;
            }
          } else {
            return;
          }
        } else {
          ctx.ui.notify(`Failed to discover vLLM models at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
      }

      if (availableModels.length === 0) {
        ctx.ui.notify(`No models found on vLLM server at ${endpoint}`, "warning");
        return;
      }

      const schemaLevels = await probeReasoningLevels(endpoint);
      const levelCandidates = schemaLevels ?? DEFAULT_REASONING_LEVELS;
      // Probe only models with no stored levels; in memory, not persisted.
      const unknown = availableModels.filter((m) => !config.models[m.id]?.thinkingLevels && !config.models[m.id]?.thinkingLevelMap);
      const perModelLevels: { [id: string]: string[] | null } = unknown.length > 0
        ? await probeServedLevels(endpoint, unknown, levelCandidates)
        : {};

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

      // Stored levels win; otherwise the in-memory probe; otherwise the schema set.
      const shownLevels = currentConfigValue.thinkingLevels ?? perModelLevels[modelId] ?? schemaLevels;
      const levelsText = shownLevels?.length
        ? shownLevels.map((l) => (l === "none" ? "off" : l)).join(", ")
        : "unknown";

      // Show current configuration and ask user to accept or modify
      const configText = `Current Configuration for ${modelId}:

API Type: ${currentConfigValue.api}
Thinking Format: ${currentConfigValue.thinkingFormat || "null"}
Reasoning: ${currentConfigValue.reasoning ? "on" : "off"}
Context Window: ${currentConfigValue.contextWindow}
Max Tokens: ${currentConfigValue.maxTokens}
Thinking Levels: ${levelsText}
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
        await switchToModel(pi, ctx, modelId, currentConfigValue, endpoint, availableModels, schemaLevels, perModelLevels);
        return;
      }

      // User wants to modify - fall back to API-discovered defaults for sizing
      const apiDefaults = getOrDefaultModelConfig(modelId, maxModelLen);

      // Levels are stored per model id, and "default" can point at a different
      // real model later, so offer an explicit refresh here.
      const reloadLevels = await ctx.ui.confirm(
        "Thinking Levels",
        `Reload accepted thinking levels for ${modelId} from the server?`
      );
      if (reloadLevels === undefined) {
        ctx.ui.notify("Configuration cancelled", "info");
        return;
      }
      if (reloadLevels) {
        const probed = await probeModelLevels(endpoint, modelId, levelCandidates, true);
        if (probed?.length) {
          config.models[modelId] = { ...getOrDefaultModelConfig(modelId, maxModelLen), ...config.models[modelId], thinkingLevels: probed };
          saveConfig(config);
          perModelLevels[modelId] = probed;
          ctx.ui.notify(`Stored thinking levels for ${modelId}: ${probed.join(", ")}`, "success");
        } else {
          ctx.ui.notify("Could not determine thinking levels from the server", "warning");
        }
      }

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

      await switchToModel(pi, ctx, modelId, result, endpoint, availableModels, schemaLevels, perModelLevels);
    },
  });
}



// Save config, (re)register all known models, remember the choice, switch to it.
async function switchToModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  modelId: string,
  result: VllmConfig["models"][string],
  endpoint: string,
  served: ServedModel[],
  servedLevels: string[] | null,
  perModelLevels: { [id: string]: string[] | null }
): Promise<void> {
  const config = loadConfig();
  config.endpoint = endpoint;
  config.models[modelId] = { ...getOrDefaultModelConfig(modelId), ...config.models[modelId], ...result };
  saveConfig(config);

  // Must pass `served`: re-registering with [] falls back to the saved set and
  // puts every historical model back into pi's registry.
  const models = buildModelRegistry(config, served, servedLevels, perModelLevels);
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
