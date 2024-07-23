import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { config } from './config';

export interface AssertTemplate {
  path: string;
  content: string;
}

export const exists = (filePath: string) =>
  access(filePath)
    .then(() => true)
    .catch(() => false);

export const assertFileFromTemplate = async (params: AssertTemplate): Promise<boolean> => {
  const { path, content } = params;
  if (await exists(path)) {
    return false;
  }

  if (config.dryRun) {
    return true;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: 'utf8' });

  return true;
};

export const renderFileAsTemplateString = async (filePath: string, data: Record<string, any>) => {
  const template = await readFile(filePath, { encoding: 'utf8' });

  return await new Function(
    'data',
    `return (async (${Object.keys(data).join(', ')}) => \`${template}\`)(...Object.values(data));`,
  )(data);
};

export const upsertFile = async (path: string, content: string, overwrite = false): Promise<boolean> => {
  if (!overwrite && (await exists(path))) {
    return false;
  }

  if (config.dryRun) {
    return true;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: 'utf8' });

  return true;
};
