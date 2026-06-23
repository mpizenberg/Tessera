/**
 * Persistent, content-addressed cache of anchored documents (survey
 * presentation docs today; rationales could join later).
 *
 * Keyed by the document's blake2b-256 hash, hex-encoded. Because the key *is*
 * the content hash, every entry is immutable and self-validating: a hit can
 * only ever be the exact bytes the on-chain anchor commits to, so there is no
 * expiry, staleness, or invalidation to reason about. Persisting across
 * sessions means each document is fetched from IPFS at most once, ever.
 *
 * Every operation degrades gracefully. If IndexedDB is unavailable (private
 * browsing, disabled, quota exhausted), reads resolve empty and writes no-op —
 * the in-memory tier still works, so only persistence is lost, never
 * correctness. We never surface an error from here.
 *
 * KNOWN LIMITATION — unbounded growth. There is no eviction: every document
 * ever authored or fetched is kept forever, and the whole store is hydrated
 * into memory on startup. Entries are small JSON and the key set grows slowly
 * (one per distinct external-content survey a user touches), so this is fine in
 * practice for now. If it ever needs bounding, add an LRU or per-entry
 * timestamp + size cap (and hydrate lazily rather than all-at-once). Left
 * unfixed deliberately — documented, not addressed.
 */

const DB_NAME = "tessera";
const DB_VERSION = 1;
const STORE = "content-docs";

let dbPromise: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null); // indexedDB entirely unavailable
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Every cached [hashHex, doc] pair, or [] if the store can't be read. */
export async function loadAllDocs(): Promise<Array<[string, unknown]>> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      // getAllKeys() and getAll() both return in ascending key order, so the
      // two result arrays line up index-for-index.
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      tx.oncomplete = () => {
        const keys = keysReq.result as string[];
        const vals = valsReq.result as unknown[];
        resolve(keys.map((k, i) => [k, vals[i]]));
      };
      tx.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Persist a verified document under its content-hash hex (idempotent). */
export async function putDoc(hashHex: string, doc: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(doc, hashHex);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
