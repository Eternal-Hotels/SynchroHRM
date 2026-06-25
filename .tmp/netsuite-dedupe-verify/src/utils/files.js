import { access, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
export async function ensureDir(targetPath) {
    await mkdir(targetPath, { recursive: true });
}
export function sanitizeFileName(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
export async function writeBufferFile(filePath, bytes) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, bytes);
}
export async function writeTextFile(filePath, content) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, content, "utf8");
}
export async function replaceFile(sourcePath, destinationPath) {
    await ensureDir(path.dirname(destinationPath));
    try {
        await copyFile(sourcePath, destinationPath);
    }
    catch {
        await rename(sourcePath, destinationPath);
    }
}
export async function pathExists(targetPath) {
    try {
        await access(targetPath);
        return true;
    }
    catch (error) {
        const nodeError = error;
        if (nodeError.code === "ENOENT" || nodeError.code === "ENAMETOOLONG" || nodeError.code === "EINVAL") {
            return false;
        }
        throw error;
    }
}
export function remapStoredDataPath(storedPath, dataDir) {
    const normalizedPath = storedPath.trim().replace(/\\/g, "/");
    const match = normalizedPath.match(/(?:^|\/)storage\/(raw|parsed|quarantine)\/(.+)$/i);
    if (!match) {
        return null;
    }
    const storageKind = match[1].toLowerCase();
    const relativeSegments = match[2].split("/").filter(Boolean);
    if (relativeSegments.length === 0) {
        return null;
    }
    return path.join(dataDir, storageKind, ...relativeSegments);
}
export async function movePathIfExists(sourcePath, destinationPath) {
    if (!(await pathExists(sourcePath))) {
        return false;
    }
    await ensureDir(path.dirname(destinationPath));
    await rename(sourcePath, destinationPath);
    return true;
}
