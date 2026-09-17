import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function testReliability({ page, worker, waitFor, capture, PNG, kind }) {
  const isolated = func => worker.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    return chrome.scripting.executeScript({target:{tabId:tab.id},func:${func.toString()}});
  })()`);
  const select = async (cross = true, container = false) => {
    if(container) await page.evaluate(()=>document.getElementById("target-article").style.paddingBottom="20px");
    await capture('region');
    await page.mouse.click(642,245);await page.mouse.click(80,40);
    if(cross) await page.evaluate(()=>scrollTo(0,1940));
    await page.mouse.click(730,245);await page.mouse.click(579,cross ? (container ? 509 : 499) : 439);
  };
  const start = () => page.mouse.click(811,245);
  const verify = async (result,height,grown = false) => {
    assert.equal(result.state,'complete',JSON.stringify(result));
    assert.equal(result.parts,1);
    const png=PNG.sync.read(await readFile(result.result.filename));
    assert.equal(png.width,499);assert.equal(png.height,height);
    const references=(await page.evaluate(()=>[...document.querySelectorAll('canvas')].map(c=>c.toDataURL().split(',')[1])))
      .map(v=>PNG.sync.read(Buffer.from(v,'base64')));
    for(let y=0;y<height;y++) {
      if(grown && (y>=2700 || (y>=1920 && y<2220))) {
        for(let x=0;x<499;x++) assert.deepEqual([...png.data.subarray((y*499+x)*4,(y*499+x+1)*4)],[224,0,224,255]);
        continue;
      }
      const row=grown && y>=2220 ? y-300 : y;
      const reference=references[Math.floor(row/480)], offset=(row%480)*500*4;
      assert.deepEqual(png.data.subarray(y*499*4,(y+1)*499*4),reference.data.subarray(offset,offset+499*4),`row ${y}`);
    }
  };
  if(kind==='chat') {
    const sizes=await page.evaluate(()=>{
      const composer=document.getElementById('composer'), anchor=document.querySelector('canvas');
      const before=anchor.getBoundingClientRect().width;
      composer.style.position='relative';
      const oldPrepare=anchor.getBoundingClientRect().width;
      composer.style.removeProperty('position');
      return [before,oldPrepare];
    });
    assert.deepEqual(sizes,[500,499.5]);
  }
  await select(false);
  assert.deepEqual(await page.evaluate(()=>[scrollX,scrollY]),[0,0]);
  if(kind==='chat') assert.equal(await page.locator('#composer').evaluate(e=>getComputedStyle(e).position),'sticky');
  await start();await verify(await waitFor(s=>!s.busy),399);
  console.log(`PASS ${kind} same viewport: no selection scrolling, exact content and restored layout`);
  await page.reload();await select();await start();await waitFor(s=>s.state==='capturing');
  if(kind==='csdn') {
    await page.evaluate(()=>mutateOutside());
    // Model root client changes even on macOS overlay-scrollbar configurations.
    await isolated(()=>{
      Object.defineProperty(document.documentElement,'clientWidth',{configurable:true,get:()=>innerWidth-20});
      Object.defineProperty(document.documentElement,'clientHeight',{configurable:true,get:()=>innerHeight-20});
      Object.defineProperty(window,'devicePixelRatio',{configurable:true,get:()=>3});
      return {dpr:devicePixelRatio,clientWidth:document.documentElement.clientWidth};
    });
  }
  const cross=await waitFor(s=>!s.busy);await verify(cross,2399);
  if(kind==='csdn') {
    assert.equal(cross.diagnostics.environment.actual.dpr,3);
    assert.equal(cross.diagnostics.environment.actual.clientWidth,880);
    assert.equal(cross.metrics.retries,0);
  }
  console.log(`PASS ${kind} cross screen: TOP, all middle checkpoints, BOTTOM and every pixel; outside markers excluded`);
  if(kind==='chat') return;
  await page.reload();await select(true,true);await start();await waitFor(s=>s.state==='capturing');
  await page.evaluate(()=>growArticle());
  const grown=await waitFor(s=>!s.busy);await verify(grown,2709,true);
  assert.equal(grown.attempt,2);assert.equal(grown.metrics.retries,1);
  console.log('PASS csdn coherent container resize: Attempt 2 adopts 300px growth, all markers and padding verified');
  for(const change of ['innerWidth','tabZoom','visualScale']) {
    await page.reload();await select();await start();await waitFor(s=>s.state==='capturing');
    if(change==='innerWidth') await page.setViewportSize({width:880,height:700});
    if(change==='tabZoom') await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});await chrome.tabs.setZoom(tab.id,1.25)});
    if(change==='visualScale') await isolated(()=>Object.defineProperty(window.visualViewport,'scale',{configurable:true,get:()=>1.2}));
    const failed=await waitFor(s=>!s.busy);
    assert.equal(failed.state,'failed',JSON.stringify(failed));assert.equal(failed.reasonCode,'CAPTURE_ENV_CHANGED');
    assert.equal(failed.attempt,1);assert.equal(failed.parts,0);assert.equal(failed.result,undefined);
    if(change==='tabZoom') assert.equal(failed.diagnostics.environment.actual.tabZoom,1.25);
    assert.ok(failed.diagnostics.delta);assert.notEqual(failed.diagnostics.delta.expected,failed.diagnostics.delta.actual);
    console.log('PASS actual environment failure diagnostics',change,JSON.stringify(failed.diagnostics.delta));
    if(change==='innerWidth') await page.setViewportSize({width:900,height:700});
    if(change==='tabZoom') await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});await chrome.tabs.setZoom(tab.id,1)});
  }
  await page.reload();await select();await start();await waitFor(s=>s.state==='capturing');
  const other=await page.context().newPage();await other.bringToFront();
  const switched=await waitFor(s=>!s.busy);
  assert.equal(switched.state,'cancelled',JSON.stringify(switched));
  assert.equal(switched.reasonCode,'TARGET_TAB_CHANGED');assert.equal(switched.parts,0);
  assert.equal(switched.result,undefined);
  await other.close();
  console.log('PASS target tab switch: no PNG and explicit reason code');
}
