// Every TS port against the output of the real Rust functions (golden.json,
// produced by golden/gen-golden.ts compiling html.rs's own code).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { barChart, fmtNum, heatMatrix, lineChart, niceCeiling } from "../src/charts.ts";
import { rustDisplay } from "../src/rustfmt.ts";
import { dur, durF, hm, hms, mdHtml } from "../src/text.ts";
import { renderUsersBody } from "../src/users-page.ts";
import { barCases, durCases, durFCases, fmtCases, heatCases, hmCases, lineCases, mdCases, niceCases, usersCases } from "../golden/cases.ts";

const golden = JSON.parse(readFileSync(new URL("../golden/golden.json", import.meta.url), "utf8")) as Record<string, string[]>;

function check<T>(group: string, inputs: readonly T[], port: (x: T) => string): void {
  const want = golden[group];
  assert.ok(want, `golden group ${group}`);
  assert.equal(want.length, inputs.length, `${group}: golden is stale, re-run gen-golden.ts`);
  inputs.forEach((x, i) => assert.equal(port(x), want[i], `${group}[${i}]`));
}

test("dur", () => check("dur", durCases, dur));
test("dur_f", () => check("dur_f", durFCases, durF));
test("hm", () => check("hm", hmCases, hm));
test("hms", () => check("hms", hmCases, hms));
test("nice_ceiling", () => check("nice_ceiling", niceCases, (v) => rustDisplay(niceCeiling(v))));
test("fmt_num", () => check("fmt_num", fmtCases, fmtNum));
test("md_html", () => check("md_html", mdCases, mdHtml));
test("line_chart", () => check("line_chart", lineCases, (k) => lineChart(k.title, k.xs, k.series, k.yMax)));
test("bar_chart", () => check("bar_chart", barCases, (k) => barChart(k.title, k.cats, k.series)));
test("heat_matrix", () =>
  check("heat_matrix", heatCases, (k) =>
    heatMatrix(k.title, k.labels, (a, b) => k.matrix[k.labels.indexOf(a)]?.[k.labels.indexOf(b)] ?? 0),
  ));
test("users_page body (compat escaping)", () => check("users_page", usersCases, (d) => renderUsersBody(d, { compat: true }).value));
