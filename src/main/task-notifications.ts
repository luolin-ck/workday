import type {Task} from '../shared/types';
export interface NotificationLike {
  once(event:'show'|'failed'|'click'|'close',listener:()=>void):unknown;
  show():void;
  close():void;
}
export interface NotificationConstructor {
  new(options:{title:string;body:string}):NotificationLike;
  isSupported():boolean;
}
export class DesktopTaskNotifications {
  private active=new Map<NotificationLike,()=>void>();
  private disposed=false;
  constructor(private Native:NotificationConstructor,private activate:()=>void){}
  async show(tasks:Task[]):Promise<boolean>{
    if(this.disposed||!tasks.length||!this.Native.isSupported())return false;
    const body=tasks.slice(0,3).map(task=>task.title.length>80?task.title.slice(0,79)+'…':task.title).join('\n')+(tasks.length>3?`\n共 ${tasks.length} 项 P0 待办`:'');
    return new Promise(resolve=>{
      let notification:NotificationLike;
      try{notification=new this.Native({title:'WorkDay · P0 重要事项',body});}catch{resolve(false);return;}
      let settled=false;
      const finish=(shown:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(shown);};
      const dismiss=()=>{finish(false);this.active.delete(notification);try{notification.close();}catch{}};
      const timer=setTimeout(dismiss,10_000);
      this.active.set(notification,dismiss);
      notification.once('show',()=>finish(true));
      notification.once('failed',dismiss);
      notification.once('close',()=>{finish(false);this.active.delete(notification);});
      notification.once('click',()=>{finish(true);this.activate();});
      try{notification.show();}catch{dismiss();}
    });
  }
  dispose(){this.disposed=true;for(const dismiss of [...this.active.values()])dismiss();}
}
