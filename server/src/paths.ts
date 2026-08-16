import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function ensureRoot(outputDirectory: string): string {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const root = realpathSync(outputDirectory);
  assertPrivateDirectory(root);
  assertSafeAncestors(root);
  return root;
}

function getFileType(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to traverse symbolic link: ${path}`);
  if (!stat.isDirectory()) throw new Error(`Output path component is not a directory: ${path}`);
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stat.uid !== currentUserId) {
    throw new Error(`Output directory must be owned by the current user: ${path}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`Output directory must not be writable by group or others: ${path}`);
  }
}

function assertSafeAncestors(root: string): void {
  let current = dirname(root);
  while (true) {
    const stat = lstatSync(current);
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new Error(`Output directory has an unsafe writable ancestor: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensureSafeParent(root: string, candidate: string): void {
  const parent = dirname(candidate);
  const relativeParent = relative(root, parent);
  if (relativeParent === "") return;

  let current = root;
  for (const segment of relativeParent.split(sep)) {
    current = join(current, segment);
    if (!getFileType(current)) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    assertPrivateDirectory(current);
    if (!isInside(root, realpathSync(current))) {
      throw new Error(`Path must stay inside the Alloy MCP output directory: ${root}`);
    }
  }
}

export function prepareOutputFile(outputDirectory: string, requestedPath: string): string {
  const root = ensureRoot(outputDirectory);
  const candidate = resolve(root, requestedPath);
  if (!isInside(root, candidate)) {
    throw new Error(`Path must stay inside the Alloy MCP output directory: ${root}`);
  }
  if (candidate === root) throw new Error("Output path must name a file");

  ensureSafeParent(root, candidate);
  const existingFile = getFileType(candidate);
  if (existingFile?.isSymbolicLink()) {
    throw new Error("Refusing to write through a symbolic link");
  }
  if (existingFile?.isDirectory()) throw new Error("Output path must name a file");
  if (existingFile && !existingFile.isFile()) throw new Error("Output path must name a regular file");
  return candidate;
}

export function writeOutputFile(
  outputDirectory: string,
  requestedPath: string,
  data: string | Uint8Array
): string {
  const filePath = prepareOutputFile(outputDirectory, requestedPath);
  const descriptor = openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Output path must name a regular file");
    if (stat.nlink !== 1) throw new Error("Refusing to overwrite a file with multiple hard links");
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, data);
  } finally {
    closeSync(descriptor);
  }
  return filePath;
}
