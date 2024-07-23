import { join } from 'path';
import { exists } from './file-utils';
import {
  extraDecorators,
  getBodyParams,
  getControllerDecorators,
  getMethodControllerName,
  getMethodName,
  getReturnValue,
  getSubPath,
  isDefaultProduces,
  nameHeadersParams,
  namePathParams,
  nameQueryParams,
} from './parse-typegen';

export type Config = {
  configFile: string;
  typegenPath: string;
  stubService: boolean;
  dryRun: boolean;

  appModulePath: string;
  modulesPath: string;
  opIdDecoratorPath: string;

  opIdDecoratorImport: string;
  typesImport: string;

  ignoredOpIds: string[] | null;

  getMethodName: typeof getMethodName;
  getReturnValue: typeof getReturnValue;
  namePathParams: typeof namePathParams;
  nameQueryParams: typeof nameQueryParams;
  nameHeadersParams: typeof nameHeadersParams;
  isDefaultProduces: typeof isDefaultProduces;
  extraDecorators: typeof extraDecorators;
  getMethodControllerName: typeof getMethodControllerName;
  getSubPath: typeof getSubPath;
  getBodyParams: typeof getBodyParams;
  getControllerDecorators: typeof getControllerDecorators;
};

export const config: Config = {
  configFile: 'nestgen',
  typegenPath: 'typegen.json',
  stubService: true,
  dryRun: false,

  appModulePath: './src/app.module.ts',
  modulesPath: './src/modules/',
  opIdDecoratorPath: './src/common/decorators/op-id.decorator.ts',

  opIdDecoratorImport: 'src/common/decorators/op-id.decorator',
  typesImport: 'src/types',

  ignoredOpIds: null,

  getMethodName,
  getReturnValue,
  namePathParams,
  nameQueryParams,
  nameHeadersParams,
  isDefaultProduces,
  extraDecorators,
  getMethodControllerName,
  getSubPath,
  getBodyParams,
  getControllerDecorators,
};

export const getConfig = async (overrides: Partial<Config> = {}) => {
  config.configFile = overrides.configFile || config.configFile;
  const supportedExtensions = ['', '.js', '.json'];

  for (const ext of supportedExtensions) {
    const configFile = `${config.configFile}${ext}`;

    if (await exists(join(process.cwd(), configFile))) {
      Object.assign(config, require(join(process.cwd(), configFile)));

      return Object.assign(config, overrides);
    }
  }

  return Object.assign(config, overrides);
};
