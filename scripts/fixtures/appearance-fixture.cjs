const assert = require('node:assert/strict');

// Each caller launches Electron with its own WORKDAY_DATA_DIR. A renderer reload
// must read the committed IndexedDB record before a theme-specific check runs.
async function setFixtureTheme(page, theme) {
  assert.ok(['mono', 'blue', 'custom'].includes(theme), 'Unknown appearance fixture theme: ' + theme);
  // The root receives its default theme before readAppearance finishes. Wait for
  // initialization to commit so its delayed default write cannot replace ours.
  await page.waitForFunction(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('workday-appearance', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('appearance')) request.result.createObjectStore('appearance');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Appearance fixture database is blocked'));
    request.onsuccess = () => {
      const database = request.result;
      try {
        const transaction = database.transaction('appearance', 'readonly');
        const current = transaction.objectStore('appearance').get('current');
        transaction.oncomplete = () => { database.close(); resolve(current.result != null); };
        transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Appearance fixture read aborted')); };
      } catch (error) { database.close(); reject(error); }
    };
  }), undefined, { polling: 100 });
  await page.evaluate(theme => new Promise((resolve, reject) => {
    const request = indexedDB.open('workday-appearance', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('appearance')) request.result.createObjectStore('appearance');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Appearance fixture database is blocked'));
    request.onsuccess = () => {
      const database = request.result;
      try {
        const transaction = database.transaction('appearance', 'readwrite');
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Appearance fixture write aborted')); };
        transaction.objectStore('appearance').put({ schemaVersion: 1, theme, custom: {}, background: null }, 'current');
      } catch (error) { database.close(); reject(error); }
    };
  }), theme);
  await page.reload();
  await page.getByRole('navigation', { name: '全局导航' }).waitFor();
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme, 'Reload must apply the stored fixture theme');
}

module.exports = { setFixtureTheme };
