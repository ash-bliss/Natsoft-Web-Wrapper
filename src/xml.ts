/**
 * A tiny XML reader for Natsoft's messages: elements and attributes only (they carry no text content).
 * Workers have no DOMParser, and the messages are small and regular, so this is all we need.
 */
export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescape(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent] ?? whole;
  });
}

const ATTR = /([A-Za-z_][\w.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parses every top-level element in the text (a frame can hold more than one). */
export function parseXml(xml: string): XNode[] {
  const roots: XNode[] = [];
  const stack: XNode[] = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    const next = xml[lt + 1];
    if (next === "?" || next === "!") {
      // declaration, comment or CDATA: skip it
      const end = next === "!" && xml.startsWith("<!--", lt) ? xml.indexOf("-->", lt) + 2 : xml.indexOf(">", lt);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    // find the end of the tag, respecting quoted attribute values
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const ch = xml[j];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      j++;
    }
    if (j >= n) break; // truncated tag
    const body = xml.slice(lt + 1, j);
    i = j + 1;

    if (body[0] === "/") {
      stack.pop();
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^([A-Za-z_][\w.\-]*)/.exec(inner);
    if (!nameMatch) continue;
    const node: XNode = { name: nameMatch[1], attrs: {}, children: [] };
    ATTR.lastIndex = nameMatch[1].length;
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(inner))) node.attrs[a[1]] = unescape(a[2] ?? a[3] ?? "");

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!selfClosing) stack.push(node);
  }
  return roots;
}

export const str = (n: XNode, k: string): string | undefined => n.attrs[k];
export function num(n: XNode, k: string): number | undefined {
  const v = n.attrs[k];
  if (v === undefined || v.trim() === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}
export function int(n: XNode, k: string): number | undefined {
  const x = num(n, k);
  return x === undefined ? undefined : Math.trunc(x);
}
export const child = (n: XNode, name: string) => n.children.find((c) => c.name === name);
export const childrenNamed = (n: XNode, name: string) => n.children.filter((c) => c.name === name);
