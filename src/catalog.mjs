import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, catalogPath, codexHome } from "./config.mjs";
import {
  agyModelId, buildCodexCatalog, discoverAgyModels, isAllowedAgyModel,
  isAntigravityModel, nativeCatalogRows,
} from "./models.mjs";
import { DEFAULT_NATIVE_BASE_URL, fetchNative } from "./native.mjs";

const execFileAsync = promisify(execFile);
const desktopBinaries = [
  "/usr/lib/chatgpt/resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  join(homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
  join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
];

function readCatalog(path) {
  try {
    const text = readFileSync(path, "utf8");
    const catalog = JSON.parse(text);
    if (Array.isArray(catalog?.models)) return { text, catalog };
  } catch {
    // A missing or malformed snapshot cannot seed a refresh.
  }
  return {};
}

function seedNativeCatalog() {
  const candidates = [
    join(codexHome(), "opencodex-catalog.json"),
    join(codexHome(), "models_cache.json"),
    join(homedir(), ".codex-freebuff-web", "codex", "model-catalog.json"),
  ];
  for (const path of candidates) {
    const { catalog } = readCatalog(path);
    if (catalog && nativeCatalogRows(catalog.models).length) return catalog;
  }
}

export function cachedAgyModels(catalog = readCatalog(catalogPath()).catalog) {
  if (!catalog) return undefined;
  const models = catalog.models
    .filter(row => isAntigravityModel(row?.slug) && isAllowedAgyModel(row.slug)
      && typeof row.display_name === "string")
    .map(row => ({ id: agyModelId(row.slug), displayName: row.display_name }));
  return models.length ? models : undefined;
}

async function fetchCodexCatalog(config) {
  const pinnedPath = process.env.CODEX_MODEL_CATALOG?.trim();
  if (pinnedPath) {
    const { catalog } = readCatalog(pinnedPath);
    if (!catalog || !nativeCatalogRows(catalog.models).length) {
      throw new Error("CODEX_MODEL_CATALOG does not contain any native Codex models");
    }
    return catalog;
  }

  if (config.nativeBaseUrl.replace(/\/+$/, "") !== DEFAULT_NATIVE_BASE_URL) {
    throw new Error("Live Codex catalog discovery requires the default ChatGPT endpoint");
  }

  let tokens;
  try {
    ({ tokens } = JSON.parse(readFileSync(join(codexHome(), "auth.json"), "utf8")));
  } catch {
    throw new Error("Codex file-backed ChatGPT sign-in is unavailable");
  }
  if (typeof tokens?.access_token !== "string" || !tokens.access_token) {
    throw new Error("Codex auth.json has no ChatGPT access token");
  }

  const binary = config.codexBinary || desktopBinaries.find(existsSync) || "codex";
  const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 5_000 });
  const version = /^codex-cli (\d+\.\d+\.\d+)([-+][\w.+-]+)?\s*$/.exec(stdout);
  if (!version) throw new Error("Unable to determine the installed Codex client version");
  const response = await fetchNative({
    config,
    endpoint: "models",
    req: {
      url: `/v1/models?client_version=${version[1]}`,
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        ...(tokens.account_id ? { "chatgpt-account-id": tokens.account_id } : {}),
        originator: "codex_cli_rs",
        "user-agent": `codex_cli_rs/${version[1]}${version[2] || ""}`,
      },
    },
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ChatGPT catalog returned HTTP ${response.status}`);
  }
  const catalog = await response.json();
  if (!Array.isArray(catalog?.models) || !catalog.models.length || catalog.models.some(row =>
    typeof row?.slug !== "string" || !row.slug || typeof row.display_name !== "string"
    || typeof row.visibility !== "string" || !Array.isArray(row.supported_reasoning_levels)
  ) || !nativeCatalogRows(catalog.models).length) {
    throw new Error("ChatGPT returned an unusable model catalog");
  }
  return catalog;
}

export async function refreshModelCatalog(config, { fetchNativeCatalog = fetchCodexCatalog } = {}) {
  const [native, agy] = await Promise.allSettled([
    fetchNativeCatalog(config),
    discoverAgyModels(config.agyPath, { allowFallback: false }).then(models => {
      if (!models.length) throw new Error("agy models returned no supported entries");
      return models;
    }),
  ]);
  for (const [provider, result] of [["Codex", native], ["Antigravity", agy]]) {
    if (result.status === "rejected") {
      console.error(`Warning: ${provider} catalog refresh failed (${result.reason.message}). Using available cached entries.`);
    }
  }

  // Read the published snapshot after both requests finish so a manual refresh
  // can provide the fallback for a provider that failed during this run.
  const path = catalogPath();
  const previous = readCatalog(path);
  const models = agy.status === "fulfilled" ? agy.value : cachedAgyModels(previous.catalog) || config.models;
  const oldNative = previous.catalog && nativeCatalogRows(previous.catalog.models).length
    ? previous.catalog : seedNativeCatalog();
  const catalog = buildCodexCatalog(models, native.status === "fulfilled" ? native.value : oldNative);
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  const changed = text !== previous.text;
  if (changed) atomicWrite(path, text);
  return { catalog, models, changed, refreshed: native.status === "fulfilled" || agy.status === "fulfilled" };
}
