// A value the page reads live, with the rule every card follows when a read fails: the last live
// answer stays (saying the refresh failed), else the records' value is shown as Recorded, else the
// card says it could not read. Kept apart from the build's records so that the tests can run it.

import { AllFailed, NodeError, TransportError } from "./rpc.ts";

export type FieldStatus = "loading" | "live" | "recorded" | "error";

export interface Field<T> {
  status: FieldStatus;
  value: T | undefined;
  /** The endpoint that answered (live). */
  endpoint?: string;
  /** When the live value was read (ms). */
  at?: number;
  /** The record a recorded value comes from. */
  from?: string;
  /** Why the live read failed. */
  error?: string;
}

/** A recorded value and the record it comes from. */
export interface Recorded<T> {
  value: T;
  from: string;
}

/** Why a read failed, in a line: each endpoint's problem when every one failed. */
export function failure(error: unknown): string {
  if (error instanceof AllFailed) return error.problems.join("; ") || error.message;
  if (error instanceof TransportError || error instanceof NodeError) return `${error.endpoint.label}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** The field after a read: live when it answered; after a failure, the last live answer, else the recorded value, else an error. */
export async function nextField<T>(
  before: Field<T>,
  read: () => Promise<{ value: T; endpoint: string }>,
  recorded: Recorded<T> | null | undefined,
  now: () => number = Date.now,
): Promise<Field<T>> {
  try {
    const { value, endpoint } = await read();
    return { status: "live", value, endpoint, at: now() };
  } catch (error) {
    // Keep the last live answer; say the refresh failed.
    if (before.status === "live") return { ...before, error: failure(error) };
    if (recorded) return { status: "recorded", value: recorded.value, from: recorded.from, error: failure(error) };
    return { status: "error", value: undefined, error: failure(error) };
  }
}
