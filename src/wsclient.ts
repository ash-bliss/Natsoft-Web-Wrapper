/**
 * A minimal HTTP/1.1 + WebSocket client over a raw byte stream.
 *
 * Workers' fetch() only reaches ports 80/443, and Natsoft's live server is on 8080, so we open a TLS socket
 * with `connect()` and speak the protocols ourselves. Kept transport-agnostic so it can be tested in Node.
 */

export interface Transport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
}

export type Connector = (host: string, port: number, tls: boolean) => Promise<Transport>;

const enc = new TextEncoder();

/** Buffers incoming bytes so we can read lines/headers and exact-length frames. */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.reader.read();
    if (done) { this.done = true; return false; }
    if (value && value.length) { this.chunks.push(value); this.length += value.length; }
    return true;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const need = n - off;
      if (c.length <= need) { out.set(c, off); off += c.length; this.chunks.shift(); }
      else { out.set(c.subarray(0, need), off); this.chunks[0] = c.subarray(need); off += need; }
    }
    this.length -= n;
    return out;
  }

  private peekAll(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0];
    const all = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) { all.set(c, off); off += c.length; }
    this.chunks = [all];
    return all;
  }

  async exactly(n: number): Promise<Uint8Array> {
    while (this.length < n) if (!(await this.fill())) throw new Error("connection closed");
    return this.take(n);
  }

  /** Reads up to and including the first \r\n\r\n. */
  async headerBlock(limit = 64 * 1024): Promise<string> {
    for (;;) {
      const all = this.peekAll();
      for (let i = 3; i < all.length; i++) {
        if (all[i - 3] === 13 && all[i - 2] === 10 && all[i - 1] === 13 && all[i] === 10) {
          return new TextDecoder().decode(this.take(i + 1));
        }
      }
      if (this.length > limit) throw new Error("response headers too large");
      if (!(await this.fill())) throw new Error("connection closed before headers");
    }
  }

  async rest(limit = 8 * 1024 * 1024): Promise<Uint8Array> {
    while (await this.fill()) if (this.length > limit) throw new Error("response too large");
    return this.length ? this.take(this.length) : new Uint8Array(0);
  }

  release() { try { this.reader.releaseLock(); } catch { /* ignore */ } }
}

interface ParsedHead { status: number; headers: Record<string, string> }

function parseHead(block: string): ParsedHead {
  const lines = block.split("\r\n");
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "");
  if (!m) throw new Error(`bad HTTP response: ${JSON.stringify((lines[0] ?? "").slice(0, 80))}`);
  const headers: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { status: Number(m[1]), headers };
}

function dechunk(body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i < body.length) {
    let j = i;
    while (j + 1 < body.length && !(body[j] === 13 && body[j + 1] === 10)) j++;
    const size = parseInt(new TextDecoder().decode(body.subarray(i, j)).split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(body.subarray(j + 2, j + 2 + size));
    i = j + 2 + size + 2;
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function target(url: URL) {
  const tls = url.protocol === "https:" || url.protocol === "wss:";
  const port = url.port ? Number(url.port) : tls ? 443 : 80;
  const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return { tls, port, hostHeader, path: (url.pathname || "/") + url.search };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]);
}

/** A plain GET with Connection: close. Enough for loading Natsoft's meeting page. */
export async function httpGet(connector: Connector, url: URL, headers: Record<string, string>, timeoutMs = 15000) {
  const t = target(url);
  const sock = await withTimeout(connector(url.hostname, t.port, t.tls), timeoutMs, "connect");
  try {
    return await withTimeout((async () => {
      const writer = sock.writable.getWriter();
      const head = [`GET ${t.path} HTTP/1.1`, `Host: ${t.hostHeader}`, "Connection: close", "Accept: text/html,*/*",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
      await writer.write(enc.encode(head));
      writer.releaseLock();
      const reader = new ByteReader(sock.readable.getReader());
      const parsed = parseHead(await reader.headerBlock());
      let body: Uint8Array;
      const len = parsed.headers["content-length"];
      if (len !== undefined) body = await reader.exactly(Number(len));
      else body = await reader.rest();
      if (/chunked/i.test(parsed.headers["transfer-encoding"] ?? "")) body = dechunk(body);
      reader.release();
      return { status: parsed.status, headers: parsed.headers, body: new TextDecoder().decode(body) };
    })(), timeoutMs, "page load");
  } finally {
    try { await sock.close(); } catch { /* ignore */ }
  }
}

function randomKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

async function expectedAccept(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", enc.encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export class HandshakeError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); }
}

/** One open WebSocket. Iterate `messages()` for text frames; it ends when the server closes. */
export class WebSocketConnection {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private closed = false;

  private constructor(private sock: Transport, private reader: ByteReader) {
    this.writer = sock.writable.getWriter();
  }

  static async open(connector: Connector, url: URL, headers: Record<string, string>, timeoutMs = 20000): Promise<WebSocketConnection> {
    const t = target(url);
    const sock = await withTimeout(connector(url.hostname, t.port, t.tls), timeoutMs, "connect");
    try {
      const key = randomKey();
      const head = [`GET ${t.path} HTTP/1.1`, `Host: ${t.hostHeader}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
      const w = sock.writable.getWriter();
      await withTimeout(w.write(enc.encode(head)), timeoutMs, "handshake write");
      w.releaseLock();
      const reader = new ByteReader(sock.readable.getReader());
      const parsed = parseHead(await withTimeout(reader.headerBlock(), timeoutMs, "handshake"));
      if (parsed.status !== 101) {
        let body = "";
        try { body = new TextDecoder().decode(await withTimeout(reader.exactly(Math.min(Number(parsed.headers["content-length"] ?? 0), 2000)), 3000, "body")); } catch { /* ignore */ }
        throw new HandshakeError(`server answered ${parsed.status} instead of upgrading`, parsed.status, body);
      }
      const accept = parsed.headers["sec-websocket-accept"];
      if (accept && accept !== (await expectedAccept(key))) throw new Error("bad Sec-WebSocket-Accept");
      return new WebSocketConnection(sock, reader);
    } catch (e) {
      try { await sock.close(); } catch { /* ignore */ }
      throw e;
    }
  }

  /** Client frames must be masked. */
  private async sendFrame(opcode: number, payload: Uint8Array) {
    if (this.closed) return;
    const len = payload.length;
    const headLen = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const frame = new Uint8Array(headLen + 4 + len);
    frame[0] = 0x80 | opcode;
    if (len < 126) frame[1] = 0x80 | len;
    else if (len < 65536) { frame[1] = 0x80 | 126; frame[2] = len >> 8; frame[3] = len & 0xff; }
    else { frame[1] = 0x80 | 127; new DataView(frame.buffer).setBigUint64(2, BigInt(len)); }
    const mask = new Uint8Array(4);
    crypto.getRandomValues(mask);
    frame.set(mask, headLen);
    for (let i = 0; i < len; i++) frame[headLen + 4 + i] = payload[i] ^ mask[i & 3];
    await this.writer.write(frame);
  }

  async *messages(): AsyncGenerator<string> {
    const utf8 = new TextDecoder("utf-8");
    let fragments: Uint8Array[] = [];
    let fragmentOpcode = 0;
    while (!this.closed) {
      const h = await this.reader.exactly(2);
      const fin = (h[0] & 0x80) !== 0;
      const opcode = h[0] & 0x0f;
      const masked = (h[1] & 0x80) !== 0;
      let len = h[1] & 0x7f;
      if (len === 126) { const b = await this.reader.exactly(2); len = (b[0] << 8) | b[1]; }
      else if (len === 127) { const b = await this.reader.exactly(8); len = Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0)); }
      if (len > 64 * 1024 * 1024) throw new Error("frame too large");
      const mask = masked ? await this.reader.exactly(4) : undefined;
      const payload = len ? await this.reader.exactly(len) : new Uint8Array(0);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      switch (opcode) {
        case 0x0: // continuation
          fragments.push(payload);
          if (fin) {
            const total = new Uint8Array(fragments.reduce((a, f) => a + f.length, 0));
            let off = 0;
            for (const f of fragments) { total.set(f, off); off += f.length; }
            fragments = [];
            if (fragmentOpcode === 0x1 || fragmentOpcode === 0x2) yield utf8.decode(total);
          }
          break;
        case 0x1:
        case 0x2:
          if (fin) yield utf8.decode(payload);
          else { fragments = [payload]; fragmentOpcode = opcode; }
          break;
        case 0x8: // close
          try { await this.sendFrame(0x8, payload.subarray(0, 2)); } catch { /* ignore */ }
          await this.close();
          return;
        case 0x9: // ping
          await this.sendFrame(0xa, payload);
          break;
        case 0xa: // pong
          break;
        default:
          throw new Error(`unknown WebSocket opcode ${opcode}`);
      }
    }
  }

  async close() {
    if (this.closed) return;
    try { await this.sendFrame(0x8, new Uint8Array([0x03, 0xe9])); } catch { /* ignore */ } // 1001 going away
    this.closed = true;
    try { this.writer.releaseLock(); } catch { /* ignore */ }
    this.reader.release();
    try { await this.sock.close(); } catch { /* ignore */ }
  }
}
