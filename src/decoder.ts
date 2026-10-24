/**
 * Natsoft frame decoding.
 *
 * Frames that start with `<` are plain XML. Anything else is XOR-chained: each character is XORed with the
 * previous *decoded* character (seed 0x7F), and decoded values 22–31 expand to common XML fragments.
 * Mirrors Natsoft's own browser client. Works on UTF-16 code units, like the original.
 */
const MACROS: Record<number, string> = {
  22: "><",
  23: ' T="',
  24: '="0.0000" ',
  25: '="0" ',
  26: '="" ',
  27: '" /><',
  28: '"><',
  29: '" />',
  30: '="',
  31: '" ',
};

export function decodeFrame(data: string): string {
  if (data.length === 0 || data[0] === "<") return data;
  const out: string[] = [];
  let prev = 0x7f;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i) ^ prev;
    const macro = c >= 22 && c <= 31 ? MACROS[c] : undefined;
    out.push(macro ?? String.fromCharCode(c));
    prev = c;
  }
  return out.join("");
}

/** Inverse of decodeFrame for plain characters only (no macros). Used by tests and the demo. */
export function encodeFrame(plain: string): string {
  const out: string[] = [];
  let prev = 0x7f;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain.charCodeAt(i);
    out.push(String.fromCharCode(ch ^ prev));
    prev = ch;
  }
  return out.join("");
}

/** Root element name: New, L, C, NotFound, Redirect… or "?" */
export function rootName(xml: string): string {
  const m = /<([A-Za-z0-9_]+)/.exec(xml);
  return m ? m[1] : "?";
}
