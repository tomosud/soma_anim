// The scene being worked on is kept in IndexedDB, so the page opens where it was left.
const DB = 'soma_anim', STORE = 'state';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

export const loadState = key => tx('readonly', s => s.get(key)).catch(() => undefined);
export const saveState = (key, value) => tx('readwrite', s => s.put(value, key)).catch(e => console.warn('could not save the scene:', e));
