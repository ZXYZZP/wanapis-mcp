// Public retail shapes with synthetic model entries; never requests a live API.
module.exports = {
  success: true,
  pricing_version: 'offline-fixture-v1',
  group_ratio: { default: 1, svip: 0.8 },
  usable_group: { default: 'Default' },
  auto_groups: ['default'],
  data: [
    ...['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].map((model_name) => ({
      model_name, model_price: 0.0435, enable_groups: ['default', 'svip'],
      supported_endpoint_types: ['openai', 'image-generation'],
      image_tier_ratios: {
        'quality:medium': 2.25, 'quality:high': 9, 'quality:xhigh': 16,
        'quality:max': 36, 'resolution:2k': 2, 'resolution:4k': 3.4,
      },
    })),
    {
      model_name: 'minimax-h3', model_price: 0.117, enable_groups: ['default', 'svip'],
      supported_endpoint_types: ['openai-video'],
      video_pricing: { '480p': 0.078, '768P': 0.117, '1080p': 0.182, '2K': 0.195 },
      video_pricing_meta: {
        version: 'offline-h3-v1', default_resolution: '768P', default_seconds: 4,
        default_ratio: '9:16', min_seconds: 4, max_seconds: 30,
        max_seconds_by_resolution: { '480p': 30, '768P': 30, '1080p': 30, '2K': 15 },
        long_from: 16, long_multiplier: 2,
        fast_mode: { default_enabled: false, multiplier: 2 },
        context_ir: { default_enabled: true, price: 0.065, unit: 'request' },
        resolutions: ['480p', '768P', '1080p', '2K'],
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], max_images: 1,
      },
    },
    { model_name: 'seedance-2.0', model_price: 0.1, enable_groups: ['default'] },
    { model_name: 'gpt-image-2-official', model_price: 0.1, enable_groups: ['default'] },
    { model_name: 'unsupported-image-fixture', model_price: 0.01, supported_endpoint_types: ['image-generation'] },
    { model_name: 'minimax-h3-max', model_price: 1, supported_endpoint_types: ['openai-video'] },
  ],
};
