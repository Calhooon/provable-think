/**
 * Full broadcast pipeline — pick a UTXO, build an OP_RETURN tx with the PRT1
 * commitment payload, sign it, race the broadcast across multiple ARCs,
 * update DO state on the result.
 *
 * Embedded in the agent Worker so a single hook fire produces a real mainnet
 * anchor with no external service in the path.
 *
 * Used by `with-provenance.ts`'s commit pipeline.
 */

import {
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  SatoshisPerKilobyte,
  Transaction,
  Utils,
  type LockingScript,
} from "@bsv/sdk";
import {
  broadcastArcRace,
  DEFAULT_MAINNET_ARC_URLS,
  type ArcRaceResult,
} from "./arc.js";
import {
  assembleCommitment,
  buildPrt1OpReturnScript,
} from "./commitment.js";
import {
  sealEnvelope,
  type RecipientGrant,
  type SealedEnvelope,
} from "./envelope.js";
import {
  envelopeKey,
  storeEnvelope,
  type R2BucketLike,
  type R2StorageOptions,
} from "./storage-r2.js";
import {
  ProvenanceState,
  type GrantRecord,
  type ProvenanceUtxo,
  type UtxoReservation,
} from "./state.js";
import type { HookKind } from "./types.js";

export interface PipelineOptions {
  /** Fee rate in sats per KB. TaaL standard = 100. */
  feeSatsPerKb?: number;
  /** Comma-list of ARC URLs (overrides default). */
  arcUrls?: string[];
  /** TaaL API key — only sent to TaaL endpoints. */
  taalApiKey?: string;
  /** Wait timeout for SEEN_ON_NETWORK (ARC caps at 30). */
  maxTimeoutSeconds?: number;
  /** Tenant identifier for envelope path/scope. Default: "default". */
  tenantId?: string;
  /** Agent identifier for envelope path/scope. */
  agentId?: string;
  /** Recipients to seal each envelope to. Default: [{id:"self", counterparty:"self"}]. */
  recipients?: RecipientGrant[];
  /** Default scope tags to attach to every envelope (e.g. ["phi.input"]). */
  defaultScopeTags?: string[];
  /** R2 bucket for envelope storage. If omitted, envelopes are NOT stored
   *  (only the on-chain commitment is published). */
  r2Bucket?: R2BucketLike;
  /** R2 path-prefix override. Default "provable-think". */
  r2PathPrefix?: string;
}

export interface CommitOutcome {
  ok: boolean;
  /** Conversation this commit was anchored under. */
  conversationId: string;
  /** Per-conversation sequence number assigned by `reserveNextSequence`. */
  sequence: number;
  txid?: string;
  txStatus?: string;
  arcUrl?: string;
  inputSats: number;
  changeSats: number;
  feeSats: number;
  payloadLen: number;
  payloadHex: string;
  commitHash: string;
  elapsedMs: number;
  arcResult: ArcRaceResult;
  /** Set when an encrypted envelope was sealed for this commit. */
  envelope?: {
    sealed: boolean;
    /** Number of recipients the content key was wrapped to. */
    recipientCount: number;
    /** R2 path the envelope was stored at, when storage is configured. */
    storageKey?: string;
    /** SHA-256 of the canonical plaintext (matches the on-chain commitment). */
    plaintextHash: string;
  };
  error?: string;
}

/**
 * Build a PRT1 OP_RETURN transaction funded by `reservation.utxo`.
 *
 * Output 0: PRT1 commitment OP_RETURN (0 sats).
 * Output 1: P2PKH change back to the agent's identity address.
 *
 * Returns the signed Transaction object + the change satoshi count for
 * post-success state updates.
 */
async function buildSignedCommitTx(
  identityKey: PrivateKey,
  identityAddress: string,
  reservation: UtxoReservation,
  prt1Payload: number[],
  feeSatsPerKb: number,
): Promise<{ tx: Transaction; txWire: string; changeSats: number }> {
  const srcTx = Transaction.fromHex(reservation.utxo.rawTxHex);

  const tx = new Transaction(1, [], []);
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: reservation.utxo.txPos,
    unlockingScriptTemplate: new P2PKH().unlock(identityKey),
  });
  tx.addOutput({
    lockingScript: buildPrt1OpReturnScript(prt1Payload) as unknown as LockingScript,
    satoshis: 0,
  });
  tx.addOutput({
    lockingScript: new P2PKH().lock(identityAddress) as unknown as LockingScript,
    change: true,
  });

  await tx.fee(new SatoshisPerKilobyte(feeSatsPerKb));
  await tx.sign();

  // ARC's /v1/tx accepts hex or EF (BRC-30) but NOT BEEF (BRC-62). EF is
  // strictly better when source transactions are available because it
  // includes the input UTXO data inline so ARC can validate without lookup.
  let txWire: string;
  try {
    txWire = tx.toHexEF();
  } catch (e) {
    if (
      (e as Error).message ===
      "All inputs must have source transactions when serializing to EF format"
    ) {
      txWire = tx.toHex();
    } else {
      throw e;
    }
  }

  const changeOutput = tx.outputs.find((o) => o.change);
  const changeSats = Number(changeOutput?.satoshis ?? 0);
  return { tx, txWire, changeSats };
}

/**
 * Full commit pipeline: assemble PRT1 payload, reserve a UTXO, build+sign
 * tx, race broadcast, update state.
 *
 * Atomic at the DO storage level: either the chain head + UTXO state
 * advance together, or both revert (UTXO returned to available pool).
 */
export async function runCommitPipeline(args: {
  state: ProvenanceState;
  wallet: ProtoWallet;
  identityKey: PrivateKey;
  identityAddress: string;
  hookKind: HookKind;
  /** Conversation this commit belongs to. Each conversation has its own
   *  chain head + sequence counter. */
  conversationId: string;
  /** Canonical bytes that uniquely identify the hook moment. */
  payloadBytes: number[];
  options: PipelineOptions;
}): Promise<CommitOutcome> {
  const t0 = Date.now();
  const {
    state,
    wallet,
    identityKey,
    identityAddress,
    hookKind,
    conversationId,
    payloadBytes,
    options,
  } = args;

  const { sequence, prevHash } = state.reserveNextSequence(conversationId);

  // The PRT1 commitment binds payload + chain prevHash so the hash chain
  // is unforgeable: tampering with any prior commit breaks all subsequent
  // ones (BRC-60 semantics, anchored per-event).
  const chainBoundPayload = [
    ...Utils.toArray(prevHash, "hex"),
    ...payloadBytes,
  ];

  const assembled = await assembleCommitment(wallet, {
    hookKind,
    sequence,
    payloadBytes: chainBoundPayload,
  });
  const commitHashHex = Utils.toHex(assembled.commitHash);

  // ========================================================================
  // Seal the encrypted envelope (BRC-78-aligned multi-recipient wrapping).
  // The envelope is sealed BEFORE we touch the chain so a sealing failure
  // doesn't leave a chain commitment without a corresponding envelope. The
  // R2 PUT happens AFTER successful broadcast, so a deferred / failed
  // broadcast doesn't leave an unanchored envelope hanging around.
  // ========================================================================
  let envelope: SealedEnvelope | undefined;
  let envelopeStorageKey: string | undefined;
  const tenantId = options.tenantId ?? "default";
  const agentId = options.agentId ?? "unknown";
  // Default recipients (operator-configured) PLUS active runtime grants whose
  // scope matches this event. Each grant becomes an additional recipient that
  // can decrypt this specific envelope using their identity priv key + the
  // agent's identity pub key (BRC-42 ECDH).
  const eventTs = new Date().toISOString();
  const eventScopeTags = options.defaultScopeTags ?? [];
  const matchingGrants = state.listActiveGrants().filter((g) =>
    grantScopeMatches(g, {
      hookKind,
      ts: eventTs,
      tags: eventScopeTags,
      agentId,
    }),
  );
  const recipients: RecipientGrant[] = [
    ...(options.recipients ?? [{ id: "self", counterparty: "self" }]),
    ...matchingGrants.map((g) => ({
      id: g.id,
      counterparty: g.recipientPubHex,
      scope: g.scope as RecipientGrant["scope"],
    })),
  ];
  try {
    envelope = await sealEnvelope({
      wallet,
      header: {
        v: "provable-think/v1",
        tenant: tenantId,
        agent: agentId,
        conversationId,
        sequence,
        hookKind,
        ts: new Date().toISOString(),
        scopeTags: options.defaultScopeTags ?? [],
        prevHash,
      },
      plaintextBytes: chainBoundPayload,
      recipients,
    });
    envelopeStorageKey = envelopeKey(envelope, {
      pathPrefix: options.r2PathPrefix,
    });
  } catch (e) {
    // Envelope sealing failure is fatal — do NOT broadcast a commitment we
    // can't audit later. (No reservation has been acquired yet at this point,
    // so nothing to release.)
    const error = `Envelope sealing failed: ${(e as Error).message}`;
    state.recordCommit({
      conversationId,
      sequence,
      hookKind,
      txid: null,
      commitHash: commitHashHex,
      payloadHex: assembled.payloadHex,
      error,
      elapsedMs: Date.now() - t0,
    });
    return {
      ok: false,
      conversationId,
      sequence,
      inputSats: 0,
      changeSats: 0,
      feeSats: 0,
      payloadLen: assembled.payload.length,
      payloadHex: assembled.payloadHex,
      commitHash: commitHashHex,
      elapsedMs: Date.now() - t0,
      arcResult: {
        status: "error",
        propagated: false,
        best: { url: "", status: "error", propagated: false },
        attempts: [],
      },
      error,
    };
  }

  // Need at least: tx size × fee_rate + dust margin. ~250 sat is plenty for
  // a 1-input/2-output OP_RETURN tx at 100 sat/kb (≈ 30 sat in fees).
  const minSats = 250;

  // Retry-with-next-UTXO loop. The first imported UTXO from /sync-mainnet
  // can be a phantom: WoC reports it as unspent, but ARC's mempool view
  // shows a competing-yet-orphaned tx that already spent it. Single-shot
  // broadcast then fails with DOUBLE_SPEND_ATTEMPTED / SEEN_IN_ORPHAN_-
  // MEMPOOL, the chain stalls, and the user is forced to retry from the
  // outside. This loop burns through poisoned UTXOs in-place: on a
  // PERMANENT_UTXO_FAILURE status from ARC, mark the reservation spent
  // (so the same UTXO is never picked again on this DO) and try the
  // next available UTXO. Cap retries so we don't drain the pool on a
  // persistent network issue. Transient failures (timeouts, unknown
  // status) bail out immediately — the caller is the right layer for
  // those retries.
  const PERMANENT_UTXO_FAILURES = new Set([
    "DOUBLE_SPEND_ATTEMPTED",
    "SEEN_IN_ORPHAN_MEMPOOL",
    "REJECTED",
    "INVALID",
    "MALFORMED",
  ]);
  const MAX_UTXO_RETRIES = 6;

  let reservation: ReturnType<ProvenanceState["reserveUtxo"]> = null;
  let signed: Awaited<ReturnType<typeof buildSignedCommitTx>> | null = null;
  let arcResult: ArcRaceResult | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_UTXO_RETRIES; attempt++) {
    reservation = state.reserveUtxo(minSats);
    if (!reservation) {
      const error =
        `Insufficient funds: no available UTXO with ≥${minSats} sats ` +
        `(after ${attempt} retries). Total available: ${state.totalAvailableSats()} sats. ` +
        "Use the topUp() method on the agent to deposit a funding UTXO.";
      state.recordCommit({
        conversationId,
        sequence,
        hookKind,
        txid: null,
        commitHash: commitHashHex,
        payloadHex: assembled.payloadHex,
        error,
        elapsedMs: Date.now() - t0,
      });
      return {
        ok: false,
        conversationId,
        sequence,
        inputSats: 0,
        changeSats: 0,
        feeSats: 0,
        payloadLen: assembled.payload.length,
        payloadHex: assembled.payloadHex,
        commitHash: commitHashHex,
        elapsedMs: Date.now() - t0,
        arcResult: arcResult ?? {
          status: "error",
          propagated: false,
          best: { url: "", status: "error", propagated: false },
          attempts: [],
        },
        error,
      };
    }

    try {
      signed = await buildSignedCommitTx(
        identityKey,
        identityAddress,
        reservation,
        assembled.payload,
        options.feeSatsPerKb ?? 100,
      );
    } catch (e) {
      // Tx build is deterministic — if it fails for one UTXO, releasing
      // and retrying the same input shape is unlikely to help. Treat as
      // immediate fatal (no retry).
      state.releaseReservation(reservation.reservationId);
      const error = `Tx build failed: ${(e as Error).message}`;
      state.recordCommit({
        conversationId,
        sequence,
        hookKind,
        txid: null,
        commitHash: commitHashHex,
        payloadHex: assembled.payloadHex,
        error,
        elapsedMs: Date.now() - t0,
      });
      return {
        ok: false,
        conversationId,
        sequence,
        inputSats: reservation.utxo.value,
        changeSats: 0,
        feeSats: 0,
        payloadLen: assembled.payload.length,
        payloadHex: assembled.payloadHex,
        commitHash: commitHashHex,
        elapsedMs: Date.now() - t0,
        arcResult: {
          status: "error",
          propagated: false,
          best: { url: "", status: "error", propagated: false },
          attempts: [],
        },
        error,
      };
    }

    arcResult = await broadcastArcRace(
      signed.txWire,
      options.arcUrls ?? DEFAULT_MAINNET_ARC_URLS,
      {
        taalApiKey: options.taalApiKey,
        maxTimeoutSeconds: options.maxTimeoutSeconds,
      },
    );

    if (arcResult.status === "success") break;

    if (arcResult.txStatus && PERMANENT_UTXO_FAILURES.has(arcResult.txStatus)) {
      // Phantom UTXO — burn it and try the next one.
      state.markSpent(reservation.reservationId);
      lastError =
        arcResult.error ??
        `ARC ${arcResult.txStatus} on attempt ${attempt + 1} (UTXO ${reservation.utxo.txHash.slice(0, 12)}…:${reservation.utxo.txPos})`;
      reservation = null;
      signed = null;
      continue;
    }

    // Transient failure — release for retry by the caller and bail out.
    state.releaseReservation(reservation.reservationId);
    lastError =
      arcResult.error ??
      `All ARCs returned non-success (best: ${arcResult.txStatus ?? "unknown"})`;
    state.recordCommit({
      conversationId,
      sequence,
      hookKind,
      txid: null,
      commitHash: commitHashHex,
      payloadHex: assembled.payloadHex,
      error: lastError,
      elapsedMs: Date.now() - t0,
    });
    return {
      ok: false,
      conversationId,
      sequence,
      inputSats: reservation.utxo.value,
      changeSats: 0,
      feeSats: 0,
      payloadLen: assembled.payload.length,
      payloadHex: assembled.payloadHex,
      commitHash: commitHashHex,
      elapsedMs: Date.now() - t0,
      arcResult,
      error: lastError,
    };
  }

  if (!reservation || !signed || !arcResult || arcResult.status !== "success") {
    // Exhausted retries — every UTXO we tried hit a permanent failure.
    const error = `Exhausted ${MAX_UTXO_RETRIES} UTXO retries; last error: ${lastError ?? "unknown"}`;
    state.recordCommit({
      conversationId,
      sequence,
      hookKind,
      txid: null,
      commitHash: commitHashHex,
      payloadHex: assembled.payloadHex,
      error,
      elapsedMs: Date.now() - t0,
    });
    return {
      ok: false,
      conversationId,
      sequence,
      inputSats: 0,
      changeSats: 0,
      feeSats: 0,
      payloadLen: assembled.payload.length,
      payloadHex: assembled.payloadHex,
      commitHash: commitHashHex,
      elapsedMs: Date.now() - t0,
      arcResult: arcResult ?? {
        status: "error",
        propagated: false,
        best: { url: "", status: "error", propagated: false },
        attempts: [],
      },
      error,
    };
  }

  const txid = signed.tx.id("hex") as string;

  if (arcResult.status === "success") {
    // Mark consumed UTXO as spent + add change UTXO to pool.
    state.markSpent(reservation.reservationId);
    if (signed.changeSats > 0) {
      const newRawHex = signed.tx.toHex();
      state.addUtxo({
        txHash: txid,
        txPos: 1, // change is always output 1 (output 0 is OP_RETURN)
        value: signed.changeSats,
        rawTxHex: newRawHex,
        createdAt: Date.now(),
      });
    }
    state.advanceChainHead(conversationId, sequence, commitHashHex);

    // Persist the envelope to R2 if a bucket was configured. Done AFTER the
    // chain advance so a successful broadcast is the gate; if R2 fails here
    // we log it but don't tear down the chain commitment (which is already
    // public and immutable).
    let envelopeStored = false;
    if (options.r2Bucket && envelope && envelopeStorageKey) {
      try {
        await storeEnvelope(options.r2Bucket, envelope, {
          pathPrefix: options.r2PathPrefix,
        });
        envelopeStored = true;
      } catch (e) {
        // Best-effort: record the failure but don't fail the commit.
        state.recordCommit({
          conversationId,
          sequence,
          hookKind,
          txid,
          commitHash: commitHashHex,
          payloadHex: assembled.payloadHex,
          arcUrl: arcResult.best.url,
          txStatus: arcResult.txStatus,
          elapsedMs: Date.now() - t0,
          error: `R2 envelope storage failed: ${(e as Error).message}`,
        });
      }
    }

    state.recordCommit({
      conversationId,
      sequence,
      hookKind,
      txid,
      commitHash: commitHashHex,
      payloadHex: assembled.payloadHex,
      arcUrl: arcResult.best.url,
      txStatus: arcResult.txStatus,
      elapsedMs: Date.now() - t0,
    });
    return {
      ok: true,
      conversationId,
      sequence,
      txid,
      txStatus: arcResult.txStatus,
      arcUrl: arcResult.best.url,
      inputSats: reservation.utxo.value,
      changeSats: signed.changeSats,
      feeSats: reservation.utxo.value - signed.changeSats,
      payloadLen: assembled.payload.length,
      payloadHex: assembled.payloadHex,
      commitHash: commitHashHex,
      elapsedMs: Date.now() - t0,
      arcResult,
      envelope: envelope
        ? {
            sealed: true,
            recipientCount: recipients.length,
            storageKey: envelopeStored ? envelopeStorageKey : undefined,
            plaintextHash: envelope.header.plaintextHash,
          }
        : undefined,
    };
  }

  // Unreachable: the retry loop above either returns success or returns
  // failure for transient/exhausted cases. This satisfies the type
  // checker (the function must return CommitOutcome on every path).
  throw new Error("runCommitPipeline: unreachable post-loop branch");
}

/**
 * Convenience: derive the agent's mainnet P2PKH funding address from its
 * identity public key (compressed hex).
 */
export function fundingAddressFromPubHex(pubHex: string): string {
  return PublicKey.fromString(pubHex).toAddress();
}

// ====================================================================
// BRC-29 / 402 payment pipeline
// ====================================================================

export interface BuildPaymentTxArgs {
  state: ProvenanceState;
  identityKey: PrivateKey;
  identityAddress: string;
  /** Recipient locking script in hex (e.g. P2PKH from BRC-29 derived address). */
  recipientLockingScriptHex: string;
  /** Payment amount the recipient gets. */
  satoshis: number;
  description?: string;
  /** ARC race targets. */
  arcUrls?: string[];
  taalApiKey?: string;
  feeSatsPerKb?: number;
  /** Free-form labels to record on the commit ledger for audit. */
  labels?: string[];
}

export interface PaymentTxOutcome {
  ok: boolean;
  txid?: string;
  /** AtomicBEEF bytes — what AuthFetch wants returned from createAction. */
  atomicBeef?: number[];
  /** Plain tx bytes (no BEEF prefix). Useful for ARC re-broadcast paths. */
  txHex?: string;
  arcResult: ArcRaceResult;
  inputSats: number;
  changeSats: number;
  feeSats: number;
  elapsedMs: number;
  error?: string;
}

/**
 * Build, sign, and broadcast a BRC-29 P2PKH payment transaction from the
 * agent's funding wallet (DO storage UTXOs). Used by `createAction` in the
 * "rich wallet" mode to satisfy AuthFetch's 402-retry contract for any
 * paid API the agent calls (UHRP upload, BRC-105 paid tools, etc.).
 *
 * Output 0 is the recipient's P2PKH (or whatever lockingScript was passed).
 * Output 1 is change back to the agent's funding address.
 *
 * On success: marks the consumed UTXO as spent, adds the change UTXO to the
 * pool, returns the AtomicBEEF bytes.
 */
export async function buildPaymentTx(
  args: BuildPaymentTxArgs,
): Promise<PaymentTxOutcome> {
  const t0 = Date.now();
  const {
    state,
    identityKey,
    identityAddress,
    recipientLockingScriptHex,
    satoshis,
    arcUrls,
    taalApiKey,
    feeSatsPerKb,
  } = args;

  // Reserve a UTXO. Need at least: payment + dust change + fee margin.
  const minSats = satoshis + 250;
  const reservation = state.reserveUtxo(minSats);
  if (!reservation) {
    return {
      ok: false,
      arcResult: {
        status: "error",
        propagated: false,
        best: { url: "", status: "error", propagated: false },
        attempts: [],
      },
      inputSats: 0,
      changeSats: 0,
      feeSats: 0,
      elapsedMs: Date.now() - t0,
      error: `Insufficient funds: no UTXO with ≥${minSats} sats available; total available = ${state.totalAvailableSats()}`,
    };
  }

  let signed: { tx: Transaction; txWire: string; changeSats: number };
  try {
    const srcTx = Transaction.fromHex(reservation.utxo.rawTxHex);
    const tx = new Transaction(1, [], []);
    tx.addInput({
      sourceTransaction: srcTx,
      sourceOutputIndex: reservation.utxo.txPos,
      unlockingScriptTemplate: new P2PKH().unlock(identityKey),
    });
    // Recipient output (the BRC-29 P2PKH).
    const sdk = (await import("@bsv/sdk")) as typeof import("@bsv/sdk");
    const recipientScript = sdk.Script.fromHex(recipientLockingScriptHex);
    tx.addOutput({
      lockingScript: recipientScript as unknown as LockingScript,
      satoshis,
    });
    // Change back to self.
    tx.addOutput({
      lockingScript: new P2PKH().lock(identityAddress) as unknown as LockingScript,
      change: true,
    });
    await tx.fee(new sdk.SatoshisPerKilobyte(feeSatsPerKb ?? 100));
    await tx.sign();
    let txWire: string;
    try {
      txWire = tx.toHexEF();
    } catch {
      txWire = tx.toHex();
    }
    const changeOutput = tx.outputs.find((o) => o.change);
    const changeSats = Number(changeOutput?.satoshis ?? 0);
    signed = { tx, txWire, changeSats };
  } catch (e) {
    state.releaseReservation(reservation.reservationId);
    return {
      ok: false,
      arcResult: {
        status: "error",
        propagated: false,
        best: { url: "", status: "error", propagated: false },
        attempts: [],
      },
      inputSats: reservation.utxo.value,
      changeSats: 0,
      feeSats: 0,
      elapsedMs: Date.now() - t0,
      error: `payment tx build failed: ${(e as Error).message}`,
    };
  }

  const txid = signed.tx.id("hex") as string;
  const arcResult = await broadcastArcRace(
    signed.txWire,
    arcUrls ?? DEFAULT_MAINNET_ARC_URLS,
    { taalApiKey },
  );

  if (arcResult.status !== "success") {
    // Same permanent-failure bookkeeping as the commit broadcast path:
    // a poisoned UTXO must be marked spent or every retry hits the
    // same DOUBLE_SPEND/ORPHAN.
    const PERMANENT_UTXO_FAILURES = new Set([
      "DOUBLE_SPEND_ATTEMPTED",
      "SEEN_IN_ORPHAN_MEMPOOL",
      "REJECTED",
      "INVALID",
      "MALFORMED",
    ]);
    if (arcResult.txStatus && PERMANENT_UTXO_FAILURES.has(arcResult.txStatus)) {
      state.markSpent(reservation.reservationId);
    } else {
      state.releaseReservation(reservation.reservationId);
    }
    return {
      ok: false,
      arcResult,
      inputSats: reservation.utxo.value,
      changeSats: 0,
      feeSats: 0,
      elapsedMs: Date.now() - t0,
      error: `payment broadcast failed: ${arcResult.error ?? arcResult.txStatus ?? "unknown"}`,
    };
  }

  // Mark the UTXO spent + register the change UTXO.
  state.markSpent(reservation.reservationId);
  if (signed.changeSats > 0) {
    state.addUtxo({
      txHash: txid,
      txPos: 1,
      value: signed.changeSats,
      rawTxHex: signed.tx.toHex(),
      createdAt: Date.now(),
    });
  }

  // Build AtomicBEEF for callers that need it (e.g. AuthFetch payment retry).
  let atomicBeefBytes: number[] | undefined;
  try {
    atomicBeefBytes = signed.tx.toAtomicBEEF() as number[];
  } catch {
    // For unconfirmed parent inputs the BEEF may not be valid yet — fall
    // through with txHex only.
  }

  return {
    ok: true,
    txid,
    atomicBeef: atomicBeefBytes,
    txHex: signed.tx.toHex(),
    arcResult,
    inputSats: reservation.utxo.value,
    changeSats: signed.changeSats,
    feeSats: reservation.utxo.value - signed.changeSats,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Does this grant's scope cover the event being committed?
 *
 * Empty filters in the grant scope match anything (so a grant with no
 * `hookKinds` filter applies to ALL hooks). Any specified filter narrows
 * the match — all specified filters must intersect for the grant to match.
 */
export function grantScopeMatches(
  grant: GrantRecord,
  event: {
    hookKind: HookKind;
    ts: string;
    tags: string[];
    agentId: string;
  },
): boolean {
  const s = grant.scope;
  if (s.hookKinds && s.hookKinds.length > 0 && !s.hookKinds.includes(event.hookKind)) {
    return false;
  }
  if (s.tags && s.tags.length > 0) {
    const overlap = s.tags.some((t) => event.tags.includes(t));
    if (!overlap) return false;
  }
  if (s.fromIso && event.ts < s.fromIso) return false;
  if (s.toIso && event.ts > s.toIso) return false;
  if (s.agentIds && s.agentIds.length > 0 && !s.agentIds.includes(event.agentId)) {
    return false;
  }
  return true;
}
