import {DateTime} from 'luxon';
import fs from 'node:fs/promises';
import {atomicWrite} from './store';
import {priorityReminderTasks} from '../shared/dates';
import type {Task} from '../shared/types';
export interface ReminderOptions {
  tasks:()=>Task[];
  notify:(tasks:Task[])=>Promise<boolean>;
  now?:()=>DateTime;
  persist?:(file:string,data:string)=>Promise<void>;
}
export class TaskReminders {
  private queue:Promise<void>=Promise.resolve();
  private dirty=false;
  private retryAfter=0;
  private constructor(private file:string,private options:ReminderOptions,private sent:Record<string,string>){}
  static async open(file:string,options:ReminderOptions){
    let sent:Record<string,string>={};
    try{
      const value=JSON.parse(await fs.readFile(file,'utf8'));
      if(value?.version!==1||!value.sent||typeof value.sent!=='object'||Array.isArray(value.sent)||Object.values(value.sent).some(day=>typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)))throw new Error('Invalid reminder receipt');
      sent=value.sent;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return new TaskReminders(file,options,sent);
  }
  check(){
    const pending=this.queue.then(()=>this.deliver());
    this.queue=pending.catch(()=>undefined);
    return pending;
  }
  private async flush(){
    if(!this.dirty)return;
    await (this.options.persist??atomicWrite)(this.file,JSON.stringify({version:1,sent:this.sent}));
    this.dirty=false;
  }
  private async deliver(){
    // A failed disk write is retried before any further notifications are sent.
    await this.flush();
    const now=(this.options.now??(()=>DateTime.local()))(),day=now.toISODate();
    if(!day||now.toMillis()<this.retryAfter)return;
    const tasks=priorityReminderTasks(this.options.tasks(),day).filter(task=>this.sent[task.id]!==day);
    if(!tasks.length)return;
    let shown=false;
    try{shown=await this.options.notify(tasks);}catch{/* Retry native failures without consuming today's reminder. */}
    if(!shown){this.retryAfter=now.toMillis()+5*60*1000;return;}
    this.retryAfter=0;
    for(const task of tasks)this.sent[task.id]=day;
    this.dirty=true;await this.flush();
  }
  async settled(){await this.queue;await this.flush();}
}
