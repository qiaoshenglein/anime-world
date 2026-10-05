// Bundles src/main.js with three.js and inlines it into a single self-contained index.html
const result = await Bun.build({
  entrypoints: ['./src/main.js'],
  minify: true,
  target: 'browser',
  format: 'iife',
});
if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
const js = (await result.outputs[0].text()).replace(/<\/script/gi, '<\\/script');
const tpl = await Bun.file('./index.template.html').text();
const html = tpl.replace('__BUNDLE__', () => js);
await Bun.write('./index.html', html);
console.log('index.html written:', (html.length / 1024).toFixed(0), 'KB');
