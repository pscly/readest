export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAtMs: number;
}

export interface WebDavFsAdapter {
  readFile(filePath: string): Promise<Uint8Array>;
  writeFileAtomic(filePath: string, data: Uint8Array): Promise<void>;
  mkdirp(dirPath: string): Promise<void>;
  stat(filePath: string): Promise<FileStat | null>;
  readDir(dirPath: string): Promise<string[]>;
  rename(fromPath: string, toPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

export const encodeUtf8 = (text: string) => new TextEncoder().encode(text);
export const decodeUtf8 = (data: Uint8Array) => new TextDecoder().decode(data);

export async function writeJsonAtomic(
  adapter: WebDavFsAdapter,
  filePath: string,
  value: unknown,
): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  await adapter.writeFileAtomic(filePath, encodeUtf8(json));
}
