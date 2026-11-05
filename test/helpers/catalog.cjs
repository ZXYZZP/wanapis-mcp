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
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], max_images: 9,
        advanced: {
          version: 'h3-v2',
          capabilities: { multi_image: true, frame_roles: true, reference_video: true, reference_audio: true, upload: true, regeneration: true, prompt_optimization: true },
          limits: { max_images: 9, max_reference_videos: 3, max_reference_audios: 3, max_input_video_seconds: 15, max_single_input_video_seconds: 15.5, max_audio_seconds: 15, effective_max_upload_bytes: { image: 31457280, video: 32505856, audio: 15728640 }, max_body_bytes: 33554432 },
          input_pricing: { free_images: 5, extra_image_price: 0.065, reference_video_price_per_second: { '480p': 0.078, '768P': 0.117, '1080p': 0.182, '2K': 0.195 }, reference_video_rounding: 'ceil_total_seconds', reserved_input_video_seconds_single: 16, reserved_input_video_seconds_multiple: 15, audio_price: 0 },
          regeneration: { output_resolution: '2K', min_seconds: 4, max_seconds: 15, output_price_per_second: 0.078, reference_video_price_per_second: 0.078, extra_image_price: 0.052, free_images: 5 },
        },
      },
    },
    { model_name: 'seedance-2.0', model_price: 0.1, enable_groups: ['default'] },
    { model_name: 'gpt-image-2-official', model_price: 0.1, enable_groups: ['default'] },
    { model_name: 'unsupported-image-fixture', model_price: 0.01, supported_endpoint_types: ['image-generation'] },
    { model_name: 'minimax-h3-max', model_price: 1, supported_endpoint_types: ['openai-video'] },
  ],
};
