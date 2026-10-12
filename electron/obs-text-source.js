// Shared helper: create/update a named OBS text source pinned to a screen corner.
// GDI+ text on Windows, FreeType2 elsewhere. Idempotent; never throws.
const TEXT_KINDS = ['text_gdiplus_v3', 'text_gdiplus_v2', 'text_ft2_source_v2', 'text_ft2_source'];

// opts (x, y, size in 1080p reference units): { name, text, enabled, alignment, x, y, size, createIfMissing(default true) }
async function ensureTextSource(obs, opts, logger) {
  if (!obs) return false;
  const { name, text, enabled, alignment, x, y, size = 40, createIfMissing = true } = opts;
  try {
    let inputKinds = [];
    try { ({ inputKinds } = await obs.call('GetInputKindList')); } catch {}
    const kind = TEXT_KINDS.find(k => inputKinds.includes(k));
    if (!kind) { logger?.warn('No OBS text source kind available', { name }); return false; }
    // Positions/sizes are authored for a 1920x1080 canvas; scale to the real OBS canvas.
    let scale = 1, scaleY = 1;
    try { const v = await obs.call('GetVideoSettings'); if (v && v.baseWidth > 0) { scale = v.baseWidth / 1920; if (v.baseHeight > 0) scaleY = v.baseHeight / 1080; } } catch {}
    const gdi = kind.startsWith('text_gdiplus');
    const { currentProgramSceneName: scene } = await obs.call('GetCurrentProgramScene');
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
    const item = sceneItems.find(it => it.sourceName === name);
    let sceneItemId = item?.sceneItemId;
    if (!item) {
      if (!createIfMissing && !enabled) return false; // nothing to hide, don't create clutter
      ({ sceneItemId } = await obs.call('CreateInput', {
        sceneName: scene, inputName: name, inputKind: kind,
        inputSettings: {}, sceneItemEnabled: !!enabled,
      }));
      await obs.call('SetSceneItemTransform', {
        sceneName: scene, sceneItemId,
        sceneItemTransform: { alignment, positionX: Math.round(x * scale), positionY: Math.round(y * scaleY) },
      }).catch(() => {});
    }
    const font = { face: 'Arial', size: Math.max(8, Math.round(size * scale)), style: 'Bold', flags: 0 };
    const settings = gdi
      ? { text, font, color: 4294967295, outline: true, outline_color: 4278190080, outline_size: 4 }
      : { text, font, color1: 4294967295, color2: 4294967295, outline: true, drop_shadow: true };
    await obs.call('SetInputSettings', { inputName: name, overlay: true, inputSettings: settings });
    await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId, sceneItemEnabled: !!enabled });
    return true;
  } catch (e) {
    logger?.warn('ensureTextSource failed', { name, error: e.message });
    return false;
  }
}

// Tip menu: lines like "25 = flash", sanitised and capped.
function parseTipMenu(raw) {
  return String(raw || '').split(/\r?\n|;/).map(s => s.trim().slice(0, 60)).filter(Boolean).slice(0, 10);
}
function tipMenuText(lines) {
  return lines.length ? 'TIP MENU\n' + lines.join('\n') : '';
}

module.exports = { ensureTextSource, parseTipMenu, tipMenuText, TEXT_KINDS };
