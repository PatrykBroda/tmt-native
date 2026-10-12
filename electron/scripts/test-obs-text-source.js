const assert = require('assert');
const { ensureTextSource, parseTipMenu, tipMenuText } = require('../obs-text-source');
function fakeObs({ kinds = ['text_gdiplus_v3'], items = [], failOn } = {}) {
  const calls = [];
  return { calls, call: async (m, p) => {
    calls.push([m, p]);
    if (m === failOn) throw new Error('boom');
    if (m === 'GetInputKindList') return { inputKinds: kinds };
    if (m === 'GetCurrentProgramScene') return { currentProgramSceneName: 'Scene' };
    if (m === 'GetSceneItemList') return { sceneItems: items };
    if (m === 'CreateInput') return { sceneItemId: 7 };
    return {};
  } };
}
const names = o => o.calls.map(c => c[0]);
(async () => {
  const base = { name: 'X', text: 'hi', enabled: true, alignment: 5, x: 1, y: 2 };
  let o = fakeObs();
  assert.strictEqual(await ensureTextSource(o, base), true);
  assert.deepStrictEqual(names(o), ['GetInputKindList','GetCurrentProgramScene','GetSceneItemList','CreateInput','SetSceneItemTransform','SetInputSettings','SetSceneItemEnabled']);
  assert.strictEqual(o.calls.find(c => c[0]==='SetInputSettings')[1].inputSettings.text, 'hi');
  // existing item: no create
  o = fakeObs({ items: [{ sourceName: 'X', sceneItemId: 3 }] });
  await ensureTextSource(o, base);
  assert(!names(o).includes('CreateInput'));
  assert.strictEqual(o.calls.find(c => c[0]==='SetSceneItemEnabled')[1].sceneItemId, 3);
  // disabled + missing + createIfMissing:false -> no clutter
  o = fakeObs();
  assert.strictEqual(await ensureTextSource(o, { ...base, enabled: false, createIfMissing: false }), false);
  assert(!names(o).includes('CreateInput'));
  // ft2 fallback uses color1
  o = fakeObs({ kinds: ['text_ft2_source_v2'] });
  await ensureTextSource(o, base);
  assert('color1' in o.calls.find(c => c[0]==='SetInputSettings')[1].inputSettings);
  // no text kind / OBS error / null client: never throws
  assert.strictEqual(await ensureTextSource(fakeObs({ kinds: [] }), base), false);
  assert.strictEqual(await ensureTextSource(fakeObs({ failOn: 'SetInputSettings' }), base), false);
  assert.strictEqual(await ensureTextSource(null, base), false);
  // menu parsing
  assert.deepStrictEqual(parseTipMenu('25 = kiss; 50 = twirl\n\n 100=flash '), ['25 = kiss','50 = twirl','100=flash']);
  assert.strictEqual(parseTipMenu(Array.from({length:30},(_, i)=>'a'+i).join(';')).length, 10);
  assert.strictEqual(tipMenuText([]), '');
  assert.strictEqual(tipMenuText(['a']), 'TIP MENU\na');
  console.log('obs-text-source OK');
})().catch(e => { console.error(e); process.exit(1); });
