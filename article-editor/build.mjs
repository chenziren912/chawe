import { build } from 'esbuild';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const result = await build({
  entryPoints: ['src.jsx'], bundle: true, minify: true, format: 'esm', target: ['chrome105','safari16'],
  outfile: '../web/article-editor.js', legalComments: 'linked',
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
  logLevel: 'info'
});
for (const output of Object.values(result.metafile.outputs)) {
  const external = output.imports.filter(dependency => dependency.external &&
    !(dependency.kind === 'url-token' && dependency.path.startsWith('data:')));
  if (external.length) {
    throw new Error('Article editor dependencies must be bundled and served by Chawe: ' + external.map(item => item.path).join(', '));
  }
}
const notices = [];
for (const name of ['md-editor-rt','react','react-dom','dompurify','highlight.js']) {
  const entry = JSON.parse(await readFile('node_modules/' + name + '/package.json','utf8'));
  let license = '';
  for (const file of ['LICENSE','LICENSE.md','LICENSE.txt']) {
    try { license = await readFile('node_modules/' + name + '/' + file,'utf8'); break; } catch {}
  }
  notices.push(name + ' ' + entry.version + '\n' + (entry.homepage || '') + '\n' + license);
}
notices.push(await readFile('../web/article-editor.js.LEGAL.txt','utf8'));
notices.push(await readFile('../web/article-editor.css.LEGAL.txt','utf8'));
await writeFile('../web/article-notices.txt',notices.join('\n\n----------------------------------------\n\n'));

// Content revisions let browsers reuse the editor across page reloads. The
// server caches only requests whose revision matches the served file.
const revision = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const replaceOne = (source,pattern,replacement) => {
  if ([...source.matchAll(new RegExp(pattern.source,'g'))].length !== 1) {
    throw new Error('Expected one editor resource reference: ' + pattern);
  }
  return source.replace(pattern,replacement);
};
const scriptRevision = await revision('../web/article-editor.js');
const styleRevision = await revision('../web/article-editor.css');
let loader = await readFile('../web/article.js','utf8');
loader = replaceOne(loader,/\/article-editor\.js\?v=[^']+/, '/article-editor.js?v=' + scriptRevision);
await writeFile('../web/article.js',loader);
let html = await readFile('../web/chat.html','utf8');
html = replaceOne(html,/\/article-editor\.css\?v=[^"]+/, '/article-editor.css?v=' + styleRevision);
html = replaceOne(html,/\/article\.js\?v=[^"]+/, '/article.js?v=' + await revision('../web/article.js'));
await writeFile('../web/chat.html',html);
