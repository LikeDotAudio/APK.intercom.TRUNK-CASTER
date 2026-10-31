import { test } from "node:test";
import assert from "node:assert/strict";
import { airportOf, continentOf, defaultSites, normalizeSites, oceanBetween, slugify, tierFrameShape, totalFrames } from "./sites.ts";
import { Layout, isReserved, joinPath } from "./folders.ts";

test("default sites: counts by tier", () => {
  const s = defaultSites();
  const by = (t: string): number => s.sites.filter((x) => x.tier === t).length;
  assert.equal(s.sites.length, 179);
  assert.equal(by("capital"), 54);
  assert.equal(by("city"), 42);
  assert.equal(by("province"), 83);
  assert.equal(totalFrames(s), 54 * 10 + 42 * 2 + 83);
  assert.ok(s.sites.every((x) => x.continent !== "Other"), "every default country maps to a continent");
});

test("continent lookup order and substrings", () => {
  assert.equal(continentOf("Türkiye"), "Middle East");
  assert.equal(continentOf("Czechia"), "Europe");
  assert.equal(continentOf("Romania"), "Europe"); // contains "oman", Europe wins by order
  assert.equal(continentOf("Atlantis"), "Other");
});

test("oceans are symmetric", () => {
  assert.equal(oceanBetween("Europe", "North America"), "North Atlantic");
  assert.equal(oceanBetween("North America", "Europe"), "North Atlantic");
  assert.equal(oceanBetween("Asia", "Asia"), undefined);
  assert.equal(oceanBetween("Other", "Europe"), "open ocean");
});

test("slugify is ASCII-only, like Rust (latent: accents become dashes)", () => {
  assert.equal(slugify("New South Wales"), "new-south-wales");
  assert.equal(slugify("Brasília"), "bras-lia");
  assert.equal(slugify("São Paulo"), "s-o-paulo");
  assert.equal(slugify("Kraków"), "krak-w");
});

test("normalize fills blanks", () => {
  const s = normalizeSites({ sites: [{ name: "Test Town", slug: "", country: "Canada", tier: "city", lat: 0, lon: 0 }] });
  assert.deepEqual(s.sites[0], { name: "Test Town", slug: "test-town", country: "Canada", continent: "North America", tier: "city", lat: 0, lon: 0, frames: 2 });
  assert.deepEqual(tierFrameShape("city", 0), [8, 8]);
  assert.deepEqual(tierFrameShape("city", 1), [2, 2]);
  assert.equal(tierFrameShape("capital", 0), undefined);
});

test("folder contract", () => {
  assert.ok(isReserved("trunk-anything"));
  assert.ok(isReserved("known protocols"));
  assert.ok(!isReserved("Riedel"));
  const l = new Layout("C:\\tc");
  assert.equal(l.checkinFile(), "C:\\tc\\TRUNK-CROSS POINTS\\checkin.wb");
  assert.equal(new Layout("/data").fader(), "/data/TRUNK-SIMULATOR/fader.json");
  assert.equal(joinPath("/data/", "a"), "/data/a");
});

test("airport codes: longest prefix wins, else three letters", () => {
  assert.equal(airportOf("Boston"), "BOS");
  assert.equal(airportOf("Washington State"), "SEA");
  assert.equal(airportOf("Washington"), "DCA");
  assert.equal(airportOf("West Virginia"), "CRW");
  assert.equal(airportOf("Virginia"), "IAD");
  assert.equal(airportOf("São Paulo"), "GRU");
  assert.equal(airportOf("Kraków"), "KRK");
  assert.equal(airportOf("Ürümqi"), "RMQ"); // non-ASCII letters skipped
  assert.equal(airportOf("Atlantis"), "ATL"); // prefix "atlanta" does not match
  assert.equal(airportOf("x1"), "X");
  assert.ok(defaultSites().sites.every((s) => /^[A-Z]{1,3}$/.test(airportOf(s.name))));
});
