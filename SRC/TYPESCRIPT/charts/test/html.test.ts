import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, escRust, html, htmlCompat, isSafeHtml, join, raw } from "../src/html.ts";
import { cmpRustStr, rustDisplay, rustFixed, rustLines, rustTrimEnd, utf8Len } from "../src/rustfmt.ts";
import { mountUsersPage, renderUsersBody } from "../src/users-page.ts";
import { NASTY, usersCases } from "../golden/cases.ts";

test("html`` escapes every hole, including '", () => {
  const out = html`<a title="${NASTY}" onclick="f('${"x');alert(1);//"}')">${NASTY}</a>`.value;
  assert.ok(!out.includes("<script>"));
  assert.ok(!out.includes("x');"));
  assert.equal(out, `<a title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;" onclick="f('x&#39;);alert(1);//')">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</a>`);
});

test("htmlCompat matches Rust esc (leaves ')", () => {
  assert.equal(htmlCompat`${"'<&>\""}`.value, "'&lt;&amp;&gt;&quot;");
  assert.equal(escRust("'"), "'");
  assert.equal(esc("'"), "&#39;");
});

test("nested fragments, arrays, raw, null/false", () => {
  const items = ["a<", "b"].map((x) => html`<li>${x}</li>`);
  assert.equal(html`<ul>${items}</ul>${null}${undefined}${false}${0}`.value, "<ul><li>a&lt;</li><li>b</li></ul>0");
  assert.equal(html`${raw("<b>ok</b>")}`.value, "<b>ok</b>");
  assert.ok(isSafeHtml(raw("x")));
  assert.ok(!isSafeHtml("x"));
  assert.equal(join([html`<i>1</i>`, html`<i>2</i>`], ", <").value, "<i>1</i>, &lt;<i>2</i>");
  assert.equal(String(html`<p>${1.5}</p>`), "<p>1.5</p>");
});

test("a fake SafeHtml-shaped object is still escaped", () => {
  const forged = { value: "<img onerror=x>", toString: () => "<img onerror=x>" } as unknown as string;
  assert.equal(html`${forged}`.value, "&lt;img onerror=x&gt;");
});

test("rustFixed: half-to-even ties, -0, inf, big", () => {
  assert.equal(rustFixed(0.25, 1), "0.2");
  assert.equal(rustFixed(0.75, 1), "0.8");
  assert.equal(rustFixed(2.5, 0), "2");
  assert.equal(rustFixed(3.5, 0), "4");
  assert.equal(rustFixed(-2.5, 0), "-2");
  assert.equal(rustFixed(9.5, 0), "10");
  assert.equal(rustFixed(-0, 1), "-0.0");
  assert.equal(rustFixed(-0.04, 1), "-0.0");
  assert.equal(rustFixed(1e21, 1), "1000000000000000000000.0");
  assert.equal(rustFixed(Infinity, 2), "inf");
  assert.equal(rustDisplay(1e-7), "0.0000001");
  assert.equal(rustDisplay(1.5e22), "15000000000000000000000");
  assert.equal(rustDisplay(-0), "-0");
  assert.equal(rustDisplay(62.5), "62.5");
});

test("utf8Len, trimEnd, lines, str order follow Rust", () => {
  assert.equal(utf8Len("load ×10"), 9);
  assert.equal(rustTrimEnd("a \u0085"), "a");
  assert.equal(rustTrimEnd("a\u{FEFF}"), "a\u{FEFF}");
  assert.deepEqual(rustLines("a\r\nb\n\nc\n"), ["a", "b", "", "c"]);
  assert.deepEqual(rustLines(""), []);
  assert.equal(cmpRustStr("\u{1F600}", "\u{FF5E}"), 1); // JS "<" says the opposite
  assert.ok("\u{1F600}" < "\u{FF5E}");
});

test("users body: default escaping neutralises ' and markup", () => {
  const out = renderUsersBody(usersCases[2]!).value;
  assert.ok(!out.includes("<script>"));
  // Table cells use html`` (escapes '); the SVG charts keep Rust parity (text nodes, where ' is inert).
  assert.ok(out.includes("<td>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</td>"));
  assert.ok(!/<td[^>]*>[^<]*'q'/.test(out));
});

test("mountUsersPage fetches both endpoints and renders into root", async () => {
  const data = usersCases[1]!;
  const seen: string[] = [];
  const root = { innerHTML: "" } as unknown as Element;
  const page = mountUsersPage(root, {
    base: "http://rt:8080",
    clock: () => data.now,
    fetchImpl: async (url) => {
      seen.push(url);
      const body: unknown = url.endsWith("/api/users") ? data.records : data.state;
      return { ok: true, status: 200, json: async () => body };
    },
  });
  await page.refresh();
  assert.deepEqual(seen.sort(), ["http://rt:8080/api/state", "http://rt:8080/api/users"]);
  assert.equal(root.innerHTML, renderUsersBody(data).value);
});

test("mountUsersPage rejects on HTTP error and bad shape", async () => {
  const root = { innerHTML: "keep" } as unknown as Element;
  const bad = mountUsersPage(root, { fetchImpl: async () => ({ ok: false, status: 503, json: async () => null }) });
  await assert.rejects(bad.refresh(), /HTTP 503/);
  const shape = mountUsersPage(root, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(shape.refresh(), /unexpected JSON shape/);
  assert.equal(root.innerHTML, "keep");
});
