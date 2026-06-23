# vLLM Local Extension - Complete Documentation

This document combines the scope definition and implementation details for the PI extension that provides a `/vllm` command to discover, configure, and switch to models running on a local vLLM API server.

# Overview

This document defines the requirements, design constraints, and technical implementation for a pi extension that provides a single `/vllm` command that:
- Queries local vLLM API for available models
- Shows TUI menu of available models
- Allows user to select a model
- Shows configuration editor for selected model
- Saves configuration to file
- Switches to selected model (replacing current model)

# Requirements

## 1. Single `/vllm` Command
**Requirement**: Provide a single `/vllm` command that handles all vLLM model operations.

**Scope**:
- Command is triggered by typing `/vllm` in pi's TUI
- No automatic discovery at startup
- No interaction with pi's `/model` selector
- User explicitly triggers discovery via `/vllm` command

**Behavior**:
1. Queries local vLLM API (`${endpoint}/models`)
2. Shows TUI menu of available models
3. Allows user to select a model
4. Shows configuration editor for selected model
5. Saves configuration to file
6. Switches to selected model (replacing current model)

## 2. Configuration File
**Requirement**: Store configuration in `~/.pi/agent/vllm-local.json` (user-level only).

**Structure**:
```json
{
  "endpoint": "http://localhost:11434/v1",
  "defaults": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": false,
    "maxTokensField": "max_tokens",
    "requiresAssistantAfterToolResult": false,
    "requiresToolResultName": false,
    "supportsStore": false
  },
  "models": {
    "<model-id>": {
      "api": "openai-completions",
      "reasoning": true,
      "contextWindow": 128000,
      "maxTokens": 16384,
      "thinkingFormat": "deepseek" | "qwen-chat-template" | null
    }
  }
}
```

**Fields**:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `endpoint` | string | No | `http://localhost:11434/v1` | vLLM API endpoint |
| `defaults` | object | No | See above | API compatibility settings |
| `models` | object | No | `{}` | Model-specific configuration |

**Model Configuration**:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `api` | string | No | `openai-completions` | API compatibility layer |
| `reasoning` | boolean | No | `true` | Supports extended thinking |
| `contextWindow` | number | No | `128000` | Context window in tokens |
| `maxTokens` | number | No | `16384` | Maximum generation tokens |
| `thinkingFormat` | string | No | `null` | Thinking format option |

## 3. Automatic Discovery on `/vllm`
**Requirement**: Query local vLLM API when `/vllm` is invoked.

**Behavior**:
- Extension does NOT discover models at startup
- Discovery happens only when user runs `/vllm` command
- Configuration file is updated with discovered models
- Default configuration is created if file doesn't exist

**API Call**:
```bash
curl ${endpoint}/models
```

Expected response:
```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-chat",
      "object": "model",
      "created": 1234567890,
      "owned_by": "vllm",
      "context_window": 128000,
      "max_tokens": 16384
    }
  ]
}
```

## 4. Configuration Editor
**Requirement**: Show TUI form to edit model configuration.

**Form Fields**:
1. **API Type**: Select from dropdown (`openai-completions`, `openai-responses`, `anthropic-messages`)
2. **Reasoning**: Toggle switch (enabled/disabled)
3. **Context Window**: Number input with min/max/step
4. **Max Tokens**: Number input with min/max/step
5. **Thinking Format**: Select from dropdown (`null`, `deepseek`, `qwen-chat-template`)

**Default Values**:
- Load from configuration file if model exists
- Use heuristics to detect capabilities from model name
- Apply defaults for missing fields

**Heuristics**:
| Model ID Pattern | `thinkingFormat` |
|------------------|------------------|
| `*deepseek*` | `"deepseek"` |
| `*qw*` | `"qwen-chat-template"` |
| Other | `null` |

## 5. Configuration Persistence
**Requirement**: Save configuration changes to file.

**Behavior**:
- Configuration is saved immediately after editing
- File is created if it doesn't exist
- Defaults are written to new files
- Model-specific config is merged with defaults

**File Location**: `~/.pi/agent/vllm-local.json`

**Error Handling**:
- Log errors if file cannot be written
- Continue with in-memory config if save fails
- Show error message to user

## 6. Model Switching
**Requirement**: Switch to the selected model.

**Behavior**:
- User can run `/vllm` from ANY model (any provider)
- Switching replaces current model
- No requirement to stay in vLLM provider
- Configuration is saved before switching

**Switching Process**:
1. User is currently using model X (any provider)
2. User runs `/vllm`
3. User selects model Y from vLLM
4. Configuration for Y is loaded/saved
5. pi replaces model X with model Y
6. User is now using model Y

## 7. No `/model` Interaction
**Requirement**: Extension does NOT use pi's `/model` selector.

**What this means**:
- Extension does NOT register `vllm-local` as a provider
- Extension does NOT interact with `/model` command
- Extension does NOT auto-populate models into `/model`
- All model selection happens via `/vllm` command only

**Why**:
- `/model` is a built-in pi command, not easily interceptable
- Complex interaction between extension and built-in command
- Single dedicated command is simpler and more predictable

# Technical Implementation

## Key Functions

### `discoverModels(endpoint)`
- Fetches model list from vLLM `/v1/models` endpoint
- Maps `max_model_len` → `contextWindow`
- Sets `maxTokens` to 16384 (default fallback)
- Returns array of model objects with: `id`, `name`, `max_model_len`, `context_window`, `max_tokens`

### `getOrDefaultModelConfig(modelId, maxModelLen?)`
- Returns model configuration for a given modelId
- Priority: Saved config > Heuristic detection > Hardcoded defaults
- Heuristic detection via `detectCapabilities()`:
  - `"deepseek"` in modelId → `thinkingFormat: "deepseek"`
  - `"qw"` in modelId → `thinkingFormat: "qwen-chat-template"`
  - Else: `thinkingFormat: null`
- Applies `maxModelLen` (from vLLM) to `contextWindow` if provided
- Uses hardcoded defaults for other fields:
  ```typescript
  const DEFAULT_MODEL_CONFIG = {
    api: "openai-completions" as const,
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 16384,
    thinkingFormat: null as "deepseek" | "qwen-chat-template" | null,
  };
  ```

## Model Configuration Persistence
- Saved to: `~/.pi/agent/vllm-local.json`
- Structure matches the specification above

## Model Registration & Switching
Two code paths exist:
1. **Accept Path** (user accepts preview): Calls `switchToModel()`
2. **Reject Path** (user modifies config): Inline model registration

Both paths create a `modelObj`:
```typescript
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
    thinkingFormat: result.thinkingFormat, // Moved to compat object
  },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: result.contextWindow,
  maxTokens: result.maxTokens,
};
```

Then:
```typescript
pi.registerProvider("vllm-local", {
  baseUrl: endpoint,
  apiKey: "local-model",
  api: result.api,
  models: [modelObj],
});
const success = await pi.setModel(modelObj);
```

## Data Flow Summary

1. **Config Load**: `loadConfig()` merges file contents with `DEFAULT_CONFIG`
2. **Model Selection**: User chooses from discovered models
3. **Config Resolution**: 
   - `currentConfigValue = config.models[modelId] || getOrDefaultModelConfig(modelId, maxModelLen)`
4. **User Interaction**: Preview shows current config; user accepts or modifies
5. **Result Usage**: 
   - Accept: `result = currentConfigValue`
   - Reject: `result` built from user selections
6. **Persistence**: 
   - Ensure model entry exists: `if (!config.models[modelId]) config.models[modelId] = getOrDefaultModelConfig(...)`
   - Merge result: `config.models[modelId] = { ...config.models[modelId], ...result }`
   - Save: `saveConfig(config)`
7. **Model Registration**: Build `modelObj` from `result`, register provider, call `pi.setModel()`

## Current State

The extension successfully implements all requirements with the following behavior:

### Model Discovery
- Queries `http://localhost:11434/v1/models` (configurable endpoint)
- Maps vLLM's `max_model_len` field to `contextWindow` in the model configuration
- Sets `maxTokens` to 16384 as a safe default (vLLM API doesn't expose this)

### Configuration Flow
1. User runs `/vllm` command
2. Extension loads saved config from `~/.pi/agent/vllm-local.json`
3. Discovers available models from vLLM API
4. User selects a model from the interactive menu
5. For the selected model:
   - If saved config exists: use it as `currentConfigValue`
   - Else: use heuristic detection (`detectCapabilities()`) for thinkingFormat and default values
6. Displays configuration preview showing:
   - API Type (openai-completions/openai-responses/anthropic-messages)
   - Thinking Format (null/deepseek/qwen-chat-template)
   - Reasoning (on/off)
   - Context Window (tokens)
   - Max Tokens (tokens)
7. User can accept or modify the configuration
8. On acceptance:
   - Saves configuration to persistent storage
   - Creates a temporary provider with the model configuration
   - Switches PI to use the model via `pi.setModel()`

### Verification

The implementation passes TypeScript compilation (`npx tsc --noEmit`) and has been verified to:
- Correctly detect thinkingFormat from model names (deepseek/qwen patterns)
- Save and load per-model configurations from `vllm-local.json`
- Apply saved configurations when switching models
- Allow user overrides via the configuration menu
- Fall back to heuristic detection and defaults appropriately

## Current Limitations

1. **Global Defaults Unused**: The `config.defaults` object in the JSON file is never read - values like `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, and `maxTokensField` are hardcoded in the extension code instead of being read from config.

2. **ThinkingFormat Location**: Moved to `compat` object to align with where PI expects model-specific behavioral flags.

3. **SwitchToModel Reload**: The `switchToModel` function reloads the config from disk before merging, which could potentially override recent changes if not careful, but the current implementation preserves the user's selections.

## Files Modified

- `vllm-local.ts`: Main extension logic (all changes)
- No other files required

## Future Improvements

1. **Use `config.defaults`**: Read global defaults from the config file instead of hardcoding
2. **Enhanced Heuristics**: Improve model name pattern matching for thinkingFormat detection
3. **API Selection**: Allow users to select between openai-completions/openai-responses/anthropic-messages
4. **Error Handling**: Improve validation of vLLM API responses and network error handling
5. **Configuration Validation**: Add validation for saved config values before applying

## Installation & Usage

1. Install: `pi extension install @ai4ci/pi-vllm`
2. Configure endpoint (if needed): Edit `~/.pi/agent/vllm-local.json` 
3. Run: `/vllm` in PI TUI
4. Select model from discovered list
5. Accept or modify configuration as needed
6. Extension will switch PI to use the selected model with the applied configuration

--- 
Document last updated: 2026-06-19
Extension version: 1.0.0
---