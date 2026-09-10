# Cartoon skin assets

These original raster assets were generated for SeeDoodle on 2026-09-10 with
Google Gemini `gemini-3.1-flash-image-preview` (the local `gemini-image` skill's
`flash` model). They use text prompts without third-party reference images.
The full-resolution generation outputs are kept outside the repository;
the game ships only the resized, optimized JPEGs listed below.

| File | Purpose |
| --- | --- |
| `toon-surface-v1.jpg` | Neutral, low-contrast plaster and painterly grain, tiled and tinted by the cartoon renderer on architecture and character materials. |
| `toon-preview-v2.jpg` | Revised landscape preview with a diverse three-person adult squad: a dark-skinned woman with curly tied-up hair in green, a medium-skinned androgynous adventurer with a short bob in blue, and a light-skinned man with close-cropped hair in orange. |

The preview was generated with the same Gemini model on 2026-09-10 by
editing an earlier generated preview. It keeps the setting and art direction
while varying the squad's gender presentation, skin tones, and hairstyles.

The 512 x 512 surface tile is derived from a generated multicolor plaster
texture: it is desaturated, high-pass filtered, reduced to subtle light-gray
contrast, and blended at opposite edges for repeat sampling. The 960 x 540
preview is cropped to 16:9. Both use optimized progressive JPEG encoding.

The preview is illustrative key art. In-game geometry, lighting, player colors,
and material tinting are implemented by the renderer.
