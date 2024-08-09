#!/usr/bin/env node

import { parseArgs, ParseArgsConfig } from 'node:util';
import { config, Config, getConfig } from './config';
import './console-patch';
import { generate } from './oas-nestgen';
import { camelCase } from './string-utils';

const description = Symbol('description');
const argname = Symbol('argname');

// https://stackoverflow.com/questions/66140451/typescript-add-kebab-case-types-form-actual-camel-case-keys
type Kebab<T extends string, A extends string = ''> = T extends `${infer F}${infer R}`
  ? Kebab<R, `${A}${F extends Lowercase<F> ? '' : '-'}${Lowercase<F>}`>
  : A;
type ConfigFunctionKeys = { [K in keyof Config]-?: Config[K] extends Function ? K : never }[keyof Config];
type ConfigKeys = Kebab<Exclude<keyof Config, ConfigFunctionKeys>>;
type ParseArgsOptionConfig = NonNullable<ParseArgsConfig['options']>[string];
type CliArg = ParseArgsOptionConfig & { [description]: string; [argname]?: string };
type CliExclusiveArgs = 'help';

const configArgs: Record<ConfigKeys | CliExclusiveArgs, CliArg> = {
  'app-module-path': { type: 'string', [argname]: 'PATH', short: 'a', [description]: 'Path to main app module' },
  'config-file': { type: 'string', [argname]: 'FILE', short: 'c', [description]: 'Config file name or path' },
  'dry-run': { type: 'boolean', short: 'd', [description]: 'Just print changes, if any' },
  'modules-path': { type: 'string', [argname]: 'PATH', short: 'm', [description]: 'Path to modules folder' },
  'op-id-decorator-import': { type: 'string', [argname]: 'NAME', short: 'O', [description]: 'OpId decorator import name' },
  'op-id-decorator-path': { type: 'string', [argname]: 'PATH', short: 'o', [description]: 'OpId decorator file path' },
  'stub-service': { type: 'string', [argname]: 'VALUE', short: 's', [description]: 'If true, generate stubbed service methods' },
  'typegen-path': { type: 'string', [argname]: 'FILE', short: 'i', [description]: 'Path to typegen json' },
  'types-import': { type: 'string', [argname]: 'NAME', short: 'T', [description]: 'Typings import name' },
  'ignored-op-ids': {
    type: 'string',
    [argname]: 'NAME',
    short: 'I',
    multiple: true,
    [description]: 'Ignore changes for opId (can be invoked multiple times)',
  },
  'max-line-length': { type: 'string', short: 'L', [description]: 'Show this menu' },
  'indent': { type: 'string', short: 'n', default: '  ', [description]: 'Indent to use when formatting code' },
  'verbose': { type: 'boolean', short: 'v', [description]: 'Print file changes when dry-run is true' },
  'help': { type: 'boolean', short: 'h', [description]: 'Show this menu' },
};

const help = (exitCode: number | null = null) => {
  let longest = 0;
  const longOpts = (Object.keys(configArgs) as (keyof typeof configArgs)[]).sort();
  const options: string[][] = [];
  for (const longOpt of longOpts) {
    let opt = configArgs[longOpt].short ? [`-${configArgs[longOpt].short}`, `--${longOpt}`].join(', ') : `--${longOpt}`;
    if (configArgs[longOpt][argname]) {
      opt += ` ${configArgs[longOpt][argname]}`;
    }
    longest = Math.max(longest, opt.length);

    const defaultArg = config[camelCase(longOpt) as keyof Config]?.toString()
      ? `(default ${config[camelCase(longOpt) as keyof Config]})`
      : null;
    const usage = [opt, configArgs[longOpt][description], defaultArg].filter(Boolean);

    if (longOpt !== 'help') {
      options.push(usage as string[]);
    }
  }
  options.push([`-h, --help`, configArgs.help[description]]);

  const log = exitCode === 0 ? console.log : console.error;
  log(`\
Generates NestJS code from oas-typegen schema.

Usage:
  oas-nestgen [options]

Example:
  oas-nestgen -i ../typegen.json -I skipMeOpid -I alsoSkipMeOpid --app-module-path=~/source/project/apps/backend/src/app.module.ts

Options:`);
  for (const [key, desc, def] of options) {
    log(' ', key.padEnd(longest), '', desc, def || '');
  }

  if (typeof exitCode === 'number') {
    process.exit(exitCode);
  }
};

const main = async (): Promise<void> => {
  try {
    const parsed = parseArgs({ options: configArgs, tokens: true });
    if (parsed.values.help) {
      return help(0);
    }

    if (parsed.values['stub-service']) {
      parsed.values['stub-service'] = parsed.values['stub-service'] !== 'false';
    }

    const configOverrides: Partial<Config> = {};
    for (const key of Object.keys(parsed.values) as ConfigKeys[]) {
      configOverrides[camelCase(key) as keyof Config] = parsed.values[key] as never;
    }
    if (parsed.values['max-line-length']) {
      configOverrides.maxLineLength = +parsed.values['max-line-length'];
    }

    const fullConfig = await getConfig(configOverrides);
    await generate(fullConfig);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const message = (e as NodeJS.ErrnoException).message;

    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' || code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      console.error(message);

      return help(1);
    }

    console.error(e);
    process.exit(1);
  }
};

if (require.main === module) {
  main();
}
