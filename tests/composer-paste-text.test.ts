import {it,expect} from 'vitest';
import {pastedMessageText} from '../src/renderer/ComposerAttachments';
it.each(['ordinary text\nwith newlines','/Users/someone/file.txt','before <img src="https://invalid"> after','  描述图片  '])('keeps actual mixed text unchanged: %s',text=>expect(pastedMessageText(text,['screenshot.png'])).toBe(text));
it.each(['screenshot.png','file:///private/tmp/screenshot.png'])('does not insert native file placeholders: %s',text=>expect(pastedMessageText(text,['screenshot.png'])).toBe(''));
it('does not treat a filename embedded in actual prose as a file placeholder',()=>expect(pastedMessageText('请看 screenshot.png',['screenshot.png'])).toBe('请看 screenshot.png'));
