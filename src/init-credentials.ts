// src/init-credentials.ts — systemd-creds loader.
//
// When Mame is run as a systemd service with `LoadCredentialEncrypted=`
// directives in its unit file, systemd materializes each credential as a
// file in $CREDENTIALS_DIRECTORY (a per-service tmpfs mount). Each file is
// named after the credential and contains the secret as plain bytes.
//
// Convention: credential names match the env var they should populate.
// e.g. a unit file with
//     LoadCredentialEncrypted=OPENROUTER_API_KEY:/etc/credstore.encrypted/OPENROUTER_API_KEY
// produces $CREDENTIALS_DIRECTORY/OPENROUTER_API_KEY containing the key,
// which this loader pushes into process.env.OPENROUTER_API_KEY.
//
// If $CREDENTIALS_DIRECTORY is not set, this is a no-op and Mame falls
// through to the existing vault loader. That keeps the local dev path
// working on macOS where systemd doesn't exist, and gives us a clean
// rollback path while we soak the systemd switch on TH50.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CredentialLoadResult {
  source: "systemd" | "none";
  loaded: string[];
  skipped: string[];
}

export function loadSystemdCredentials(): CredentialLoadResult {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir || !existsSync(dir)) {
    return { source: "none", loaded: [], skipped: [] };
  }

  const loaded: string[] = [];
  const skipped: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`[init-credentials] Failed to read ${dir}: ${err instanceof Error ? err.message : err}`);
    return { source: "systemd", loaded: [], skipped: [] };
  }

  for (const filename of entries) {
    const fullPath = join(dir, filename);
    try {
      // Skip anything that isn't a regular file (defensive — systemd
      // always materializes credentials as plain files, but a future
      // change might add subdirectories).
      if (!statSync(fullPath).isFile()) {
        skipped.push(filename);
        continue;
      }

      const value = readFileSync(fullPath, "utf-8").trim();
      if (!value) {
        skipped.push(filename);
        continue;
      }

      // Don't clobber an env var the operator has set explicitly. This
      // matches the vault loader's behavior and lets you override a
      // single secret on the command line for one-off testing.
      if (process.env[filename]) {
        skipped.push(filename);
        continue;
      }

      process.env[filename] = value;
      loaded.push(filename);
    } catch (err) {
      console.error(`[init-credentials] Failed to load ${filename}: ${err instanceof Error ? err.message : err}`);
      skipped.push(filename);
    }
  }

  return { source: "systemd", loaded, skipped };
}
