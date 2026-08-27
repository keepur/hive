// KPR-394 fixture entry — the shape a real provider plugin's compiled
// dist/provider.js has. Factory + kit round-trip + fake adapter.
export function createProviderModule(kit) {
  if (kit.abiVersion !== 1) {
    throw new Error(`fixture built for provider ABI 1, engine offers ${kit.abiVersion}`);
  }
  const constructions = [];
  const module = {
    provider: "sol",
    createAdapter(args) {
      constructions.push(args);
      return {
        provider: "sol",
        wasAborted: false,
        abort() {},
        async runTurn() {
          return {
            text: `sol turn ok (model=${args.route.model ?? ""})`,
            sessionId: "",
            costUsd: 0,
            durationMs: 1,
            llmMs: 1,
            toolMs: 0,
            toolCalls: 0,
            toolSummary: "",
            streamed: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 0,
            compactions: 0,
          };
        },
      };
    },
  };
  // Test observability only.
  module.__constructions = constructions;
  module.__kit = kit;
  return module;
}
