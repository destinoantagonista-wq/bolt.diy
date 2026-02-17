import { z } from 'zod';

const nonEmptyTrimmed = (label: string, min = 1, max = 256) =>
  z
    .string({
      required_error: `${label} is required`,
      invalid_type_error: `${label} must be a string`,
    })
    .trim()
    .min(min, `${label} is required`)
    .max(max, `${label} must be ${max} characters or less`);

const optionalTrimmed = (label: string, max = 256) =>
  z
    .string({
      invalid_type_error: `${label} must be a string`,
    })
    .trim()
    .max(max, `${label} must be ${max} characters or less`)
    .optional();

export const sessionActionQuerySchema = z.object({
  intent: z.enum(['delete']).optional(),
  runtimeToken: optionalTrimmed('runtimeToken', 4096),
});

export const sessionCreateBodySchema = z.object({
  chatId: optionalTrimmed('chatId', 256),
  templateId: optionalTrimmed('templateId', 128),
  runtimeToken: optionalTrimmed('runtimeToken', 4096),
});

export const heartbeatBodySchema = z.object({
  runtimeToken: optionalTrimmed('runtimeToken', 4096),
});

export const filesListQuerySchema = z.object({
  path: optionalTrimmed('path', 4096),
});

export const filesReadQuerySchema = z.object({
  path: nonEmptyTrimmed('path', 1, 4096),
});

export const filesWriteBodySchema = z.object({
  path: nonEmptyTrimmed('path', 1, 4096),
  content: z.string({
    required_error: 'content is required',
    invalid_type_error: 'content must be a string',
  }),
  encoding: z.enum(['utf8', 'base64']).optional(),
  runtimeToken: optionalTrimmed('runtimeToken', 4096),
});

export const filesMkdirBodySchema = z.object({
  path: nonEmptyTrimmed('path', 1, 4096),
  runtimeToken: optionalTrimmed('runtimeToken', 4096),
});

export const filesDeleteBodySchema = z.object({
  path: nonEmptyTrimmed('path', 1, 4096),
  recursive: z.boolean().optional(),
  runtimeToken: optionalTrimmed('runtimeToken', 4096),
});

export const filesSearchQuerySchema = z.object({
  query: nonEmptyTrimmed('query', 1, 512),
  path: optionalTrimmed('path', 4096),
});

export const redeployBodySchema = z.object({
  reason: optionalTrimmed('reason', 256),
  runtimeToken: optionalTrimmed('runtimeToken', 4096),
});

export const cleanupBodySchema = z.object({
  actorId: optionalTrimmed('actorId', 256),
});
