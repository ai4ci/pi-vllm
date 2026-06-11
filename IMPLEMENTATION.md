# vLLM Extension - Implementation Details

## Overview

The extension implements a single `/vllm` command that provides a complete workflow for discovering, selecting, configuring, and switching to vLLM models.

## Implementation

### Single Command Approach

```typescript
pi.registerCommand("vllm", {
  description: "Switch to a vLLM model and configure it",
  handler: async (args, ctx) => {
    // 1. Load config to get endpoint
    // 2. Discover models from vLLM API
    // 3. Show model selection menu
    // 4. Show configuration menu
    // 5. Save config
    // 6. Switch to selected model
  }
});
```

### No Provider Registration

The extension **does NOT** register a provider. This means:
- vLLM models don't appear in `/model` dialog
- No need to manage provider lifecycle
- Simpler code and fewer edge cases

### Configuration Management

1. **loadConfig()**: Reads from `~/.pi/agent/vllm-local.json`
2. **saveConfig()**: Writes configuration to file
3. **getOrDefaultModelConfig()**: Returns defaults with heuristic detection
4. **detectCapabilities()**: Detects thinking format from model name

### TUI Flow

```
/vllm command
    ↓
Query vLLM API for models
    ↓
Show model selection menu
    ↓
User selects model
    ↓
Show configuration menu for selected model
    ↓
User edits configuration
    ↓
Save to config file
    ↓
Switch to selected model via pi.setModel()
```

### Model Switching

Uses `pi.setModel(selectedModelId)` to switch models:
- pi handles all the details (API key lookup, provider lookup)
- Works with any model ID registered in pi's configuration
- Returns success/failure status

## Files

```
.pi/extensions/
├── vllm-local.ts              # Main extension (277 lines)
├── vllm-local-scope.md        # Requirements (user-provided)
├── README.md                  # User documentation
└── default-config.json        # Default provider configuration
```

## Key Decisions

### Why No Provider Registration?

1. **Simpler**: No need to manage provider lifecycle
2. **Cleaner**: vLLM models don't clutter `/model` list
3. **Explicit**: User consciously chooses to use `/vllm`
4. **Less code**: Fewer edge cases to handle

### Why Single Command?

1. **One workflow**: Everything in one place
2. **No coordination**: No need for discovery + selection separate
3. **Easy to use**: Single command does everything
4. **Easy to maintain**: Less code, fewer bugs

### Why Config File on Save?

1. **Persistence**: Configuration survives restarts
2. **User editable**: Users can tweak config directly
3. **Per-model**: Each model has its own config
4. **Defaults first**: Auto-populates with heuristics
