#!/usr/bin/env npx tsx
/**
 * One-shot idempotent LiveKit SIP setup (KPR-322 §10 SIP-1..SIP-3).
 * Consumes KPR-321 §8 artifacts: termination URI + E.164 (hive.yaml
 * telephony.twilio.*), SIP credential values (Honeypot, resolved in-process,
 * never printed). Prints object IDs only. Re-runnable: existing objects
 * (matched by name) are reported and skipped.
 *
 * Usage: npx tsx scripts/livekit-setup.ts [--dry]
 */
import { RoomAgentDispatch, SipClient } from "livekit-server-sdk";
import { RoomConfiguration, SIPTransport } from "@livekit/protocol";
import { config } from "../src/config.js";
import { fromKeychain } from "../src/keychain/from-keychain.js";
import {
  planSetup,
  OUTBOUND_TRUNK_NAME,
  INBOUND_TRUNK_NAME,
  DISPATCH_RULE_NAME,
  ROOM_PREFIX,
  AGENT_NAME,
} from "../src/voice-worker/livekit-setup-plan.js";

const dry = process.argv.includes("--dry");

function honeypot(key: string): string {
  // argv-array subprocess via fromKeychain (repo security rule) — value never echoed.
  const instanceId = process.env.HIVE_INSTANCE_ID || config.instance.id || "hive";
  return fromKeychain(instanceId, key) || (process.env[key] ?? "");
}

async function main(): Promise<void> {
  const lk = config.voice.livekit;
  const twilio = config.telephony.twilio;
  const apiKey = config.voice.livekitApiKey || honeypot("LIVEKIT_API_KEY");
  const apiSecret = config.voice.livekitApiSecret || honeypot("LIVEKIT_API_SECRET");
  const trunkUser = honeypot("TWILIO_SIP_TRUNK_USERNAME");
  const trunkPass = honeypot("TWILIO_SIP_TRUNK_PASSWORD");

  const missing = Object.entries({
    "voice.livekit.url": lk.url,
    "telephony.twilio.number": twilio.number,
    "telephony.twilio.trunkDomain": twilio.trunkDomain,
    LIVEKIT_API_KEY: apiKey,
    LIVEKIT_API_SECRET: apiSecret,
    TWILIO_SIP_TRUNK_USERNAME: trunkUser,
    TWILIO_SIP_TRUNK_PASSWORD: trunkPass,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing inputs (config or Honeypot): ${missing.join(", ")}`);
    process.exit(1);
  }

  const sip = new SipClient(lk.url, apiKey, apiSecret);
  const plan = planSetup({
    outboundTrunks: (await sip.listSipOutboundTrunk()).map((t) => ({ sipTrunkId: t.sipTrunkId, name: t.name })),
    inboundTrunks: (await sip.listSipInboundTrunk()).map((t) => ({ sipTrunkId: t.sipTrunkId, name: t.name })),
    dispatchRules: (await sip.listSipDispatchRule()).map((r) => ({
      sipDispatchRuleId: r.sipDispatchRuleId,
      name: r.name,
    })),
  });

  // SIP-1: outbound trunk
  // livekit-server-sdk 2.14.1: CreateSipOutboundTrunkOptions.transport is required
  // when opts is provided (SDK only defaults SIP_TRANSPORT_AUTO if opts === undefined).
  let outboundId = plan.existingOutboundId;
  if (plan.createOutbound && !dry) {
    const t = await sip.createSipOutboundTrunk(OUTBOUND_TRUNK_NAME, twilio.trunkDomain, [twilio.number], {
      authUsername: trunkUser,
      authPassword: trunkPass,
      transport: SIPTransport.SIP_TRANSPORT_AUTO,
    });
    outboundId = t.sipTrunkId;
  }
  console.log(
    `SIP-1 outbound trunk: ${plan.createOutbound ? (dry ? "WOULD CREATE" : `created ${outboundId}`) : `exists ${outboundId}`}`,
  );

  // SIP-2: inbound trunk (restricted to our E.164; krisp-class NC ⚠ verify plan availability)
  let inboundId = plan.existingInboundId;
  if (plan.createInbound && !dry) {
    const t = await sip.createSipInboundTrunk(INBOUND_TRUNK_NAME, [twilio.number], {
      krispEnabled: true, // ⚠ ignore-if-unavailable on the pilot plan
    });
    inboundId = t.sipTrunkId;
  }
  console.log(
    `SIP-2 inbound trunk: ${plan.createInbound ? (dry ? "WOULD CREATE" : `created ${inboundId}`) : `exists ${inboundId}`}`,
  );

  // SIP-3: dispatch rule — individual rooms `call-*` dispatching hive-voice
  let dispatchRuleId = plan.existingDispatchRuleId;
  if (plan.createDispatchRule && !dry) {
    const r = await sip.createSipDispatchRule(
      { type: "individual", roomPrefix: ROOM_PREFIX },
      {
        name: DISPATCH_RULE_NAME,
        trunkIds: inboundId ? [inboundId] : [],
        roomConfig: new RoomConfiguration({
          agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
        }),
      },
    );
    dispatchRuleId = r.sipDispatchRuleId;
  }
  console.log(
    `SIP-3 dispatch rule: ${plan.createDispatchRule ? (dry ? "WOULD CREATE" : `created ${dispatchRuleId}`) : `exists ${dispatchRuleId}`}`,
  );

  console.log("\nRecord in hive.yaml:  voice.livekit.sipTrunkId: " + (outboundId ?? "<pending>"));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
