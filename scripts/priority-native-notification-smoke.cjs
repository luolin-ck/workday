const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const executablePath = process.env.WORKDAY_ELECTRON_EXECUTABLE;
  if (!executablePath || !path.isAbsolute(executablePath)) throw new Error('A stage executable path is required');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-native-notification-'));
  const resultFile = path.join(root, 'test-results/priority-native-notification.json');
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath, args: [], env, timeout: 30000 }, { mockHolidays: true });
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.hide();
    });
    const result = await app.evaluate(async ({ Notification }) => {
      if (!Array.isArray(globalThis.__priorityNotifications?.calls)) throw new Error('Business notifications must remain stubbed');
      const events = [], supported = Notification.isSupported();
      if (!supported) return { supported, acceptedBySystem: false, events, reason: 'unsupported' };
      let notification, timer;
      try {
        notification = new Notification({ title: 'WorkDay · 提醒测试', body: '这是重要事项提醒的合成测试，无需处理。', silent: true });
        return await new Promise(resolve => {
          let completed = false;
          const finish = (acceptedBySystem, reason) => {
            if (completed) return;
            completed = true; clearTimeout(timer);
            resolve({ supported, acceptedBySystem, events: [...events], reason });
          };
          timer = setTimeout(() => finish(false, 'no-show-event-within-10s'), 10000);
          notification.once('show', () => { events.push('show'); finish(true, 'show-event'); });
          notification.once('failed', () => { events.push('failed'); finish(false, 'failed-event'); });
          notification.once('close', () => { events.push('close'); finish(false, 'closed-before-show'); });
          notification.show();
        });
      } finally { clearTimeout(timer); if (notification) notification.close(); }
    });
    const report = { ...result, checkedAt: new Date().toISOString(), executablePath, dataDirectory: data, personalData: false, businessNotificationsStubbed: true, syntheticNativeNotifications: 1, bannerVisuallyVerified: false };
    await fs.writeFile(resultFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (!result.acceptedBySystem) process.exitCode = 1;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
