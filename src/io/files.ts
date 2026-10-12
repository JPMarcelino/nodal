/** File access that works both in the desktop app (Tauri) and in a browser. */

export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenedFile {
  name: string;
  path: string | null;
  text: string;
}

export async function openTextFile(filters: FileFilter[]): Promise<OpenedFile | null> {
  if (isDesktop()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, directory: false, filters });
    if (!path || Array.isArray(path)) return null;
    const text = await readTextFile(path);
    return { name: path.split(/[\\/]/).pop() ?? path, path, text };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, path: null, text: await file.text() });
    };
    input.click();
  });
}

/** Picks a file of any kind (binary too) as a File; `path` is set on desktop. */
export async function openAnyFile(filters: FileFilter[]): Promise<{ file: File; path: string | null } | null> {
  if (isDesktop()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, directory: false, filters });
    if (!path || Array.isArray(path)) return null;
    const name = path.split(/[\\/]/).pop() ?? path;
    return { file: new File([await readFile(path)], name, { type: mimeOf(name) }), path };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? { file, path: null } : null);
    };
    input.click();
  });
}

/**
 * Saves data. When `path` is given (desktop) it is overwritten silently;
 * otherwise the user is asked where to save. Returns the path written (desktop) or null.
 */
export async function saveFile(
  data: string | Uint8Array | Blob,
  suggestedName: string,
  filters: FileFilter[],
  path?: string | null,
): Promise<string | null | false> {
  if (isDesktop()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
    const target = path ?? (await save({ defaultPath: suggestedName, filters }));
    if (!target) return false;
    if (typeof data === 'string') await writeTextFile(target, data);
    else if (data instanceof Blob) await writeFile(target, new Uint8Array(await data.arrayBuffer()));
    else await writeFile(target, data);
    return target;
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeOf(suggestedName) });
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandleLike> };
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: filters.map((f) => ({ description: f.name, accept: { [mimeOf(`x.${f.extensions[0]}`)]: f.extensions.map((e) => `.${e}`) } })),
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return null;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return null;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
}

function mimeOf(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'json':
    case 'nodal':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    default:
      return 'text/plain';
  }
}

export const sanitizeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'circuit';
