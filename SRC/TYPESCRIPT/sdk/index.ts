/**
 * Trunk-Caster SDK for TypeScript — the single canonical export of every
 * wire type (port of TRUNK-CASTER-SDK/src/lib.rs).
 *
 * Browser-safe: nothing here imports `node:*`. Node-only clients
 * (FileClient, HttpClient, WardBeckClient, findLayout) are in `./node.ts`.
 *
 * Nothing here knows a brand as an address: a trunk is identified by
 * protocol and frame, never by vendor.
 */

export * from "./types.ts";
export * from "./labels.ts";
export * from "./sites.ts";
export * from "./folders.ts";
export * as wardbeck from "./wardbeck.ts";
export type { WbLine, Switch, ParseResult } from "./wardbeck.ts";
export { CHECKIN, SWITCHES } from "./wardbeck.ts";
export * from "./schema.ts";
export * from "./mqtt.ts";
export * as voice from "./voice.ts";
export type { Assembled, AssembledRecording, Chunk } from "./voice.ts";
export { Reassembler } from "./voice.ts";
