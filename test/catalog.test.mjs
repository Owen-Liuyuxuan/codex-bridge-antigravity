import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cachedAgyModels, refreshModelCatalog } from "../src/catalog.mjs";
import { catalogPath, defaultConfig } from "../src/config.mjs";

test("refresh reconciles additions and removals while keeping each failed provider's last good rows", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-catalog-"));
  const oldHome = process.env.CODEX_ANTIGRAVITY_HOME;
  process.env.CODEX_ANTIGRAVITY_HOME = dir;
  t.after(() => {
    if (oldHome === undefined) delete process.env.CODEX_ANTIGRAVITY_HOME;
    else process.env.CODEX_ANTIGRAVITY_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const agyPath = join(dir, "agy");
  const config = defaultConfig({ agyPath });
  const setAgy = script => writeFileSync(agyPath, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  const native = slug => ({
    slug, display_name: slug, visibility: "list",
    supported_reasoning_levels: [{ effort: "low", description: "Low" }], extra: { keep: true },
  });
  const makeCatalog = row => async () => ({ tag: "native metadata", models: [row, row] });
  const offline = async () => { throw new Error("offline"); };
  const slugs = result => result.catalog.models.map(row => row.slug);

  setAgy("printf 'gemini-4-argon-low\\tArgon Low\\n'");
  const first = await refreshModelCatalog(config, { fetchNativeCatalog: makeCatalog(native("gpt-old")) });
  assert.deepEqual(slugs(first), ["gpt-old", "antigravity/gemini-4-argon-low"]);

  const futureModel = "gemini-5.1-example-family-max";
  const futureOrchestrator = "gemini-pro-orchestrator-example-family";
  const futureRoutes = [futureModel, futureOrchestrator].map(id => `antigravity/${id}`);
  setAgy(`printf '${futureModel}\\tFuture model\\n${futureOrchestrator}\\tFuture orchestrator\\nclaude-opus-5-5-high\\tClaude\\n'`);
  const agyUpdate = await refreshModelCatalog(config, { fetchNativeCatalog: offline });
  assert.deepEqual(slugs(agyUpdate), ["gpt-old", ...futureRoutes]);
  assert.deepEqual(agyUpdate.catalog.models.slice(1).map(row => row.default_reasoning_level), ["max", "medium"]);
  assert.equal(agyUpdate.catalog.tag, "native metadata");

  setAgy("exit 1");
  const newNative = native("gpt-new");
  const codexUpdate = await refreshModelCatalog(config, { fetchNativeCatalog: makeCatalog(newNative) });
  assert.deepEqual(slugs(codexUpdate), ["gpt-new", ...futureRoutes]);
  assert.deepEqual(codexUpdate.catalog.models[0], newNative);
  assert.deepEqual(cachedAgyModels().map(row => row.id), [futureModel, futureOrchestrator]);
  assert.deepEqual(JSON.parse(readFileSync(catalogPath(), "utf8")), codexUpdate.catalog);

  const before = statSync(catalogPath(), { bigint: true });
  setAgy("printf 'Unexpected output\\n'");
  const unchanged = await refreshModelCatalog(config, { fetchNativeCatalog: offline });
  assert.equal(unchanged.refreshed, false);
  assert.equal(unchanged.changed, false);
  assert.equal(statSync(catalogPath(), { bigint: true }).mtimeNs, before.mtimeNs);

  setAgy("printf 'claude-opus-5-5-high\\tClaude\\ngemini-3.1-pro-high\\tOld Gemini\\n'");
  const retired = await refreshModelCatalog(config, { fetchNativeCatalog: offline });
  assert.deepEqual(slugs(retired), ["gpt-new"]);
  assert.deepEqual(cachedAgyModels(), []);

  setAgy("exit 1");
  const staleConfig = { ...config, models: [{ id: futureModel, displayName: "Old cached model" }] };
  const afterOutage = await refreshModelCatalog(staleConfig, { fetchNativeCatalog: offline });
  assert.deepEqual(slugs(afterOutage), ["gpt-new"]);
  assert.equal(afterOutage.changed, false);
});

test("fresh setup leaves Codex config intact if there is no usable native catalog", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-setup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codexHome = join(dir, "codex");
  const bridgeHome = join(dir, "bridge");
  const agyPath = join(dir, "agy");
  mkdirSync(codexHome);
  const configPath = join(codexHome, "config.toml");
  const originalConfig = 'model = "gpt-test"\n';
  writeFileSync(configPath, originalConfig);
  writeFileSync(agyPath, "#!/bin/sh\nprintf 'gemini-4-neon-low\\tNeon\\n'\n", { mode: 0o700 });

  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, "setup", "--agy-path", agyPath], {
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_ANTIGRAVITY_HOME: bridgeHome, CODEX_MODEL_CATALOG: "" },
  }), { stderr: /No usable native Codex catalog is available for setup/ });
  assert.equal(readFileSync(configPath, "utf8"), originalConfig);
  assert.equal(existsSync(bridgeHome), false);
});
