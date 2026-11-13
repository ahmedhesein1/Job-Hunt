import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * Secrets live in SSM Parameter Store Standard SecureString parameters encrypted with
 * the AWS-managed key (§3, §14). Values are cached per execution environment.
 */
const ssm = new SSMClient({});
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: string; expiresAt: number }>();

export class MissingConfigError extends Error {
  override name = 'MissingConfigError';
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new MissingConfigError(`Environment variable ${name} is not set`);
  return value;
}

export async function getSecret(parameterName: string): Promise<string> {
  const cached = cache.get(parameterName);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const result = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new MissingConfigError(`SSM parameter ${parameterName} is empty or missing`);
  cache.set(parameterName, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Secret named by an environment variable that holds the SSM parameter name. */
export function getSecretFromEnv(envName: string): Promise<string> {
  return getSecret(requiredEnv(envName));
}

/** Optional secret: returns undefined when the env var is unset or the parameter is missing. */
export async function getOptionalSecretFromEnv(envName: string): Promise<string | undefined> {
  const name = process.env[envName];
  if (!name) return undefined;
  try {
    return await getSecret(name);
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

export function telegramChatId(): string {
  return requiredEnv('TELEGRAM_CHAT_ID');
}

export function telegramBotToken(): Promise<string> {
  return getSecretFromEnv('TELEGRAM_BOT_TOKEN_PARAM');
}
