// NIP-19 bech32 entities (npub, note, nprofile, nevent, naddr).
// A self-contained bech32 implementation: encode and decode share the same helpers.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const polymod = (values: number[]): number => {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
};

const hrpExpand = (hrp: string): number[] => [
  ...[...hrp].map((c) => c.charCodeAt(0) >>> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

const convertBits = (data: number[], from: number, to: number, pad: boolean): number[] | null => {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >>> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
};

export const hexToBytes = (hex: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
};

export const bytesToHex = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

export const encodeBech32 = (hrp: string, bytes: number[]): string => {
  const words = convertBits(bytes, 8, 5, true) ?? [];
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
};

export const decodeBech32 = (text: string): { hrp: string; bytes: number[] } | null => {
  const s = text.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos);
  const words: number[] = [];
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    words.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) return null;
  const bytes = convertBits(words.slice(0, -6), 5, 8, false);
  return bytes == null ? null : { hrp, bytes };
};

export const npubEncode = (pubkeyHex: string): string => encodeBech32('npub', hexToBytes(pubkeyHex));

export type Nip19Entity =
  | { type: 'npub' | 'nprofile'; pubkey: string }
  | { type: 'note' | 'nevent'; id: string }
  | { type: 'naddr' };

/** Decodes "npub1...", "nevent1..." etc. (with or without the "nostr:" prefix). */
export const decodeNip19 = (text: string): Nip19Entity | null => {
  const decoded = decodeBech32(text.replace(/^nostr:/, ''));
  if (decoded == null) return null;
  const { hrp, bytes } = decoded;
  if (hrp === 'npub' && bytes.length === 32) return { type: 'npub', pubkey: bytesToHex(bytes) };
  if (hrp === 'note' && bytes.length === 32) return { type: 'note', id: bytesToHex(bytes) };
  if (hrp === 'naddr') return { type: 'naddr' };
  if (hrp === 'nprofile' || hrp === 'nevent') {
    // TLV: type 0 is the 32-byte pubkey / event id
    for (let i = 0; i + 2 <= bytes.length; ) {
      const type = bytes[i];
      const length = bytes[i + 1];
      const value = bytes.slice(i + 2, i + 2 + length);
      if (type === 0 && value.length === 32) {
        return hrp === 'nprofile'
          ? { type: 'nprofile', pubkey: bytesToHex(value) }
          : { type: 'nevent', id: bytesToHex(value) };
      }
      i += 2 + length;
    }
  }
  return null;
};
