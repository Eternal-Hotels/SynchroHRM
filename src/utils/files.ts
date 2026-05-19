import { access, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

export function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export async function writeBufferFile(filePath: string, bytes: Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, bytes);
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, content, "utf8");
}

export async function replaceFile(sourcePath: string, destinationPath: string): Promise<void> {
  await ensureDir(path.dirname(destinationPath));
  try {
    await copyFile(sourcePath, destinationPath);
  } catch {
    await rename(sourcePath, destinationPath);
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function movePathIfExists(sourcePath: string, destinationPath: string): Promise<boolean> {
  if (!(await pathExists(sourcePath))) {
    return false;
  }

  await ensureDir(path.dirname(destinationPath));
  await rename(sourcePath, destinationPath);
  return true;
}
