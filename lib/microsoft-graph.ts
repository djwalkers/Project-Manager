/**
 * Microsoft Graph API integration — server-side only.
 * Tokens are stored as an AES-256-GCM encrypted HTTP-only cookie.
 * Never import this module from a "use client" file.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MicrosoftTokenData = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix ms
  email: string;
  displayName: string;
  scope: string;
};

export type MicrosoftConnectionStatus = {
  connected: boolean;
  email?: string;
  displayName?: string;
  scope?: string;
  expiresAt?: number;
};

export type GraphEmailRecipient = { address: string; name?: string };

export type GraphSendMailRequest = {
  subject: string;
  body: string; // HTML
  to: GraphEmailRecipient[];
  cc?: GraphEmailRecipient[];
  saveToSentItems?: boolean;
};

// ── Environment ───────────────────────────────────────────────────────────────

export function getMicrosoftConfig() {
  return {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    tenantId: process.env.MICROSOFT_TENANT_ID ?? "common",
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
    tokenSecret: process.env.MICROSOFT_TOKEN_SECRET,
  };
}

export function isMicrosoftConfigured(): boolean {
  const cfg = getMicrosoftConfig();
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri && cfg.tokenSecret);
}

// ── Cookie crypto ─────────────────────────────────────────────────────────────

const COOKIE_NAME = "ms_auth_v1";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 90 days

function getKey(): Buffer {
  const secret = process.env.MICROSOFT_TOKEN_SECRET;
  if (!secret || secret.length < 32) throw new Error("MICROSOFT_TOKEN_SECRET must be at least 32 characters");
  return Buffer.from(secret, "utf8").subarray(0, 32);
}

function encryptToken(data: MicrosoftTokenData): string {
  const plain = JSON.stringify(data);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64url");
}

function decryptToken(ciphertext: string): MicrosoftTokenData | null {
  try {
    const data = Buffer.from(ciphertext, "base64url");
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as MicrosoftTokenData;
  } catch {
    return null;
  }
}

// ── Token persistence ─────────────────────────────────────────────────────────

export async function storeTokens(data: MicrosoftTokenData): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, encryptToken(data), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function clearTokens(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

async function readStoredTokens(): Promise<MicrosoftTokenData | null> {
  const store = await cookies();
  const value = store.get(COOKIE_NAME)?.value;
  if (!value) return null;
  return decryptToken(value);
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function refreshAccessToken(refreshToken: string): Promise<MicrosoftTokenData | null> {
  const cfg = getMicrosoftConfig();
  if (!cfg.clientId || !cfg.clientSecret) return null;

  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
  );
  if (!res.ok) return null;

  const json = await res.json() as {
    access_token: string; refresh_token?: string; expires_in: number; scope: string;
  };

  const current = await readStoredTokens();
  const updated: MicrosoftTokenData = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
    email: current?.email ?? "",
    displayName: current?.displayName ?? "",
    scope: json.scope,
  };
  await storeTokens(updated);
  return updated;
}

// ── Public: get valid access token ───────────────────────────────────────────

export async function getValidAccessToken(): Promise<string | null> {
  const stored = await readStoredTokens();
  if (!stored) return null;

  // Refresh if expired or within 5 minutes of expiry
  if (Date.now() >= stored.expiresAt - 300_000) {
    const refreshed = await refreshAccessToken(stored.refreshToken);
    return refreshed?.accessToken ?? null;
  }
  return stored.accessToken;
}

// ── Public: connection status ─────────────────────────────────────────────────

export async function getMicrosoftStatus(): Promise<MicrosoftConnectionStatus> {
  const stored = await readStoredTokens();
  if (!stored) return { connected: false };
  return {
    connected: true,
    email: stored.email,
    displayName: stored.displayName,
    scope: stored.scope,
    expiresAt: stored.expiresAt,
  };
}

// ── OAuth URL builder ────────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const cfg = getMicrosoftConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId!,
    response_type: "code",
    redirect_uri: cfg.redirectUri!,
    response_mode: "query",
    scope: "openid profile email Mail.Send User.Read offline_access",
    state,
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize?${params}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeCodeForTokens(code: string): Promise<MicrosoftTokenData | null> {
  const cfg = getMicrosoftConfig();
  if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) return null;

  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: cfg.redirectUri,
        grant_type: "authorization_code",
      }),
    },
  );
  if (!res.ok) return null;

  const json = await res.json() as {
    access_token: string; refresh_token: string; expires_in: number; scope: string;
  };

  // Fetch user profile
  const profileRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,displayName", {
    headers: { Authorization: `Bearer ${json.access_token}` },
  });
  const profile = profileRes.ok ? await profileRes.json() as { mail?: string; displayName?: string } : {};

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    email: profile.mail ?? "",
    displayName: profile.displayName ?? "",
    scope: json.scope,
  };
}

// ── Graph API: send mail ──────────────────────────────────────────────────────

export async function sendMailViaGraph(request: GraphSendMailRequest): Promise<{ ok: boolean; error?: string }> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return { ok: false, error: "Microsoft 365 is not connected. Please connect your account in Settings." };

  const toRecipients = request.to.map((r) => ({ emailAddress: { address: r.address, name: r.name ?? r.address } }));
  const ccRecipients = (request.cc ?? []).map((r) => ({ emailAddress: { address: r.address, name: r.name ?? r.address } }));

  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject: request.subject,
        body: { contentType: "HTML", content: request.body },
        toRecipients,
        ...(ccRecipients.length ? { ccRecipients } : {}),
      },
      saveToSentItems: request.saveToSentItems ?? true,
    }),
  });

  if (res.status === 202) return { ok: true };

  let error = `Graph API error ${res.status}`;
  try {
    const body = await res.json() as { error?: { message?: string } };
    if (body.error?.message) error = body.error.message;
  } catch { /* ignore */ }

  if (res.status === 401) error = "Microsoft 365 token expired. Please reconnect your account.";
  if (res.status === 403) error = "Mail.Send permission not granted. Please reconnect with Mail.Send scope.";

  return { ok: false, error };
}
