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
        if (nodeError.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
export async function movePathIfExists(sourcePath, destinationPath) {
    if (!(await pathExists(sourcePath))) {
        return false;
    }
    await ensureDir(path.dirname(destinationPath));
    await rename(sourcePath, destinationPath);
    return true;
}
