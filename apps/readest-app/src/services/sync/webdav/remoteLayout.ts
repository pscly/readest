const normalizeSlashes = (value: string) => value.replace(/\\/g, '/');

const toPathSegments = (...parts: string[]) => {
  return parts
    .flatMap((part) => normalizeSlashes(part).split('/'))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
};

const encodeSegment = (segment: string) => encodeURIComponent(segment);

export const normalizeRootDir = (rootDir: string) => {
  return toPathSegments(rootDir).join('/');
};

export const buildRemotePath = (...parts: string[]) => {
  const segments = toPathSegments(...parts).map(encodeSegment);
  return `/${segments.join('/')}`;
};

export const getManifestPath = (rootDir: string) => {
  return buildRemotePath(normalizeRootDir(rootDir), '.meta', 'manifest.json');
};

export const getTombstonesPath = (rootDir: string) => {
  return buildRemotePath(normalizeRootDir(rootDir), '.meta', 'tombstones.json');
};

export const getDeviceInfoPath = (rootDir: string, deviceId: string) => {
  return buildRemotePath(normalizeRootDir(rootDir), '.meta', 'devices', `${deviceId}.json`);
};

export const getTrashPath = (rootDir: string, deletedAt: number, originalPath: string) => {
  return buildRemotePath(normalizeRootDir(rootDir), '.trash', `${deletedAt}`, originalPath);
};
