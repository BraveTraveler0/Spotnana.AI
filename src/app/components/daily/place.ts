// Part of town and cost for an event. Iris writes both on her cards (TASKS-CONTRACT.md:
// "area" and "cost", null when she doesn't know); when a card has neither, or a task
// was typed or made from a suggestion, they are read out of the wording ("... in
// Doraville", "free lesson", "~$15-20"). Nothing is guessed: no match, no label.

// Neighbourhoods and nearby cities, spelled the way people write them here.
// "Downtown" is the vaguest, so any other match beats it ("downtown Decatur").
const PLACES: string[][] = [
  ['Midtown'], ['Buckhead'], ['Decatur'], ['Doraville'], ['Tucker'], ['Northlake', 'North Lake'],
  ['Druid Hills'], ['North Druid Hills'], ['Brookhaven'], ['Chamblee'], ['Dunwoody'], ['Sandy Springs'],
  ['Smyrna'], ['Vinings'], ['Marietta'], ['Kennesaw'], ['Roswell'], ['Alpharetta'], ['Norcross'],
  ['Peachtree Corners'], ['Duluth'], ['Lawrenceville'], ['Snellville'], ['Stone Mountain'],
  ['Clarkston'], ['Lithonia'], ['Conyers'], ['Avondale Estates'], ['Kirkwood'], ['Edgewood'],
  ['East Atlanta'], ['East Point'], ['College Park'], ['Hapeville'], ['West End'], ['Castleberry Hill'],
  ['Old Fourth Ward', 'O4W'], ['Inman Park'], ['Virginia-Highland', 'Virginia Highland'],
  ['Poncey-Highland', 'Poncey Highland'], ['Little Five Points', 'L5P'], ['Candler Park'],
  ['Grant Park'], ['Reynoldstown'], ['Cabbagetown'], ['Ormewood Park'], ['Summerhill'],
  ['Atlantic Station'], ['Westside'], ['Ansley Park'], ['Morningside'], ['Lindbergh'],
  ['Sweet Auburn'], ['Vine City'], ['Downtown'],
];

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STREET_WORD = /^\s*(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Pkwy|Parkway|Way|Ln|Lane|Ct|Court|Hwy|Pl|Place)\b/i;
const ATLANTA_AREA = /\b(?:atlanta area|metro atlanta|greater atlanta)\b/i;

interface Hit {
  name: string;
  at: number;
  score: number;
}

// The part of town an event's wording points at. "in Doraville" and the city after
// a street address ("185 Sams St, Decatur") outrank a bare mention, and a street
// named after a place ("N Decatur Rd") is not the place.
function placeIn(text: string): string | null {
  const hits: Hit[] = [];
  for (const [name, ...aliases] of PLACES) {
    for (const spelling of [name, ...aliases]) {
      for (const match of text.matchAll(new RegExp(`\\b${escapeRegex(spelling)}\\b`, 'gi'))) {
        const at = match.index ?? 0;
        const before = text.slice(Math.max(0, at - 48), at);
        const after = text.slice(at + match[0].length);
        let score = name === 'Downtown' ? 0.5 : 1;
        if (/\b(?:in|at|near|around|@)\s+$/i.test(before)) score += 2;
        if (/\d+\s[^,;·—]*,\s*$/.test(before)) score += 3;
        if (STREET_WORD.test(after)) score -= 2;
        // "15 min e-bike from Tucker": a distance from somewhere, not where it is.
        if (/\b(?:from|than)\s+$/i.test(before)) score -= 2;
        hits.push({ name, at, score });
      }
    }
  }
  const likely = hits.filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.at - b.at);
  if (likely.length === 0) return cityIn(text) ?? (ATLANTA_AREA.test(text) ? 'Atlanta' : null);
  return likely[0].name;
}

// A town outside the list above, from its address ("1150 Carruth Rd, Watkinsville GA")
// or "at his HQ outside Madison, GA".
const CITY_AFTER_ADDRESS = /\d+\s[^,;·—]*,\s*([A-Z][A-Za-z.'’-]+(?: [A-Z][A-Za-z.'’-]+)?),?\s+(?:GA|Georgia)\b/;
const CITY_NEAR = /\b(?:in|near|outside|at)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?),\s*(?:GA|Georgia)\b/;

function cityIn(text: string): string | null {
  return text.match(CITY_AFTER_ADDRESS)?.[1] ?? text.match(CITY_NEAR)?.[1] ?? null;
}

const FREE = /\b(?:free(?!\s+(?:parking|wi-?fi|shipping|refills?|drinks?))|no cover|no charge|no cost|complimentary)\b/i;
const DONATION = /\b(?:donation|pay what you (?:can|want)|sliding scale)\b/i;
// "$12", "~$15-20", "$20-40 all-in", "$40-ish"
const PRICE = /~?\$\s?\d{1,4}(?:\.\d{2})?(?:\s*[-–—]\s*~?\$?\s?\d{1,4})?(?:-ish|\+)?/;

// What it costs, as short as the card wants it: "Free", "$12", "~$15–20", "Donation".
// "free" for some people only ("kids under 13 free", "free for members") is not what it costs.
const FREE_FOR_SOME = /\b(?:kids?|children|youth|teens?|students?|seniors?|members?|under[\s-]*\d+|ages?\s+\d+)\b[^.;]{0,30}\bfree\b|\bfree\b[^.;]{0,30}\b(?:kids?|children|under[\s-]*\d+|for\s+(?:members|students|seniors))\b/i;

function costIn(text: string): string | null {
  if (FREE.test(text) && !(PRICE.test(text) && FREE_FOR_SOME.test(text))) return 'Free';
  const price = text.match(PRICE);
  if (price) return price[0].replace(/\s+/g, '').replace(/[-—]/g, (dash, at, whole) => (/\d/.test(whole[at - 1] ?? '') && /[\d$~]/.test(whole[at + 1] ?? '') ? '–' : dash));
  return DONATION.test(text) ? 'Donation' : null;
}

export function extractAreaCost(description: string): { area: string | null; cost: string | null; cleaned: string } {
  return { area: placeIn(description), cost: costIn(description), cleaned: description };
}

interface Describable {
  title?: string;
  label?: string;
  detail?: string;
  note?: string;
  area?: string | null;
  cost?: string | null;
}

const wording = (item: Describable) => `${item.title ?? item.label ?? ''}. ${item.detail ?? item.note ?? ''}`;

// What Iris wrote on the card (or what was kept from it), else what the wording says.
export function areaFor(item: Describable): string | null {
  return item.area?.trim() || extractAreaCost(wording(item)).area;
}

export function costFor(item: Describable): string | null {
  return item.cost?.trim() || extractAreaCost(wording(item)).cost;
}
