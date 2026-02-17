import { SignJWT, jwtVerify } from 'jose';
import type { RuntimeTokenClaims } from './types';

const encoder = new TextEncoder();

export const signRuntimeToken = async (
  claims: Omit<RuntimeTokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSec: number,
) => {
  const nowSec = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    ...claims,
    v: 1,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSec)
    .sign(encoder.encode(secret));
};

export const verifyRuntimeToken = async (token: string, secret: string): Promise<RuntimeTokenClaims> => {
  const result = await jwtVerify(token, encoder.encode(secret), {
    algorithms: ['HS256'],
  });

  return result.payload as unknown as RuntimeTokenClaims;
};
