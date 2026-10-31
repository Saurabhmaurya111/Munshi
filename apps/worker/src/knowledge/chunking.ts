import type {
  ChunkOptions,
  PolicyChunkDraft,
} from "./types.js";

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;

type TextUnit = {
  text: string;
  paragraph: number;
};

export function normalizePolicyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveOptions(options: ChunkOptions): {
  maxChars: number;
  overlapChars: number;
} {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  if (!Number.isInteger(maxChars) || maxChars < 20) {
    throw new RangeError("maxChars must be an integer of at least 20");
  }

  if (!Number.isInteger(overlapChars) || overlapChars < 0) {
    throw new RangeError("overlapChars must be a non-negative integer");
  }

  if (overlapChars >= maxChars) {
    throw new RangeError("overlapChars must be smaller than maxChars");
  }

  return { maxChars, overlapChars };
}

function hardSplit(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();

  while (rest.length > maxChars) {
    const breakAt = rest.lastIndexOf(" ", maxChars);
    const cut = breakAt > 0 ? breakAt : maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) {
    pieces.push(rest);
  }

  return pieces;
}

function splitSentences(paragraph: string, maxChars: number): string[] {
  const sentences =
    paragraph.match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g)?.map((value) => value.trim()) ??
    [paragraph];

  return sentences
    .filter((sentence) => sentence.length > 0)
    .flatMap((sentence) =>
      sentence.length > maxChars ? hardSplit(sentence, maxChars) : [sentence],
    );
}

function toUnits(text: string, maxChars: number): TextUnit[] {
  const units: TextUnit[] = [];
  const paragraphs = text.split(/\n{2,}/);

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const trimmed = paragraph.trim();

    if (!trimmed) {
      return;
    }

    const sentences =
      trimmed.length > maxChars ? splitSentences(trimmed, maxChars) : [trimmed];

    sentences.forEach((sentence) => {
      units.push({ text: sentence, paragraph: paragraphIndex });
    });
  });

  return units;
}

function joinUnits(units: TextUnit[]): string {
  return units
    .map((unit, index) => {
      if (index === 0) {
        return unit.text;
      }

      const previous = units[index - 1];
      const separator = previous?.paragraph === unit.paragraph ? " " : "\n\n";

      return `${separator}${unit.text}`;
    })
    .join("");
}

function splitMarkdownSections(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const section = current.join("\n").trim();

    if (section) {
      sections.push(section);
    }

    current = [];
  };

  lines.forEach((line) => {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
    }

    if (!inFence && /^#{1,2}\s+/.test(line) && current.length > 0) {
      flush();
    }

    current.push(line);
  });

  flush();

  return sections;
}

function chunkPlainText(
  text: string,
  maxChars: number,
  overlapChars: number,
): string[] {
  const units = toUnits(text, maxChars);
  const chunks: string[] = [];

  let start = 0;

  while (start < units.length) {
    const chunkUnits: TextUnit[] = [];
    let end = start;

    while (end < units.length) {
      const unit = units[end];

      if (!unit) {
        break;
      }

      const candidate = [...chunkUnits, unit];

      if (chunkUnits.length > 0 && joinUnits(candidate).length > maxChars) {
        break;
      }

      chunkUnits.push(unit);
      end += 1;
    }

    chunks.push(joinUnits(chunkUnits));

    if (end >= units.length) {
      break;
    }

    let overlapStart = end;
    let overlapLength = 0;

    while (overlapStart > start) {
      const previous = units[overlapStart - 1];

      if (!previous) {
        break;
      }

      const added = previous.text.length + (overlapLength > 0 ? 1 : 0);

      if (overlapLength + added > overlapChars) {
        break;
      }

      overlapLength += added;
      overlapStart -= 1;
    }

    start = overlapStart > start ? overlapStart : end;
  }

  return chunks;
}

function chunkSection(
  section: string,
  maxChars: number,
  overlapChars: number,
): string[] {
  if (section.length <= maxChars) {
    return [section];
  }

  const match = section.match(/^(#{1,2})[ \t]+([^\n]+)\n?/);

  if (!match) {
    return chunkPlainText(section, maxChars, overlapChars);
  }

  const heading = match[0].trim();
  const body = section.slice(match[0].length);

  if (!body.trim()) {
    return [section];
  }

  const prefix = `${heading}\n\n`;
  const bodyMaxChars = maxChars - prefix.length;

  if (bodyMaxChars < 20) {
    return chunkPlainText(section, maxChars, overlapChars);
  }

  const bodyOverlap = Math.min(overlapChars, bodyMaxChars - 1);

  return chunkPlainText(body, bodyMaxChars, bodyOverlap).map(
    (part) => `${prefix}${part}`,
  );
}

export function chunkPolicyText(
  text: string,
  options: ChunkOptions = {},
): PolicyChunkDraft[] {
  const normalized = normalizePolicyText(text);

  if (!normalized) {
    return [];
  }

  const { maxChars, overlapChars } = resolveOptions(options);
  const chunks: PolicyChunkDraft[] = [];

  for (const section of splitMarkdownSections(normalized)) {
    for (const content of chunkSection(section, maxChars, overlapChars)) {
      chunks.push({
        chunkIndex: chunks.length,
        content,
      });
    }
  }

  return chunks;
}
