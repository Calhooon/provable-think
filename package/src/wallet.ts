/**
 * MinimalWallet — `WalletInterface` adapter wrapping `@bsv/sdk`'s `ProtoWallet`.
 *
 * `@bsv/sdk`'s `AuthFetch` requires a full `WalletInterface` to perform
 * BRC-103/104 mutual authentication and (optionally) BRC-105 402-retry
 * payments. The full surface exposes ~30 methods spanning the BRC-100
 * transaction subset (createAction, signAction, internalizeAction, …),
 * certificates, and discovery — none of which `provable-think` needs to
 * implement here, because those calls go directly to the wallet Worker
 * (`bsv-wallet-infra-cloudflare`) over JSON-RPC.
 *
 * `MinimalWallet` therefore implements only the crypto subset (delegated
 * to `ProtoWallet`) plus a few authenticated/network/version accessors.
 * Every other method throws a clear "not implemented" error so any
 * accidental dependency is loud.
 *
 * Lifted verbatim from the Phase 1 spike (`phase-1-spike/src/minimal-wallet.ts`).
 */

import {
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Utils,
  type WalletInterface,
} from "@bsv/sdk";
import {
  buildPaymentTx,
  type PaymentTxOutcome,
} from "./broadcast-pipeline.js";
import type { ProvenanceState } from "./state.js";

const NOT_IMPLEMENTED = (name: string) => () => {
  throw new Error(
    `MinimalWallet.${name}() is not implemented. AuthFetch should not call this method during BRC-103/104 mutual auth. ` +
      "If you need the BRC-100 transaction surface, route the call through the wallet Worker (bsv-wallet-infra-cloudflare) instead.",
  );
};

/**
 * Optional payment-support hooks for `makeMinimalWallet`. When provided,
 * `createAction` is implemented as a real BRC-29 payment builder backed by
 * the agent's funding wallet (DO-storage UTXO pool). This is what AuthFetch
 * calls when handling 402 Payment Required responses (e.g. UHRP `/upload`,
 * BRC-105 paid tools).
 *
 * If omitted, `createAction` stub-throws (existing v0.1 behaviour).
 */
export interface MinimalWalletPaymentSupport {
  state: ProvenanceState;
  identityKey: PrivateKey;
  identityAddress: string;
  arcUrls?: string[];
  taalApiKey?: string;
  feeSatsPerKb?: number;
}

/**
 * Build a `WalletInterface` adapter around an existing `ProtoWallet`.
 * The `ProtoWallet` should be constructed with the agent's identity `PrivateKey`.
 *
 * Optional `paymentSupport` enables real BRC-29 payment construction for
 * AuthFetch's 402 retry path.
 */
export function makeMinimalWallet(
  wallet: ProtoWallet,
  paymentSupport?: MinimalWalletPaymentSupport,
): WalletInterface {
  return {
    // ===== Implemented (delegated to ProtoWallet) =====
    async getPublicKey(args) {
      return wallet.getPublicKey(args);
    },
    async revealCounterpartyKeyLinkage(args) {
      return wallet.revealCounterpartyKeyLinkage(args);
    },
    async revealSpecificKeyLinkage(args) {
      return wallet.revealSpecificKeyLinkage(args);
    },
    async encrypt(args) {
      return wallet.encrypt(args);
    },
    async decrypt(args) {
      return wallet.decrypt(args);
    },
    async createHmac(args) {
      return wallet.createHmac(args);
    },
    async verifyHmac(args) {
      return wallet.verifyHmac(args);
    },
    async createSignature(args) {
      return wallet.createSignature(args);
    },
    async verifySignature(args) {
      return wallet.verifySignature(args);
    },

    // ===== Implemented (constant returns) =====
    async isAuthenticated(_args) {
      return { authenticated: true };
    },
    async waitForAuthentication(_args) {
      return { authenticated: true };
    },
    async getNetwork(_args) {
      return { network: "mainnet" };
    },
    async getVersion(_args) {
      return { version: "provable-think-v0.1.0-alpha" };
    },

    async getHeight(_args) {
      throw new Error(
        "MinimalWallet.getHeight() not implemented — agent Worker does not track block headers. " +
          "Ask the wallet Worker via getBalance / listOutputs instead.",
      );
    },
    async getHeaderForHeight(_args) {
      throw new Error(
        "MinimalWallet.getHeaderForHeight() not implemented — agent Worker does not track block headers.",
      );
    },

    // ===== BRC-100 transaction surface =====
    // `createAction` is real when paymentSupport is supplied (used by
    // AuthFetch's 402 retry path for paid APIs). The other methods stay
    // stubbed for v0.1.
    createAction: paymentSupport
      ? buildCreateAction(paymentSupport)
      : (NOT_IMPLEMENTED("createAction") as WalletInterface["createAction"]),
    signAction: NOT_IMPLEMENTED("signAction"),
    abortAction: NOT_IMPLEMENTED("abortAction"),
    listActions: NOT_IMPLEMENTED("listActions"),
    internalizeAction: NOT_IMPLEMENTED("internalizeAction"),
    listOutputs: NOT_IMPLEMENTED("listOutputs"),
    relinquishOutput: NOT_IMPLEMENTED("relinquishOutput"),

    // ===== Certificate surface — NOT implemented for v0.1 =====
    acquireCertificate: NOT_IMPLEMENTED("acquireCertificate"),
    listCertificates: NOT_IMPLEMENTED("listCertificates"),
    proveCertificate: NOT_IMPLEMENTED("proveCertificate"),
    relinquishCertificate: NOT_IMPLEMENTED("relinquishCertificate"),
    discoverByIdentityKey: NOT_IMPLEMENTED("discoverByIdentityKey"),
    discoverByAttributes: NOT_IMPLEMENTED("discoverByAttributes"),
  };
}

/**
 * Convenience: derive the BSV mainnet P2PKH address for an identity public key.
 * Useful when funding the agent's wallet-infra user with sats sent from an
 * external wallet (MetaNet Client, rust-wallet-utils, etc.).
 */
export function addressFromIdentityPubHex(pubHex: string): string {
  return PublicKey.fromString(pubHex).toAddress();
}

/**
 * Build a `WalletInterface["createAction"]` that satisfies AuthFetch's
 * 402-retry contract.
 *
 * AuthFetch passes a single output `{ satoshis, lockingScript, customInstructions, outputDescription }`
 * with `options.randomizeOutputs: false`. We build a P2PKH-funded payment tx,
 * broadcast it via the multi-ARC race, and return `{ tx: AtomicBEEF, txid }`.
 */
function buildCreateAction(
  ps: MinimalWalletPaymentSupport,
): WalletInterface["createAction"] {
  return async (args) => {
    if (!args.outputs || args.outputs.length !== 1) {
      throw new Error(
        `MinimalWallet.createAction(): expected exactly 1 output (AuthFetch 402 retry shape), got ${args.outputs?.length ?? 0}`,
      );
    }
    const out = args.outputs[0];
    const lockingScriptHex =
      typeof out.lockingScript === "string"
        ? out.lockingScript
        : Utils.toHex(out.lockingScript as unknown as number[]);
    const outcome: PaymentTxOutcome = await buildPaymentTx({
      state: ps.state,
      identityKey: ps.identityKey,
      identityAddress: ps.identityAddress,
      recipientLockingScriptHex: lockingScriptHex,
      satoshis: out.satoshis ?? 0,
      description:
        typeof args.description === "string" ? args.description : undefined,
      arcUrls: ps.arcUrls,
      taalApiKey: ps.taalApiKey,
      feeSatsPerKb: ps.feeSatsPerKb,
    });
    if (!outcome.ok || !outcome.atomicBeef) {
      throw new Error(
        `createAction: payment tx build/broadcast failed: ${outcome.error ?? "unknown"}`,
      );
    }
    return {
      txid: outcome.txid,
      tx: outcome.atomicBeef,
      noSendChange: undefined,
      sendWithResults: undefined,
      signableTransaction: undefined,
    };
  };
}
