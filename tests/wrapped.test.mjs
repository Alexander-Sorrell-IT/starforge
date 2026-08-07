// The wrapped is the part of this tool people actually look at, so its failure
// modes are visual and silent. Two real ones, both found by rendering it and
// reading the output rather than by any assertion that existed at the time:
//
//   1. `.filter(Boolean)` was used to drop conditional lines — and it also drops
//      "", which is what every deliberate blank spacer is. Whole cards lost
//      their internal spacing and rendered as a wall of text.
//   2. the box clipper bailed out of its loop at the first "\x1b", so an
//      over-long line that STARTED with a colour code was clipped to nothing.
//      It deleted a line of copy instead of trimming it — including, on one
//      card, the sentence promising no prompt text is stored.
//
// So these tests check geometry and completeness of the rendered frame, not
// just that the functions return something.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  box, bar, miniStar, ownRank, estimateCost, buildCards, renderAll,
  wrapWords, DEFAULT_RATES,
} from "../src/wrapped.mjs";
import { ARMS, MAX_LEVEL } from "../src/starsvg.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const AGG = {
  total_sessions: 153, active_days: 29, total_duration_hours: 341,
  total_input_tokens: 54_000_000, total_output_tokens: 16_000_000,
  total_cache_read_tokens: 5_400_000_000, total_cache_write_tokens: 135_000_000,
  longest_streak_days: 16, current_streak_days: 8,
  languages: { markdown: 214, javascript: 207 },
  models: { "claude-opus-5": 10 },
  projects: [{ name: "a/b", sessions: 71 }, { name: "c/d", sessions: 32 }],
  tool_call_counts: { Bash: 6072 },
};
const PROFILE = {
  conversation: { prompt_turns: 5123, correction_rate_pct: 10.4, question_ratio: 0.04, avg_prompt_chars: 457, prompt_bucket: "spec-writer" },
  delegation: { tool_calls: 10415, delegation_ratio: 2, hands_on_code_pct: 8.1, tool_mix: [{ name: "Bash", count: 6072 }] },
  concurrency: { open_peak: 40, open_avg: 1.33, juggle_pct: 19.9, longest_session_hours: 82.3 },
  rhythm: { hour_buckets: new Array(24).fill(100), peak_hour: 21, weekend_ratio: 0.27, night_share: 0.31, night_owl: false },
  tool_relationship: { kind: "switch", from_tool: "Cowork", to_tool: "Claude Code", switch_month: "2026-08" },
};
const TIMELINE = [
  { month: "2026-05", duration_hours: 1, levels: [1, 1, 1, 0.5, 1] },
  { month: "2026-07", duration_hours: 538, levels: [5, 5, 4.7, 4, 4.7] },
  { month: "2026-08", duration_hours: 124, levels: [5, 5, 4.7, 5, 4] },
];
const LEVELS = [5, 5, 4.7, 5, 4];

test("every rendered box line is exactly the same width", () => {
  // A single mis-measured line breaks the frame for the whole card, and ANSI
  // makes .length lie — the padding has to measure VISIBLE characters.
  const cards = buildCards({ levels: LEVELS, agg: AGG, profile: PROFILE, timeline: TIMELINE, url: "https://example.com/x" });
  assert.ok(cards.length >= 8, `expected a full story, got ${cards.length} cards`);
  for (const { lines, color } of cards) {
    const rendered = strip(box(lines, { color })).split("\n");
    const widths = new Set(rendered.map((l) => [...l].length));
    assert.equal(widths.size, 1, `ragged box: widths ${[...widths].join(",")} in card starting "${strip(lines[0])}"`);
    assert.match(rendered[0], /^╭─+╮$/);
    assert.match(rendered[rendered.length - 1], /^╰─+╯$/);
  }
});

test("blank spacer lines survive into the rendered card", () => {
  // The filter(Boolean) bug: "" is falsy, so every deliberate blank line was
  // dropped and the cards rendered as a solid block of text.
  const cards = buildCards({ levels: LEVELS, agg: AGG, profile: PROFILE, timeline: TIMELINE, url: "https://example.com/x" });
  const withSpacers = cards.filter(({ lines }) =>
    strip(box(lines, {})).split("\n").some((l) => /^│\s+│$/.test(l))
  );
  assert.ok(
    withSpacers.length >= cards.length - 1,
    `only ${withSpacers.length}/${cards.length} cards kept their blank lines`
  );
});

test("an over-long coloured line is trimmed, never deleted", () => {
  const long = "\x1b[2m" + "word ".repeat(40) + "\x1b[0m";
  const rendered = strip(box([long], {})).split("\n")[1];
  const content = rendered.slice(1, -1).trim();
  assert.ok(content.length > 40, `an over-long coloured line was clipped to "${content}"`);
  assert.match(content, /^word/, "the line should start with its real text");
});

test("bar never overflows its width and is monotonic", () => {
  for (const w of [10, 14, 22]) {
    assert.equal(strip(bar(0, 100, w)).length, w);
    assert.equal(strip(bar(100, 100, w)).length, w);
    assert.equal(strip(bar(1e9, 100, w)).length, w, "an out-of-range value must not overflow the bar");
    assert.equal(strip(bar(-5, 100, w)).length, w, "a negative value must not produce a negative-length bar");
    let prevFilled = -1;
    for (let v = 0; v <= 100; v += 10) {
      const filled = (strip(bar(v, 100, w)).match(/█/g) ?? []).length;
      assert.ok(filled >= prevFilled, "a larger value must never shorten the bar");
      prevFilled = filled;
    }
  }
});

test("the mini star uses its whole box and grows with the levels", () => {
  // It was fitted as if the star were centred in a circle, which left the
  // bottom rows of every card permanently blank.
  const rows = miniStar(LEVELS, 23, 11);
  assert.equal(rows.length, 11);
  for (const r of rows) assert.equal([...r].length, 23, "every row must be the full width");
  assert.notEqual(rows[rows.length - 1].trim(), "", "the last row must not be dead space");
  assert.notEqual(rows[0].trim(), "", "the first row must not be dead space");

  const ink = (lv) => miniStar(lv, 23, 11).join("").replace(/ /g, "").length;
  assert.ok(ink([5, 5, 5, 5, 5]) > ink([1, 1, 1, 1, 1]), "a bigger profile must draw a bigger shape");
  assert.ok(ink([0, 0, 0, 0, 0]) > 0, "an empty profile still draws the floor pentagon, not nothing");
});

test("ownRank compares you to yourself, and refuses to guess from thin history", () => {
  // The honest replacement for "top 17% of users". With fewer than 3 months
  // there is no distribution to speak of, so it must say nothing at all.
  assert.equal(ownRank(5, [1, 2]), null, "two months is not a distribution");
  assert.equal(ownRank(NaN, [1, 2, 3, 4]), null);
  assert.match(strip(ownRank(100, [1, 2, 3, 4])), /your best of 4 months/);
  assert.match(strip(ownRank(2.5, [1, 2, 3, 4])), /above 50% of your 4 months/);
  // It must never claim to know about other people.
  for (const s of [ownRank(100, [1, 2, 3, 4]), ownRank(2.5, [1, 2, 3, 4])])
    assert.doesNotMatch(strip(s), /users|percentile|globally/i);
});

test("the cost estimate is arithmetic on the stated rates, and prints them", () => {
  const cost = estimateCost(
    { total_input_tokens: 1e6, total_output_tokens: 1e6, total_cache_read_tokens: 1e6, total_cache_write_tokens: 0 },
    { in: 10, out: 20, cache: 1 }
  );
  assert.equal(cost, 31);
  assert.equal(estimateCost({}, DEFAULT_RATES), 0, "no tokens must cost nothing, not NaN");
  // The rates are assumptions — the card has to say so, because this tool makes
  // no network calls and cannot look up a real price.
  const cards = buildCards({ levels: LEVELS, agg: AGG, profile: PROFILE, timeline: TIMELINE, url: "https://example.com/x" });
  const text = strip(renderAll(cards));
  assert.match(text, /per Mtok/, "the card must print the rates it used");
  assert.match(text, /assumed|rates you passed/, "the card must mark the rates as an assumption");
});

test("the wrapped never claims to know about other users", () => {
  // The entire point: a tool that has seen exactly one person's data must not
  // borrow the hosted wrapped's "top N% of users" framing.
  const cards = buildCards({
    levels: LEVELS, agg: AGG, profile: PROFILE, timeline: TIMELINE, url: "https://example.com/x",
  });
  // The proof card QUOTES the hosted framing in order to disclaim it, so it is
  // checked separately rather than exempted by keyword — otherwise this test
  // could be silenced by moving a claim onto that card.
  const proof = cards.find((c) => strip(c.lines[0]).includes("WHAT LEFT THIS MACHINE"));
  assert.ok(proof, "the proof card must be in the story");
  const others = cards.filter((c) => c !== proof);
  for (const c of others) {
    const t = strip(c.lines.join("\n"));
    assert.doesNotMatch(t, /top \d+% of users/i, `a card claims a cross-user percentile: ${strip(c.lines[0])}`);
    assert.doesNotMatch(t, /leaderboard|percentile of users|of \d+ users/i, `card: ${strip(c.lines[0])}`);
  }
  const proofText = strip(proof.lines.join("\n"));
  assert.match(proofText, /"top \d+% of users" anywhere in it/, "the proof card must name what it refuses to do");
  assert.match(proofText, /no process can prove that about itself/i);
  assert.match(proofText, /compares you to your own\s+history/i);
});

test("cards with no data are dropped, not rendered empty", () => {
  const cards = buildCards({ levels: [0, 0, 0, 0, 0], agg: {}, profile: null, timeline: [], url: "https://example.com/x" });
  assert.ok(cards.length >= 1, "the star and proof cards stand alone");
  for (const { lines } of cards)
    assert.ok(lines.length > 2, "a rendered card must have real content");
  const text = strip(renderAll(cards));
  assert.doesNotMatch(text, /undefined|NaN|\[object/, "missing data must never surface as undefined/NaN");
});

test("wrapWords never exceeds its width and loses no words", () => {
  const text = "the kernel refuses our own escape attempt inside the sandbox while the identical attempt outside connected";
  for (const w of [20, 40, 55]) {
    const lines = wrapWords(text, w);
    for (const l of lines) assert.ok(l.length <= w, `"${l}" is ${l.length} > ${w}`);
    assert.equal(lines.join(" "), text, "wrapping must not drop or duplicate words");
  }
});

test("providers come as an OBJECT keyed by name — the shape the scanner returns", async () => {
  // This is the bug that shipped: cardTokens did `(providers ?? []).filter(...)`
  // on the value of scanAllProviders().providers, which is an object keyed by
  // provider name with rows of {sessions,input,output,cacheRead,cacheWrite}.
  // It threw on the DEFAULT path — every run that did not pass --no-providers —
  // and killed the whole invocation after the scan, the snapshots and the stars
  // had all finished. Every test I had written used --no-providers, so nothing
  // covered the path real users take.
  const { normaliseProviders, cardTokens } = await import("../src/wrapped.mjs");
  const real = {
    gemini: { sessions: 4, input: 1e8, output: 9e7, cacheRead: 7e8, cacheWrite: 1e7 },
    copilot: { sessions: 36, input: 2e8, output: 5e7, cacheRead: 2e8, cacheWrite: 4e7 },
    idle: { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const norm = normaliseProviders(real);
  assert.equal(norm.length, 2, "providers with no tokens must be dropped");
  // gemini totals 900M against copilot's 490M — ordering is by TOKENS, not by
  // session count, which is what a token card should rank on.
  assert.equal(norm[0].name, "gemini", "biggest by tokens first");
  assert.ok(norm[0].tokens > norm[1].tokens);

  // The card must render with the real shape and not throw.
  const lines = cardTokens(AGG, real, DEFAULT_RATES);
  assert.ok(Array.isArray(lines) && lines.length);
  const text = strip(lines.join("\n"));
  assert.match(text, /gemini/);
  assert.match(text, /copilot/);
  assert.doesNotMatch(text, /undefined|NaN/);

  // And the shapes it must tolerate rather than crash on.
  assert.deepEqual(normaliseProviders(null), []);
  assert.deepEqual(normaliseProviders(undefined), []);
  assert.deepEqual(normaliseProviders({}), []);
  assert.equal(normaliseProviders([{ name: "x", total_tokens: 5 }])[0].tokens, 5, "array form must still work");
});

test("a card that throws costs you that card, never the run", async () => {
  // Drawing is the least important thing this program does and must fail like
  // it. Before this, one bad card threw away a two-minute scan at the very end.
  const { buildCardsSafe } = await import("../src/wrapped.mjs");
  const poisoned = {
    levels: LEVELS, agg: AGG, profile: PROFILE, timeline: TIMELINE, url: "https://example.com/x",
    // A getter that throws when the tokens card reads it.
    get providers() { throw new Error("boom from a provider row"); },
  };
  let cards;
  assert.doesNotThrow(() => { cards = buildCardsSafe(poisoned); }, "one bad card must not abort the build");
  assert.ok(cards.length >= 8, `expected the other cards to survive, got ${cards.length}`);
  const text = strip(renderAll(cards));
  assert.match(text, /THE SHAPE OF YOUR WORK/, "unrelated cards must still render");
  assert.match(text, /WHAT LEFT THIS MACHINE/);
  assert.match(text, /could not be drawn/, "the failed card must name itself rather than vanish");
  assert.match(text, /rendering fault only/, "and must say the scan itself was fine");
});

test("no card can be made to throw, whatever it is handed", async () => {
  // The shipped crash was a card trusting the shape its one caller happened to
  // pass. A fuzz over hostile arguments then found 598 crashing combinations
  // out of 2028 — the same defect, everywhere. Cards are the LAST thing a run
  // does, so a card that raises can throw away a completed two-minute scan.
  // The rule this pins: a card either returns lines or returns null. Never
  // raises, whatever it is given.
  const W = await import("../src/wrapped.mjs");
  const hostile = [
    null, undefined, {}, [], 0, "", NaN, Infinity, true,
    { weird: 1 }, { rhythm: {} }, { conversation: {} }, { delegation: {} },
    { concurrency: {} }, [1, 2], ["a", "b", "c", "d", "e"],
    { projects: [null] }, { projects: "nope" }, { levels: null },
    { hour_buckets: "no" }, { total_sessions: "many" },
  ];
  const cards = [
    "cardStar", "cardManaged", "cardHistory", "cardTokens", "cardShapeOverTime",
    "cardRhythm", "cardHowYouDrive", "cardAgents", "cardStack", "cardProjects",
    "cardProof", "cardShare",
  ];
  const failures = [];
  for (const name of cards) {
    const fn = W[name];
    assert.equal(typeof fn, "function", `${name} must be exported`);
    for (const a of hostile) {
      for (const b of hostile) {
        try {
          const out = fn(a, b, W.DEFAULT_RATES);
          if (out !== null && !Array.isArray(out))
            failures.push(`${name} returned ${typeof out}, expected array or null`);
          if (Array.isArray(out))
            for (const line of out)
              if (typeof line !== "string")
                failures.push(`${name} produced a non-string line: ${typeof line}`);
        } catch (e) {
          failures.push(`${name}(${JSON.stringify(a)}, ${JSON.stringify(b)}) threw: ${e.message}`);
        }
      }
    }
  }
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} card failures; first few shown`);
});
