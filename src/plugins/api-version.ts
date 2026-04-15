/**
 * Hive plugin API version. Plugins declare a compatibility range in their
 * plugin.yaml under `hiveApi:` (e.g. "^1.0.0"). The loader skips plugins
 * whose declared range does not include this version. Bump the major when a
 * change to the plugin contract (manifest schema, agent-env resolver, base
 * env var set) breaks existing plugins.
 */
export const HIVE_PLUGIN_API_VERSION = "1.0.0";
