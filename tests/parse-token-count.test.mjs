import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTokenCount, buildModelRegistry, endpointForPort, distinctServedModels, thinkingLevelMapFrom, shouldDropEffort, VERSION, LOADED_BUILD } from "../vllm-local.ts";

assert.equal(endpointForPort("8000"), "http://localhost:8000/v1");
assert.equal(endpointForPort(8000), "http://localhost:8000/v1");
assert.equal(endpointForPort("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1");
assert.equal(endpointForPort("", "http://localhost:11434/v1"), "http://localhost:11434/v1");
console.log("endpointForPort ok");

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
assert.equal(fresh.provider, "vllm-local"); // setModel resolves auth via model.provider
assert.equal(fresh.contextWindow, 131072); // server value
assert.equal(fresh.maxTokens, 8192); // max_model_len / 16
assert.equal(fresh.compat.thinkingFormat, "deepseek"); // autodetect heuristic

// Regression: the registry must mirror the server, not accumulate every model
// ever configured. Registering the union left stale models selectable and
// resumable forever (a 20-entry config registered 22 models against a server
// that served 3).
assert.ok(!buildModelRegistry(cfg, [{ id: "new-deepseek-v3", max_model_len: 131072 }])
  .some((m) => m.id === "old-model"), "unserved saved model must not be registered");

// ...but with the server unreachable we fall back to the saved set, so pi can
// still bind a restored vllm-local model on resume.
assert.deepEqual(buildModelRegistry(cfg, []).map((m) => m.id), ["old-model"]);
console.log("buildModelRegistry ok");

// vLLM serves one model under several ids sharing a `root`; alias count is not
// model count. Treating it as such broke single-model auto-adopt at session_start.
const aliases = [
  { id: "deepseek-ai/DeepSeek-V4.1-Flash", root: "deepseek-ai/DeepSeek-V4.1-Flash" },
  { id: "default", root: "deepseek-ai/DeepSeek-V4.1-Flash" },
  { id: "ds41flash", root: "deepseek-ai/DeepSeek-V4.1-Flash" },
];
assert.equal(distinctServedModels(aliases).length, 1);
assert.equal(distinctServedModels(aliases)[0].id, "deepseek-ai/DeepSeek-V4.1-Flash"); // canonical id preferred
// "default" only wins when it is the sole alias for that root
assert.equal(distinctServedModels([{ id: "default", root: "some/model" }])[0].id, "default");
// genuinely distinct roots stay distinct
assert.equal(distinctServedModels([
  { id: "a", root: "org/a" },
  { id: "b", root: "org/b" },
]).length, 2);
// ids with no root reported (non-vLLM servers) are treated as distinct models
assert.equal(distinctServedModels([{ id: "x" }, { id: "y" }]).length, 2);
console.log("distinctServedModels ok");

// The server's reasoning_effort enum (server-wide) drives which thinking levels
// pi advertises. Levels the server rejects are hidden (null) rather than sent.
assert.deepEqual(thinkingLevelMapFrom(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
// A narrower server enum hides the gradations it does not accept.
assert.deepEqual(thinkingLevelMapFrom(["low", "medium", "high"]),
  { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null });
// No "none" in the enum: leave off unmapped so pi uses its per-format disable.
assert.ok(!("off" in thinkingLevelMapFrom(["high"])));
console.log("thinkingLevelMapFrom ok");

// buildModelRegistry applies the server-derived map to reasoning models only,
// and an explicit per-model config map always wins.
const levelled = buildModelRegistry(cfg, [{ id: "new-deepseek-v3", max_model_len: 131072 }], ["none", "high"]);
assert.deepEqual(levelled[0].thinkingLevelMap,
  { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
const nonReasoning = buildModelRegistry(cfg, [{ id: "old-model", max_model_len: 65536 }], ["none", "high"]);
assert.equal(nonReasoning[0].thinkingLevelMap, undefined); // reasoning:false in cfg
const overridden = buildModelRegistry(
  { ...cfg, models: { m: { api: "openai-completions", reasoning: true, contextWindow: 1, maxTokens: 1, temperatureScale: 1, thinkingLevelMap: { off: null, high: "high" } } } },
  [{ id: "m", max_model_len: 1 }], ["none", "high"]);
assert.deepEqual(overridden[0].thinkingLevelMap, { off: null, high: "high" }); // config wins
console.log("buildModelRegistry thinkingLevelMap ok");

// The schema enum is only a candidate list; the per-model probed set wins, and a
// null (undetermined) per-model result falls back to the schema universe.
const perModel = buildModelRegistry(cfg, [{ id: "m", max_model_len: 1 }], ["none", "high"], { m: ["none", "low", "high"] });
assert.deepEqual(perModel[0].thinkingLevelMap,
  { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
const fellBack = buildModelRegistry(cfg, [{ id: "m", max_model_len: 1 }], ["none", "high"], { m: null });
assert.deepEqual(fellBack[0].thinkingLevelMap, { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
console.log("buildModelRegistry per-model levels ok");

// Levels stored on the model config (vllm-local.json) win over a fresh probe and
// the schema set, so boots don't re-probe; an explicit thinkingLevelMap still wins.
const withStored = (extra) => ({ api: "openai-completions", reasoning: true, contextWindow: 1, maxTokens: 1, temperatureScale: 1, ...extra });
const cached = buildModelRegistry(
  { ...cfg, models: { m: withStored({ thinkingLevels: ["none", "low", "high"] }) } },
  [{ id: "m", max_model_len: 1 }], ["none", "high"], { m: null });
assert.deepEqual(cached[0].thinkingLevelMap,
  { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
const explicitWins = buildModelRegistry(
  { ...cfg, models: { m: withStored({ thinkingLevels: ["none", "low", "high"], thinkingLevelMap: { off: null, high: "high" } }) } },
  [{ id: "m", max_model_len: 1 }], null, { m: null });
assert.deepEqual(explicitWins[0].thinkingLevelMap, { off: null, high: "high" });
console.log("buildModelRegistry stored levels ok");

// pi sends `map[level] ?? level`, so a hidden level still goes out under its own
// name. shouldDropEffort is the last line of defence before the 400.
assert.equal(shouldDropEffort("medium", { off: "none", medium: null, high: "high" }), true);
assert.equal(shouldDropEffort("high", { off: "none", medium: null, high: "high" }), false);
assert.equal(shouldDropEffort("none", { off: "none", medium: null }), false); // mapped wire value, not a hidden level
assert.equal(shouldDropEffort("medium", undefined, ["none", "low", "high"]), true); // schema fallback rejects it
assert.equal(shouldDropEffort("high", undefined, ["none", "low", "high"]), false);
assert.equal(shouldDropEffort("medium", undefined, null), false); // nothing known, don't guess
console.log("shouldDropEffort ok");

// /vllm --version reports the release and a content hash of the loaded file.
assert.equal(VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
assert.match(LOADED_BUILD, /^[0-9a-f]{12}$/);
console.log(`version ok (${VERSION} build ${LOADED_BUILD})`);
