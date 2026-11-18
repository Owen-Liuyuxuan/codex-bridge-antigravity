import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  const native = slug => ({ slug, supported_reasoning_levels: [{ effort: "low", description: "Low" }], extra: { keep: true } });
  const makeCatalog = row => async () => ({ tag: "native metadata", models: [row, row] });
  const offline = async () => { throw new Error("offline"); };
  const slugs = result => result.catalog.models.map(row => row.slug);

  setAgy("printf 'gemini-4-argon-low\\tArgon Low\\n'");
  const first = await refreshModelCatalog(config, { fetchNativeCatalog: makeCatalog(native("gpt-old")) });
  assert.deepEqual(slugs(first), ["gpt-old", "antigravity/gemini-4-argon-low"]);

  setAgy("printf 'gemini-4-hydrogen-high\\tHydrogen High\\nclaude-opus-5-5-high\\tClaude\\n'");
  const agyUpdate = await refreshModelCatalog(config, { fetchNativeCatalog: offline });
  assert.deepEqual(slugs(agyUpdate), ["gpt-old", "antigravity/gemini-4-hydrogen-high"]);
  assert.equal(agyUpdate.catalog.tag, "native metadata");

  setAgy("exit 1");
  const newNative = native("gpt-new");
  const codexUpdate = await refreshModelCatalog(config, { fetchNativeCatalog: makeCatalog(newNative) });
  assert.deepEqual(slugs(codexUpdate), ["gpt-new", "antigravity/gemini-4-hydrogen-high"]);
  assert.deepEqual(codexUpdate.catalog.models[0], newNative);
  assert.deepEqual(cachedAgyModels(), [{ id: "gemini-4-hydrogen-high", displayName: "Hydrogen High" }]);
  assert.deepEqual(JSON.parse(readFileSync(catalogPath(), "utf8")), codexUpdate.catalog);

  const before = statSync(catalogPath(), { bigint: true });
  setAgy("printf 'Unexpected output\\n'");
  const unchanged = await refreshModelCatalog(config, { fetchNativeCatalog: offline });
  assert.equal(unchanged.refreshed, false);
  assert.equal(unchanged.changed, false);
  assert.equal(statSync(catalogPath(), { bigint: true }).mtimeNs, before.mtimeNs);
});
