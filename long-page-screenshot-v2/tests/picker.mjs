import assert from 'node:assert/strict';

function walk(node, nodes = []) {
  nodes.push(node);
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child, nodes);
  return nodes;
}
function attribute(node, name) {
  const attributes = node.attributes || [];
  for (let i = 0; i < attributes.length; i += 2) if (attributes[i] === name) return attributes[i + 1];
}

// Locate the production CLOSED-shadow picker through DevTools, then send a
// real mouse click. Do not open the shadow root, invoke onclick directly, or
// bypass the two DOM anchors with a synthetic REGION message.
export async function clickPickerButton(page, id) {
  assert.ok(['first', 'second', 'capture', 'cancel'].includes(id), `Unknown picker button: ${id}`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const pickers = walk(root).filter(node => node.shadowRootType === 'closed').map(node => walk(node))
      .filter(nodes => ['panel', 'first', 'second', 'capture'].every(id => nodes.some(node => attribute(node, 'id') === id)));
    assert.equal(pickers.length, 1, `Expected one closed-shadow picker for ${id}, found ${pickers.length}`);
    const button = pickers[0].find(node => node.nodeName === 'BUTTON' && attribute(node, 'id') === id);
    assert.ok(button, `Missing picker button: ${id}`);
    assert.equal(attribute(button, 'disabled'), undefined, `Picker button is disabled: ${id}`);
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: button.nodeId });
    assert.ok(model.width > 0 && model.height > 0, `Picker button is not visible: ${id}`);
    const quad = model.border;
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await page.mouse.click(x, y);
  } finally {
    await cdp.detach();
  }
}
