// The emblem: the big piece of ASCII art that heads the rank card.
//
// One per tier, forge-themed, escalating — a spark, a hammer, an anvil working,
// a struck star, a crowned one. The tier is the headline (S+, S, A, B, C), the
// same role the animal name plays on the card this answers.
//
// Every emblem is at most EMBLEM_W columns wide, because the card frame CLIPS
// rather than wraps and art is the easiest thing to lose a limb off. A test
// measures all of them.
export const EMBLEM_W = 56;

// Art is stored as plain lines with no escape codes. Colour is applied by the
// caller, so the same emblem works in a colour terminal, in a NO_COLOR capture,
// and inside an SVG title.
const EMBLEMS = {
  "S+": [
    "            .          *          .           ",
    "                 \\     |     /                ",
    "        *      .--*----+----*--.      *       ",
    "               |   \\   |   /   |              ",
    "         .     |    \\  |  /    |     .        ",
    "               |     \\ | /     |              ",
    "     *---------+------\\|/------+---------*    ",
    "               |      /|\\      |              ",
    "         .     |     / | \\     |     .        ",
    "               |    /  |  \\    |              ",
    "        *      '--*----+----*--'      *       ",
    "                 /     |     \\                ",
    "            .          *          .           ",
  ],
  S: [
    "                       *                      ",
    "                      /|\\                     ",
    "               .     / | \\     .              ",
    "                \\   /  |  \\   /               ",
    "         *-------\\-*---+---*-/-------*        ",
    "                  \\    |    /                 ",
    "                   \\   |   /                  ",
    "                    \\  |  /                   ",
    "               .     \\ | /     .              ",
    "                      \\|/                     ",
    "                       *                      ",
  ],
  A: [
    "                       ^                      ",
    "                      /|\\                     ",
    "                     / | \\                    ",
    "              .     /  |  \\     .             ",
    "                   *---+---*                  ",
    "                    \\  |  /                   ",
    "                     \\ | /                    ",
    "                      \\|/                     ",
    "                       v                      ",
  ],
  B: [
    "                       .                      ",
    "                      /|\\                     ",
    "                     / | \\                    ",
    "                    *--+--*                   ",
    "                     \\ | /                    ",
    "                      \\|/                     ",
    "                       '                      ",
  ],
  C: [
    "                       .                      ",
    "                      \\|/                     ",
    "                    ---+---                   ",
    "                      /|\\                     ",
    "                       '                      ",
  ],
};

// An unknown tier must still draw something rather than crashing a card, and the
// smallest emblem is the honest default: it claims the least.
export function emblem(tier) {
  return EMBLEMS[tier] ?? EMBLEMS.C;
}

export const TIERS_WITH_ART = Object.keys(EMBLEMS);
