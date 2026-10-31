import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageBody, buildVideoBody, normalizeImageOptions, normalizeVideoOptions, submitPath } from '../src/models.js';
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
