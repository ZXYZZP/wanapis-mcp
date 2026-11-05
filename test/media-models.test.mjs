import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageBody, buildVideoBody, buildRegenerationBody, buildPromptOptimizationBody, normalizeImageOptions, normalizeVideoOptions, submitPath } from '../src/models.js';
import { parseCatalog, listCatalogModels } from '../src/catalog.js';
import { estimateCost } from '../src/pricing.js';
import fixture from './helpers/catalog.cjs';

const catalog = () => parseCatalog(structuredClone(fixture));

test('Image 2.5 all quality/resolution combinations are independent and async', () => {
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
    for (const quality of ['low', 'medium', 'high', 'xhigh', 'max']) {
      for (const resolution of ['1k', '2k', '4k']) {
        const body = buildImageBody(model, { prompt: 'p', quality, resolution, count: 3 });
        assert.equal(body.quality, quality);
        assert.equal(body.resolution, resolution);
        assert.equal(body.n, 3);
        assert.equal(submitPath('image', model), '/v1/images/tasks');
      }
    }
  }
});

test('Image 2.5 size/reference options preserve input and reject ambiguous or invalid inputs', () => {
  const options = { prompt: 'p', size: '1536x1024', referenceImages: ['https://cdn.example/a.png'] };
  const before = structuredClone(options);
  assert.equal(buildImageBody('gpt-image-2.5-flare', options).size, '1536x1024');
  assert.deepEqual(options, before);
  assert.throws(() => normalizeImageOptions('gpt-image-2.5-flare', { size: '1:1', aspect: '16:9' }), /conflict/);
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeImageOptions('gpt-image-2.5-flare', { count }), /positive integer/);
  }
  assert.throws(() => buildImageBody('gpt-image-2.5-sunburst', { prompt: ' ' }), /prompt/);
});

test('H3 duration and ratio boundaries follow the verified client contract', () => {
  for (const resolution of ['480p', '768P', '1080p', '2K']) {
    for (const seconds of [4, resolution === '2K' ? 15 : 30]) {
      const body = buildVideoBody('minimax-h3', { prompt: 'p', resolution, seconds, aspect: '16:9' });
      assert.equal(body.ratio, '16:9');
      assert.equal(body.seconds, seconds);
      assert.equal(body.duration, undefined);
      assert.equal(body.size, undefined);
    }
  }
  for (const options of [{ seconds: 3 }, { seconds: 31 }, { seconds: 4.1 }, { resolution: '2K', seconds: 16 }, { resolution: '4K' }, { ratio: '2:3' }, { aspect: '16:9', ratio: '9:16' }, { fast_mode: 'false' }, { context_ir_enabled: 0 }]) {
    assert.throws(() => normalizeVideoOptions('minimax-h3', options));
  }
});

test('H3 typed media preserves roles, sources and fewer constraints on legacy input', () => {
  const body = buildVideoBody('minimax-h3', {
    prompt: 'p', resolution: '768P', seconds: 4, ratio: '16:9', context_ir_enabled: false,
    referenceImages: ['https://cdn.example/a.png', 'asset_0123456789abcdef0123456789abcdef'],
    firstFrame: 'https://cdn.example/first.png', lastFrame: 'https://cdn.example/last.png',
    referenceVideos: ['https://cdn.example/ref.mp4'], referenceAudio: ['https://cdn.example/ref.mp3'],
  });
  assert.equal(body.prompt, undefined);
  assert.deepEqual(body.content.map((item) => [item.type, item.role]), [
    ['text', undefined], ['image_url', 'first_frame'], ['image_url', 'last_frame'],
    ['image_url', 'reference_image'], ['image_url', 'reference_image'],
    ['video_url', 'reference_video'], ['audio_url', 'reference_audio'],
  ]);
  assert.deepEqual(body.content[3].image_url, { url: 'https://cdn.example/a.png' });
  assert.deepEqual(body.content[4].image_url, { asset_id: 'asset_0123456789abcdef0123456789abcdef' });
  const legacy = buildVideoBody('minimax-h3', { prompt: 'p', imageUrl: 'https://cdn.example/a.png' });
  assert.deepEqual(legacy.input_reference, { image_url: 'https://cdn.example/a.png' });
  for (const options of [
    { referenceImages: Array.from({ length: 10 }, () => 'https://cdn.example/a.png') },
    { referenceVideos: ['a', 'b', 'c', 'd'] },
    { referenceAudio: ['a', 'b', 'c', 'd'] },
    { firstFrame: 'https://cdn.example/a.png', lastFrame: 'https://cdn.example/a.png' },
    { imageUrl: 'https://cdn.example/a.png', referenceImages: ['https://cdn.example/b.png'] },
  ]) {
    assert.throws(() => buildVideoBody('minimax-h3', { prompt: 'p', ...options }));
  }
});

test('regeneration and prompt optimization build their native public bodies', () => {
  assert.deepEqual(buildRegenerationBody({ mode: 'source' }), { mode: 'source', resolution: '2K' });
  assert.throws(() => buildRegenerationBody({ mode: 'source', prompt: 'p' }));
  assert.throws(() => buildRegenerationBody({ mode: 'content' }));
  const content = buildRegenerationBody({ mode: 'content', prompt: 'p', referenceImages: ['https://cdn.example/a.png'] });
  assert.equal(content.mode, 'content');
  assert.equal(content.resolution, '2K');
  assert.deepEqual(content.content.map((item) => item.type), ['text', 'image_url']);
  assert.deepEqual(buildPromptOptimizationBody({ prompt: 'p' }), {
    model: 'minimax-h3', content: [{ type: 'text', text: 'p' }], duration: 4, ratio: '9:16',
  });
  assert.throws(() => buildPromptOptimizationBody({ prompt: 'p', seconds: 3 }));
  assert.throws(() => buildPromptOptimizationBody({ prompt: 'p', ratio: '2:3' }));
});

test('H3 capabilities expose multi-image, video/audio references, regeneration and upload', () => {
  const h3 = listCatalogModels(catalog(), 'video').find((row) => row.model === 'minimax-h3');
  assert.equal(h3.capabilities.max_reference_images, 9);
  assert.equal(h3.capabilities.max_reference_videos, 3);
  assert.equal(h3.capabilities.max_reference_audio, 3);
  assert.deepEqual(h3.capabilities.frame_roles, ['first_frame', 'last_frame']);
  assert.equal(h3.capabilities.upload, true);
  assert.deepEqual(h3.capabilities.regeneration, ['content']);
  assert.equal(h3.capabilities.prompt_optimization, true);
});

test('H3 media estimates reserve reference-video seconds and charge extra images', () => {
  const c = catalog();
  const oneVideo = estimateCost(c, 'minimax-h3', { seconds: 4, context_ir_enabled: false, referenceVideos: ['https://cdn.example/a.mp4'] });
  assert.equal(oneVideo.estimate_kind, 'reservation_upper_bound');
  assert.equal(oneVideo.estimated_quota, 1170000);
  assert.equal(oneVideo.breakdown.reference_video_reserved_seconds, 16);
  const twoVideos = estimateCost(c, 'minimax-h3', { seconds: 4, context_ir_enabled: false, referenceVideos: ['a', 'b'] });
  assert.equal(twoVideos.breakdown.reference_video_reserved_seconds, 15);
  assert.equal(twoVideos.estimated_quota, 1111500);
  const images = estimateCost(c, 'minimax-h3', { seconds: 4, context_ir_enabled: false, referenceImages: Array.from({ length: 6 }, (_, i) => `https://cdn.example/${i}.png`) });
  assert.equal(images.breakdown.extra_image_fee, 0.065);
  assert.equal(images.estimated_quota, 266500);
  const unavailableCatalog = catalog();
  delete unavailableCatalog.entries.get('minimax-h3').video_pricing_meta.advanced;
  assert.equal(estimateCost(unavailableCatalog, 'minimax-h3', { seconds: 4, referenceImages: ['https://cdn.example/a.png'] }).estimate, null);
});

test('Seedance accepts frames with reference images and emits typed content', () => {
  const body = buildVideoBody('seedance-2.0-mini', {
    prompt: 'p', quality: 'low', seconds: 4, aspect: '16:9',
    referenceImages: ['https://cdn.example/ref.png'],
    firstFrame: 'https://cdn.example/first.png',
    lastFrame: 'https://cdn.example/last.png',
    generateAudio: false, returnLastFrame: true, seed: 7,
  });
  assert.equal(body.resolution, '480p');
  assert.equal(body.duration, 4);
  assert.equal(body.size, '16:9');
  assert.deepEqual(body.image_with_roles.map((item) => [item.role, item.url]), [
    ['first_frame', 'https://cdn.example/first.png'],
    ['last_frame', 'https://cdn.example/last.png'],
    ['reference_image', 'https://cdn.example/ref.png'],
  ]);
  assert.equal(body.generate_audio, false);
  assert.equal(body.return_last_frame, true);
  assert.equal(body.seed, 7);
});

test('Seedance reference video and audio use their top-level arrays', () => {
  const body = buildVideoBody('seedance-2.0-mini', {
    prompt: 'p', quality: 'medium', seconds: 5,
    referenceImages: ['https://cdn.example/ref.png'],
    referenceVideos: ['https://cdn.example/ref.mp4'],
    referenceAudio: ['https://cdn.example/ref.mp3'],
  });
  assert.equal(body.resolution, '720p');
  assert.equal(body.duration, 5);
  assert.deepEqual(body.image_urls, ['https://cdn.example/ref.png']);
  assert.deepEqual(body.video_urls, ['https://cdn.example/ref.mp4']);
  assert.deepEqual(body.audio_urls, ['https://cdn.example/ref.mp3']);
  assert.equal(body.image_with_roles, undefined);
});

test('Seedance untyped images use image_urls and media limits are enforced', () => {
  const body = buildVideoBody('seedance-2.0', { prompt: 'p', referenceImages: ['https://cdn.example/a.png'] });
  assert.deepEqual(body.image_urls, ['https://cdn.example/a.png']);
  assert.equal(body.image_with_roles, undefined);
  for (const options of [
    { referenceImages: Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.png`) },
    { referenceVideos: ['a', 'b', 'c', 'd'] },
    { referenceAudio: ['a'] },
    { firstFrame: 'https://cdn.example/a.png', lastFrame: 'https://cdn.example/a.png' },
    { firstFrame: 'https://cdn.example/a.png', referenceVideos: ['https://cdn.example/v.mp4'] },
    { imageUrl: 'https://cdn.example/a.png', referenceImages: ['https://cdn.example/b.png'] },
  ]) {
    assert.throws(() => buildVideoBody('seedance-2.0', { prompt: 'p', ...options }));
  }
  const caps = listCatalogModels(catalog(), 'video').find((row) => row.model === 'seedance-2.0').capabilities;
  assert.equal(caps.max_reference_images, 9);
  assert.equal(caps.max_reference_videos, 3);
  assert.equal(caps.max_reference_audios, 3);
  assert.equal(caps.generate_audio, true);
  assert.equal(caps.return_last_frame, true);
  assert.equal(caps.seed, true);
});

test('legacy generation defaults remain unchanged', () => {
  assert.deepEqual(buildVideoBody('seedance-2.0', { prompt: 'p' }), { model: 'seedance-2.0', prompt: 'p', resolution: '720p', duration: 5 });
  assert.deepEqual(buildVideoBody('kling-v2-6', { prompt: 'p', quality: 'low', seconds: 4, imageUrl: 'https://cdn.example/a.png' }), {
    model: 'kling-v2-6', prompt: 'p', mode: 'std', duration: 4, image_urls: ['https://cdn.example/a.png'],
  });
  assert.deepEqual(buildImageBody('gpt-image-2', { prompt: 'p' }), { model: 'gpt-image-2', prompt: 'p', resolution: '2K' });
  assert.throws(() => buildImageBody('gpt-image-2', { prompt: 'p', quality: 'max' }), /quality/);
  assert.throws(() => buildVideoBody('seedance-2.0', { prompt: 'p', fast_mode: false }), /not supported/);
});

test('catalog listing only intersects adapters, preserving public pricing context', () => {
  const c = catalog();
  assert.deepEqual(c.group_ratio, fixture.group_ratio);
  assert.deepEqual(c.auto_groups, ['default']);
  assert.equal(listCatalogModels(c, 'image').length, 3);
  assert.equal(listCatalogModels(c, 'video').length, 2);
  assert.ok(!listCatalogModels(c).some((r) => r.model === 'minimax-h3-max'));
  assert.deepEqual(listCatalogModels(parseCatalog({ success: true, data: [] })), []);
  for (const payload of [null, { data: {} }, { success: false, data: [] }, { data: [null] }, { data: [{ model_name: 'x' }, { model_name: 'x' }] }]) {
    assert.throws(() => parseCatalog(payload));
  }
});

test('H3 estimates apply duration, priority and IR in the right order', () => {
  for (const [options, expected] of [
    [{}, 0.533], [{ context_ir_enabled: false }, 0.468], [{ seconds: 15 }, 1.82],
    [{ seconds: 16 }, 3.809], [{ seconds: 16, fast_mode: true }, 7.553],
    [{ resolution: '2K', seconds: 15 }, 2.99], [{ group_ratio: 0 }, 0],
    [{ seconds: 16, fast_mode: true, group_ratio: 0.5 }, 3.7765],
  ]) {
    const result = estimateCost(catalog(), 'minimax-h3', options);
    assert.equal(result.estimate, expected, JSON.stringify(options));
    assert.equal(result.estimated_quota, Math.round(expected * 500000));
    assert.equal(result.breakdown.ir_fee, options.context_ir_enabled === false ? 0 : 0.065);
    assert.equal(result.group_ratio_source, 'user_assumption');
  }
  const tiny = estimateCost(catalog(), 'minimax-h3', { group_ratio: 0.000001 });
  assert.equal(tiny.estimated_quota, 0);
  assert.throws(() => estimateCost(catalog(), 'minimax-h3', { group_ratio: -1 }), /group_ratio/);
});

test('Image 2.5 tiers multiply rather than replace each other, with a precharge disclaimer', () => {
  const result = estimateCost(catalog(), 'gpt-image-2.5-flare', { quality: 'max', resolution: '4k', count: 2, group_ratio: 0.8 });
  assert.equal(result.estimate, 8.51904);
  assert.equal(result.settings.count, 2);
  assert.equal(result.estimate_kind, 'tier_precharge');
  assert.match(result.note, /actual usage/);
  assert.equal(estimateCost(catalog(), 'gpt-image-2.5-flare').estimate, 0.0435);
});

test('new models never guess missing or invalid pricing metadata', () => {
  for (const change of [
    (e) => { delete e.video_pricing_meta; },
    (e) => { delete e.video_pricing['768P']; },
    (e) => { e.video_pricing_meta.context_ir.price = NaN; },
    (e) => { e.video_pricing_meta.fast_mode.multiplier = '2'; },
    (e) => { delete e.video_pricing_meta.max_seconds_by_resolution; },
  ]) {
    const c = catalog(); change(c.entries.get('minimax-h3'));
    assert.equal(estimateCost(c, 'minimax-h3').estimate, null);
  }
  for (const change of [
    (e) => { delete e.image_tier_ratios['quality:high']; },
    (e) => { e.model_price = -1; },
    (e) => { e.image_tier_ratios['resolution:2k'] = '2'; },
  ]) {
    const c = catalog(); change(c.entries.get('gpt-image-2.5-flare'));
    assert.equal(estimateCost(c, 'gpt-image-2.5-flare', { quality: 'high', resolution: '2k' }).estimate, null);
  }
});

test('new-model quota estimates round exact half units up without float loss', () => {
  const image = estimateCost(catalog(), 'gpt-image-2.5-flare', { quality: 'medium' });
  assert.equal(image.estimated_quota, 48938);
  assert.equal(image.estimate, 0.097876);
  const video = estimateCost(catalog(), 'minimax-h3', {
    resolution: '480p', seconds: 5, fast_mode: true, context_ir_enabled: true, group_ratio: 0.001,
  });
  assert.equal(video.estimated_quota, 423);
  assert.equal(video.estimate, 0.000846);
});

test('freeform estimates remain possible but never imply generation support', () => {
  const result = estimateCost(catalog(), 'unsupported-image-fixture');
  assert.equal(result.estimate, 0.01);
  assert.equal(estimateCost(catalog(), 'missing').estimate, null);
});
