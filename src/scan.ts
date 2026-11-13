/* Scanning a book's barcode with the camera: scan() shows the camera in a
 * <video>, reads its frames until the same ISBN barcode (EAN-13, 978 or
 * 979) comes up twice running, and resolves with the ISBN-13.
 *
 *   camera --> <video> --every 150 ms--> reader --> bookCode --> twice? --> ISBN-13
 *
 * The reader is the browser's own BarcodeDetector where it has one
 * (Chrome, Android), else zxing-wasm, self-hosted in vendor/zxing/ (robbie
 * zxing) and fetched only then (iPhone Safari). Depends on isbn.ts. Leaves
 * out the torch, zoom, picking a camera, and every barcode but EAN-13. */
import { toIsbn13 } from './isbn.ts';

/** Why scanning can't start, for the reader to be told in words. */
export type Reason = 'denied' | 'none' | 'insecure' | 'other';

/** Scanning could not start; reason says why. */
export class ScanError extends Error {
  reason: Reason;
  constructor(reason: Reason, message: string) {
    super(message);
    this.name = 'ScanError';
    this.reason = reason;
  }
}

/** Milliseconds between two reads of the camera (battery). */
const EVERY = 150;
/** Widest frame handed to zxing; a barcode survives the shrinking. */
const WIDTH = 640;
/** Where zxing-wasm is vendored, beside this file once built. */
const ZXING = './vendor/zxing/reader/index.js';

/** A reader: the barcode texts seen in the video's current frame. */
type Reader = (video: HTMLVideoElement) => Promise<string[]>;

/** The part of zxing-wasm (its reader build) used here. */
interface Zxing {
  prepareZXingModule(options: {
    overrides: { locateFile(path: string): string };
    fireImmediately: true;
  }): Promise<unknown>;
  readBarcodesFromImageData(
    image: ImageData,
    options: { formats: string[]; tryHarder: boolean },
  ): Promise<{ text: string }[]>;
}

/** The part of the browser's BarcodeDetector used here. */
interface Detector {
  detect(video: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

/** Whether this browser could scan at all. */
export function canScan(): boolean {
  return !!navigator.mediaDevices?.getUserMedia;
}

/** The ISBN-13 a scanned text is, or null: 13 digits, 978 or 979, check
 * digit right. */
export function bookCode(text: string): string | null {
  return /^97[89]\d{10}$/.test(text) ? toIsbn13(text) : null;
}

/** The error for scanning stopped by its signal. */
function stopped(): DOMException {
  return new DOMException('Scanning stopped', 'AbortError');
}

/** What p gives, unless stop is aborted first (then an AbortError). */
function unlessStopped<T>(p: Promise<T>, stop: AbortSignal): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      stop.addEventListener('abort', () => reject(stopped()), { once: true }),
    ),
  ]);
}

/** The ScanError for what getUserMedia (or the page) threw. */
function failure(e: unknown): ScanError {
  const name = e instanceof DOMException ? e.name : '';
  const reason: Reason = !isSecureContext
    ? 'insecure'
    : name === 'NotAllowedError' || name === 'SecurityError'
      ? 'denied'
      : name === 'NotFoundError' || name === 'OverconstrainedError'
        ? 'none'
        : 'other';
  return new ScanError(reason, e instanceof Error ? e.message : String(e));
}

/** The reader to use: BarcodeDetector if it reads EAN-13, else zxing. */
async function pickReader(): Promise<Reader> {
  if ('BarcodeDetector' in window) {
    const BD = window.BarcodeDetector as unknown as {
      new (o: { formats: string[] }): Detector;
      getSupportedFormats(): Promise<string[]>;
    };
    if ((await BD.getSupportedFormats()).includes('ean_13')) {
      const detector = new BD({ formats: ['ean_13'] });
      return async video => (await detector.detect(video)).map(r => r.rawValue);
    }
  }
  return zxingReader();
}

/** A reader on zxing-wasm, loaded from our own site. */
async function zxingReader(): Promise<Reader> {
  const zxing: Zxing = await import(ZXING);
  await zxing.prepareZXingModule({
    overrides: { locateFile: path => new URL('vendor/zxing/reader/' + path, import.meta.url).href },
    fireImmediately: true,
  });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return async video => {
    if (!context) return [];
    canvas.width = Math.min(video.videoWidth, WIDTH);
    canvas.height = Math.round((canvas.width * video.videoHeight) / video.videoWidth);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const found = await zxing.readBarcodesFromImageData(image, {
      formats: ['EAN13'],
      tryHarder: true,
    });
    return found.map(r => r.text);
  };
}

/** Waits ms, or until stop is aborted. */
function pause(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    stop.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

/** Reads video until two reads in a row give the same ISBN. */
async function watch(video: HTMLVideoElement, read: Reader, stop: AbortSignal): Promise<string> {
  let previous: string | null = null;
  while (!stop.aborted) {
    let seen: string | null = null;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      try {
        seen = (await read(video)).map(bookCode).find(code => code) ?? null;
      } catch {
        seen = null; // a frame that would not read is just a frame without a code
      }
    }
    if (seen && seen === previous && !stop.aborted) return seen;
    previous = seen;
    await pause(EVERY, stop);
  }
  throw stopped();
}

/** Scans the camera until it sees an ISBN barcode, shows the camera in
 * video, and resolves with the ISBN-13. Rejects with a ScanError when the
 * camera can't be had. Stops the camera when it resolves, rejects, or when
 * stop is aborted (then rejects with an AbortError DOMException). */
export async function scan(video: HTMLVideoElement, stop: AbortSignal): Promise<string> {
  if (stop.aborted) throw stopped();
  if (!canScan())
    throw new ScanError(isSecureContext ? 'none' : 'insecure', 'No camera access in this browser');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (e) {
    throw failure(e);
  }
  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true; // iOS plays it in the page, not full screen
    await unlessStopped(
      video.play().catch(e => {
        throw failure(e);
      }),
      stop,
    );
    const read = await unlessStopped(pickReader(), stop);
    return await watch(video, read, stop);
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}
