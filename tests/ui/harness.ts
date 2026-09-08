import { PenPanel } from "../../src/view/penPanel";
import { ColorPopover } from "../../src/view/colorPopover";
import { StickerPicker } from "../../src/view/stickerPicker";
import { FloatingToolbarController } from "../../src/view/floatingToolbar";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { setToolIcon } from "../../src/view/icons";
// Only Obsidian's DOM conveniences are mocked; production controls/CSS execute unchanged.
const proto = HTMLElement.prototype as any;
proto.createEl = function(tag: string, options: any = {}) { const el = document.createElement(tag); el.className = options.cls ?? ""; el.textContent = options.text ?? ""; for (const [k,v] of Object.entries(options.attr ?? {})) el.setAttribute(k,String(v)); this.append(el); return el; };
proto.createDiv = function(options: any) { return this.createEl("div", options); };
proto.createSpan = function(options: any) { return this.createEl("span", options); };
proto.addClass = function(...names: string[]) { this.classList.add(...names); };
proto.removeClass = function(...names: string[]) { this.classList.remove(...names); };
proto.toggleClass = function(name: string, value: boolean) { this.classList.toggle(name,value); };
proto.empty = function() { this.replaceChildren(); };
proto.setText = function(value: string) { this.textContent = value; };
const root = document.querySelector<HTMLElement>("#root")!;
const bar = root.createDiv({cls:"ink-toolbar"});
const anchors: HTMLElement[] = [];
for (const tool of ["pen","eraser","pencil","highlighter","mouse-pointer","type","shapes","ruler","undo-2","redo-2","smile"]) {
 const btn = bar.createEl("button",{cls:"ink-tb-btn",attr:{"aria-label":tool,title:tool}});setToolIcon(btn,tool);anchors.push(btn);
}
anchors[0].addClass("is-active");
const controller = new FloatingToolbarController(root,bar,{mode:"full",position:"bottom",floatX:9999,floatY:9999},{onStateChange(){}});
const settings=structuredClone(DEFAULT_SETTINGS);
let color=settings.color;
const pen=new PenPanel(root,{settings,getColor:()=>color,setColor:c=>{color=c;},onConfigChanged(){},addPreset:p=>settings.penPresets.push(p)});
const colors=new ColorPopover(root,{settings,getColor:()=>color,setColor:c=>{color=c;colors.refreshIfOpen(anchors[3]);},activatePreset(){},removePreset(){}});
const stickers=new StickerPicker(root,()=>{});
(window as any).ui={controller,root,open(kind: string){pen.close();colors.close();stickers.close();bar.scrollLeft=0;if(kind==="pen")pen.open(anchors[0],"pen");if(kind==="color")colors.toggle(anchors[3]);if(kind==="sticker")stickers.open(anchors[10]);},close(){pen.close();colors.close();stickers.close();}};
