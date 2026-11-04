// Test-only provider responses. Installed in the paused main process before app entry.
function installWeatherFixture(options = {}, net) {
  const originalFetch = net.fetch.bind(net);
  const fixture = globalThis.__weatherFixture = {
    installedBeforeEntry: true, ipCalls: 0, forecastCalls: 0, searchCalls: 0, log: [],
    ipFail: false, forecastQueue: [], searchDelays: {}, mockHolidays: false, ...options
  };
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  net.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
    if (url.hostname === 'ipwho.is') {
      fixture.ipCalls++; fixture.log.push('ip');
      if (fixture.ipFail) throw new Error('test provider unavailable');
      return json({ success: true, city: '出口城市', region: '上海市', country: '中国', latitude: 31.23, longitude: 121.47, timezone: { id: 'Asia/Shanghai' } });
    }
    if (url.hostname === 'geocoding-api.open-meteo.com') {
      const name = url.searchParams.get('name'); fixture.searchCalls++; fixture.log.push('search:' + name);
      await sleep(fixture.searchDelays[name] ?? 0);
      if (name === '空城') return json({ results: [] });
      return json({ results: name === '北京' ? [{ name, country: '中国', admin1: '北京市', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }] : [
        { name, country: '中国', admin1: '浙江省', latitude: 30.29, longitude: 120.16, timezone: 'Asia/Shanghai' },
        { name, country: '中国', admin1: '四川省', latitude: 31.8, longitude: 103.7, timezone: 'Asia/Shanghai' }
      ] });
    }
    if (url.hostname === 'api.open-meteo.com') {
      const control = fixture.forecastQueue.shift() ?? {};
      const latitude = Number(url.searchParams.get('latitude')); fixture.forecastCalls++; fixture.log.push('forecast:' + latitude);
      await sleep(control.delay ?? 0);
      if (control.error) throw new Error('test forecast unavailable');
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
      const base = control.minBase ?? (latitude > 35 ? 2 : 16);
      const time = Array.from({ length: 23 }, (_, i) => new Date(Date.parse(today + 'T12:00:00Z') + (i - 7) * 86400000).toISOString().slice(0, 10));
      return json({ daily_units: { time: 'iso8601', weather_code: 'wmo code', temperature_2m_min: '°C', temperature_2m_max: '°C' }, daily: {
        time, weather_code: time.map(() => control.code ?? 3),
        temperature_2m_min: time.map((_, i) => i - 7 === control.nullOffset ? null : base + i - 7),
        temperature_2m_max: time.map((_, i) => base + i - 7 + 9)
      } });
    }
    if (fixture.mockHolidays && url.hostname === 'sousuo.www.gov.cn') return json({ code: 1001, msg: '抱歉，没有找到相关结果', data: [], searchVO: null });
    return originalFetch(input, init);
  };
}
module.exports = { installWeatherFixture };
