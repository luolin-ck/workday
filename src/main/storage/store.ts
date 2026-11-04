import initSqlJs, {type Database} from 'sql.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
export const TABLES=['tasks','projects','conversations','messages','sources','knowledge','skills','mcpServers','grants','plugins','drafts','schedules','runs','requests','settings'] as const;
export type Table=(typeof TABLES)[number];
export async function atomicWrite(file:string,data:Uint8Array|string) {
 await fs.mkdir(path.dirname(file),{recursive:true});
 const temporary=file+'.tmp';const handle=await fs.open(temporary,'w',0o600);
 try {await handle.writeFile(data);await handle.sync();} finally {await handle.close();}
 try {await fs.rename(temporary,file);} catch(error){await fs.rm(temporary,{force:true});throw error;}
 // Rename is the commit point; directory sync is best effort after the committed file exists.
 try{const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}catch{}
}
export class Store {
 private committed:Database;
 private transactionContext=new AsyncLocalStorage<boolean>();
 private constructor(public file:string,private db:Database,private SQL:Awaited<ReturnType<typeof initSqlJs>>,private persist:(file:string,data:Uint8Array)=>Promise<void>){this.committed=new SQL.Database(db.export());}
 private reader(){return this.transactionContext.getStore()?this.db:this.committed;}
 private queue:Promise<unknown>=Promise.resolve();
 static async open(file:string,persist=atomicWrite) {
  const SQL=await initSqlJs({locateFile:()=>require.resolve('sql.js/dist/sql-wasm.wasm')});
  let bytes:Buffer|undefined;try{bytes=await fs.readFile(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const db=bytes?new SQL.Database(bytes):new SQL.Database();
  db.run('PRAGMA foreign_keys=ON');db.run('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)');
  const ver=db.exec('SELECT version FROM schema_version')[0]?.values[0]?.[0];if(ver!==undefined&&ver!==1)throw new Error('数据库版本不兼容');
  if(ver===undefined)db.run('INSERT INTO schema_version VALUES (1)');
  for(const table of TABLES)db.run(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL)`);
  await persist(file,db.export());return new Store(file,db,SQL,persist);
 }
 list<T>(table:Table):T[] {const stmt=this.reader().prepare(`SELECT payload FROM ${table} ORDER BY rowid`);const rows:T[]=[];try{while(stmt.step())rows.push(JSON.parse(stmt.getAsObject().payload as string));}finally{stmt.free();}return rows;}
 get<T>(table:Table,id:string):T|undefined {const stmt=this.reader().prepare(`SELECT payload FROM ${table} WHERE id=?`);try{stmt.bind([id]);return stmt.step()?JSON.parse(stmt.getAsObject().payload as string):undefined;}finally{stmt.free();}}
 put<T extends {id:string}>(table:Table,item:T) {this.db.run(`INSERT INTO ${table}(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,[item.id,JSON.stringify(item)]);}
 remove(table:Table,id:string){this.db.run(`DELETE FROM ${table} WHERE id=?`,[id]);}
 async transaction<T>(fn:()=>T|Promise<T>):Promise<T>{
  const run=this.queue.then(async()=>{const before=this.db.export();let candidate:Database|undefined;try{this.db.run('BEGIN IMMEDIATE');const value=await this.transactionContext.run(true,fn);this.db.run('COMMIT');const bytes=this.db.export();candidate=new this.SQL.Database(bytes);await this.persist(this.file,bytes);const old=this.committed;this.committed=candidate;candidate=undefined;try{old.close();}catch{}return value;}catch(error){candidate?.close();this.db.close();this.db=new this.SQL.Database(before);this.db.run('PRAGMA foreign_keys=ON');throw error;}});
  this.queue=run.catch(()=>undefined);return run;
 }
 async replaceBytes(bytes:Uint8Array){const run=this.queue.then(async()=>{const next=new this.SQL.Database(bytes);try{for(const table of TABLES)next.exec('SELECT id,payload FROM '+table+' LIMIT 0');await this.persist(this.file,bytes);const previous=this.db,committed=this.committed;this.db=next;this.committed=new this.SQL.Database(bytes);previous.close();committed.close();}catch(error){next.close();throw error;}});this.queue=run.catch(()=>undefined);return run;}
 async settled(){await this.queue;}
 exportRows(){return Object.fromEntries(TABLES.map(t=>[t,this.list(t)])) as Record<Table,any[]>;}
 close(){this.db.close();this.committed.close();}
}
