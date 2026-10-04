import React, { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MdEditor, MdPreview, config } from 'md-editor-rt';
import DOMPurify from 'dompurify';
import highlight from 'highlight.js/lib/common';
import 'md-editor-rt/lib/style.css';
import 'highlight.js/styles/github.css';
import './style.css';

// All enabled dependencies are bundled below. Clear the library's CDN fallbacks;
// optional extensions remain disabled instead of downloading remote scripts.
config({ editorExtensions: {
  highlight: { js: undefined, css: undefined },
  prettier: { standaloneJs: undefined, parserMarkdownJs: undefined },
  cropper: { js: undefined, css: undefined },
  screenfull: { js: undefined },
  mermaid: { js: undefined },
  katex: { js: undefined, css: undefined },
  echarts: { js: undefined }
} });
config({ editorExtensions: {
  highlight: { instance: highlight, css: { chawe: { light: '/article-editor.css', dark: '/article-editor.css' } } },
  screenfull: { instance: {
    isEnabled: !!document.fullscreenEnabled,
    get isFullscreen() { return !!document.fullscreenElement; },
    request: element => (element || document.documentElement).requestFullscreen(),
    exit: () => document.exitFullscreen(),
    on: (_name,callback) => document.addEventListener('fullscreenchange',callback),
    off: (_name,callback) => document.removeEventListener('fullscreenchange',callback)
  } }
} });
DOMPurify.addHook('afterSanitizeAttributes',node => {
  if (node.tagName === 'A') {
    node.setAttribute('target','_blank'); node.setAttribute('rel','noopener noreferrer');
  }
  if (node.tagName === 'INPUT') { node.setAttribute('type','checkbox'); node.setAttribute('disabled',''); }
  if (node.tagName === 'IMG') {
    const source = node.getAttribute('src') || '';
    let allowed = /^data:image\/(png|jpeg|webp|gif);base64,/i.test(source);
    try { allowed ||= new URL(source,location.origin).origin === location.origin; } catch {}
    if (!allowed) node.removeAttribute('src');
    node.setAttribute('loading','lazy'); node.setAttribute('referrerpolicy','no-referrer');
  }
});
const sanitize = html => DOMPurify.sanitize(html,{
  ALLOWED_TAGS: ['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','b','i','s','del','u','blockquote','ul','ol','li','pre','code','span','a','img','table','thead','tbody','tr','th','td','details','summary','sup','sub','input'],
  ALLOWED_ATTR: ['href','src','alt','title','class','colspan','rowspan','align','type','checked','disabled'],
  FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
});
const common = {
  language: 'zh-CN', theme: 'light', previewTheme: 'github', codeTheme: 'chawe',
  codeStyleReverse: false, noMermaid: true, noKatex: true, noEcharts: true,
  noImgZoomIn: true, sanitize, mdHeadingId: ({index}) => 'article-heading-' + index
};
export function mountEditor(host,options) {
  const root = createRoot(host), ref = createRef();
  let value = options.value || '', readOnly = false, disposed = false;
  const render = () => {
    if (disposed) return;
    root.render(<MdEditor {...common} id="chawe-article-editor" ref={ref} value={value}
      className="chawe-md-editor" placeholder="用 Markdown 写下你的文章…"
      onChange={next => { value = next; render(); options.onChange(next); }}
      onSave={() => options.onSave()} onError={error => options.onError?.(error)}
      readOnly={readOnly} disabled={readOnly} noPrettier noUploadImg
      preview={window.innerWidth > 740} footers={[]}
      toolbars={['title','bold','italic','strikeThrough','-','quote','unorderedList','orderedList','task','codeRow','code','link','table','-','revoke','next','=','preview']} />);
  };
  const keydown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); options.onSend();
    }
  };
  host.addEventListener('keydown',keydown,true); flushSync(render);
  return {
    value: () => value,
    setReadOnly: next => { readOnly = next; render(); },
    focus: () => ref.current?.focus(),
    insert: text => { ref.current?.insert(() => ({targetValue:text,select:false})); ref.current?.focus(); },
    dispose: () => { disposed = true; host.removeEventListener('keydown',keydown,true); root.unmount(); }
  };
}
export function mountPreview(host,markdown) {
  const root = createRoot(host);
  root.render(<MdPreview {...common} id="chawe-article-preview" value={markdown} className="chawe-md-preview" />);
  return { update: value => root.render(<MdPreview {...common} id="chawe-article-preview" value={value} className="chawe-md-preview" />), dispose: () => root.unmount() };
}
