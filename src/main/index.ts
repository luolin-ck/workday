import {app,BrowserWindow,ipcMain,dialog,safeStorage,powerMonitor,shell,Notification,Menu} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Store} from './store';
import {KeychainAccess} from './keychain-access';
import {Credentials} from './credentials';
import {AppService,type NativeDialogs} from './service';
import {AppError,requireThat} from './validation';
import {OPERATIONS,type Operations} from '../shared/api';
import type {Task} from '../shared/types';
import {TaskReminders} from './task-reminders';
import {DesktopTaskNotifications} from './task-notifications';
app.setName('WorkDay');app.disableHardwareAcceleration();
if(process.env.WORKDAY_DATA_DIR)app.setPath('userData',path.resolve(process.env.WORKDAY_DATA_DIR));
if(!app.requestSingleInstanceLock()){app.quit();}else{
 let window:BrowserWindow|null=null,service:AppService|undefined,timer:NodeJS.Timeout|undefined;
 let reminders:TaskReminders|undefined,notifications:DesktopTaskNotifications|undefined;
 let reminderErrorReported=false;
 const checkReminders=()=>{if(quitting||!reminders)return;return reminders.check().catch(()=>{if(!reminderErrorReported){console.warn('WorkDay priority reminder receipt could not be saved.');reminderErrorReported=true;}});};
 const renderer=path.resolve(__dirname,'../renderer/index.html');const allowedUrl=pathToFileURL(renderer).href;
 app.on('second-instance',()=>{window?.show();window?.focus();});
 app.whenReady().then(async()=>{
  const directory=app.getPath('userData');await fs.mkdir(directory,{recursive:true});const credentials=new Credentials(path.join(directory,'credentials.json'),safeStorage);await credentials.init();
  const dialogs:NativeDialogs={
   async openFile(file){if(await shell.openPath(file))throw new AppError('OPEN_FILE','无法打开媒体文件');},
   desktopDirectory:()=>app.getPath('desktop'),
   async openAttachments(){const r=await dialog.showOpenDialog({title:'添加聊天附件',properties:['openFile','multiSelections'],filters:[{name:'图片、PDF、文本与代码',extensions:['png','jpg','jpeg','webp','pdf','txt','md','json','yaml','yml','csv','ts','tsx','js','jsx','py','go','rs','java','swift','html','css']},{name:'所有文件',extensions:['*']}]});return r.canceled?[]:r.filePaths;},
   async openProject(){const r=await dialog.showOpenDialog({title:'选择项目文件夹',properties:['openDirectory']});return r.canceled?null:r.filePaths[0]??null;},
   async openText(){const r=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'文本资料',extensions:['md','txt']}]});return r.canceled?null:r.filePaths[0];},
   async openComponentMaterial(kind){const r=await dialog.showOpenDialog({title:kind==='skill'?'选择 Skill 目录或 SKILL.md':kind==='mcp'?'选择 MCP JSON':'选择 Plugin 目录',properties:kind==='skill'?['openFile','openDirectory']:kind==='mcp'?['openFile']:['openDirectory'],...(kind==='mcp'?{filters:[{name:'MCP',extensions:['json']}]}:{})});return r.canceled?null:r.filePaths[0];},
   async openSkill(){const r=await dialog.showOpenDialog({title:'选择 SKILL.md',properties:['openFile'],filters:[{name:'Skill',extensions:['md']}]});return r.canceled?null:r.filePaths[0];},
   async openComponentMigration(){const r=await dialog.showOpenDialog({title:'选择组件迁移清单',properties:['openFile'],filters:[{name:'WorkDay 组件迁移',extensions:['json']}]});return r.canceled?null:r.filePaths[0]??null;},
   async openPlugin(){const r=await dialog.showOpenDialog({title:'选择插件目录',properties:['openDirectory']});return r.canceled?null:r.filePaths[0];},
   async saveBackup(){const r=await dialog.showSaveDialog({title:'保存不含凭证及授权的备份',defaultPath:'WorkDay-backup.json',filters:[{name:'WorkDay backup',extensions:['json']}]});return r.canceled?null:r.filePath??null;},
   async openBackup(){const r=await dialog.showOpenDialog({title:'验证备份，创建安全副本',properties:['openFile'],filters:[{name:'WorkDay backup',extensions:['json']}]});return r.canceled?null:r.filePaths[0];},
   async openExternal(url){await shell.openExternal(url);},
   async openDirectory(directory){
    try{if(await shell.openPath(directory))throw new Error('openPath failed');}
    catch{throw new AppError('OPEN_DIRECTORY','无法打开数据文件夹，请检查目录是否存在或访问权限');}
   }
  };
  service=new AppService(await Store.open(path.join(directory,'workday.sqlite')),credentials,dialogs,directory,new KeychainAccess(undefined,process.platform,app.isPackaged));await service.recover();
  ipcMain.handle('workday:call',async(event,operation,payload)=>{try{requireThat(window&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame.url===allowedUrl,'调用来源无效','ORIGIN');requireThat(typeof operation==='string'&&OPERATIONS.includes(operation as any),'操作不在白名单');const value=await service!.call(operation as keyof Operations,payload);return {ok:true,value};}catch(error){return {ok:false,error:{code:error instanceof AppError?error.code:'FAILED',message:error instanceof AppError?error.message:'操作失败，请检查输入、连接或磁盘空间'}};}});
  ipcMain.handle('workday:paste',async(event,owner,files)=>{try{requireThat(window&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame.url===allowedUrl,'调用来源无效','ORIGIN');return {ok:true,value:await service!.pasteAttachments(owner,files)};}catch(error){return {ok:false,error:{code:error instanceof AppError?error.code:'FAILED',message:error instanceof AppError?error.message:'无法准备附件，请重新粘贴'}};}});
  service.subscribe(event=>{if(window&&!window.isDestroyed())window.webContents.send('workday:event',event);if(event.type==='stateChanged')void checkReminders();});
  function createWindow(){window=new BrowserWindow({width:1500,height:980,minWidth:660,minHeight:620,title:'WorkDay',...(process.platform==='darwin'?{titleBarStyle:'hiddenInset' as const,trafficLightPosition:{x:12,y:17}}:{}),backgroundColor:'#141b17',webPreferences:{preload:path.join(__dirname,'../preload/index.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.on('will-attach-webview',event=>event.preventDefault());window.webContents.on('context-menu',(_event,params)=>{const current=window;if(!current||current.isDestroyed()||current.webContents.getURL()!==allowedUrl||params.mediaType!=='image'||!params.hasImageContents||!/^data:image\/(?:png|jpeg);base64,/.test(params.srcURL))return;Menu.buildFromTemplate([{label:'复制图片',click:()=>{if(!current.isDestroyed()&&current.webContents.getURL()===allowedUrl)current.webContents.copyImageAt(params.x,params.y);}}]).popup({window:current});});window.loadFile(renderer);window.on('closed',()=>{window=null;});}
  createWindow();
  notifications=new DesktopTaskNotifications(Notification,()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
  try{reminders=await TaskReminders.open(path.join(directory,'task-reminders.json'),{tasks:()=>service!.store.list<Task>('tasks'),notify:tasks=>notifications!.show(tasks)});}catch{console.warn('WorkDay priority reminder receipt is unavailable; original data preserved.');}
  void checkReminders();
  timer=setInterval(()=>void service!.tick().then(checkReminders).catch(()=>undefined),1000);powerMonitor.on('resume',()=>void service!.tick(true).then(checkReminders).catch(()=>undefined));
  app.on('activate',()=>{if(!window)createWindow();});
 }).catch(error=>{console.error('WorkDay startup failed:',error instanceof AppError?error.message:'local data unavailable');dialog.showErrorBox('WorkDay 启动失败','本地数据无法读取，请检查数据目录；原文件保留。');app.quit();});
 app.on('window-all-closed',()=>app.quit());
 let quitting=false;app.on('before-quit',event=>{if(quitting||!service)return;event.preventDefault();quitting=true;if(timer)clearInterval(timer);notifications?.dispose();void Promise.allSettled([service.dispose(),reminders?.settled()]).finally(()=>app.quit());});
}
