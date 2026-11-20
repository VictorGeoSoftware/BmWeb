import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';

const bytes = (...value: number[]) => Buffer.from(value);
function der(tag: number, value: Buffer) {
  const n = value.length;
  const length = n < 128 ? bytes(n) : n < 256 ? bytes(0x81, n) : bytes(0x82, n >> 8, n & 255);
  return Buffer.concat([bytes(tag), length, value]);
}
const seq = (...items: Buffer[]) => der(0x30, Buffer.concat(items));
const time = (ms: number) => der(0x18, Buffer.from(new Date(ms).toISOString().slice(0, 19).replace(/[-T:]/g, '') + 'Z'));

/** Local test-server identities only; each use mints an in-memory key, no files or subprocesses. */
export function syntheticLoopbackCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = seq(der(0x31, seq(der(6, bytes(0x55, 4, 3)), der(0x0c, Buffer.from('BM synthetic loopback')))));
  const alg = seq(der(6, bytes(0x2a, 0x86, 0x48, 0xce, 0x3d, 4, 3, 2)));
  const san = seq(der(6, bytes(0x55, 0x1d, 0x11)), der(4, seq(der(0x87, bytes(127, 0, 0, 1)))));
  const now = Date.now();
  const tbs = seq(der(0xa0, der(2, bytes(2))), der(2, bytes(1)), alg, name, seq(time(now - 60_000), time(now + 3_600_000)),
    name, publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(san)));
  const cert = new X509Certificate(seq(tbs, alg, der(3, Buffer.concat([bytes(0), sign('sha256', tbs, privateKey)]))));
  return { pin: cert.raw.toString('base64'), options: { cert: cert.toString(), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) } };
}
