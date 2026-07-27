// Persists the output-folder FileSystemDirectoryHandle across sessions via IndexedDB
// (Chrome/Edge support storing FS handles as structured-cloneable IndexedDB values).
// The permission grant itself doesn't persist — callers must re-request it with
// verifyPermission() before use, but that's a single click, not the full picker.

const DB_NAME = "logger-app";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const DIR_HANDLE_KEY = "outputDir";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveDirectoryHandle(handle) {
  await withStore("readwrite", (store) => store.put(handle, DIR_HANDLE_KEY));
}

export async function getDirectoryHandle() {
  let handle;
  await withStore("readonly", (store) => {
    const req = store.get(DIR_HANDLE_KEY);
    req.onsuccess = () => {
      handle = req.result;
    };
  });
  return handle ?? null;
}

// Re-acquires permission on a previously-persisted handle. Returns true if usable.
// mode: 'read' | 'readwrite'
export async function verifyPermission(handle, mode = "readwrite") {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}
