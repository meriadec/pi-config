import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, link, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writePrepared(path, value, async (temporaryPath) => rename(temporaryPath, path));
}

export async function createJsonAtomic(path: string, value: unknown): Promise<void> {
  await writePrepared(path, value, async (temporaryPath) => {
    await link(temporaryPath, path);
    await unlink(temporaryPath);
  });
}

async function writePrepared(
  path: string,
  value: unknown,
  install: (temporaryPath: string) => Promise<void>,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Refusing to write JSON through an unsafe storage directory.");
  }
  // mkdir mode is affected by pre-existing paths. Enforce private storage on every write.
  await chmod(parent, 0o700);
  const temporaryPath = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const file = await open(temporaryPath, "wx", 0o600);
  let installed = false;
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    await install(temporaryPath);
    installed = true;
    await syncDirectory(parent);
  } finally {
    await file.close().catch(() => undefined);
    if (!installed) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
