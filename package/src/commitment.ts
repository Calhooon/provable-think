/**
 * PRT1 OP_RETURN commitment payload assembly.
 *
 * Wire format (variable length, ~145–148 bytes):
 *
 *   Offset  Size  Field
 *   ─────────────────────────────────────────────
 *     0      4   Magic "PRT1" (0x50 0x52 0x54 0x31)
 *     4      1   Hook kind enum (see HOOK_KIND_BYTES)
 *     5      4   Sequence number (BE, agent-scoped, monotonic)
 *     9     32   Commitment hash (SHA-256 of canonical payload)
 *    41     33   Derived signing pubkey (BRC-42 derived under the commit
 *                protocol; compressed)
 *    74      1   DER signature length (typical 70–72)
 *    75      v   DER ECDSA signature over the commitment hash
 *
 * The signature is produced via `ProtoWallet.createSignature` with:
 *   protocolID  = [2, "provable think commitment v1"]
 *   keyID       = String(sequence)
 *   counterparty = "self"
 *
 * A verifier reconstructs the derived pubkey from the agent's identity key +
 * those derivation parameters (BRC-42), then validates the DER signature.
 *
 * Lifted and lightly cleaned from the Phase 1 spike.
 */

import {
  Hash,
  ProtoWallet,
  Script,
  Utils,
  type LockingScript,
} from "@bsv/sdk";
import {
  HOOK_KIND_BYTES,
  PROVABLE_THINK_COMMIT_PROTOCOL,
  type HookKind,
} from "./types.js";

export const PRT1_MAGIC = new Uint8Array([0x50, 0x52, 0x54, 0x31]); // "PRT1"

export interface AssembleArgs {
  hookKind: HookKind;
  sequence: number;
  /** Canonical bytes of the hook payload to be committed (we hash this). */
  payloadBytes: number[];
}

export interface AssembledCommitment {
  /** Full PRT1 OP_RETURN payload bytes. */
  payload: number[];
  payloadHex: string;
  /** Hash of `payloadBytes` (the thing that gets signed). */
  commitHash: number[];
  /** DER signature bytes. */
  signature: number[];
  /** Derived signing pubkey bytes (33-byte compressed). */
  derivedPubkey: number[];
}

/**
 * Build a PRT1 commitment payload using the BRC-100 ProtoWallet for signing.
 *
 * `payloadBytes` is the canonical-serialized hook payload (anything that
 * uniquely identifies the moment we're committing — input context hash,
 * tool args, model output, etc.). We hash it here and sign that hash.
 */
export async function assembleCommitment(
  wallet: ProtoWallet,
  args: AssembleArgs,
): Promise<AssembledCommitment> {
  const hookKindByte = HOOK_KIND_BYTES[args.hookKind];
  if (hookKindByte === undefined) {
    throw new Error(`unknown hookKind: ${args.hookKind}`);
  }
  const sequence = args.sequence;
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    throw new Error(`sequence must be a 32-bit unsigned integer: ${sequence}`);
  }

  // 1. Hash the canonical payload.
  const commitHash = Hash.sha256(args.payloadBytes) as number[];
  if (commitHash.length !== 32) {
    throw new Error(
      `expected 32-byte SHA-256 commit hash, got ${commitHash.length}`,
    );
  }

  // 2. BRC-100: derive the per-commitment signing pubkey
  const pubRes = await wallet.getPublicKey({
    protocolID: PROVABLE_THINK_COMMIT_PROTOCOL,
    keyID: String(sequence),
    counterparty: "self",
  });
  const derivedPubkey = Utils.toArray(pubRes.publicKey, "hex");
  if (derivedPubkey.length !== 33) {
    throw new Error(
      `expected 33-byte compressed pubkey, got ${derivedPubkey.length}`,
    );
  }

  // 3. BRC-100: sign the commit hash with the derived key.
  // `hashToDirectlySign` so ProtoWallet does not re-hash.
  const sigRes = await wallet.createSignature({
    hashToDirectlySign: commitHash,
    protocolID: PROVABLE_THINK_COMMIT_PROTOCOL,
    keyID: String(sequence),
    counterparty: "self",
  });
  const signature = sigRes.signature;
  if (signature.length > 0xff) {
    throw new Error(
      `DER signature too long for 1-byte length prefix: ${signature.length}`,
    );
  }

  // 4. Assemble.
  const payload: number[] = [];
  payload.push(...PRT1_MAGIC);
  payload.push(hookKindByte & 0xff);
  payload.push((sequence >>> 24) & 0xff);
  payload.push((sequence >>> 16) & 0xff);
  payload.push((sequence >>> 8) & 0xff);
  payload.push(sequence & 0xff);
  payload.push(...commitHash);
  payload.push(...derivedPubkey);
  payload.push(signature.length & 0xff);
  payload.push(...signature);

  return {
    payload,
    payloadHex: Utils.toHex(payload),
    commitHash,
    signature,
    derivedPubkey,
  };
}

/**
 * Build the OP_RETURN locking script for a PRT1 payload.
 *
 *   OP_FALSE OP_RETURN <payload>
 *
 * The leading `OP_FALSE` makes the output provably unspendable, which miners
 * reliably classify as data-carrier (BRC-18 / BRC-60 convention).
 */
export function buildPrt1OpReturnScript(payload: number[]): LockingScript {
  const script = new Script();
  script.writeOpCode(0x00); // OP_FALSE
  script.writeOpCode(0x6a); // OP_RETURN
  script.writeBin(payload);
  return script as unknown as LockingScript;
}
