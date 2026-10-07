// Telnyx webhook signatures (copied from Lemonade 1.7.1). Telnyx signs every
// v2 webhook with Ed25519: the signature (header telnyx-signature-ed25519,
// base64) covers "<telnyx-timestamp>|<raw body>". The public key is in
// Mission Control (Account Settings -> Keys & Credentials -> Public Key) and
// goes in TELNYX_PUBLIC_KEY. Events more than 5 minutes old are refused.
import { createPublicKey, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TOLERANCE_SEC = 300;

export function verifyTelnyxSignature({ rawBody, signature, timestamp, publicKey, now = Date.now() }) {
  if (!rawBody && rawBody !== "") return false;
  if (!signature || !timestamp || !publicKey) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_SEC) return false;
  try {
    const raw = Buffer.from(publicKey, "base64");
    const key = createPublicKey({ key: raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw, format: "der", type: "spki" });
    return verify(null, Buffer.from(`${timestamp}|${rawBody}`), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
