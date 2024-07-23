# Nestgen

Nestjs code generator for openapi.

Early alhpa - docs subject to change.

<!--
to regen:
  npx doctoc --github readme.md
then manually remove %5C from the routes

or 
  npm run docs
-->

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Install](#install)
- [Quickstart](#quickstart)
- [Config](#config)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Install

Install from src (pre-release)
```bash
npm install
npm run build
npm pack
# from consumer project: npm i -D /path/to/oas-nestgen-0.0.1.tgz
# do the same for oas-typegen. you may need to install typegen first if there are issues with install
```

post-release:
```bash
npm install --save-dev @acrontum/oas-nestgen
```


## Quickstart

```bash
npx oas-nestgen
```

Most up to date docs are in the cli help
```bash
npx oas-nestgen -h
```


## Config

By default, nestgen looks for `nestgen`, `nestgen.js`, and `nestgen.json`. Config files extend the default config, and cli args overwrite both.

All config options are available from the cli with the exception of override functions - those must be configured in a config file.

Default config:
```ts
export const config: Config = {
  // -c, --config-file FILE             Config file name or path (default nestgen)
  configFile: 'nestgen',
  // -i, --typegen-path FILE            Path to typegen json (default typegen.json)
  typegenPath: 'typegen.json',
  // -s, --stub-service VALUE           If true, generate stubbed service methods (default true)
  stubService: true,

  // -d, --dry-run                      Just print changes, if any (default false)
  dryRun: false,

  // -a, --app-module-path PATH         Path to main app module (default ./src/app.module.ts)
  appModulePath: './src/app.module.ts',
  // -m, --modules-path PATH            Path to modules folder (default ./src/modules/)
  modulesPath: './src/modules/',
  // -o, --op-id-decorator-path PATH    OpId decorator file path (default ./src/common/decorators/op-id.decorator.ts)
  opIdDecoratorPath: './src/common/decorators/op-id.decorator.ts',

  // -O, --op-id-decorator-import NAME  OpId decorator import name (default src/common/decorators/op-id.decorator)
  opIdDecoratorImport: 'src/common/decorators/op-id.decorator',
  // -T, --types-import NAME            Typings import name (default src/types)
  typesImport: 'src/types',

  // -I, --ignored-op-ids NAME          Ignore changes for opId (can be invoked multiple times)
  ignoredOpIds: null,

  // codegen methods used to name params, add decorators, etc for when the defaults don't work for your project
  // rtfm for now src/parse-typegen exports all of these
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
```

Example config override:
```js
// my-custom-thingy.js

const { getMethodName: defaultGetMethodName } = require('oas-nestgen/dist/parse-typegen');

module.exports = {
  typegenPath: '/tmp/typegen.json',
  stubService: false,
  getMethodName(method/*: TypeGenMethod*/, basename/*: string*/) {
    const original = defaultGetMethodName(method, basename);

    if (original.indexOf('get') === 0) {
      const suffix = original.slice(3);

      return (/\}\/$/.test(method.path.name)) ? `show${suffix}` : `list${suffix}`;
    }

    return original;
  }
}

```

```bash
npx oas-nestgen -c ./my-custom-thingy.js --dry-run
```
