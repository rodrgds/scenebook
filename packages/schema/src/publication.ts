import { z } from 'zod';

import {
  IdSchema,
  LocaleSchema,
  RelativePathSchema,
  SceneSourceRevisionSchema,
  Sha256Schema,
  SlugSchema,
} from './common.js';

export const MAX_PUBLICATION_METADATA_BYTES = 8 * 1024 * 1024;
export const MAX_PUBLICATION_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_PUBLICATION_FILES = 20_000;

export const CompilerOutputFormatSchema = z.enum([
  'catalog',
  'standalone-html',
  'web-component',
  'iframe',
  'markdown',
  'mdx',
  'html-guide',
  'pdf',
  'mp4',
  'webm',
  'gif',
  'readme-card',
  'og-image',
  'social-carousel',
  'remix-source',
]);

export const PublicationMediaTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u,
    'Expected a canonical media type without parameters',
  );

export const PublicationPathSchema = RelativePathSchema.refine(
  (path) => /^[A-Za-z0-9._/-]+$/u.test(path),
  'Publication archive paths must use portable ASCII filename characters',
);

export const PublicationFileSchema = z
  .object({
    path: PublicationPathSchema,
    sha256: Sha256Schema,
    byteLength: z.number().int().nonnegative().max(MAX_PUBLICATION_ARCHIVE_BYTES),
    mediaType: PublicationMediaTypeSchema,
  })
  .strict();

export const PublicationArchiveObjectSchema = z
  .object({
    sha256: Sha256Schema,
    byteLength: z.number().int().positive().max(MAX_PUBLICATION_ARCHIVE_BYTES),
    mediaType: z.literal('application/zip'),
  })
  .strict();

export const PublicationJsonObjectSchema = z
  .object({
    sha256: Sha256Schema,
    byteLength: z.number().int().positive().max(MAX_PUBLICATION_METADATA_BYTES),
    mediaType: z.literal('application/json'),
  })
  .strict();

export const PublicationInventorySchema = z
  .object({
    format: z.literal('scenebook-publication-archive'),
    version: z.literal(1),
    archive: PublicationArchiveObjectSchema,
    treeHash: Sha256Schema,
    byteLength: z.number().int().nonnegative().max(MAX_PUBLICATION_ARCHIVE_BYTES),
    compilerManifest: PublicationFileSchema,
    files: z.array(PublicationFileSchema).min(1).max(MAX_PUBLICATION_FILES),
  })
  .strict()
  .superRefine((inventory, context) => {
    const paths = new Set<string>();
    let previousPath: string | undefined;
    let totalBytes = 0;
    for (const [index, file] of inventory.files.entries()) {
      if (paths.has(file.path)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate publication file path: ${file.path}`,
          path: ['files', index, 'path'],
        });
      }
      paths.add(file.path);
      if (previousPath !== undefined && previousPath >= file.path) {
        context.addIssue({
          code: 'custom',
          message: 'Publication files must be strictly sorted by path',
          path: ['files', index, 'path'],
        });
      }
      previousPath = file.path;
      totalBytes += file.byteLength;
    }
    if (totalBytes !== inventory.byteLength) {
      context.addIssue({
        code: 'custom',
        message: 'Publication byteLength must equal the sum of its file byte lengths',
        path: ['byteLength'],
      });
    }
    if (
      inventory.compilerManifest.path !== 'manifest.json' ||
      inventory.compilerManifest.mediaType !== 'application/json'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The compiler manifest must identify manifest.json as application/json',
        path: ['compilerManifest'],
      });
    }
    const manifestFile = inventory.files.find((file) => file.path === 'manifest.json');
    if (
      !manifestFile ||
      manifestFile.sha256 !== inventory.compilerManifest.sha256 ||
      manifestFile.byteLength !== inventory.compilerManifest.byteLength ||
      manifestFile.mediaType !== inventory.compilerManifest.mediaType
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The compiler manifest descriptor must match the manifest.json inventory entry',
        path: ['compilerManifest'],
      });
    }
  });

const CompilerSceneOutputsSchema = z
  .record(z.string().max(100), z.array(PublicationPathSchema).min(1).max(MAX_PUBLICATION_FILES))
  .superRefine((outputs, context) => {
    const entries = Object.entries(outputs);
    if (entries.length === 0) {
      context.addIssue({ code: 'custom', message: 'A compiled Scene requires output files' });
    }
    for (const [format] of entries) {
      if (!CompilerOutputFormatSchema.safeParse(format).success) {
        context.addIssue({
          code: 'custom',
          message: `Unknown compiler output format: ${format}`,
          path: [format],
        });
      }
    }
  });

export const CompilerPublicationSceneSchema = z
  .object({
    id: IdSchema,
    slug: SlugSchema,
    sourceHash: SceneSourceRevisionSchema,
    locale: LocaleSchema,
    evidence: PublicationPathSchema,
    outputs: CompilerSceneOutputsSchema,
  })
  .passthrough()
  .superRefine((scene, context) => {
    if (scene.evidence !== `scenes/${scene.slug}/evidence.json`) {
      context.addIssue({
        code: 'custom',
        message: 'Compiler evidence path must be owned by its exact Scene slug',
        path: ['evidence'],
      });
    }
  });

/**
 * The release-relevant, bounded portion of compiler manifest.json. Additional
 * compiler presentation metadata remains forward-compatible but is covered by
 * the uploaded object's digest and byte limit.
 */
export const CompilerPublicationManifestSchema = z
  .object({
    format: z.literal('scenebook-catalog'),
    version: z.literal(1),
    privacy: z
      .object({
        status: z.literal('passed'),
        scanner: z.string().min(1).max(2_000),
      })
      .passthrough(),
    scenes: z.array(CompilerPublicationSceneSchema).min(1).max(MAX_PUBLICATION_FILES),
  })
  .passthrough()
  .superRefine((manifest, context) => {
    const sceneIds = new Set<string>();
    const sceneSlugs = new Set<string>();
    const sceneReferencePaths = new Set<string>();
    for (const [sceneIndex, scene] of manifest.scenes.entries()) {
      if (sceneIds.has(scene.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate compiler Scene: ${scene.id}`,
          path: ['scenes', sceneIndex, 'id'],
        });
      }
      sceneIds.add(scene.id);
      if (sceneSlugs.has(scene.slug)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate compiler Scene slug: ${scene.slug}`,
          path: ['scenes', sceneIndex, 'slug'],
        });
      }
      sceneSlugs.add(scene.slug);
      if (sceneReferencePaths.has(scene.evidence)) {
        context.addIssue({
          code: 'custom',
          message: `Compiler evidence path is owned more than once: ${scene.evidence}`,
          path: ['scenes', sceneIndex, 'evidence'],
        });
      }
      sceneReferencePaths.add(scene.evidence);
      for (const [format, paths] of Object.entries(scene.outputs)) {
        for (const [pathIndex, path] of paths.entries()) {
          if (sceneReferencePaths.has(path)) {
            context.addIssue({
              code: 'custom',
              message: `Compiler Scene reference is owned more than once: ${path}`,
              path: ['scenes', sceneIndex, 'outputs', format, pathIndex],
            });
          }
          sceneReferencePaths.add(path);
        }
      }
    }
  });

export const ReleasePublicationSchema = z
  .object({
    archive: PublicationArchiveObjectSchema,
    inventory: PublicationJsonObjectSchema,
    compilerManifest: PublicationJsonObjectSchema,
    treeHash: Sha256Schema,
  })
  .strict();

export type CompilerOutputFormat = z.infer<typeof CompilerOutputFormatSchema>;
export type CompilerPublicationManifest = z.infer<typeof CompilerPublicationManifestSchema>;
export type PublicationFile = z.infer<typeof PublicationFileSchema>;
export type PublicationInventory = z.infer<typeof PublicationInventorySchema>;
export type ReleasePublication = z.infer<typeof ReleasePublicationSchema>;
