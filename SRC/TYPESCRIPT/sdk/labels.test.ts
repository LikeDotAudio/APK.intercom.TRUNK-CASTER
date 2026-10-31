import { test } from "node:test";
import assert from "node:assert/strict";
import { fit, graphemes, labelForWidth, labelWithOverrides, makeLabel, rustTrim, width } from "./labels.ts";

const cp = (...xs: number[]): string => String.fromCodePoint(...xs);
const ZWJ = cp(0x200d);
const VS16 = cp(0xfe0f);

// --- Mirrors of labels.rs #[cfg(test)] -------------------------------------

test("plain_names (labels.rs)", () => {
  const l = makeLabel("Andrey Kuzub");
  assert.deepEqual([l.l6, l.l8, l.l16], ["Andrey", "Andrey K", "Andrey Kuzub"]);
  assert.equal(l.chars, 12);
  assert.ok(l.over6 && l.over8 && !l.over16);
  assert.equal(makeLabel("Sam").l6, "Sam");
});

test("emoji_count_as_one (labels.rs)", () => {
  const mic = cp(0x1f399) + VS16;
  assert.equal(width(`${mic}Dir`), 4);
  const family = [0x1f468, 0x1f469, 0x1f467].map((c) => cp(c)).join(ZWJ);
  assert.equal(width(`${family} fam`), 5);
  assert.equal(width(`${cp(0x1f1fa, 0x1f1f8)} NYC`), 5);
  assert.equal(width(`${cp(0x1f44d, 0x1f3fd)}ok`), 3);
  const l = makeLabel(`${mic} Studio B Director`);
  assert.equal(l.l6, `${mic} Stud`);
  assert.equal(l.l8, `${mic} Studio`);
});

test("overrides_are_fitted (labels.rs)", () => {
  const l = labelWithOverrides("Andrey Kuzub", "ANDREY!!", null, null);
  assert.equal(l.l6, "ANDREY");
  assert.equal(l.l8, "Andrey K");
});

// --- Extra cases -----------------------------------------------------------

test("literal emoji in source agree with code-point built ones", () => {
  assert.equal(width("🎙️Dir"), 4);
  assert.equal(width("👨‍👩‍👧 fam"), 5);
  assert.equal(width("🇺🇸 NYC"), 5);
  assert.equal(width("👍🏽ok"), 3);
});

test("three regional indicators pair the first two only", () => {
  const g = graphemes(cp(0x1f1fa, 0x1f1f8, 0x1f1e8));
  assert.equal(g.length, 2);
});

test("keycap and subdivision flag are one character each", () => {
  assert.equal(width(`1${VS16}${cp(0x20e3)}`), 1);
  // England flag: black flag + tag letters + cancel tag
  const england = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
  assert.equal(width(england), 1);
});

test("CRLF is one, combining accent glues", () => {
  assert.equal(width("a\r\nb"), 3);
  assert.equal(width(`e${cp(0x301)}`), 1);
});

test("never splits an emoji at the cut", () => {
  const name = `${"ABCDE"}${cp(0x1f469)}${ZWJ}${cp(0x1f4bb)}xyz`;
  const l = makeLabel(name);
  assert.equal(l.l6, `ABCDE${cp(0x1f469)}${ZWJ}${cp(0x1f4bb)}`);
  assert.equal(l.chars, 9);
});

test("for_width picks the right cut", () => {
  const l = makeLabel("Andrey Kuzub Long Name Here");
  assert.equal(labelForWidth(l, 4), l.l6);
  assert.equal(labelForWidth(l, 7), l.l8);
  assert.equal(labelForWidth(l, 12), l.l16);
  assert.equal(l.l16, "Andrey Kuzub Lon");
});

test("trim follows Rust: BOM is kept, NEL is trimmed", () => {
  const bom = cp(0xfeff);
  assert.equal(rustTrim(`${bom}Ann`), `${bom}Ann`);
  assert.equal(rustTrim(`${cp(0x85)}Ann `), "Ann");
  assert.equal(fit("  Andrey  ", 3), "And");
  assert.equal(makeLabel("  Sam ").full, "Sam");
});

test("overrides keep chars/over* from full", () => {
  const l = labelWithOverrides("Sam", "Samuel Longname", "x", "y");
  assert.equal(l.l6, "Samuel");
  assert.equal(l.chars, 3);
  assert.equal(l.over6, false);
});
