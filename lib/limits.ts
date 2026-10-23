/*
 * Upload limits, shared by the browser and the server so both say the same
 * thing.
 *
 * Vercel refuses a function request whose body is over 4.5 MB before our code
 * runs, so files go up one per request and each must fit, with room left for
 * the form around it. The same limit applies locally, so a run that works on a
 * laptop also works when deployed.
 */

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 40;

/** "4 MB". Said as a whole number, so a file just over it never reads "4.0 MB, the limit is 4.0 MB". */
export const UPLOAD_LIMIT = `${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;

export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
