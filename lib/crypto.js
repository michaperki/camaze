// Encrypts/decrypts provider credentials at rest. AES-256-GCM via
// node:crypto only — no dependencies. Keep the algorithm choice contained
// here so it can be swapped later without touching callers.
const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended nonce size for GCM

function getKey() {
  const hex = process.env.CAMAZE_ENCRYPTION_KEY;
  if (!hex) throw new Error("CAMAZE_ENCRYPTION_KEY is not set");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("CAMAZE_ENCRYPTION_KEY must be a 32-byte hex string (64 hex characters)");
  }
  return key;
}

// -> "<iv>.<authTag>.<ciphertext>", each base64.
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map(b => b.toString("base64")).join(".");
}

function decrypt(payload) {
  const key = getKey();
  const [ivB64, tagB64, ciphertextB64] = String(payload).split(".");
  if (!ivB64 || !tagB64 || !ciphertextB64) throw new Error("Malformed encrypted payload");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

module.exports = { encrypt, decrypt };
