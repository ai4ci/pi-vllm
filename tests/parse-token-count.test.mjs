import assert from "node:assert/strict";
import { parseTokenCount, buildModelRegistry } from "../vllm-local.ts";

assert.equal(parseTokenCount("64K"), 65536);
assert.equal(parseTokenCount("64k"), 65536);
assert.equal(parseTokenCount(" 128K "), 131072);
assert.equal(parseTokenCount("1M"), 1048576);
assert.equal(parseTokenCount("2m"), 2097152);
assert.equal(parseTokenCount("131072"), 131072);
assert.equal(parseTokenCount("0.5K"), 512);
assert.ok(Number.isNaN(parseTokenCount("64KB")));
assert.ok(Number.isNaN(parseTokenCount("abc")));
assert.ok(Number.isNaN(parseTokenCount("")));
console.log("parseTokenCount ok");

// buildModelRegistry: saved values win, newly-served models get heuristics + live max_model_len
const cfg = {
  endpoint: "http://x/v1",
  defaults: {},
  models: {
    "old-model": { api: "anthropic-messages", reasoning: false, contextWindow: 999, maxTokens: 111, thinkingFormat: null, temperatureScale: 1 },
  },
};
const served = [
  { id: "old-model", max_model_len: 65536 },
  { id: "new-deepseek-v3", max_model_len: 131072 },
];
const models = buildModelRegistry(cfg, served);
assert.deepEqual(models.map((m) => m.id).sort(), ["new-deepseek-v3", "old-model"]);
const old = models.find((m) => m.id === "old-model");
assert.equal(old.contextWindow, 999); // saved value wins over server
assert.equal(old.api, "anthropic-messages");
const fresh = models.find((m) => m.id === "new-deepseek-v3");
assert.equal(fresh.contextWindow, 131072); // server value
assert.equal(fresh.maxTokens, 8192); // max_model_len / 16
assert.equal(fresh.compat.thinkingFormat, "deepseek"); // autodetect heuristic
console.log("buildModelRegistry ok");
