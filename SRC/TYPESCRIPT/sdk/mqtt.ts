/**
 * MQTT topic contract — pure parts of TRUNK-CASTER-SDK/src/mqtt.rs (added
 * to the SDK while this audit ran). The packet codec and reconnecting Link
 * are not ported: a Node consumer should use a real MQTT client.
 *
 *   trunk-caster/<protocol>/<frame>/line     caster → frame   one Ward-Beck line
 *   trunk-caster/<protocol>/<frame>/ack      frame → caster   the line, applied (double validated)
 *   trunk-caster/<protocol>/<frame>/reject   frame → caster   "<reason>|<line>"
 *
 * A frame applies a line only when the same line arrived over both the
 * Ward-Beck TCP port and MQTT.
 */

import type { U64 } from "./types.ts";

/** Root of every Trunk-Caster topic. */
export const MQTT_ROOT = "trunk-caster";

export type MqttTopicKind = "line" | "ack" | "reject";

export function lineTopic(protocol: string, frame: string): string {
  return `${MQTT_ROOT}/${protocol}/${frame}/line`;
}
export function ackTopic(protocol: string, frame: string): string {
  return `${MQTT_ROOT}/${protocol}/${frame}/ack`;
}
export function rejectTopic(protocol: string, frame: string): string {
  return `${MQTT_ROOT}/${protocol}/${frame}/reject`;
}

/** Split `trunk-caster/<protocol>/<frame>/<kind>`; exactly four segments or `undefined`. `kind` is not validated (as in Rust). */
export function parseTopic(topic: string): { protocol: string; frame: string; kind: string } | undefined {
  const p = topic.split("/");
  if (p.length !== 4 || p[0] !== MQTT_ROOT) return undefined;
  const [, protocol = "", frame = "", kind = ""] = p;
  return { protocol, frame, kind };
}

/** Split a reject payload `"<reason>|<line>"` at the FIRST `|` (a Ward-Beck name may contain `|`). */
export function parseReject(payload: string): { reason: string; line: string } | undefined {
  const i = payload.indexOf("|");
  return i < 0 ? undefined : { reason: payload.slice(0, i), line: payload.slice(i + 1) };
}

/** `mqtt::LinkStats`: counters for status pages (`Status.mqtt`). */
export interface LinkStats {
  broker: string;
  connected: boolean;
  published: U64;
  received: U64;
  connects: U64;
}
