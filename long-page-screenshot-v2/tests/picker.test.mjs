import test from 'node:test';
import assert from 'node:assert/strict';
import { clickPickerButton } from './picker.mjs';

function harness({ disabled = false, duplicate = false, zeroSize = false } = {}) {
  const button = id => ({nodeName:'BUTTON', nodeId:{first:1,second:2,capture:3,cancel:4}[id],
    attributes:['id',id,...(disabled && id==='capture'?['disabled','']:[])]});
  const picker = () => ({shadowRootType:'closed',children:[{nodeName:'SECTION',attributes:['id','panel'],
    children:['first','second','capture','cancel'].map(button)}]});
  const root={children:[{shadowRoots:[picker(),...(duplicate?[picker()]:[])]},
    {nodeName:'BUTTON',attributes:['id','capture'],nodeId:99}]};
  const calls=[], clicks=[];
  let detached=0;
  const cdp={send:async(method,args)=>{
    calls.push([method,args]);
    if(method==='DOM.getDocument')return {root};
    if(method==='DOM.getBoxModel')return {model:{width:zeroSize?0:40,height:20,border:[710,367,750,367,750,387,710,387]}};
    throw Error(`Unexpected method ${method}`);
  },detach:async()=>{detached++}};
  const page={context:()=>({newCDPSession:async()=>cdp}),mouse:{click:async(x,y)=>{clicks.push([x,y])}}};
  return {page,calls,clicks,get detached(){return detached}};
}

test('picker uses live closed-shadow geometry, not old toolbar coordinates or a page lookalike', async()=>{
  const h=harness();
  await clickPickerButton(h.page,'capture');
  assert.deepEqual(h.calls,[['DOM.getDocument',{depth:-1,pierce:true}],['DOM.getBoxModel',{nodeId:3}]]);
  assert.deepEqual(h.clicks,[[730,377]]);assert.equal(h.detached,1);
});
for(const [option,pattern] of [['disabled',/disabled/],['duplicate',/Expected one/],['zeroSize',/not visible/]]){
  test(`picker fails explicitly for ${option} and detaches CDP`,async()=>{
    const h=harness({[option]:true});
    await assert.rejects(()=>clickPickerButton(h.page,'capture'),pattern);
    assert.deepEqual(h.clicks,[]);assert.equal(h.detached,1);
  });
}
test('unknown picker actions are rejected before creating a CDP session',async()=>{
  const h=harness();
  await assert.rejects(()=>clickPickerButton(h.page,'unknown'),/Unknown picker/);
  assert.deepEqual(h.calls,[]);assert.equal(h.detached,0);
});
