import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function testDiagnostics({page,capture,waitFor,worker,PNG}) {
  // Read permission is only for verifying the clipboard in this temporary profile;
  // the production extension still writes solely in response to the user's click.
  for (const mode of ['success','mutation-failure']) {
    await page.context().clearPermissions();
    await page.reload();
    await capture('full','css');
    await waitFor(s=>s.state==='capturing'&&s.frames>=1);
    if(mode==='mutation-failure') {
      await page.evaluate(()=>appendBlock('INSERTED ABOVE',true));
    }
    const result=await waitFor(s=>!s.busy);
    assert.equal(result.state,mode==='success'?'complete':'failed',JSON.stringify(result));
    const button=page.locator('#long-screenshot-v2-progress').getByRole('button',{name:'复制诊断信息'});
    await button.click();
    await page.waitForFunction(()=>document.querySelector('#long-screenshot-v2-progress').shadowRoot.querySelector('#diagnostics').textContent!=='复制诊断信息');
    assert.equal(await page.locator('#long-screenshot-v2-progress #diagnostics').textContent(),'已复制诊断信息');
    await page.context().grantPermissions(['clipboard-read'], {origin:new URL(page.url()).origin});
    const text=await page.evaluate(()=>navigator.clipboard.readText());
    const report=JSON.parse(text);
    assert.equal(report.state,result.state);
    assert.equal(report.attempt,result.attempt);
    assert.deepEqual(report.diagnostics.fullProof,result.diagnostics.fullProof);
    assert.deepEqual(report.diagnostics.visual,result.diagnostics.visual);
    assert.ok(report.diagnostics.fullProof.trace.length<=150);
    assert.ok(report.diagnostics.fullProof.counters.witnessVerifications>0);
    assert.equal(report.diagnostics.fullProof.counters.mutations,
      report.diagnostics.fullProof.counters.ignoredMutations+report.diagnostics.fullProof.counters.dirtyMutations);
    assert.equal(report.diagnostics.fullProof.trace.at(-1).frameCount,result.frames);
    assert.equal(report.metrics.filenameFallbacks,result.metrics.filenameFallbacks);
    // Match the private field name, not the numeric filenameFallbacks counter.
    assert.doesNotMatch(text,/data:image|ARTICLE \d|INSERTED ABOVE|SECOND REFLOW|"filename"\s*:|127\.0\.0\.1/);
    if(mode==='success') {
      assert.equal(report.reasonCode,null);assert.equal(report.diagnostics.fullProof.trigger,null);
      const png=PNG.sync.read(await readFile(result.result.filename));
      const reference=PNG.sync.read(Buffer.from(await page.evaluate(()=>{
        const c=document.createElement('canvas');c.width=900;c.height=2400;
        const ctx=c.getContext('2d');
        [...document.querySelector('#article').children].forEach((child,i)=>ctx.drawImage(child,0,i*400));
        return c.toDataURL().split(',')[1];
      }),'base64'));
      assert.equal(png.width,reference.width);assert.equal(png.height,reference.height);
      assert.deepEqual(png.data,reference.data);
      assert.equal(result.metrics.retries,0);
    } else {
      assert.equal(report.reasonCode,'VISUAL_CONTINUITY_FAILED');
      assert.equal(report.diagnostics.fullProof.trigger,'WITNESS_MOVED');
      assert.equal(report.diagnostics.fullPageRestarts,0);assert.equal(result.attempt,1);
      assert.equal(result.result,undefined);assert.equal(result.parts,0);
      for(const attempt of [1]) assert.ok(report.diagnostics.fullProof.trace.some(t=>t.attempt===attempt&&t.trigger==='WITNESS_MOVED'));
      assert.ok(report.diagnostics.fullProof.trace.some(t=>t.event==='mutation-marked-dirty'));
    }
    assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})),[]);
    console.log('PASS diagnostics Chrome',mode,JSON.stringify(report));
  }
}
