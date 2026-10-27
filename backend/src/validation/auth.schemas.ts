import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from './common.js';

export const loginBodySchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  // Upper bound stops absurdly large inputs from being hashed.
  password: z.string().min(1).max(128),
});
export const loginSchemas = { body: loginBodySchema };

export const changePasswordSchemas = {
  body: z.strictObject({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(128),
  }),
};
