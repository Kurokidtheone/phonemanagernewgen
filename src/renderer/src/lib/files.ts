// Choosing a file on the PC. The core copies it into the app's files folder, so it needs the real path, which
// the native dialog gives (a browser <input type="file"> does not).
import { open } from '@tauri-apps/plugin-dialog';

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
export const DOCUMENT_EXTENSIONS = [...IMAGE_EXTENSIONS, 'pdf'];

/** The chosen file's path, or null when the dialog was cancelled. */
export async function pickFile(name: string, extensions: string[]): Promise<string | null> {
  const chosen = await open({ multiple: false, directory: false, filters: [{ name, extensions }] });
  return typeof chosen === 'string' ? chosen : null;
}

/** The file name at the end of a path, for showing what was chosen. */
export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
