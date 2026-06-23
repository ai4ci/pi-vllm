# vLLM Extension - User Guide

## Overview

The vLLM extension provides a single `/vllm` command that lets you:
- Discover models available on your local vLLM server
- Select which model to use
- Configure model-specific settings
- Switch to the selected model

**Note**: This extension does NOT register a provider, so vLLM models do not appear in pi's built-in `/model` dialog. All model selection happens via the `/vllm` command.

## Installation

The extension is automatically loaded from `.pi/extensions/vllm-local.ts` when pi starts.

## Usage

### The `/vllm` Command

Run `/vllm` from anywhere in pi:

```
/vllm
```

This will:
1. Query your local vLLM server for available models
2. Show a menu of all discovered models
3. Let you select a model to switch to
4. Show a configuration menu for that model
5. Save the configuration
6. Switch to the selected model

### Configuration

Configuration is stored in `~/.pi/agent/vllm-local.json`:

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
    "meta-llama/Llama-3.1-8B-Instruct": {
      "api": "openai-completions",
      "reasoning": false,
      "contextWindow": 8192,
      "maxTokens": 4096,
      "temperatureScale": 1
    },
    "deepseek-ai/DeepSeek-R1": {
      "api": "openai-completions",
      "reasoning": true,
      "contextWindow": 65536,
      "maxTokens": 8192,
      "thinkingFormat": "deepseek",
      "temperatureScale": 1
    }
  }
}
```

### Model Configuration Options

- **API Type**: Which API to use (openai-completions, openai-responses, anthropic-messages)
- **Reasoning**: Whether the model supports extended thinking
- **Context Window**: Maximum context size in tokens
- **Max Tokens**: Maximum output tokens
- **Thinking Format**: How reasoning/thinking is formatted (deepseek, qwen-chat-template, or none)

- **Temperature Scale**: Multiplier applied to the model's temperature before each request (default: 1, range: > 0). A value of `0.5` halves the temperature, `2.0` doubles it.

### Model Detection Heuristics

The extension automatically sets default configuration based on model name patterns:

| Model Pattern | Thinking Format |
|--------------|-----------------|
| `*deepseek*` | `deepseek` |
| `*qw*` | `qwen-chat-template` |
| Other | none |

## Requirements

- A running vLLM server with OpenAI-compatible API
- The server must expose a `/models` endpoint
- Default endpoint: `http://localhost:11434/v1`

## Comparison with Built-in `/model`

| Feature | Built-in `/model` | `/vllm` Command |
|---------|------------------|-----------------|
| Shows vLLM models | Yes (if registered) | No |
| Manual model selection | Yes | Yes |
| Configurable settings | Limited | Full control |
| Provider registration | Required | Not needed |
| Model switching | Direct | Direct |

## Troubleshooting

### "No models found on vLLM server"

- Check that your vLLM server is running
- Verify the endpoint in the config file matches your server
- Test: `curl http://localhost:11434/v1/models`

### "Failed to switch to model"

- Check if the model ID is correct
- Ensure you have the appropriate API key configured
- The model might not be available on your vLLM server

### Configuration changes not taking effect

- Configuration is saved immediately
- Run `/vllm` again and re-select the model to verify
- Restart pi if you suspect caching issues
