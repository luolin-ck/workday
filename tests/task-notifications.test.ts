import {EventEmitter} from 'node:events';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DesktopTaskNotifications} from '../src/main/task-notifications';
import type {Task} from '../src/shared/types';
class Native extends EventEmitter {
 static supported=true;
 static instances:Native[]=[];
 static isSupported(){return this.supported;}
 constructor(public options:{title:string;body:string}){super();Native.instances.push(this);}
 show=vi.fn();close=vi.fn();
}
const tasks=[{id:'fixture',title:'合成重要事项',priority:'P0'}] as Task[];
afterEach(()=>{Native.instances=[];Native.supported=true;vi.useRealTimers();});
describe('native P0 alert adapter',()=>{
 it('requests an OS popup and records success only after show, then focuses the app on click',async()=>{
  const focus=vi.fn(),alerts=new DesktopTaskNotifications(Native,focus),result=alerts.show(tasks);
  expect(Native.instances).toHaveLength(1);const native=Native.instances[0];
  expect(native.options).toEqual({title:'WorkDay · P0 重要事项',body:'合成重要事项'});expect(native.show).toHaveBeenCalledTimes(1);
  let resolved=false;void result.then(()=>{resolved=true;});await Promise.resolve();expect(resolved).toBe(false);
  native.emit('show');await expect(result).resolves.toBe(true);native.emit('click');expect(focus).toHaveBeenCalledTimes(1);alerts.dispose();
 });
 it('does not claim unsupported or failed desktop notifications were shown',async()=>{
  const alerts=new DesktopTaskNotifications(Native,()=>{});Native.supported=false;await expect(alerts.show(tasks)).resolves.toBe(false);expect(Native.instances).toHaveLength(0);
  Native.supported=true;const result=alerts.show(tasks);Native.instances[0].emit('failed');await expect(result).resolves.toBe(false);alerts.dispose();
 });
 it('times out without a successful receipt and closes an unconfirmed notification',async()=>{
  vi.useFakeTimers();const alerts=new DesktopTaskNotifications(Native,()=>{}),result=alerts.show(tasks);
  await vi.advanceTimersByTimeAsync(10_000);await expect(result).resolves.toBe(false);expect(Native.instances[0].close).toHaveBeenCalledTimes(1);alerts.dispose();
 });
 it('settles an in-flight request on shutdown',async()=>{
  const alerts=new DesktopTaskNotifications(Native,()=>{}),result=alerts.show(tasks);alerts.dispose();await expect(result).resolves.toBe(false);
 });
 it('batches large sets with a short readable preview',async()=>{
  const alerts=new DesktopTaskNotifications(Native,()=>{}),result=alerts.show(Array.from({length:20},(_,i)=>({...tasks[0],id:String(i),title:'合成事项'.repeat(40)})));
  const native=Native.instances[0];expect(native.options.body).toContain('共 20 项');expect(native.options.body.length).toBeLessThan(300);native.emit('show');await result;alerts.dispose();
 });
});
