import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Calendar } from '../src/renderer/calendar';
import { WorkDayProvider } from '../src/renderer/component-theme';
import { RuntimeContext, type Runtime } from '../src/renderer/ui';

describe('meetings in the month grid',()=>{
  it('shows only nonzero meeting icon counts, independent of task details',()=>{
    const runtime:Runtime={state:{tasks:[],projects:[],conversations:[],sources:[],knowledge:[],skills:[],mcpServers:[],grants:[],plugins:[],drafts:[],schedules:[],runs:[],gitAccount:null,defaultModel:null,dataDirectory:'',appVersion:'test'},call:async()=>{throw new Error('SSR must not query');},refresh:async()=>{},report:()=>{},go:()=>{},openChat:()=>{},browseProject:()=>{}};
    const meetings={startDate:'2026-09-27',endDate:'2026-11-08',timezone:'Asia/Shanghai',status:'ready',message:null,meetings:[{id:'fixture',title:'合成会议完整文案',start:'2026-10-15T10:00:00+08:00',end:'2026-10-15T11:00:00+08:00',allDay:false,startDate:null,endDate:null}]};
    const html=renderToStaticMarkup(createElement(WorkDayProvider,{appearance:'mono',children:createElement(RuntimeContext.Provider,{value:runtime},createElement(Calendar,{date:'2026-10-15',onDate:()=>{},meetings} as any))}));
    expect(html).toContain('class="meeting-count"');
    expect(html).toContain('aria-label="会议 1 项"');
    expect(html.match(/lucide-presentation/g)).toHaveLength(2);
    expect(html).not.toContain('lucide-video');
    expect(html.match(/class="meeting-count"/g)).toHaveLength(1);
    expect(html).not.toContain('合成会议完整文案');
  });
});
