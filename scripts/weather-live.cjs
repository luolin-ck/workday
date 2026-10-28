const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  const data = path.join(root, 'test-data', 'weather-live-' + kind), output = path.join(root, 'output', 'playwright', 'weather-live-' + kind);
  await fs.rm(data, { recursive: true, force: true }); await fs.mkdir(data, { recursive: true }); await fs.mkdir(output, { recursive: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'packaged' ? [] : [root], env, timeout: 30000 });
    const page = await app.firstWindow(); await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await app.evaluate(({net}) => {
      globalThis.__liveWeather = []; const original = net.fetch.bind(net);
      net.fetch = async (input, init) => {
        const url = new URL(input), isWeather = ['ipwho.is', 'geocoding-api.open-meteo.com', 'api.open-meteo.com'].includes(url.hostname);
        try { const result = await original(input, init); if (isWeather) globalThis.__liveWeather.push({ host: url.hostname, path: url.pathname, status: result.status }); return result; }
        catch (error) { if (isWeather) globalThis.__liveWeather.push({ host: url.hostname, path: url.pathname, error: error.cause?.code ?? error.code ?? error.name }); throw error; }
      };
    });
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const call = (op, payload) => page.evaluate(({ op, payload }) => window.workday.call(op, payload), { op, payload });
    const auto = await call('weather.query', { date: today, location: null, refresh: true });
    const cities = await call('weather.search', { query: '杭州' }); let manual = null;
    if (cities.ok && cities.value.length) {
      const location = cities.value.find(city => city.region === '浙江省') ?? cities.value[0];
      manual = await call('weather.query', { date: today, location, refresh: true });
      if (manual.ok && manual.value.status === 'ready') {
        await page.evaluate(location => localStorage.setItem('workday.weather', JSON.stringify({ mode: 'manual', location })), location);
        await page.reload(); await page.locator('.weather-block[data-weather-state="ready"]').waitFor();
        await page.screenshot({ path: path.join(output, 'actual-manual-weather.png'), fullPage: true });
      }
    }
    const result = { checkedAt: new Date().toISOString(), kind, actualNetwork: true, mocked: false, TLSBypass: false, versions: await app.evaluate(() => ({ ...process.versions })), executable: await app.evaluate(() => process.execPath), selectedDate: today, auto, cities, manual, trace: await app.evaluate(() => globalThis.__liveWeather), personalData: false };
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
