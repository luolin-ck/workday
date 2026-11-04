export interface AppearanceStorage {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export function createAppearanceStorage(factory: IDBFactory = indexedDB): AppearanceStorage {
  async function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory.open('workday-appearance', 1);
      let failed = false;
      const fail = () => { failed = true; reject(new Error('外观存储无法打开，请检查本机存储空间')); };
      request.onupgradeneeded = () => request.result.createObjectStore('appearance');
      request.onerror = request.onblocked = fail;
      request.onsuccess = () => {
        if (failed) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  async function transaction(mode: IDBTransactionMode, value?: unknown): Promise<unknown> {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('appearance', mode);
        const request = mode === 'readonly' ? tx.objectStore('appearance').get('current') : tx.objectStore('appearance').put(value, 'current');
        let result: unknown;
        request.onsuccess = () => { result = request.result; };
        // A request can succeed before its transaction aborts. Only commit releases callers.
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(new Error('外观设置保存失败，请检查本机存储空间；原设置保留。'));
      });
    } finally { db.close(); }
  }
  return { read: () => transaction('readonly'), write: async value => { await transaction('readwrite', value); } };
}
