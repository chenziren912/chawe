import React, { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MdEditor, MdPreview, config } from 'md-editor-rt';
import DOMPurify from 'dompurify';
import highlight from 'highlight.js/lib/common';
import katex from 'katex';
import 'md-editor-rt/lib/style.css';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';
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
  katex: { instance: katex, js: undefined, css: undefined },
  screenfull: { instance: {
    isEnabled: !!document.fullscreenEnabled,
    get isFullscreen() { return !!document.fullscreenElement; },
    request: element => (element || document.documentElement).requestFullscreen(),
    exit: () => document.exitFullscreen(),
    on: (_name,callback) => document.addEventListener('fullscreenchange',callback),
    off: (_name,callback) => document.removeEventListener('fullscreenchange',callback)
  } }
} });
config({
  markdownItConfig: markdown => { markdown.set({html:false}); return markdown; },
  katexConfig: base => ({...base,trust:false,throwOnError:false,maxExpand:1000,maxSize:40,output:'htmlAndMathml'})
});
// KaTeX needs numeric layout styles; ordinary article HTML must not gain arbitrary CSS.
const dimensions = new Set(['height','width','min-width','top','bottom','left','vertical-align','margin','margin-left','margin-right','margin-top','padding-left','border-width','border-top-width','border-bottom-width','border-right-width','text-shadow','--md-code-line-number-width']);
const lengths = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|ch|rem|%)?)(?:\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|ch|rem|%)?){0,3}$/i;
const color = /^(?:#[a-f\d]{3,8}|[a-z]+|rgba?\([\d\s.,%+-]+\)|hsla?\([\d\s.,%+-]+\))$/i;
DOMPurify.addHook('uponSanitizeAttribute',(node,attribute) => {
  if(attribute.attrName !== 'style') return;
  if(!node.closest?.('.katex,.katex-display,.katex-error,.md-editor-code-block-lines')) { attribute.keepAttr = false; return; }
  const safe = [];
  for(const property of Array.from(node.style || [])) {
    const value = node.style.getPropertyValue(property).trim();
    if(dimensions.has(property) && lengths.test(value)
      || ['color','background-color','border-color'].includes(property) && color.test(value)
      || ['border-style','border-right-style'].includes(property) && /^(solid|none)$/.test(value)
      || property === 'position' && value === 'relative') safe.push(property+':'+value);
  }
  attribute.attrValue = safe.join(';'); attribute.keepAttr = safe.length > 0;
});
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
  ALLOWED_TAGS: ['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','b','i','s','del','u','blockquote','ul','ol','li','pre','code','div','span','a','img','figure','figcaption','table','thead','tbody','tr','th','td','details','summary','sup','sub','input',
    'math','semantics','annotation','mrow','mi','mo','mn','mtext','mspace','mfrac','msqrt','mroot','msub','msup','msubsup','munder','mover','munderover','mtable','mtr','mtd','mstyle','mpadded','menclose','mphantom','svg','path','g','line','rect'],
  ALLOWED_ATTR: ['href','src','alt','title','class','colspan','rowspan','align','type','checked','disabled','style','open','language','role','rn-wrapper','data-line','data-line-number','data-tips','data-is-icon',
    'xmlns','encoding','display','mathvariant','stretchy','fence','separator','lspace','rspace','minsize','maxsize','columnalign','columnspacing','rowspacing','linethickness','notation','accent','accentunder','width','height','viewbox','preserveaspectratio','d','fill','stroke','stroke-width','x','y','x1','x2','y1','y2'],
  ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: true
});
const common = {
  language: 'zh-CN', theme: 'light', previewTheme: 'github', codeTheme: 'chawe',
  codeStyleReverse: false, showCodeRowNumber: true, codeFoldable: false, noMermaid: true, noKatex: false, noEcharts: true,
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
      toolbars={['title','bold','italic','strikeThrough','-','quote','unorderedList','orderedList','task','codeRow','code','link','table','katex','-','revoke','next','=','preview']} />);
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
