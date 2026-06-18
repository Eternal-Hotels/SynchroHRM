import { readFile } from "node:fs/promises";
import path from "node:path";

let loaded = false;

export async function loadDotEnv(envPath = ".env"): Promise<void> {
  if (loaded) {
    return;
  }

  if (process.env.SYNCHRO_SKIP_DOTENV === "1") {
    loaded = true;
    return;
  }

  const resolved = path.resolve(envPath);

  try {
    const content = await readFile(resolved, "utf8");

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  loaded = true;
}
