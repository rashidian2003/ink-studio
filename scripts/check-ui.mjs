import {build} from 'esbuild';
const {chromium} = await import(process.env.INK_PLAYWRIGHT ?? 'playwright');
import {readFileSync} from 'node:fs';
const cwd=process.cwd();
const result=await build({entryPoints:[cwd+'/tests/ui/harness.ts'],bundle:true,write:false,alias:{obsidian:cwd+'/tests/ui/obsidian-mock.ts'}});
const browser=await chromium.launch({headless:true,channel:"chrome"});
const page=await browser.newPage({deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let count=0;
for(const dark of [false,true]) for(const [width,height] of [[1920,1080],[1440,900],[1280,800],[1024,768],[800,1280],[768,1024],[480,800],[400,700],[360,640]]) {
 await page.setViewportSize({width,height});
 await page.setContent(`<style>:root{--background-primary:${dark?'#24262b':'#faf9f6'};--background-secondary:${dark?'#303238':'#efeee9'};--background-secondary-alt:${dark?'#1b1d21':'#e7e5df'};--background-modifier-border:${dark?'#484b54':'#d6d4ce'};--background-modifier-hover:${dark?'#414550':'#e3e0da'};--text-normal:${dark?'#eeedf4':'#252630'};--text-muted:${dark?'#b7bac5':'#616570'};--text-faint:var(--text-muted);--interactive-accent:#8662d2;--text-on-accent:white;--font-ui-smaller:12px;}*{box-sizing:border-box}body{margin:0;font:13px system-ui;background:var(--background-secondary-alt)}button,input,select{font:inherit}#root{width:100%;height:100vh}button{cursor:pointer} ${readFileSync(cwd+'/styles.css','utf8')}</style><div id="root" class="ink-studio-view"></div>`);
 await page.addScriptTag({content:result.outputFiles[0].text});
 for(const position of ['top','bottom','left','right','floating']) for(const kind of ['pen','color','sticker']) {
  await page.evaluate(({position,kind})=>{window.ui.controller.setPosition(position);window.ui.open(kind);},{position,kind});
  await page.waitForTimeout(60);
  const rects=await page.evaluate(()=>[...document.querySelectorAll('.ink-toolbar,.ink-floating-surface')].map(e=>({cls:e.className,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,right:e.getBoundingClientRect().right,bottom:e.getBoundingClientRect().bottom})));
  for(const r of rects)if(r.x < -1||r.y < -1||r.right>width+1||r.bottom>height+1)throw Error(JSON.stringify({width,height,position,kind,r}));
  count++;
 }
 if(width===800){await page.evaluate(()=>{window.ui.controller.setPosition('bottom');window.ui.open('pen');});await page.waitForTimeout(250);await page.screenshot({path:`/tmp/ink-${dark?'dark':'light'}.png`});}
}
// Resize an already-open inspector inside an offset pane on a wide desktop.
await page.setViewportSize({width:1440,height:900});
await page.evaluate(()=>{window.ui.root.style.cssText="position:absolute;left:320px;top:60px;width:480px;height:760px";window.ui.controller.setPosition("floating");window.ui.open("pen");});
await page.waitForTimeout(100);
await page.evaluate(()=>{window.ui.root.style.width="360px";window.ui.root.style.height="320px";});
await page.waitForTimeout(100);
const contained=await page.evaluate(()=>{const p=document.querySelector('.ink-floating-surface').getBoundingClientRect();const r=window.ui.root.getBoundingClientRect();return p.left>=r.left&&p.right<=r.right&&p.top>=r.top&&p.bottom<=r.bottom;});
if(!contained)throw Error('Open inspector escaped resized split pane');
await page.locator('input[aria-label="Thickness"]').focus();
const before=await page.locator('input[aria-label="Thickness"]').inputValue();
await page.keyboard.press('ArrowRight');
if(await page.locator('input[aria-label="Thickness"]').inputValue()===before)throw Error('Native slider keyboard input failed');
await page.keyboard.press('Escape');
if(await page.locator('.ink-floating-surface').count())throw Error('Escape failed to close inspector');
for(let i=0;i<20;i++)await page.evaluate(()=>{window.ui.open('pen');window.ui.close();});
await page.waitForTimeout(100);
if(await page.locator('.ink-floating-surface').count())throw Error('Surface leaked after repeated close');
if(errors.length)throw Error(errors.join("\n"));
console.log(JSON.stringify({checks:count,splitPaneResize:true,keyboard:true,repeatedClose:true,errors}));await browser.close();
