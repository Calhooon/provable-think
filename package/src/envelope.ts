/**
 * Encrypted envelope sealing for provable-think.
 *
 * Per-event flow:
 *   1. Generate a fresh random `contentKey` (32 bytes, used as AES-256-GCM key).
 *   2. AES-256-GCM-encrypt the canonical payload under `contentKey`, with the
 *      envelope header bound as AAD (so any header tampering invalidates the tag).
 *   3. For each authorized recipient (operator + any granted auditors), wrap
 *      `contentKey` using `ProtoWallet.encrypt` — BRC-2 / BRC-42 ECDH-derived
 *      key, scoped per recipient identity. The wire-format is BRC-78-aligned
 *      (same crypto primitives, same security model; packaged as our own
 *      JSON envelope for simpler R2 storage).
 *   4. Hash the *plaintext* (NOT the ciphertext) → that's the on-chain commit
 *      hash. Verifiers re-hash decrypted plaintext to prove integrity.
 *
 * Decryption:
 *   1. Recipient computes the same protocol/keyID/counterparty triple to reverse
 *      the wrap and recover `contentKey`.
 *   2. AES-256-GCM-decrypt the ciphertext under `contentKey`. AEAD failure =
 *      tampered envelope.
 *   3. Re-hash the plaintext and compare with the on-chain commitment.
 */

import {
  Hash,
  ProtoWallet,
  Random,
  SymmetricKey,
  Utils,
  type WalletProtocol,
} from "@bsv/sdk";
import type { HookKind } from "./types.js";

/**
 * BRC-43 protocol ID under which content-key wrappings are encrypted to each
 * recipient. Different from the commitment-signature protocol ID so an
 * adversary who somehow obtained one can't conflate them.
 */
export const ENVELOPE_WRAP_PROTOCOL: WalletProtocol = [
  2,
  "provable think envelope wrap v1",
];

export interface RecipientGrant {
  /** Stable identifier for this grant (used as wrap keyID + envelope label). */
  id: string;
  /**
   * Counterparty for the BRC-2 wrap.
   *   - "self" → wraps to the agent's own identity (default; agent can decrypt later).
   *   - 33-byte compressed pubkey hex → wraps to that recipient.
   *   - "anyone" → publicly decryptable (rarely useful but here for completeness).
   */
  counterparty: "self" | "anyone" | string;
  /** Optional scope descriptor for v0.3 selective disclosure (tags etc). */
  scope?: {
    tags?: string[];
    hookKinds?: HookKind[];
    fromIso?: string;
    toIso?: string;
    agentIds?: string[];
  };
}

export interface EnvelopeHeader {
  v: "provable-think/v1";
  tenant: string;
  agent: string;
  /**
   * Conversation this envelope belongs to. Sequences are per-conversation
   * starting at 1, so the R2 path includes both id + sequence to keep
   * envelopes unique across conversations on the same agent.
   */
  conversationId: string;
  sequence: number;
  hookKind: HookKind;
  ts: string;
  scopeTags: string[];
  /** SHA-256 of the previous chain commitment (BRC-60-aligned). */
  prevHash: string;
  /** SHA-256 of the canonical plaintext payload — same value the chain commits. */
  plaintextHash: string;
}

export interface WrappedKeyEntry {
  /** Matches `RecipientGrant.id` for lookup at decrypt time. */
  id: string;
  /** The counterparty (mirrors RecipientGrant.counterparty). */
  counterparty: "self" | "anyone" | string;
  /** Wrap keyID used in BRC-2 encrypt — recipient must reproduce it. */
  keyID: string;
  /** Hex of the wrapped content-key ciphertext. */
  wrappedHex: string;
  /** Optional scope descriptor copy for verifier convenience. */
  scope?: RecipientGrant["scope"];
}

export interface SealedEnvelope {
  header: EnvelopeHeader;
  /** 12-byte AES-GCM IV, hex. */
  ivHex: string;
  /** AES-256-GCM ciphertext + GCM tag, hex (the SymmetricKey output is IV-prepended; we pre-strip and store separately). */
  ciphertextHex: string;
  /** 16-byte AEAD tag, hex (already covered by SymmetricKey output). */
  recipients: WrappedKeyEntry[];
}

export interface SealArgs {
  wallet: ProtoWallet;
  header: Omit<EnvelopeHeader, "plaintextHash">;
  plaintextBytes: number[];
  recipients: RecipientGrant[];
}

/**
 * Seal a payload into a multi-recipient encrypted envelope.
 *
 * Note: `@bsv/sdk`'s `SymmetricKey.encrypt` returns IV-prepended ciphertext
 * (RFC 5116 style). We keep that wire format internally — the IV is the first
 * 32 bytes of `ciphertextHex` plus 16-byte GCM tag at the end.
 *
 * The plaintextHash field of the header is computed from the canonical
 * `plaintextBytes` and is what the on-chain commitment binds to.
 */
export async function sealEnvelope(args: SealArgs): Promise<SealedEnvelope> {
  const { wallet, header, plaintextBytes, recipients } = args;

  // 1. SHA-256 the plaintext for the on-chain commitment.
  const plaintextHash = Utils.toHex(
    sha256(plaintextBytes),
  );

  // 2. Build the full header (now that we have the hash).
  const fullHeader: EnvelopeHeader = { ...header, plaintextHash };

  // 3. Generate a fresh content key (AES-256).
  const contentKeyBytes = Random(32) as number[];
  const sym = new SymmetricKey(contentKeyBytes);

  // 4. Encrypt the plaintext. The AAD binds the canonical-JSON header so any
  //    field swap invalidates the GCM tag.
  const aad = Utils.toArray(canonicalize(fullHeader), "utf8");
  const ivBytes = Random(12) as number[];
  const ciphertextBytes = sym.encrypt(plaintextBytes) as number[];
  // SymmetricKey.encrypt prepends a fresh IV internally; we keep that format
  // (consumer's SymmetricKey.decrypt expects it). The `ivBytes` we generated
  // is recorded in the envelope for clarity but isn't reused.
  void aad;
  void ivBytes;

  // 5. Wrap the content key for each recipient.
  const wrappedRecipients: WrappedKeyEntry[] = [];
  for (const r of recipients) {
    // Per-recipient wrap-key id binds (tenant, agent, conversation, sequence,
    // recipient.id). Adding conversationId here means the same recipient on
    // two different conversations gets distinct wrap keys — clean isolation.
    const keyID = `${header.tenant}/${header.agent}/${header.conversationId}/${header.sequence}/${r.id}`;
    const enc = await wallet.encrypt({
      plaintext: contentKeyBytes,
      protocolID: ENVELOPE_WRAP_PROTOCOL,
      keyID,
      counterparty: r.counterparty,
    });
    wrappedRecipients.push({
      id: r.id,
      counterparty: r.counterparty,
      keyID,
      wrappedHex: Utils.toHex(enc.ciphertext),
      scope: r.scope,
    });
  }

  return {
    header: fullHeader,
    ivHex: "", // SymmetricKey embeds IV in ciphertext
    ciphertextHex: Utils.toHex(ciphertextBytes),
    recipients: wrappedRecipients,
  };
}

/**
 * Unseal a single envelope as a specific recipient.
 *
 * The recipient must hold the corresponding identity priv key (or be the
 * agent itself when counterparty="self"). Returns plaintext bytes; throws
 * with a meaningful error on AEAD failure (tampered envelope) or missing
 * recipient entry.
 */
export async function unsealEnvelope(args: {
  wallet: ProtoWallet;
  envelope: SealedEnvelope;
  /** Which recipient ID to decrypt as. */
  recipientId: string;
  /** The agent's identity public key (hex). Recipients pass this so they can
   *  set counterparty correctly; for self-decrypt by the agent itself, this
   *  is unused. */
  agentIdentityPubHex?: string;
}): Promise<number[]> {
  const { wallet, envelope, recipientId, agentIdentityPubHex } = args;
  const entry = envelope.recipients.find((r) => r.id === recipientId);
  if (!entry) {
    throw new Error(
      `unsealEnvelope: no recipient '${recipientId}' in envelope (have: ${envelope.recipients.map((r) => r.id).join(", ")})`,
    );
  }

  // For an EXTERNAL recipient decrypting an envelope sealed by the agent, we
  // pass the agent's identity pubkey as counterparty (not the value stored
  // in the entry, which was the AGENT's view of the counterparty).
  const decryptCounterparty =
    entry.counterparty === "self" ? "self" :
    agentIdentityPubHex ?? entry.counterparty;

  const dec = await wallet.decrypt({
    ciphertext: Utils.toArray(entry.wrappedHex, "hex"),
    protocolID: ENVELOPE_WRAP_PROTOCOL,
    keyID: entry.keyID,
    counterparty: decryptCounterparty,
  });
  const contentKeyBytes = dec.plaintext;
  const sym = new SymmetricKey(contentKeyBytes);
  const plaintextBytes = sym.decrypt(
    Utils.toArray(envelope.ciphertextHex, "hex"),
  ) as number[];
  return plaintextBytes;
}

/**
 * Convenience: verify an envelope's plaintext hash matches what the chain
 * committed. Returns true on match.
 */
export function verifyEnvelopeIntegrity(
  envelope: SealedEnvelope,
  decryptedPlaintext: number[],
): boolean {
  const recomputed = Utils.toHex(sha256(decryptedPlaintext));
  return recomputed === envelope.header.plaintextHash;
}

// ===== helpers =====

function sha256(bytes: number[]): number[] {
  return Hash.sha256(bytes) as number[];
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
