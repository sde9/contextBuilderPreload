'use client';

/*
 * Saving a file without touching the page (RT-US-15).
 *
 * The old version clicked a link that was never attached to the document and
 * freed the blob URL on the next line. Some browsers then either drop the
 * download or open the blob in the current tab, and since the session lives
 * only in memory, opening the blob in the tab throws the whole session away.
 *
 * The link is attached, hidden, clicked and removed, and the URL is freed
 * only after the browser has had time to start the download. Nothing here
 * opens a window or changes the address bar.
 */

const REVOKE_AFTER_MS = 1500;

export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, REVOKE_AFTER_MS);
}

export function saveText(filename: string, mime: string, content: string): void {
  saveBlob(filename, new Blob([content], { type: mime }));
}

/** A PNG from html-to-image arrives as a data URL. Turn it into a Blob first. */
export function saveDataUrl(filename: string, dataUrl: string): void {
  const [head, data] = dataUrl.split(',', 2);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  const bytes = atob(data);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  saveBlob(filename, new Blob([buf], { type: mime }));
}
