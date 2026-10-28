import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import type {ContextOwner,ConversationReference} from '../shared/chat-context';
import type {ContextSelection} from '../shared/types';
import {componentDescription} from '../shared/component-description';
import {Icon,type IconName} from './icons';
import {useApp} from './ui';
import {addContextReference,composerTrigger,consumeComposerTrigger,matchCommand,type ComposerCommand,type ComposerTrigger} from './composer-commands';

type Suggestion={key:string;kind:'command'|'conversation'|'skill'|'plugin'|'knowledge';id:string;title:string;description:string;icon:IconName;version:number;digest?:string;selected?:boolean};
export function useComposerSuggestions({input,onInput,inputRef,anchorRef,owner,scope,disabled,management=false,context,onContext,onCommand,onPlugin}:{
  input:string;onInput:(text:string)=>void;inputRef:RefObject<HTMLTextAreaElement|null>;anchorRef:RefObject<HTMLDivElement|null>;
  owner:ContextOwner;scope:string;disabled:boolean;management?:boolean;context:ContextSelection;onContext:(value:ContextSelection)=>void;
  onCommand:(command:ComposerCommand)=>void;onPlugin:(id:string)=>void;
}) {
  const {state,call,report}=useApp();
  const callRef=useRef(call);callRef.current=call;
  const [intent,setIntent]=useState<{trigger:ComposerTrigger;scope:string}|null>(null);
  const [active,setActive]=useState(0);
  const [remote,setRemote]=useState<{key:string;items:ConversationReference[];loading:boolean;error:string}>({key:'',items:[],loading:false,error:''});
  const [position,setPosition]=useState<{left:number;width:number;bottom:number;maxHeight:number}|null>(null);
  const composing=useRef(false),selectionLock=useRef(false),alive=useRef(true),sequence=useRef(0),intentRevision=useRef(0);
  const menuRef=useRef<HTMLDivElement>(null),listRef=useRef<HTMLDivElement>(null),id=useId();
  const current=useRef({input,scope,disabled,context,onInput,onContext,onCommand,onPlugin,state});
  current.current={input,scope,disabled,context,onInput,onContext,onCommand,onPlugin,state};
  const trigger=!disabled&&!composing.current&&intent?.scope===scope?intent.trigger:null;
  const requestKey=trigger?.kind==='@'?`${scope}:${trigger.start}:${trigger.end}:${trigger.query}`:'';
  function close(){setIntent(null);sequence.current++;intentRevision.current++;}
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
  useEffect(()=>{close();selectionLock.current=false;},[scope,disabled]);
  useEffect(()=>{
    if(!requestKey||!trigger)return;
    const serial=++sequence.current;
    setRemote({key:requestKey,items:[],loading:true,error:''});
    const timer=setTimeout(()=>{
      void callRef.current('context.conversations',{owner,query:trigger.query}).then(items=>{
        if(alive.current&&serial===sequence.current&&current.current.scope===scope&&!current.current.disabled)setRemote({key:requestKey,items,loading:false,error:''});
      }).catch(error=>{
        if(alive.current&&serial===sequence.current&&current.current.scope===scope&&!current.current.disabled)setRemote({key:requestKey,items:[],loading:false,error:error.message});
      });
    },120);
    return()=>{clearTimeout(timer);sequence.current++;};
  },[requestKey]);
  function detect(element:HTMLTextAreaElement){
    if(current.current.disabled||composing.current||selectionLock.current){close();return;}
    intentRevision.current++;
    const found=composerTrigger(element.value,element.selectionStart,element.selectionEnd);
    setIntent(found?{trigger:found,scope:current.current.scope}:null);setActive(0);
  }
  const candidates:Suggestion[]=[];
  if(trigger?.kind==='/')candidates.push(...matchCommand(trigger.query).map(c=>({key:c.id,kind:'command' as const,id:c.id,title:c.title,description:c.description,icon:c.icon,version:0})));
  if(trigger?.kind==='@'){
    const matches=(...texts:string[])=>texts.some(text=>text.toLowerCase().includes(trigger.query.toLowerCase()));
    for(const item of remote.key===requestKey?remote.items:[]){
      const chat=state.conversations.find(c=>c.id===item.id);
      if(chat&&!chat.archived&&!chat.activeRequestId&&chat.version===item.version&&chat.id!==owner.conversationId)candidates.push({key:'conversation:'+item.id,kind:'conversation',id:item.id,version:item.version,digest:item.digest,title:item.title,description:'对话 · '+item.projectName,icon:'messages-square',selected:context.conversationRefs?.some(r=>r.id===item.id)});
    }
    for(const skill of state.skills.filter(s=>!management&&s.enabled&&!s.ownerPluginId&&matches(s.name,s.description,s.descriptionZh??'')))candidates.push({key:'skill:'+skill.id,kind:'skill',id:skill.id,version:skill.version,title:skill.name,description:'Skill · '+componentDescription(skill),icon:'sparkles',selected:context.skillRef?.id===skill.id});
    for(const plugin of state.plugins.filter(p=>!management&&p.enabled&&matches(p.name,p.description,p.descriptionZh??'')))candidates.push({key:'plugin:'+plugin.id,kind:'plugin',id:plugin.id,version:plugin.version,title:plugin.name,description:'插件 · '+componentDescription(plugin),icon:'puzzle',selected:context.pluginRefs?.some(r=>r.id===plugin.id)});
    for(const item of state.knowledge.filter(k=>!k.removed&&k.projectId===owner.projectId&&matches(k.name,k.content)))candidates.push({key:'knowledge:'+item.id,kind:'knowledge',id:item.id,version:item.version,title:item.name,description:'知识资料 · '+item.content.slice(0,150).replace(/\s+/g,' '),icon:'library-big',selected:context.knowledgeRefs.some(r=>r.id===item.id)});
  }
  const currentCandidates=useRef(candidates);currentCandidates.current=candidates;
  const activeIndex=Math.min(active,Math.max(0,candidates.length-1));
  const opened=!!trigger&&(trigger.kind==='@'||candidates.length>0);
  useLayoutEffect(()=>{
    if(!opened)return;
    const place=()=>{
      const box=anchorRef.current?.getBoundingClientRect();if(!box)return;
      const gap=8,edge=12;
      setPosition({left:Math.max(edge,box.left),width:Math.min(box.width,innerWidth-2*edge),bottom:Math.max(edge,innerHeight-box.top+gap),maxHeight:Math.max(80,box.top-gap-edge)});
    };
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    const observer=new ResizeObserver(place);if(anchorRef.current)observer.observe(anchorRef.current);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[opened,anchorRef]);
  useEffect(()=>{
    if(!opened)return;
    const dismiss=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node)&&!inputRef.current?.contains(event.target as Node))close();};
    document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss);
  },[opened,inputRef]);
  useLayoutEffect(()=>{
    const list=listRef.current,option=document.getElementById(`${id}-${activeIndex}`);
    if(!list||!option)return;
    const deltaTop=option.getBoundingClientRect().top-list.getBoundingClientRect().top;
    if(deltaTop<0)list.scrollTop+=deltaTop;
    else if(deltaTop+option.offsetHeight>list.clientHeight)list.scrollTop+=deltaTop+option.offsetHeight-list.clientHeight;
  },[activeIndex,opened]);
  async function select(item:Suggestion){
    const origin=scope,chosenTrigger=trigger,sourceInput=input,revision=intentRevision.current;
    if(!chosenTrigger||disabled||selectionLock.current||composing.current)return;
    const caretMatches=()=>inputRef.current?.selectionStart===chosenTrigger.end&&inputRef.current?.selectionEnd===chosenTrigger.end;
    if(!caretMatches())return;
    const candidate=currentCandidates.current.find(c=>c.key===item.key&&c.version===item.version&&c.digest===item.digest);
    if(!candidate)return;
    selectionLock.current=true;
    const valid=()=>alive.current&&current.current.scope===origin&&!current.current.disabled&&current.current.input===sourceInput&&intentRevision.current===revision&&caretMatches();
    try {
      if(item.kind==='conversation'){
        const available=await call('context.conversations',{owner,query:chosenTrigger.query});
        if(!valid())return;
        if(!available.some(c=>c.id===item.id&&c.version===item.version&&c.digest===item.digest))throw Error('对话内容已变化，请重新选择。');
      }
      if(!valid()||!currentCandidates.current.some(c=>c.key===item.key&&c.version===item.version&&c.digest===item.digest))return;
      const consumed=consumeComposerTrigger(current.current.input,chosenTrigger);if(!consumed)return;
      if(item.kind==='conversation'||item.kind==='skill'||item.kind==='knowledge'){
        const reference=item.kind==='conversation'?{kind:item.kind,id:item.id,version:item.version,digest:item.digest!}:{kind:item.kind,id:item.id,version:item.version};
        current.current.onContext(addContextReference(current.current.context,reference));
      }
      current.current.onInput(consumed.text);close();
      if(item.kind==='plugin')current.current.onPlugin(item.id);
      else if(item.kind==='command')current.current.onCommand(item.id as ComposerCommand);
      else requestAnimationFrame(()=>{if(validAfterConsume()){inputRef.current?.focus();inputRef.current?.setSelectionRange(consumed.caret,consumed.caret);}});
      function validAfterConsume(){return alive.current&&current.current.scope===origin&&!current.current.disabled&&current.current.input===consumed!.text;}
    }catch(error){if(alive.current&&current.current.scope===origin)report(error instanceof Error?error.message:String(error));}
    finally{selectionLock.current=false;}
  }
  function onKeyDown(event:KeyboardEvent<HTMLTextAreaElement>){
    if(composing.current||event.nativeEvent.isComposing||event.keyCode===229)return true;
    if(!opened)return false;
    if(event.key==='Escape'){event.preventDefault();close();return true;}
    if(event.metaKey||event.ctrlKey)return false;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();if(candidates.length)setActive(index=>(index+(event.key==='ArrowDown'?1:-1)+candidates.length)%candidates.length);return true;
    }
    if((event.key==='Enter'||event.key==='Tab')&&candidates[activeIndex]){event.preventDefault();void select(candidates[activeIndex]);return true;}
    return false;
  }
  return {
    close,detect,onKeyDown,
    onSelect:(element:HTMLTextAreaElement)=>{if(trigger&&(element.selectionStart!==trigger.end||element.selectionEnd!==trigger.end))detect(element);},
    composing:()=>composing.current,
    onCompositionStart:()=>{composing.current=true;close();},
    onCompositionEnd:(element:HTMLTextAreaElement)=>{composing.current=false;detect(element);},
    aria:{'aria-expanded':opened,'aria-controls':opened?id:undefined,'aria-activedescendant':opened&&candidates.length?`${id}-${activeIndex}`:undefined,'aria-autocomplete':'list' as const},
    menu:opened&&position?createPortal(<div ref={menuRef} className="composer-suggestions" style={{left:position.left,width:position.width,bottom:position.bottom,maxHeight:position.maxHeight}}>
      <div className="composer-suggestions-heading">{trigger?.kind==='@'?'添加上下文':'快捷命令'}<span>↑↓ 选择 · Enter 确认 · Esc 关闭</span></div>
      <div ref={listRef} id={id} role="listbox" aria-label={trigger?.kind==='@'?'上下文建议':'快捷命令'} className="composer-suggestions-list">
        {candidates.map((item,index)=><button id={`${id}-${index}`} key={item.key} type="button" role="option" aria-selected={activeIndex===index} className="composer-suggestion" tabIndex={-1} title={`${item.title}\n${item.description}`} onPointerDown={event=>event.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>void select(item)}>
          <Icon name={item.icon} size="sm"/><span className="composer-suggestion-copy"><strong>{item.title}</strong><span>{item.description}</span></span>
          {item.kind==='command'?<code>/{item.id}</code>:item.selected?<Icon name="check" size="sm"/>:item.kind==='plugin'?<Icon name="chevron-right" size="sm"/>:null}
        </button>)}
        {trigger?.kind==='@'&&remote.key===requestKey&&remote.loading&&<p role="status">正在搜索对话…</p>}
        {trigger?.kind==='@'&&remote.key===requestKey&&remote.error&&<p role="status">对话暂时无法加载，请重新输入以重试。</p>}
        {!candidates.length&&!(remote.key===requestKey&&remote.loading)&&<p role="status">没有匹配的上下文</p>}
      </div>
    </div>,document.body):null
  };
}
