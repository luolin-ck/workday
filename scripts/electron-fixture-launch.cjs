const http = require('node:http');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { installWeatherFixture } = require('./weather-fixture.cjs');
const { installMeetingsFixture } = require('./meetings-fixture.cjs');
const { installKeychainFixture } = require('./keychain-fixture.cjs');

// Install at the app entry breakpoint: Electron's initial inspect-brk pause is
// before Node bootstrap, when requiring Electron is not available yet.
async function launchWithWeatherFixture(electron, options, fixture = {}) {
  if (!options.env?.WORKDAY_DATA_DIR) throw new Error('Electron fixture requires an isolated data directory');
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const launched = electron.launch({ ...options, args: [`--inspect-brk=127.0.0.1:${port}`, ...(options.args ?? [])] });
  let app, socket, call, fixturePid;
  try {
    let endpoint;
    for (let i = 0; i < 200; i++) {
      try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0]?.webSocketDebuggerUrl; if (endpoint) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!endpoint) throw new Error('Electron inspector unavailable before entry');
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0, waitingPause; const pending = new Map(), pauses = [], scripts = new Map();
    socket.addEventListener('message', event => {
      const result = JSON.parse(event.data);
      if (result.id) { pending.get(result.id)?.(result); pending.delete(result.id); }
      if (result.method === 'Debugger.scriptParsed') scripts.set(result.params.scriptId, result.params.url);
      if (result.method === 'Debugger.paused') { if (waitingPause) { waitingPause(result.params); waitingPause = null; } else pauses.push(result.params); }
    });
    call = (method, params) => new Promise(resolve => { pending.set(++id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    const entry = options.args?.length ? path.resolve(options.args[0], 'dist/main/index.js') : path.resolve(path.dirname(options.executablePath), '../Resources/app/dist/main/index.js');
    await call('Debugger.enable');
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await call('Debugger.setBreakpointByUrl', { urlRegex: '(?:' + [entry, pathToFileURL(entry).href].map(escape).join('|') + ')$', lineNumber: 0 });
    await call('Runtime.runIfWaitingForDebugger');
    let frame;
    for (;;) {
      const pause = pauses.shift() ?? await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('App entry breakpoint unavailable: ' + JSON.stringify({ entry, scripts: [...scripts.values()].filter(url => /dist\/main\/index|run_main/.test(url)) }))), 15000); waitingPause = value => { clearTimeout(timer); resolve(value); }; });
      frame = pause.callFrames[0];
      const url = frame.url || scripts.get(frame.location.scriptId) || '';
      if ((url.startsWith('file:') ? fileURLToPath(url) : url) === entry) break;
      await call('Debugger.resume');
    }
    const processResult=await call('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'process.pid'});
    fixturePid=processResult.result?.result?.value;
    if(!Number.isInteger(fixturePid)||fixturePid<=0)throw new Error('Isolated fixture PID unavailable');
    const notificationResult=await call('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`(() => { const Notifications=require(${JSON.stringify(path.join(path.dirname(entry),'task-notifications.js'))}).DesktopTaskNotifications; globalThis.__priorityNotifications={calls:[]}; Notifications.prototype.show=async function(tasks){globalThis.__priorityNotifications.calls.push(JSON.parse(JSON.stringify(tasks)));return true;}; })()`});
    if(notificationResult.error||notificationResult.result?.exceptionDetails)throw new Error('Priority notification fixture installation failed');
    const result = await call('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: `(${installWeatherFixture.toString()})(${JSON.stringify(fixture)}, require('electron').net)` });
    if (result.error || result.result?.exceptionDetails) throw new Error('Fixture installation failed: ' + JSON.stringify(result));
    const meetingResult=await call('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`(${installMeetingsFixture.toString()})(${JSON.stringify(fixture.meetings??{})},require(${JSON.stringify(path.join(path.dirname(entry),'meetings.js'))}).Meetings)`});
    if(meetingResult.error||meetingResult.result?.exceptionDetails)throw new Error('Meeting fixture installation failed');
    if(fixture.keychain){
      const keychainResult=await call('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`(${installKeychainFixture.toString()})(require(${JSON.stringify(path.join(path.dirname(entry),'keychain-access.js'))}).KeychainAccess,require('electron').safeStorage,${JSON.stringify(path.resolve(path.dirname(entry),'../../native/keychain-access'))})`});
      if(keychainResult.error||keychainResult.result?.exceptionDetails)throw new Error('Keychain fixture installation failed');
    }
    await call('Debugger.resume'); socket.close(); socket = null;
    app = await launched;
    if (!await app.evaluate(() => globalThis.__weatherFixture?.installedBeforeEntry)) throw new Error('Missing main-process fixture');
    if (!await app.evaluate(() => globalThis.__meetingsFixture?.installedBeforeEntry)) throw new Error('Missing meeting fixture before main entry');
    if (!await app.evaluate(() => Array.isArray(globalThis.__priorityNotifications?.calls))) throw new Error('Missing priority notification fixture before main entry');
    return app;
  } catch (error) {
    // A failed pre-entry fixture must never resume the unisolated application.
    // This PID comes from the matched entry frame of the child launched above.
    if (fixturePid && socket) { try { process.kill(fixturePid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; } }
    if (socket) socket.close();
    if (app) await app.close(); else await launched.then(value => value.close()).catch(() => {});
    throw error;
  }
}
module.exports = { launchWithWeatherFixture };
