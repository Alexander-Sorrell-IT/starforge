// A close tag a browser honours and the verifier did not.
//
// markupStrings and visibleText both exist to answer "what does this document
// SHOW a reader", and the verifier judges published HTML and SVG on the
// answer. Both stripped scripts with `</script>` or `</script\s*>`. HTML also
// ends the element on `</script bar>` and `</script\t\n foo>`, so a document
// containing one made the non-greedy match run on to the NEXT real close tag
// and blank everything between — text a browser renders and the verifier never
// looked at. CodeQL's js/bad-tag-filter named both sites; no suite here could
// have, because nothing asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markupStrings } from "../src/verify.mjs";

const VARIANTS = [
  ["a space before the bracket", "</script >"],
  ["an attribute after the name", "</script bar>"],
  ["a tab and a newline", "</script\t\n foo>"],
  ["upper case", "</SCRIPT>"],
  ["mixed case with an attribute", "</ScRiPt data-x=1>"],
];

const doc = (close) => `<html><body>
<script>var a=1;</script${close === "</script>" ? ">" : ""}${close === "</script>" ? "" : close.replace(/^<\/script/i, "")}
<p>READER-VISIBLE-42</p>
<script>var b=2;</script>
<p>tail</p>
</body></html>`;

function strings(html) {
  return markupStrings(html).map((x) => x.s).join(" | ");
}

test("the control document is read correctly", () => {
  const seen = strings(`<html><body>
<script>var a=1;</script>
<p>READER-VISIBLE-42</p>
<p>tail</p>
</body></html>`);
  assert.ok(seen.includes("READER-VISIBLE-42"));
  assert.ok(!seen.includes("var a=1"), "script body is not reader-visible");
});

for (const [label, close] of VARIANTS) {
  test(`text after a close tag with ${label} is still examined`, () => {
    const html = `<html><body>
<script>var a=1;${close}
<p>READER-VISIBLE-42</p>
<script>var b=2;</script>
<p>tail</p>
</body></html>`;
    const seen = strings(html);
    assert.ok(
      seen.includes("READER-VISIBLE-42"),
      `a document closing its script with \`${close}\` hid reader-visible text from the verifier: ${seen}`,
    );
  });
}

test("a tag that merely starts with the name does not close the element", () => {
  // `</scriptfoo>` is not a script close tag, and treating it as one would
  // make the verifier examine script bodies as prose.
  const seen = strings(`<html><body>
<script>var secret=1;</scriptfoo>
<p>tail</p>
</script>
</body></html>`);
  assert.ok(!seen.includes("var secret=1"), `script body leaked into the text: ${seen}`);
});

test("style elements close the same way", () => {
  const seen = strings(`<html><body>
<style>.a{color:red}</style bar>
<p>READER-VISIBLE-42</p>
<style>.b{}</style>
</body></html>`);
  assert.ok(seen.includes("READER-VISIBLE-42"), seen);
});
