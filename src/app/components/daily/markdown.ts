// Iris writes her notes in Markdown; the dashboard shows them as plain text.

// Emphasis, links and code markers out of one line of text. Underscores only
// count at word edges, so snake_case_names survive.
export function stripInline(text: string): string {
  return text
    // Escaped characters are set aside first so they can't be read as markers.
    .replace(/\\([*_`~#>[\]()-])/g, (_, char: string) => String.fromCharCode(0xe000 + char.charCodeAt(0)))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*(?!\s)([^*]+?)\*/g, '$1')
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?=[^\w]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[-]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xe000));
}

// A block of Markdown as plain lines: heading, list and quote markers removed,
// inline markers stripped, line breaks kept.
export function plainText(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripInline(line.trim().replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Spark {
  // The heading with its date taken off ("Philosophical Spark"), or ''.
  label: string;
  paragraphs: string[];
  // The "Source: ..." line, if there is one.
  source: string;
}

// Iris's daily spark: a heading, the passage, and a *Source: ...* line.
export function parseSpark(markdown: string): Spark {
  let label = '';
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current.join(' '));
    current = [];
  };

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const text = line.trim();
    if (!text) {
      flush();
      continue;
    }
    const heading = text.match(/^#{1,6}\s+(.*)$/);
    if (heading && !label) {
      flush();
      label = stripInline(heading[1]).replace(/\s*[—–-]\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim();
      continue;
    }
    current.push(text);
  }
  flush();

  const paragraphs: string[] = [];
  let source = '';
  for (const block of blocks) {
    const plain = stripInline(block).trim();
    if (!source && /^source\s*:/i.test(plain)) source = plain;
    else if (plain) paragraphs.push(plain);
  }
  return { label, paragraphs, source };
}
