export const CHAT_LIMITS = Object.freeze({attachments:6,fileBytes:10*1024*1024,imageBytes:4*1024*1024,historyImageBytes:12*1024*1024,pendingBytes:24*1024*1024,attachmentText:30000,pdfPages:50,imagePixels:40000000,imageEdge:2048,systemText:60000,protocolText:120000});
export interface AttachmentMaterial {name:string;mime:'image/png'|'image/jpeg'|'application/pdf'|'text/plain';size:number;text?:string;dataUrl?:string}
export interface AttachmentRef {token:string;name:string;mime:AttachmentMaterial['mime'];size:number}
export interface ContextOwner {projectId:string|null;conversationId:string|null;draftKey:string}
export interface ConversationReference {id:string;version:number;digest:string;title:string;projectName:string;preview:string}
