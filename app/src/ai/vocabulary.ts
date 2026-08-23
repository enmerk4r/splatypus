/**
 * The label set the object namer chooses from.
 *
 * CLIP is zero-shot: it scores an image against whatever phrases you give it and returns
 * the closest, so the vocabulary *is* the classifier. A curated list beats an open one
 * here — the scenes are interior scans, and an unconstrained model will happily label a
 * desk "a table" or a chair leg "a microphone". Keeping the list to what actually turns up
 * in a room capture is what makes the answers useful rather than merely plausible.
 *
 * Phrasing matters: CLIP was trained on captions, so "a photo of a monitor" scores more
 * reliably than the bare noun. `PROMPT` supplies that wrapper, leaving the entries here
 * readable and reusable as display names.
 */

export const PROMPT = (label: string): string => `a photo of ${label}`;

export interface VocabularyEntry {
  /** What the user sees on the group. */
  name: string;
  /** What CLIP is asked about; defaults to `name`. Several phrasings can share a name. */
  phrase?: string;
}

/**
 * Several phrasings map to one display name on purpose: a monitor photographs very
 * differently from a TV but means the same thing to someone tidying up a scan, and giving
 * CLIP both wordings catches more of them than either alone.
 */
export const VOCABULARY: readonly VocabularyEntry[] = [
  { name: 'Monitor', phrase: 'a computer monitor' },
  { name: 'Monitor', phrase: 'a television screen' },
  { name: 'Laptop', phrase: 'a laptop computer' },
  { name: 'Keyboard', phrase: 'a computer keyboard' },
  { name: 'Mouse', phrase: 'a computer mouse' },
  { name: 'Desk', phrase: 'a desk' },
  { name: 'Table', phrase: 'a table' },
  { name: 'Chair', phrase: 'an office chair' },
  { name: 'Chair', phrase: 'a chair' },
  { name: 'Sofa', phrase: 'a sofa' },
  { name: 'Shelf', phrase: 'a bookshelf' },
  { name: 'Cabinet', phrase: 'a cabinet' },
  { name: 'Drawer unit', phrase: 'a drawer unit' },
  { name: 'Lamp', phrase: 'a lamp' },
  { name: 'Ceiling light', phrase: 'a ceiling light fixture' },
  { name: 'Window', phrase: 'a window' },
  { name: 'Door', phrase: 'a door' },
  { name: 'Wall', phrase: 'a blank wall' },
  { name: 'Floor', phrase: 'a floor' },
  { name: 'Ceiling', phrase: 'a ceiling' },
  { name: 'Carpet', phrase: 'a carpet or rug' },
  { name: 'Plant', phrase: 'a potted plant' },
  { name: 'Whiteboard', phrase: 'a whiteboard' },
  { name: 'Picture', phrase: 'a framed picture on a wall' },
  { name: 'Book', phrase: 'books' },
  { name: 'Paper', phrase: 'sheets of paper' },
  { name: 'Box', phrase: 'a cardboard box' },
  { name: 'Bag', phrase: 'a bag or backpack' },
  { name: 'Bottle', phrase: 'a bottle' },
  { name: 'Cup', phrase: 'a mug or cup' },
  { name: 'Phone', phrase: 'a mobile phone' },
  { name: 'Printer', phrase: 'a printer' },
  { name: 'Speaker', phrase: 'a loudspeaker' },
  { name: 'Cable', phrase: 'cables and wires' },
  { name: 'Radiator', phrase: 'a radiator' },
  { name: 'Pipe', phrase: 'a pipe or duct' },
  { name: 'Stairs', phrase: 'a staircase' },
  { name: 'Railing', phrase: 'a handrail or railing' },
  { name: 'Curtain', phrase: 'a curtain or blind' },
  { name: 'Bin', phrase: 'a waste bin' },
  { name: 'Person', phrase: 'a person' },
];

/**
 * A deliberate none-of-the-above class. Every group gets *some* nearest label, so without
 * a competing "background" option a scrap of wall reliably comes back as furniture. These
 * absorb that, and a group landing on one is left unnamed.
 */
export const REJECT_PHRASES: readonly string[] = [
  'a blurry photograph of nothing',
  'a random texture',
  'an empty grey background',
];

/** Every phrase put to CLIP, rejects last. */
export function allPhrases(): string[] {
  return [
    ...VOCABULARY.map((entry) => PROMPT(entry.phrase ?? entry.name)),
    ...REJECT_PHRASES.map(PROMPT),
  ];
}

/** Display name for a phrase index, or undefined when it landed on a reject class. */
export function nameOf(index: number): string | undefined {
  return VOCABULARY[index]?.name;
}
