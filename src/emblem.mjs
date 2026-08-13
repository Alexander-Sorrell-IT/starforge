// The emblem: the big piece of ASCII art that heads the rank card.
//
// One per forge tier, escalating — a spark at RAW, rays spreading from a centre
// point at MASTERWORK. The rays-from-centre geometry is the whole image: every
// arm of the emblem radiates from the same + just as every arm of the skill star
// radiates from the same origin. The art is kept as plain lines with no escape
// codes so colour can be applied by the caller and the same emblem works in a
// colour terminal, a NO_COLOR capture, or an SVG title.
//
// Every emblem is at most EMBLEM_W columns wide, because the card frame CLIPS
// rather than wraps and art is the easiest thing to lose a limb off. A test
// measures all of them.
export const EMBLEM_W = 56;

const EMBLEMS = {
  MASTERWORK: [
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
  TEMPERED: [
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
  FORGED: [
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
  CAST: [
    "                       .                      ",
    "                      /|\\                     ",
    "                     / | \\                    ",
    "                    *--+--*                   ",
    "                     \\ | /                    ",
    "                      \\|/                     ",
    "                       '                      ",
  ],
  RAW: [
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
  return EMBLEMS[tier] ?? EMBLEMS.RAW;
}

export const TIERS_WITH_ART = Object.keys(EMBLEMS);
