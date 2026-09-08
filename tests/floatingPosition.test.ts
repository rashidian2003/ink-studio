import { test } from "node:test";
import assert from "node:assert/strict";
import { positionFloating, intersectRects, clamp, type Placement } from "../src/view/floatingPosition";
const pane = { left: 320, top: 80, width: 400, height: 600 };
for (const placement of ["top", "bottom", "left", "right"] as Placement[]) {
  for (const [x, y] of [[320,80],[690,80],[320,650],[690,650]]) {
    test(`${placement} at pane edge ${x},${y}`, () => {
      const result = positionFloating({left:x,top:y,width:30,height:30}, {width:340,height:900}, pane, placement);
      assert.ok(result.x >= 328 && result.x + Math.min(340,result.maxWidth) <= 712);
      assert.ok(result.y >= 88 && result.y + result.maxHeight <= 672);
    });
  }
}
test("unavailable bottom flips above", () => {
  assert.equal(positionFloating({left:400,top:620,width:44,height:44}, {width:250,height:200},pane).placement,"top");
});
test("keyboard intersects an offset split pane", () => {
  assert.deepEqual(intersectRects(pane,{left:0,top:100,width:1000,height:280}), {left:320,top:100,width:400,height:280});
});
test("narrow and tiny bounds constrain both dimensions", () => {
  for (const width of [0,8,100,360,480,600,768,1024,1280,1440,1920]) {
    const r=positionFloating({left:0,top:0,width:44,height:44},{width:340,height:800},{left:0,top:0,width,height:300});
    assert.ok(r.x>=0 && r.x+r.maxWidth<=width);
    assert.ok(r.y>=0 && r.y+r.maxHeight<=300);
  }
});
test("invalid saved positions recover", () => {
  for (const value of [NaN,Infinity,-Infinity,-20,90000]) assert.ok(clamp(value,12,300)>=12 && clamp(value,12,300)<=300);
});
