// src/vault.ts — Encrypted secrets (~60 lines per spec)
// AES-256-GCM encrypted JSON files, one per project
// Master key loaded from MAME_MASTER_KEY env var

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { MAME_HOME } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getMasterKey(): Buffer {
  const key = process.env.MAME_MASTER_KEY;
  if (!key) {
    throw new Error(
      "MAME_MASTER_KEY environment variable not set. " +
      "Generate one with: openssl rand -hex 32"
    );
  }
  return Buffer.from(key, "hex");
}

function encrypt(plaintext: string, masterKey: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: [iv (16)] [authTag (16)] [encrypted data]
  return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(data: Buffer, masterKey: Buffer): string {
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted, undefined, "utf-8") + decipher.final("utf-8");
}

export class Vault {
  private masterKey: Buffer;
  private vaultDir: string;

  constructor() {
    this.masterKey = getMasterKey();
    this.vaultDir = path.join(MAME_HOME, ".vault");
    fs.mkdirSync(this.vaultDir, { recursive: true });
  }

  /**
   * True iff the vault can be constructed in this process — i.e. iff
   * MAME_MASTER_KEY is set in the environment. Lets callers gracefully
   * skip the vault when secrets are already in env (e.g. via the
   * systemd-creds loader on TH50 post-cutover) instead of crashing the
   * whole CLI on a missing master key.
   */
  static isAvailable(): boolean {
    return !!process.env.MAME_MASTER_KEY;
  }

  async get(project: string, key: string): Promise<string | undefined> {
    const secrets = await this.load(project);
    return secrets[key];
  }

  async getAll(project: string): Promise<Record<string, string>> {
    return this.load(project);
  }

  async set(project: string, key: string, value: string): Promise<void> {
    const secrets = await this.load(project);
    secrets[key] = value;
    await this.save(project, secrets);
  }

  async delete(project: string, key: string): Promise<void> {
    const secrets = await this.load(project);
    delete secrets[key];
    await this.save(project, secrets);
  }

  async list(project: string): Promise<string[]> {
    const secrets = await this.load(project);
    return Object.keys(secrets);
  }

  private async load(project: string): Promise<Record<string, string>> {
    const file = path.join(this.vaultDir, `${project}.enc`);
    if (!fs.existsSync(file)) return {};
    const encrypted = fs.readFileSync(file);
    return JSON.parse(decrypt(encrypted, this.masterKey));
  }

  private async save(project: string, secrets: Record<string, string>): Promise<void> {
    const file = path.join(this.vaultDir, `${project}.enc`);
    fs.writeFileSync(file, encrypt(JSON.stringify(secrets), this.masterKey));
  }
}
