// Addresses as Etherscan prints them: EIP-55 casing, shortened.

import { keccak256 } from "./hashes.ts";
import { checksumAddress, shortHex } from "./hex.ts";

export const checksum = (a: string): string => checksumAddress(a, keccak256);

export const shortAddr = (a: string, head = 4, tail = 4): string => shortHex(checksum(a), head, tail);
