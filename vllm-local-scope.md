# vLLM Local Extension - Scope Document

## Overview

This document defines the requirements and design constraints for a pi extension that provides a single `/vllm` command to discover, configure, and switch to models running on a local vLLM API server.

## Requirements

### 1. Single `/vllm` Command

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

### 2. Configuration File

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

### 3. Automatic Discovery on `/vllm`

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

### 4. Configuration Editor

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

### 5. Configuration Persistence

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

### 6. Model Switching

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

### 7. No `/model` Interaction

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

## Out of Scope

The following are explicitly out of scope for this extension:

1. **Provider Registration**: Extension does NOT register `vllm-local` as a provider
2. **Automatic Discovery at Startup**: Models are only discovered when `/vllm` is invoked
3. **Multiple Endpoints**: Only one endpoint is configurable
4. **API Key Management**: Single API key for all models
5. **Model Categories**: No grouping or organization of models
6. **Recent Models**: No history of recently used models
7. **Config Profiles**: No save/load of configuration profiles

## Implementation Constraints

### Environment
- Node.js runtime (pi's extension environment)
- pi-coding-agent TypeScript API
- TUI mode required (command doesn't work in CLI mode)

### File System
- Configuration stored in user's home directory
- No project-level configuration (user-level only)
- File must be JSON format

### API Compatibility
- vLLM API must expose `/v1/models` endpoint
- Model discovery uses standard OpenAI-compatible API format
- Configuration uses pi's provider model format

## Success Criteria

The extension is successful when:

1. User can run `/vllm` from any model
2. Extension queries local vLLM API and shows model list
3. User can select a model from the list
4. Configuration editor shows sensible defaults
5. User can edit configuration and save
6. Configuration is persisted to `~/.pi/agent/vllm-local.json`
7. pi switches to the selected model
8. No interference with pi's `/model` command
9. Error cases are handled gracefully
10. Documentation is clear and complete

## Future Enhancements

Potential improvements (not in current scope):

1. **Refresh button** to re-query API without restarting
2. **Config profiles** to save/load configurations
3. **API key per model** for different authentication
4. **Model categories** for organization
5. **Recent models** list for quick access
6. **Model filtering** to search through available models
7. **Custom endpoints** per model (not just global)
