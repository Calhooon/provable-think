#!/usr/bin/env node
/**
 * Top up the demo agent's funding address from a local BRC-100 wallet
 * (the kind running on `localhost:3321` — Metanet desktop / Babbage
 * compat). Sends a configurable list of UTXO denominations + then
 * pings the agent's /sync-mainnet so the new outputs land in pt_utxos.
 *
 * Usage:
 *   node scripts/fund-from-local-wallet.mjs                # default 4 UTXOs
 *   node scripts/fund-from-local-wallet.mjs 1000 500 500   # custom sizes
 */

import { Script, P2PKH } from "@bsv/sdk";

const WALLET_URL = process.env.WALLET_URL || "http://localhost:3321";
const AGENT_URL = "https://acme-health-agent.dev-a3e.workers.dev";

const denoms =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((s) => parseInt(s, 10))
    : [1000, 1000, 500, 500];

async function main() {
  // 1. Get the agent's funding address.
  const info = await (await fetch(`${AGENT_URL}/info`)).json();
  const agentAddr = info.address;
  console.log(`agent address: ${agentAddr}`);
  console.log(`agent balance before: ${info.balance} sat`);
  console.log(`sending: ${denoms.join(", ")} sat (${denoms.reduce((a, b) => a + b, 0)} total)`);

  // 2. Build P2PKH locking script for that address.
  const lockingScript = new P2PKH().lock(agentAddr).toHex();

  // 3. Build outputs payload for createAction.
  const outputs = denoms.map((sats, i) => ({
    satoshis: sats,
    lockingScript,
    outputDescription: `acme-health funding utxo ${i + 1}/${denoms.length}`,
  }));

  // 4. Hit the local wallet's /createAction.
  const body = {
    description: "acme-health agent top-up (provable-think v0.2 testing)",
    outputs,
    labels: ["acme-health-funding"],
  };
  console.log(`POST ${WALLET_URL}/createAction with ${outputs.length} outputs…`);
  const r = await fetch(`${WALLET_URL}/createAction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`wallet createAction returned ${r.status}: ${await r.text()}`);
    process.exit(1);
  }
  const result = await r.json();
  // The result has either { txid, tx, log } or for delayed broadcast may
  // include a signableTransaction. Print the keys so we know what shape.
  console.log("createAction result keys:", Object.keys(result));
  if (result.txid) console.log("  txid:", result.txid);
  if (result.tx) console.log("  tx bytes len:", Array.isArray(result.tx) ? result.tx.length : result.tx?.length);
  if (result.log) console.log("  log:", result.log);
  if (result.error) console.log("  error:", result.error);
  if (result.signableTransaction) console.log("  signableTransaction present (delayed)");
  if (result.noSendChange) console.log("  noSendChange present");

  // If we got tx bytes back but not a txid, broadcast manually via the
  // agent's WhatsOnChain pull so it lands on chain.
  if (result.tx && !result.txid) {
    console.log("\nwallet returned raw tx; broadcasting via WoC…");
    const txBytes = Array.isArray(result.tx) ? Buffer.from(result.tx) : Buffer.from(result.tx);
    const txHex = txBytes.toString("hex");
    const woc = await fetch("https://api.whatsonchain.com/v1/bsv/main/tx/raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txhex: txHex }),
    });
    console.log("WoC broadcast status:", woc.status, await woc.text());
  }

  // 5. Tell the agent to re-sync from WhatsOnChain so the new UTXOs
  //    land in pt_utxos. (Sync may take a beat — WoC indexer is async.)
  console.log("\nwaiting 5s for WoC indexer…");
  await new Promise((f) => setTimeout(f, 5000));
  console.log("POST /sync-mainnet");
  const sync = await (await fetch(`${AGENT_URL}/sync-mainnet`, { method: "POST" })).json();
  console.log("sync result:", sync);

  const after = await (await fetch(`${AGENT_URL}/info`)).json();
  console.log(`\nagent balance after: ${after.balance} sat`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
