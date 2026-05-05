#!/usr/bin/env node
/**
 * Fund the demo agent's pt_utxos with genuinely-fresh UTXOs via the
 * local BRC-100 wallet at localhost:3321 — and avoid the
 * `/sync-mainnet` re-import of phantom UTXOs that contaminate the pool
 * when prior orphan-mempool broadcasts left the address with WoC-
 * unspent-but-actually-contested outputs.
 *
 * Flow:
 *   1. Build a tx with N outputs paying the agent's funding address.
 *   2. Have the wallet sign + broadcast it (so it lands on chain).
 *   3. POST /topup once per output with { rawTxHex, outputIndex,
 *      valueSatoshis }.
 *
 * The agent's pt_utxos ends up with EXACTLY the freshly-funded UTXOs —
 * no WoC-import side effects.
 *
 * Usage:
 *   node scripts/fund-via-topup.mjs                # default 4 UTXOs
 *   node scripts/fund-via-topup.mjs 1500 1500 1000 1000  # custom denoms
 */

import { Script, P2PKH } from "@bsv/sdk";

const WALLET_URL = process.env.WALLET_URL || "http://localhost:3321";
const AGENT_URL = "https://acme-health-agent.dev-a3e.workers.dev";

const denoms =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((s) => parseInt(s, 10))
    : [1500, 1500, 1000, 1000];

async function main() {
  const info = await (await fetch(`${AGENT_URL}/info`)).json();
  const agentAddr = info.address;
  console.log(`agent address: ${agentAddr}`);
  console.log(`agent balance before: ${info.balance} sat`);
  console.log(`sending: ${denoms.join(", ")} sat (${denoms.reduce((a, b) => a + b, 0)} total)`);

  const lockingScript = new P2PKH().lock(agentAddr).toHex();
  const outputs = denoms.map((sats, i) => ({
    satoshis: sats,
    lockingScript,
    outputDescription: `acme-health funding utxo ${i + 1}/${denoms.length}`,
  }));

  console.log(`POST ${WALLET_URL}/createAction with ${outputs.length} outputs…`);
  const r = await fetch(`${WALLET_URL}/createAction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      description: "acme-health agent v17 fresh-UTXO top-up",
      outputs,
      labels: ["acme-health-funding"],
    }),
  });
  if (!r.ok) {
    console.error(`wallet createAction returned ${r.status}: ${await r.text()}`);
    process.exit(1);
  }
  const result = await r.json();
  console.log("createAction result keys:", Object.keys(result));
  if (!result.txid) {
    console.error("wallet did not return txid", result);
    process.exit(1);
  }
  // Get raw tx hex. Either result.tx (byte array) or via WoC.
  let rawTxHex;
  if (result.tx) {
    const txBytes = Array.isArray(result.tx) ? Buffer.from(result.tx) : Buffer.from(result.tx);
    rawTxHex = txBytes.toString("hex");
  } else {
    const wocResp = await fetch(
      `https://api.whatsonchain.com/v1/bsv/main/tx/${result.txid}/hex`,
    );
    if (!wocResp.ok) {
      console.error("could not fetch raw tx hex");
      process.exit(1);
    }
    rawTxHex = (await wocResp.text()).trim();
  }
  console.log(`  txid: ${result.txid}`);
  console.log(`  raw tx hex: ${rawTxHex.length / 2} bytes`);

  // Send each output to /topup
  for (let i = 0; i < denoms.length; i++) {
    console.log(`POST /topup output ${i} (${denoms[i]} sat)`);
    const tu = await fetch(`${AGENT_URL}/topup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rawTxHex,
        outputIndex: i,
        valueSatoshis: denoms[i],
      }),
    });
    if (!tu.ok) {
      console.error(`/topup output ${i} failed: ${tu.status} ${await tu.text()}`);
      process.exit(1);
    }
    const tuJson = await tu.json();
    console.log(`  result:`, tuJson);
  }

  const after = await (await fetch(`${AGENT_URL}/info`)).json();
  console.log(`\nagent balance after: ${after.balance} sat`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
