// The calldata of the bridge's transactions: a light-client import (importHeader or
// importFinalityProof) and BridgeMinter.importAndMint, decoded down to the GRANDPA signatures.

import { decode, type AbiValue } from "./abi.ts";
import { selector } from "./hashes.ts";
import { hexToBytes, type Hex } from "./hex.ts";
import { decodeFinalityProof, decodeHeader, decodeJustification, decodeSigners, type Justification, type ScaleHeader, type SignerEntry } from "./scale.ts";

export const SIG = {
  importHeader: "importHeader(bytes,bytes,bytes)",
  importFinalityProof: "importFinalityProof(bytes,bytes,bytes)",
  importAndMint: "importAndMint(bytes,bytes,bytes,(bytes32,bytes[],bytes[],bytes[],address,uint256,uint256))",
} as const;

export interface LockProofArg {
  blockHash: Hex;
  accountProof: Hex[];
  childRootProof: Hex[];
  slotProof: Hex[];
  recipient: Hex;
  amount: bigint;
  nonce: bigint;
}

export interface DecodedImport {
  method: "importHeader" | "importFinalityProof" | "importAndMint";
  header: Hex;
  headerFields: ScaleHeader;
  /** The justification, unwrapped from the FinalityProof for importFinalityProof and importAndMint. */
  justification: Justification;
  signersHint: Hex;
  signers: SignerEntry[];
  lockProof: LockProofArg | null;
}

export class CallError extends Error {}

/** Decodes a light-client import or an importAndMint from its calldata. */
export function decodeImportCall(input: string): DecodedImport {
  const sel = input.slice(0, 10).toLowerCase();
  const body = "0x" + input.slice(10);
  let method: DecodedImport["method"];
  let values: AbiValue[];
  if (sel === selector(SIG.importHeader)) {
    method = "importHeader";
    values = decode("bytes,bytes,bytes", body);
  } else if (sel === selector(SIG.importFinalityProof)) {
    method = "importFinalityProof";
    values = decode("bytes,bytes,bytes", body);
  } else if (sel === selector(SIG.importAndMint)) {
    method = "importAndMint";
    values = decode("bytes,bytes,bytes,(bytes32,bytes[],bytes[],bytes[],address,uint256,uint256)", body);
  } else {
    throw new CallError(`not a light-client import (selector ${sel})`);
  }
  const header = values[0] as Hex;
  const proof = values[1] as Hex;
  const signersHint = values[2] as Hex;
  const justification = method === "importHeader" ? decodeJustification(proof) : decodeFinalityProof(proof).justification;
  let lockProof: LockProofArg | null = null;
  if (method === "importAndMint") {
    const t = values[3] as AbiValue[];
    lockProof = {
      blockHash: t[0] as Hex,
      accountProof: t[1] as Hex[],
      childRootProof: t[2] as Hex[],
      slotProof: t[3] as Hex[],
      recipient: t[4] as Hex,
      amount: t[5] as bigint,
      nonce: t[6] as bigint,
    };
  }
  return {
    method,
    header,
    headerFields: decodeHeader(hexToBytes(header)),
    justification,
    signersHint,
    signers: decodeSigners(signersHint),
    lockProof,
  };
}
