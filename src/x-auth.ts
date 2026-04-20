// src/x-auth.ts — X (Twitter) OAuth 2.0 PKCE helpers

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { Vault } from "./vault.js";
import { MAME_HOME } from "./config.js";
import { childLogger } from "./logger.js";

const log = childLogger("x-auth");

export const X_REDIRECT_URI = "http://localhost:3847/x/callback";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const SCOPES = "tweet.read users.read bookmark.read offline.access";

export const PENDING_AUTH_FILE = path.join(MAME_HOME, "magazine", "x-auth-pending.json");

export interface PendingAuth {
  state: string;
  verifier: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export function generatePkceChallenge(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(clientId: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: X_REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  clientId: string,
  clientSecret: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: X_REDIRECT_URI,
    code_verifier: verifier,
    client_id: clientId,
  });

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

export async function storeTokens(vault: Vault, tokens: TokenResponse): Promise<void> {
  const expiresAtMs = Date.now() + tokens.expires_in * 1000;
  await vault.set("global", "X_ACCESS_TOKEN", tokens.access_token);
  await vault.set("global", "X_TOKEN_EXPIRES_AT", String(expiresAtMs));
  if (tokens.refresh_token) {
    await vault.set("global", "X_REFRESH_TOKEN", tokens.refresh_token);
  }
  log.info({ expiresIn: tokens.expires_in }, "X tokens stored in vault");
}

export async function getValidToken(vault: Vault): Promise<string> {
  const [accessToken, refreshToken, expiresAt, clientId, clientSecret] = await Promise.all([
    vault.get("global", "X_ACCESS_TOKEN"),
    vault.get("global", "X_REFRESH_TOKEN"),
    vault.get("global", "X_TOKEN_EXPIRES_AT"),
    vault.get("global", "X_CLIENT_ID"),
    vault.get("global", "X_CLIENT_SECRET"),
  ]);

  if (!accessToken) {
    throw new Error("No X access token in vault. Run: mame x auth");
  }
  if (!clientId || !clientSecret) {
    throw new Error("X_CLIENT_ID or X_CLIENT_SECRET missing from vault");
  }

  const expiresAtMs = expiresAt ? parseInt(expiresAt, 10) : 0;
  const msUntilExpiry = expiresAtMs - Date.now();

  if (msUntilExpiry > 60_000) return accessToken;

  if (!refreshToken) {
    throw new Error("X access token expired and no refresh token available. Run: mame x auth");
  }

  log.info("X access token expiring soon — refreshing");
  const tokens = await refreshAccessToken(refreshToken, clientId, clientSecret);
  await storeTokens(vault, tokens);
  return tokens.access_token;
}

export function writePendingAuth(pending: PendingAuth): void {
  fs.mkdirSync(path.dirname(PENDING_AUTH_FILE), { recursive: true });
  fs.writeFileSync(PENDING_AUTH_FILE, JSON.stringify(pending), "utf-8");
}

export function readPendingAuth(): PendingAuth | null {
  try {
    const raw = fs.readFileSync(PENDING_AUTH_FILE, "utf-8");
    return JSON.parse(raw) as PendingAuth;
  } catch {
    return null;
  }
}

export function clearPendingAuth(): void {
  try {
    fs.unlinkSync(PENDING_AUTH_FILE);
  } catch {
    // ignore — file may already be gone
  }
}
